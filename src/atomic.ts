import { constants } from 'node:fs'
import { open, rename, unlink } from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { throwIfAborted } from './errors.ts'

const IGNORED_SYNC_ERROR_CODE: Readonly<Record<string, true>> = {
  EINVAL: true,
  ENOTSUP: true,
  EOPNOTSUPP: true,
  EBADF: true,
  EPERM: true,
}

export interface AtomicWriteOperations {
  readonly open: (path: string, flags: string | number, mode?: number) => Promise<FileHandle>
  readonly rename: (oldPath: string, newPath: string) => Promise<void>
  readonly unlink: (path: string) => Promise<void>
  readonly randomBytes: (size: number) => Buffer
}

export interface AtomicWriteOptions {
  readonly signal?: AbortSignal
  readonly mode?: number
  readonly assertSafe?: (path: string, signal?: AbortSignal) => Promise<void>
  readonly operations?: Partial<AtomicWriteOperations>
}

const DEFAULT_OPERATIONS: AtomicWriteOperations = { open, rename, unlink, randomBytes }

function isIgnoredSyncError(cause: unknown): boolean {
  return IGNORED_SYNC_ERROR_CODE[(cause as NodeJS.ErrnoException).code ?? ''] === true
}

async function syncFile(handle: FileHandle): Promise<void> {
  try {
    await handle.sync()
  } catch (cause) {
    if (!isIgnoredSyncError(cause)) throw cause
  }
}

async function closeWithoutMasking(handle: FileHandle | undefined): Promise<void> {
  if (handle === undefined) return
  try {
    await handle.close()
  } catch {
    // Cleanup must not replace the operation's primary failure.
  }
}

async function unlinkWithoutMasking(path: string | undefined, operations: AtomicWriteOperations): Promise<void> {
  if (path === undefined) return
  try {
    await operations.unlink(path)
  } catch {
    // The original write, abort, or rename error remains authoritative.
  }
}

async function syncDirectory(path: string, operations: AtomicWriteOperations): Promise<void> {
  let handle: FileHandle | undefined
  try {
    handle = await operations.open(path, constants.O_RDONLY)
    await syncFile(handle)
  } catch (cause) {
    if (!isIgnoredSyncError(cause)) {
      // The rename is already committed. Directory fsync is best effort because it is
      // unavailable on some supported filesystems and platforms.
    }
  } finally {
    await closeWithoutMasking(handle)
  }
}

function temporaryPath(target: string, operations: AtomicWriteOperations): string {
  const token = operations.randomBytes(18).toString('hex')
  return join(dirname(target), `.${basename(target)}.tmp-${process.pid}-${token}`)
}

/** Atomically replaces target with exact bytes using a sibling, exclusively-created file. */
export async function atomicWriteFile(
  target: string,
  bytes: Uint8Array,
  options: AtomicWriteOptions = {},
): Promise<void> {
  const operations: AtomicWriteOperations = { ...DEFAULT_OPERATIONS, ...options.operations }
  const signal = options.signal
  let temporary: string | undefined
  let handle: FileHandle | undefined

  throwIfAborted(signal)
  try {
    // Retry is unnecessary with 144 random bits; an adversarial collision fails closed.
    temporary = temporaryPath(target, operations)
    if (options.assertSafe !== undefined) {
      await options.assertSafe(target, signal)
      await options.assertSafe(temporary, signal)
    }
    handle = await operations.open(temporary, 'wx', options.mode ?? 0o600)
    throwIfAborted(signal)
    await handle.writeFile(bytes)
    throwIfAborted(signal)
    await syncFile(handle)
    throwIfAborted(signal)
    await handle.close()
    handle = undefined
    throwIfAborted(signal)
    if (options.assertSafe !== undefined) {
      await options.assertSafe(target, signal)
      await options.assertSafe(temporary, signal)
    }
    await operations.rename(temporary, target)
    temporary = undefined
  } catch (cause) {
    await closeWithoutMasking(handle)
    await unlinkWithoutMasking(temporary, operations)
    throw cause
  }

  // There is deliberately no abort check beyond the commit point: reporting
  // ABORTED after a successful rename would lie about the persisted outcome.
  await syncDirectory(dirname(target), operations)
}
