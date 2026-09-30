import { constants, type BigIntStats } from 'node:fs'
import { open, lstat, mkdir, opendir, unlink, rmdir, type FileHandle } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { LlmWikiError, throwIfAborted, unsafeFilesystem } from './errors.ts'
import type { PageId, SourceId } from './ids.ts'
import { atomicWriteFile, syncFile, type AtomicWriteOptions } from './atomic.ts'

export interface DirectoryIdentity { readonly dev: bigint; readonly ino: bigint }
export interface WikiAuthority { readonly root: string; identity?: DirectoryIdentity }
export interface EntrySnapshot { readonly name: string; readonly segments: readonly string[]; readonly stat: BigIntStats }
export type FileSnapshot = EntrySnapshot
/** Diagnostic metadata only; never authorizes a retry or pathname access. */
export class WikiTraversalError extends LlmWikiError {
  constructor(readonly segments: readonly string[], readonly entryKind: 'symlink' | 'not-directory' | 'unknown', cause: unknown) {
    super('UNSAFE_FILESYSTEM', 'Unable to open wiki directory safely.', { cause })
  }
}
export interface WikiPaths {
  readonly authority: WikiAuthority
  readonly root: string
  readonly schema: string
  readonly sources: string
  readonly pages: string
  readonly index: string
  sourceDirectory(id: SourceId): string
  sourceContent(id: SourceId): string
  sourceMetadata(id: SourceId): string
  page(id: PageId): string
  indexFile(name: 'search.json' | 'state.json'): string
}
const code = (cause: unknown) => (cause as NodeJS.ErrnoException).code
export function validateComponent(name: string): void {
  if (!name || name === '.' || name === '..' || /[\\/\0]/u.test(name)) throw unsafeFilesystem('Invalid wiki path component.')
}
function sameIdentity(a: DirectoryIdentity, b: DirectoryIdentity): boolean { return a.dev === b.dev && a.ino === b.ino }
export function sameFileSnapshot(a: BigIntStats, b: BigIntStats): boolean {
  return sameIdentity(a, b) && a.mode === b.mode && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs
}
function directoryFlags(): number {
  if (process.platform !== 'linux' || !constants.O_DIRECTORY || !constants.O_NOFOLLOW || !constants.O_NONBLOCK) {
    throw unsafeFilesystem('Descriptor-contained filesystem access requires Linux with usable procfs.')
  }
  return constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW
}
async function closeScope<T>(handle: FileHandle, action: () => Promise<T>, publication?: { committed: boolean }): Promise<T> {
  let failed = false
  try { return await action() } catch (cause) { failed = true; throw cause }
  finally { try { await handle.close() } catch (cause) { if (!failed && !publication?.committed) throw unsafeFilesystem('Unable to close wiki descriptor.', { cause }) } }
}
async function checked<T>(signal: AbortSignal | undefined, action: () => Promise<T>): Promise<T> {
  throwIfAborted(signal)
  try { const value = await action(); throwIfAborted(signal); return value }
  catch (cause) { throwIfAborted(signal); throw cause }
}
export class WikiDirectory {
  constructor(private readonly handle: FileHandle, readonly segments: readonly string[], private readonly operationRoot?: WikiDirectory, private readonly publication = { committed: false }) {}
  /** Internal commit boundary used by the atomic adapter, including ancestor cleanup. */
  markCommitted(): void { this.publication.committed = true }
  /** Internal filesystem adapter seam. Only atomic.ts may use descriptor aliases. */
  async withHandle<T>(callback: (handle: FileHandle, alias: string) => Promise<T>): Promise<T> {
    return callback(this.handle, `/proc/self/fd/${this.handle.fd}`)
  }
  private child(name: string): string { validateComponent(name); return `/proc/self/fd/${this.handle.fd}/${name}` }
  async identity(): Promise<DirectoryIdentity> { return this.handle.stat({ bigint: true }) }
  async inspect(name: string, signal?: AbortSignal): Promise<BigIntStats | null> {
    try { return await checked(signal, () => lstat(this.child(name), { bigint: true })) }
    catch (cause) { throwIfAborted(signal); if (code(cause) === 'ENOENT') return null; throw unsafeFilesystem('Unable to inspect wiki entry.', { cause }) }
  }
  async directory<T>(segments: readonly string[], options: { create?: boolean; signal?: AbortSignal | undefined }, callback: (directory: WikiDirectory) => Promise<T>): Promise<T | null> {
    segments.forEach(validateComponent)
    throwIfAborted(options.signal)
    if (!segments.length) return callback(this)
    const name = segments[0]!
    let handle: FileHandle
    try {
      try { handle = await open(this.child(name), directoryFlags()) }
      catch (cause) {
        if (code(cause) !== 'ENOENT' || !options.create) throw cause
        await checked(options.signal, async () => { try { await mkdir(this.child(name)) } catch (error) { if (code(error) !== 'EEXIST') throw unsafeFilesystem('The wiki filesystem operation failed.', { cause: error }) } })
        handle = await open(this.child(name), directoryFlags())
      }
    } catch (cause) {
      throwIfAborted(options.signal)
      if (cause instanceof LlmWikiError) throw cause
      if (code(cause) === 'ENOENT' && !options.create) return null
      let entryKind: 'symlink' | 'not-directory' | 'unknown' = 'unknown'
      if (code(cause) === 'ELOOP' || code(cause) === 'ENOTDIR') {
        const entry = await this.inspect(name, options.signal)
        if (entry?.isSymbolicLink()) entryKind = 'symlink'
        else if (entry && !entry.isDirectory()) entryKind = 'not-directory'
      }
      throw new WikiTraversalError([...this.segments, name], entryKind, cause)
    }
    return closeScope(handle, async () => {
      throwIfAborted(options.signal)
      const stat = await checked(options.signal, () => handle.stat({ bigint: true }))
      if (!stat.isDirectory()) throw unsafeFilesystem('Wiki parent is not a directory.')
      const directory = new WikiDirectory(handle, [...this.segments, name], this.operationRoot ?? this, this.publication)
      return directory.directory(segments.slice(1), options, callback)
    }, this.publication)
  }
  async read(name: string, signal?: AbortSignal): Promise<{ bytes: Buffer; snapshot: FileSnapshot } | null> {
    let handle: FileHandle
    try { throwIfAborted(signal); handle = await open(this.child(name), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK) }
    catch (cause) { throwIfAborted(signal); if (code(cause) === 'ENOENT') return null; throw unsafeFilesystem('Unable to open wiki file safely.', { cause }) }
    return closeScope(handle, async () => {
      throwIfAborted(signal)
      const before = await checked(signal, () => handle.stat({ bigint: true }))
      if (!before.isFile()) throw unsafeFilesystem('Wiki entry is not a regular file.')
      const bytes = await checked(signal, () => handle.readFile())
      const after = await checked(signal, () => handle.stat({ bigint: true }))
      const entry = await this.inspect(name, signal)
      if (!entry || !entry.isFile() || !sameFileSnapshot(before, after) || !sameFileSnapshot(before, entry)) throw unsafeFilesystem('Wiki file changed while reading.')
      return { bytes, snapshot: { name, segments: [...this.segments, name], stat: before } }
    })
  }
  async list(signal?: AbortSignal): Promise<readonly EntrySnapshot[]> {
    throwIfAborted(signal)
    let dir
    try { dir = await opendir(`/proc/self/fd/${this.handle.fd}`) }
    catch (cause) { throw unsafeFilesystem('Unable to enumerate pinned wiki directory.', { cause }) }
    const entries: EntrySnapshot[] = []
    let failed = false
    try {
      while (true) {
        const entry = await checked(signal, () => dir.read())
        if (!entry) break
        const stat = await this.inspect(entry.name, signal)
        if (!stat) throw unsafeFilesystem('Wiki entry disappeared during enumeration.')
        entries.push({ name: entry.name, segments: [...this.segments, entry.name], stat })
      }
    } catch (cause) { failed = true; throw cause }
    finally { try { await dir.close() } catch (cause) { if (!failed) throw unsafeFilesystem('Unable to close directory enumeration.', { cause }) } }
    return entries.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)
  }
  async validate(snapshot: EntrySnapshot, signal?: AbortSignal): Promise<boolean> {
    const root = this.operationRoot ?? this
    const result = await root.directory(snapshot.segments.slice(0, -1), { signal }, async parent => {
      const current = await parent.inspect(snapshot.name, signal)
      return current !== null && sameFileSnapshot(snapshot.stat, current)
    })
    return result === true
  }
  async createDirectory(name: string, signal?: AbortSignal): Promise<{ created: boolean; identity: DirectoryIdentity }> {
    // Read-only filesystems may reject mkdir even when its target already exists.
    // Verify existing directories through the same nofollow descriptor walk first.
    const existing = await this.directory([name], { signal }, directory => directory.identity())
    if (existing) return { created: false, identity: existing }
    let created = true
    await checked(signal, async () => { try { await mkdir(this.child(name)) } catch (cause) { if (code(cause) !== 'EEXIST') throw unsafeFilesystem('The wiki filesystem operation failed.', { cause }); created = false } })
    const identity = await this.directory([name], { signal }, directory => directory.identity())
    if (!identity) throw unsafeFilesystem('Created wiki directory disappeared.')
    return { created, identity }
  }
  async createFileExclusive(name: string, bytes: Uint8Array, options: { mode?: number; signal?: AbortSignal | undefined } = {}): Promise<void> {
    throwIfAborted(options.signal)
    let handle: FileHandle
    try { handle = await open(this.child(name), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, options.mode ?? 0o600) }
    catch (cause) {
      throwIfAborted(options.signal)
      if (code(cause) === 'EEXIST') {
        const existing = await this.read(name, options.signal)
        if (!existing) throw unsafeFilesystem('Existing schema disappeared during initialization.')
      }
      throw cause
    }
    let identity: DirectoryIdentity | undefined
    try {
      await closeScope(handle, async () => {
        identity = await handle.stat({ bigint: true })
        throwIfAborted(options.signal)
        await checked(options.signal, () => handle.writeFile(bytes))
        await checked(options.signal, () => syncFile(handle))
      })
    } catch (cause) { if (identity) { try { await this.unlink(name, identity) } catch {} } throw cause }
  }
  atomicWrite(name: string, bytes: Uint8Array, options: AtomicWriteOptions = {}): Promise<void> { return atomicWriteFile(this, name, bytes, options) }
  async unlink(name: string, expectedIdentity?: DirectoryIdentity): Promise<void> {
    if (expectedIdentity) { const stat = await this.inspect(name); if (!stat || !sameIdentity(stat, expectedIdentity)) return }
    await unlink(this.child(name))
  }
  async removeCreatedSource(name: string, expectedIdentity: DirectoryIdentity, ownedNames: readonly string[]): Promise<void> {
    await this.directory([name], {}, async directory => {
      if (!sameIdentity(await directory.identity(), expectedIdentity)) return
      for (const child of ownedNames) { try { await directory.unlink(child) } catch {} }
    })
    const stat = await this.inspect(name)
    if (stat?.isDirectory() && sameIdentity(stat, expectedIdentity)) await rmdir(this.child(name))
  }
}
export async function withWikiRoot<T>(authority: WikiAuthority, options: { create?: boolean; signal?: AbortSignal | undefined }, callback: (root: WikiDirectory) => Promise<T>): Promise<T | null> {
  const flags = directoryFlags()
  throwIfAborted(options.signal)
  let handle: FileHandle
  try { handle = await open('/', flags) } catch (cause) { throw unsafeFilesystem('Unable to acquire filesystem authority.', { cause }) }
  const publication = { committed: false }
  let failed = false
  try {
    throwIfAborted(options.signal)
    const aliasStat = await lstat(`/proc/self/fd/${handle.fd}/.`, { bigint: true }).catch(cause => { throw unsafeFilesystem('Usable Linux procfs is required.', { cause }) })
    const stat = await checked(options.signal, () => handle.stat({ bigint: true }))
    if (!stat.isDirectory() || !sameIdentity(stat, aliasStat)) throw unsafeFilesystem('Descriptor alias capability is unavailable.')
    const enumeration = await opendir(`/proc/self/fd/${handle.fd}`).catch(cause => { throw unsafeFilesystem('Descriptor enumeration capability is unavailable.', { cause }) })
    await enumeration.close()
    throwIfAborted(options.signal)
    const segments = resolve(authority.root).split(sep).filter(Boolean)
    for (let index = 0; index < segments.length; index += 1) {
      const name = segments[index]!
      validateComponent(name)
      const parent = new WikiDirectory(handle, segments.slice(0, index))
      let next: FileHandle
      try {
        try { next = await open(`/proc/self/fd/${handle.fd}/${name}`, flags) }
        catch (cause) {
          if (code(cause) !== 'ENOENT' || !options.create || authority.identity) throw cause
          await checked(options.signal, async () => {
            try { await mkdir(`/proc/self/fd/${handle.fd}/${name}`) }
            catch (error) { if (code(error) !== 'EEXIST') throw unsafeFilesystem('Unable to create the configured wiki root.', { cause: error }) }
          })
          next = await open(`/proc/self/fd/${handle.fd}/${name}`, flags)
        }
      } catch (cause) {
        throwIfAborted(options.signal)
        if (cause instanceof LlmWikiError) throw cause
        if (code(cause) === 'ENOENT') {
          if (authority.identity) throw unsafeFilesystem('Initialized wiki root is missing.', { cause })
          if (!options.create) return null
        }
        let entryKind: 'symlink' | 'not-directory' | 'unknown' = 'unknown'
        if (code(cause) === 'ELOOP' || code(cause) === 'ENOTDIR') {
          const entry = await parent.inspect(name, options.signal)
          if (entry?.isSymbolicLink()) entryKind = 'symlink'
          else if (entry && !entry.isDirectory()) entryKind = 'not-directory'
        }
        throw new WikiTraversalError(segments.slice(0, index + 1), entryKind, cause)
      }
      const previous = handle
      handle = next
      // No alias syscall is outstanding; the new directory now owns the walk.
      await previous.close()
      throwIfAborted(options.signal)
      const current = await checked(options.signal, () => handle.stat({ bigint: true }))
      if (!current.isDirectory()) throw unsafeFilesystem('Wiki root component is not a directory.')
    }
    const root = new WikiDirectory(handle, [], undefined, publication)
    if (authority.identity && !sameIdentity(authority.identity, await root.identity())) throw unsafeFilesystem('Initialized wiki root was replaced.')
    throwIfAborted(options.signal)
    return await callback(root)
  } catch (cause) { failed = true; throw cause }
  finally {
    try { await handle.close() }
    catch (cause) { if (!failed && !publication.committed) throw unsafeFilesystem('Unable to close wiki descriptor.', { cause }) }
  }
}
export function wikiRelativeSegments(paths: WikiPaths, target: string): readonly string[] {
  const value = relative(paths.root, resolve(target))
  if (value === '..' || value.startsWith(`..${sep}`) || isAbsolute(value)) throw unsafeFilesystem('Derived path escapes the wiki root.')
  const segments = value ? value.split(sep) : []
  segments.forEach(validateComponent)
  return segments
}
export function assertContainedWikiPath(root: string, target: string): void {
  if (!wikiRelativeSegments(createWikiPaths(resolve(root)), target).length) throw unsafeFilesystem('Derived path escapes the wiki root.')
}
export function createWikiPaths(root: string, authority?: WikiAuthority): WikiPaths {
  if (!isAbsolute(root) || root.includes('\0')) throw new LlmWikiError('INVALID_PATH', 'Wiki root must be an absolute filesystem path.')
  root = resolve(root)
  const sources = join(root, 'sources'), pages = join(root, 'pages'), index = join(root, '.index')
  const derive = (target: string): string => {
    const value = relative(root, target)
    if (!value || value === '..' || value.startsWith(`..${sep}`) || isAbsolute(value) || target.includes('\0')) throw unsafeFilesystem('Derived path escapes the wiki root.')
    return target
  }
  return Object.freeze({ root, authority: authority ?? { root }, sources, pages, index, schema: join(root, 'schema.md'),
    sourceDirectory: (id: SourceId) => derive(join(sources, id)), sourceContent: (id: SourceId) => derive(join(sources, id, 'content')),
    sourceMetadata: (id: SourceId) => derive(join(sources, id, 'metadata.json')), page: (id: PageId) => derive(join(pages, `${id}.md`)),
    indexFile: (name: 'search.json' | 'state.json') => derive(join(index, name)) })
}
export async function acquireWikiPaths(configuredRoot: string, signal?: AbortSignal, cwd = process.cwd()): Promise<WikiPaths> {
  throwIfAborted(signal)
  if (!configuredRoot || configuredRoot.includes('\0')) throw new LlmWikiError('INVALID_PATH', 'Configured wiki root must be a non-empty filesystem path.')
  const paths = createWikiPaths(resolve(cwd, configuredRoot))
  await withWikiRoot(paths.authority, { signal }, () => Promise.resolve(undefined))
  return paths
}
export async function initializeWikiPaths(configuredRoot: string, signal?: AbortSignal, cwd = process.cwd()): Promise<WikiPaths> {
  const paths = await acquireWikiPaths(configuredRoot, signal, cwd)
  await withWikiRoot(paths.authority, { create: true, signal }, async root => {
    for (const name of ['sources', 'pages', '.index']) await root.directory([name], { create: true, signal }, () => Promise.resolve(undefined))
    const identity = await root.identity()
    throwIfAborted(signal)
    paths.authority.identity = identity
  })
  return paths
}
export async function ensureWikiDirectory(paths: WikiPaths, target: string, signal?: AbortSignal): Promise<void> {
  await withWikiRoot(paths.authority, { signal }, async root => { await root.directory(wikiRelativeSegments(paths, target), { create: true, signal }, () => Promise.resolve(undefined)) })
}
