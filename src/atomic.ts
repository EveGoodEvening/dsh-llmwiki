import { constants } from 'node:fs'
import { open, rename, unlink, type FileHandle } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import { throwIfAborted, unsafeFilesystem } from './errors.ts'
import { validateComponent, type DirectoryIdentity, type WikiDirectory } from './paths.ts'

const IGNORED_SYNC_ERROR_CODE: Readonly<Record<string, true>> = {
  EINVAL: true, ENOTSUP: true, EOPNOTSUPP: true, EBADF: true, EPERM: true,
}
export interface AtomicWriteOperations {
  readonly open: (path: string, flags: string | number, mode?: number) => Promise<FileHandle>
  readonly rename: (oldPath: string, newPath: string) => Promise<void>
  readonly unlink: (path: string) => Promise<void>
  readonly randomBytes: (size: number) => Buffer
}
export interface AtomicWriteOptions {
  readonly signal?: AbortSignal | undefined
  readonly mode?: number
  readonly operations?: Partial<AtomicWriteOperations>
}
export async function syncFile(handle: FileHandle): Promise<void> {
  try { await handle.sync() }
  catch (cause) { if (IGNORED_SYNC_ERROR_CODE[(cause as NodeJS.ErrnoException).code ?? ''] !== true) throw cause }
}
const ATOMIC_TEMP_SUFFIX = /^[1-9][0-9]*-[0-9a-f]{36}$/u
function atomicTemporaryPrefix(name: string): string { return `.${name}.tmp-` }
function atomicTemporaryName(name: string, entropy: Buffer): string {
  return `${atomicTemporaryPrefix(name)}${process.pid}-${entropy.toString('hex')}`
}
/** Recognize only names produced by this writer for the specified target. */
export function isAtomicTemporaryName(candidate: string, name: string): boolean {
  const prefix = atomicTemporaryPrefix(name)
  return candidate.startsWith(prefix) && ATOMIC_TEMP_SUFFIX.test(candidate.slice(prefix.length))
}
/** Publish exact bytes within one pinned parent. No failure is reported after rename commits. */
export async function atomicWriteFile(directory: WikiDirectory, name: string, bytes: Uint8Array, options: AtomicWriteOptions = {}): Promise<void> {
  validateComponent(name)
  const operations: AtomicWriteOperations = { open, rename, unlink, randomBytes, ...options.operations }
  const signal = options.signal
  await directory.withHandle(async (parent, alias) => {
    throwIfAborted(signal)
    const target = `${alias}/${name}`
    const temporaryName = atomicTemporaryName(name, operations.randomBytes(18))
    validateComponent(temporaryName)
    const temporary = `${alias}/${temporaryName}`
    let handle: FileHandle | undefined
    let ownedIdentity: DirectoryIdentity | undefined
    let committed = false
    const rejectUnsafeTarget = async () => {
      const stat = await directory.inspect(name, signal)
      if (stat && !stat.isFile()) throw unsafeFilesystem('Atomic target is not a regular file.')
    }
    try {
      await rejectUnsafeTarget()
      throwIfAborted(signal)
      handle = await operations.open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, options.mode ?? 0o600)
      ownedIdentity = await handle.stat({ bigint: true })
      throwIfAborted(signal)
      await handle.writeFile(bytes)
      throwIfAborted(signal)
      await syncFile(handle)
      throwIfAborted(signal)
      await handle.close()
      handle = undefined
      await rejectUnsafeTarget()
      const temporaryStat = await directory.inspect(temporaryName, signal)
      if (!temporaryStat?.isFile() || temporaryStat.dev !== ownedIdentity.dev || temporaryStat.ino !== ownedIdentity.ino) throw unsafeFilesystem('Atomic temporary file was replaced.')
      throwIfAborted(signal)
      await operations.rename(temporary, target)
      committed = true
      directory.markCommitted()
    } catch (cause) {
      if (handle) { try { await handle.close() } catch {} }
      if (!committed && ownedIdentity) {
        try {
          const stat = await directory.inspect(temporaryName)
          if (stat?.dev === ownedIdentity.dev && stat.ino === ownedIdentity.ino) await operations.unlink(temporary)
        } catch { /* Preserve the primary write/abort failure. */ }
      }
      throw cause
    }
    // Durability is best effort after the commit boundary; abort cannot undo publication.
    try { await syncFile(parent) } catch {}
  })
}
