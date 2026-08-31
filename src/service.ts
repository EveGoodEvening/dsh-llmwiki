import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import type { BigIntStats, Dirent } from 'node:fs'
import { lstat, mkdir, open, readFile, readdir, realpath, rm, unlink } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { Service } from '@deepseek-ai/cordis'
import type { Context } from '@deepseek-ai/cordis'
import { Config as ConfigSchema, resolveConfig } from './config.ts'
import type { Config, ResolvedConfig } from './config.ts'
import { atomicWriteFile } from './atomic.ts'
import { LlmWikiError, throwIfAborted } from './errors.ts'
import { isPageId, isSourceId, pageId, sourceId } from './ids.ts'
import type { PageId, SourceId } from './ids.ts'
import {
  buildSearchIndex,
  INDEX_FORMAT_VERSION,
  parseSearchIndex,
  parseIndexState,
  searchBuiltIndex,
  trustedSearchIndex,
  validateBuiltIndexSnapshot,
  writeIndex,
} from './indexer.ts'
import type { BuiltIndex } from './indexer.ts'
import { lintWiki } from './lint.ts'
import { decodeUtf8, encodeUtf8, parsePageMarkdown, renderPageMarkdown } from './markdown.ts'
import { acquireWikiPaths, initializeWikiPaths } from './paths.ts'
import type { WikiPaths } from './paths.ts'
import { tokenize } from './tokenizer.ts'
import type {
  AddSourceInput,
  ByteRange,
  CatalogRequest,
  IndexStatus,
  LintReport,
  PageCatalogEntry,
  PageCatalogPage,
  PageRead,
  PageReceipt,
  ReindexReceipt,
  SearchHit,
  SourceCatalogEntry,
  SourceCatalogPage,
  SourceMetadata,
  SourceRead,
  SourceReceipt,
  UpsertPageInput,
  WikiStatus,
} from './types.ts'
const DEFAULT_SCHEMA = `# LLM Wiki Schema\n\nPages are durable Markdown notes grounded in immutable source records. Keep titles and summaries concise, organize related facts under headings, and cite every supporting source ID in frontmatter.\n`
const HASH = /^[0-9a-f]{64}$/u
const NON_WHITESPACE = /\S/u
const INCOMPLETE_UTF8_RANGE = 'Source byte range contains no complete UTF-8 code point; increase the limit.'
const CURSOR_TEXT = /^[A-Za-z0-9_-]+$/u

type CatalogKind = 'sources' | 'pages'

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function catalogCorrupt(message: string): LlmWikiError {
  return new LlmWikiError('CATALOG_CORRUPT', message)
}

function invalidCursor(): never {
  throw new LlmWikiError('INVALID_CURSOR', 'Catalog cursor is invalid.')
}

function encodeCursor(kind: CatalogKind, after: string): string {
  return Buffer.from(JSON.stringify({ v: 1, kind, after }), 'utf8').toString('base64url')
}

function decodeCursor(cursor: string | undefined, kind: CatalogKind): string | undefined {
  if (cursor === undefined) return undefined
  if (!CURSOR_TEXT.test(cursor) || cursor.includes('=')) return invalidCursor()

  let text: string
  try {
    const bytes = Buffer.from(cursor, 'base64url')
    if (bytes.toString('base64url') !== cursor) return invalidCursor()
    text = decodeUtf8(bytes)
  } catch {
    return invalidCursor()
  }

  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return invalidCursor()
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return invalidCursor()

  const object = value as Record<string, unknown>
  if (object.v !== 1
    || object.kind !== kind
    || typeof object.after !== 'string'
    || (kind === 'sources' ? !isSourceId(object.after) : !isPageId(object.after))
    || JSON.stringify({ v: 1, kind, after: object.after }) !== text) return invalidCursor()
  return object.after
}

function catalogLimit(request: CatalogRequest, maximum: number): number {
  const value = request.limit ?? maximum
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) throw limit('Catalog limit is outside the configured range.')
  return value
}

function appendCatalogItem<T extends { readonly id: string }>(
  items: T[],
  id: string,
  after: string | undefined,
  limitValue: number,
  create: () => T,
): boolean {
  if (after !== undefined && compareCodeUnits(id, after) <= 0) return false
  if (items.length === limitValue) return true
  items.push(create())
  return false
}

function finishCatalogPage<T extends { readonly id: string }>(kind: CatalogKind, items: T[], hasMore: boolean): { items: T[]; nextCursor: string | null } {
  return { items, nextCursor: hasMore ? encodeCursor(kind, items[items.length - 1]!.id) : null }
}

async function collectCatalogPageFiles(directory: string, paths: WikiPaths, output: string[], signal?: AbortSignal): Promise<void> {
  await paths.assertSafe(directory, signal)
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    throwIfAborted(signal)
    const child = join(directory, entry.name)
    if (entry.isSymbolicLink()) throw new LlmWikiError('UNSAFE_FILESYSTEM', 'Symbolic links are not allowed in the wiki.')
    if (entry.isDirectory()) await collectCatalogPageFiles(child, paths, output, signal)
    else if (entry.isFile()) output.push(child)
    else throw new LlmWikiError('UNSAFE_FILESYSTEM', 'Wiki trees may contain only directories and regular files.')
  }
}
const EMPTY_INDEX_STATUS = Object.freeze({
  present: false,
  fresh: false,
  formatVersion: null,
  sectionCount: 0,
}) satisfies IndexStatus

function hash(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function canonicalJson(value: unknown): Uint8Array {
  return encodeUtf8(`${JSON.stringify(value, null, 2)}\n`)
}

interface StableCatalogSnapshot {
  readonly path: string
  readonly stats: BigIntStats
  readonly kind: 'directory' | 'file'
  readonly children?: readonly string[]
}

function sameStableSnapshot(before: BigIntStats, after: BigIntStats): boolean {
  return before.dev === after.dev
    && before.ino === after.ino
    && before.size === after.size
    && before.mtimeNs === after.mtimeNs
    && before.ctimeNs === after.ctimeNs
}

async function revalidateCatalogSnapshot(snapshot: StableCatalogSnapshot, paths: WikiPaths, signal?: AbortSignal): Promise<void> {
  try {
    await paths.assertSafe(snapshot.path, signal)
    const current = await lstat(snapshot.path, { bigint: true })
    throwIfAborted(signal)
    const correctType = snapshot.kind === 'file' ? current.isFile() : current.isDirectory()
    if (!correctType || !sameStableSnapshot(snapshot.stats, current)) {
      throw new LlmWikiError('UNSAFE_FILESYSTEM', 'The catalog changed while it was being read.')
    }
    if (snapshot.children !== undefined) {
      const children = (await readdir(snapshot.path, { withFileTypes: true }))
        .map(entry => `${entry.name}\0${entry.isFile() ? 'file' : entry.isDirectory() ? 'directory' : entry.isSymbolicLink() ? 'symlink' : 'other'}`)
        .sort(compareCodeUnits)
      if (children.length !== snapshot.children.length || children.some((child, index) => child !== snapshot.children?.[index])) {
        throw new LlmWikiError('UNSAFE_FILESYSTEM', 'Catalog membership changed while it was being read.')
      }
      const completed = await lstat(snapshot.path, { bigint: true })
      if (!completed.isDirectory() || !sameStableSnapshot(snapshot.stats, completed)) {
        throw new LlmWikiError('UNSAFE_FILESYSTEM', 'The catalog changed while it was being read.')
      }
    }
  } catch (cause) {
    throwIfAborted(signal)
    if (cause instanceof LlmWikiError) throw cause
    throw new LlmWikiError('UNSAFE_FILESYSTEM', 'Unable to revalidate the catalog safely.', { cause })
  }
}

async function readSafeCatalogDirectory(path: string, paths: WikiPaths, signal?: AbortSignal): Promise<{ entries: Dirent[]; snapshot: StableCatalogSnapshot }> {
  await paths.assertSafe(path, signal)
  try {
    const opened = await lstat(path, { bigint: true })
    if (!opened.isDirectory()) throw new LlmWikiError('UNSAFE_FILESYSTEM', 'Catalog directories must be regular directories.')
    const entries = await readdir(path, { withFileTypes: true })
    throwIfAborted(signal)
    const completed = await lstat(path, { bigint: true })
    if (!completed.isDirectory() || !sameStableSnapshot(opened, completed)) throw new LlmWikiError('UNSAFE_FILESYSTEM', 'A catalog directory changed while it was being read.')
    const children = entries
      .map(entry => `${entry.name}\0${entry.isFile() ? 'file' : entry.isDirectory() ? 'directory' : entry.isSymbolicLink() ? 'symlink' : 'other'}`)
      .sort(compareCodeUnits)
    return { entries, snapshot: { path, stats: completed, kind: 'directory', children } }
  } catch (cause) {
    throwIfAborted(signal)
    if (cause instanceof LlmWikiError) throw cause
    throw new LlmWikiError('UNSAFE_FILESYSTEM', 'Unable to read a catalog directory safely.', { cause })
  }
}

async function readSafeCatalogFile(path: string, paths: WikiPaths, signal?: AbortSignal): Promise<{ bytes: Uint8Array; snapshot: StableCatalogSnapshot }> {
  await paths.assertSafe(path, signal)
  throwIfAborted(signal)
  let handle
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
    const opened = await handle.stat({ bigint: true })
    if (!opened.isFile()) throw new LlmWikiError('UNSAFE_FILESYSTEM', 'Catalog files must be regular files.')
    const [canonical, current] = await Promise.all([realpath(path), lstat(path, { bigint: true })])
    throwIfAborted(signal)
    if (canonical !== path || current.isSymbolicLink() || !current.isFile() || !sameStableSnapshot(opened, current)) {
      throw new LlmWikiError('UNSAFE_FILESYSTEM', 'A catalog file changed while it was being opened.')
    }
    const bytes = await handle.readFile()
    throwIfAborted(signal)
    const completed = await handle.stat({ bigint: true })
    if (!sameStableSnapshot(opened, completed)) throw new LlmWikiError('UNSAFE_FILESYSTEM', 'A catalog file changed while it was being read.')
    const final = await lstat(path, { bigint: true })
    throwIfAborted(signal)
    if (final.isSymbolicLink() || !final.isFile() || !sameStableSnapshot(completed, final)) {
      throw new LlmWikiError('UNSAFE_FILESYSTEM', 'A catalog file changed while it was being read.')
    }
    return { bytes, snapshot: { path, stats: final, kind: 'file' } }
  } catch (cause) {
    throwIfAborted(signal)
    if (cause instanceof LlmWikiError) throw cause
    throw new LlmWikiError('UNSAFE_FILESYSTEM', 'Unable to read a catalog file safely.', { cause })
  } finally {
    await handle?.close().catch(() => undefined)
  }
}

function missing(code: 'SOURCE_NOT_FOUND' | 'PAGE_NOT_FOUND', message: string): LlmWikiError {
  return new LlmWikiError(code, message)
}

function limit(message: string): LlmWikiError {
  return new LlmWikiError('LIMIT_EXCEEDED', message)
}

function isMissing(cause: unknown): boolean {
  return (cause as NodeJS.ErrnoException).code === 'ENOENT'
}

function sanitizeFailure(cause: unknown): never {
  if (cause instanceof LlmWikiError) throw cause.cause === undefined ? cause : new LlmWikiError(cause.code, cause.message)
  if (typeof (cause as NodeJS.ErrnoException).code === 'string') {
    throw new LlmWikiError('UNSAFE_FILESYSTEM', 'The wiki filesystem operation failed.')
  }
  throw cause
}

function validateText(value: string, field: string): void {
  if (!NON_WHITESPACE.test(value)) throw new LlmWikiError('INVALID_PAGE', `${field} must not be empty.`)
}

function parseMetadata(bytes: Uint8Array, expectedId: SourceId): SourceMetadata {
  let value: unknown
  try { value = JSON.parse(decodeUtf8(bytes)) } catch (cause) {
    throw new LlmWikiError('INVALID_PAGE', 'Source metadata is malformed.', { cause })
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new LlmWikiError('INVALID_PAGE', 'Source metadata is malformed.')
  const object = value as Record<string, unknown>
  const keys = Object.keys(object)
  const expectedKeys = object.origin === undefined
    ? ['id', 'name', 'mediaType', 'byteCount', 'capturedAt']
    : ['id', 'name', 'mediaType', 'byteCount', 'capturedAt', 'origin']
  if (keys.length !== expectedKeys.length
    || keys.some((key, index) => key !== expectedKeys[index])
    || object.id !== expectedId
    || typeof object.name !== 'string' || !NON_WHITESPACE.test(object.name)
    || typeof object.mediaType !== 'string' || !NON_WHITESPACE.test(object.mediaType)
    || typeof object.byteCount !== 'number' || !Number.isSafeInteger(object.byteCount) || object.byteCount < 0
    || typeof object.capturedAt !== 'string' || Number.isNaN(Date.parse(object.capturedAt))
    || new Date(object.capturedAt).toISOString() !== object.capturedAt
    || (object.origin !== undefined && (typeof object.origin !== 'string' || !NON_WHITESPACE.test(object.origin)))
    || !Buffer.from(canonicalJson(object)).equals(Buffer.from(bytes))) {
    throw new LlmWikiError('INVALID_PAGE', 'Source metadata does not match its required schema.')
  }
  return object as unknown as SourceMetadata
}

function alignedRange(bytes: Uint8Array, offset: number, limitValue: number): { start: number; end: number } {
  let start = offset
  while (start < bytes.byteLength && (bytes[start]! & 0xc0) === 0x80) start += 1
  let end = Math.max(start, Math.min(bytes.byteLength, offset + limitValue))
  while (end > start && end < bytes.byteLength && (bytes[end]! & 0xc0) === 0x80) end -= 1
  return { start, end }
}

async function regularFile(path: string, paths: WikiPaths, signal?: AbortSignal): Promise<boolean> {
  await paths.assertSafe(path, signal)
  try {
    const stat = await lstat(path)
    throwIfAborted(signal)
    if (!stat.isFile() || stat.isSymbolicLink()) throw new LlmWikiError('UNSAFE_FILESYSTEM', 'A wiki file target is not a regular file.')
    return true
  } catch (cause) {
    throwIfAborted(signal)
    if (isMissing(cause)) return false
    throw cause
  }
}

async function regularDirectory(path: string, paths: WikiPaths, signal?: AbortSignal): Promise<boolean> {
  await paths.assertSafe(path, signal)
  try {
    const stat = await lstat(path)
    throwIfAborted(signal)
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new LlmWikiError('UNSAFE_FILESYSTEM', 'A wiki directory target is not a safe directory.')
    return true
  } catch (cause) {
    throwIfAborted(signal)
    if (isMissing(cause)) return false
    throw cause
  }
}

async function wikiRootPresent(paths: WikiPaths, signal?: AbortSignal): Promise<boolean> {
  throwIfAborted(signal)
  try {
    const stat = await lstat(paths.root)
    throwIfAborted(signal)
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new LlmWikiError('UNSAFE_FILESYSTEM', 'Wiki root must be a safe directory.')
    return true
  } catch (cause) {
    throwIfAborted(signal)
    if (isMissing(cause)) return false
    throw cause
  }
}

async function countFiles(directory: string, suffix: string | undefined, paths: WikiPaths, signal?: AbortSignal): Promise<number> {
  await paths.assertSafe(directory, signal)
  let total = 0
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    throwIfAborted(signal)
    const child = join(directory, entry.name)
    if (entry.isSymbolicLink()) throw new LlmWikiError('UNSAFE_FILESYSTEM', 'Symbolic links are not allowed in the wiki.')
    if (entry.isDirectory()) {
      if (suffix !== undefined && entry.name.endsWith(suffix)) throw new LlmWikiError('UNSAFE_FILESYSTEM', 'A wiki file target is not a regular file.')
      total += await countFiles(child, suffix, paths, signal)
    } else if (!entry.isFile()) throw new LlmWikiError('UNSAFE_FILESYSTEM', 'Wiki trees may contain only directories and regular files.')
    else if (suffix === undefined || entry.name.endsWith(suffix)) total += 1
  }
  return total
}

async function countSources(paths: WikiPaths, signal?: AbortSignal): Promise<number> {
  await paths.assertSafe(paths.sources, signal)
  let total = 0
  for (const entry of await readdir(paths.sources, { withFileTypes: true })) {
    throwIfAborted(signal)
    if (entry.isSymbolicLink() || !entry.isDirectory()) throw new LlmWikiError('UNSAFE_FILESYSTEM', 'The sources tree may contain only regular source directories.')
    const directory = join(paths.sources, entry.name)
    await countFiles(directory, undefined, paths, signal)
    if (HASH.test(entry.name)) {
      const requiredFiles = await Promise.all([
        regularFile(join(directory, 'content'), paths, signal),
        regularFile(join(directory, 'metadata.json'), paths, signal),
      ])
      if (requiredFiles.some(present => !present)) throw new LlmWikiError('UNSAFE_FILESYSTEM', 'A source record is missing a required regular file.')
      total += 1
    }
  }
  return total
}

const configKey: unique symbol = Symbol('llmwiki.config')

export class LlmWikiService extends Service {
  static Config = ConfigSchema

  private readonly [configKey]: ResolvedConfig
  private pathsValue: WikiPaths | undefined
  private queue: Promise<void> = Promise.resolve()
  private readonly queued = new Set<(error: LlmWikiError) => void>()
  private disposed = false

  constructor(ctx: Context, config: Config = {}) {
    super(ctx, 'llmwiki')
    const resolved = resolveConfig(config)
    this[configKey] = Object.freeze({ ...resolved, root: resolve(process.cwd(), resolved.root) })
    ctx.effect(() => () => {
      this.disposed = true
      const error = new LlmWikiError('NOT_INITIALIZED', 'The llmwiki service has been disposed.')
      for (const reject of this.queued) reject(error)
      this.queued.clear()
      return this.queue.catch(() => undefined)
    }, 'llmwiki.service')
  }

  private enqueue<T>(work: (paths: WikiPaths) => Promise<T>, signal?: AbortSignal, getPaths: (signal?: AbortSignal) => WikiPaths | Promise<WikiPaths> = operationSignal => this.initialize(operationSignal)): Promise<T> {
    if (this.disposed) return Promise.reject(new LlmWikiError('NOT_INITIALIZED', 'The llmwiki service has been disposed.'))
    let started = false
    let settled = false
    let cancelled = false
    let resolveResult!: (value: T) => void
    let rejectResult!: (error: unknown) => void
    const result = new Promise<T>((resolvePromise, rejectPromise) => {
      resolveResult = resolvePromise
      rejectResult = rejectPromise
    })
    void result.catch(() => undefined)
    const rejectQueued = (error: LlmWikiError): void => {
      if (started || settled) return
      cancelled = true
      settled = true
      rejectResult(error)
    }
    const onAbort = (): void => rejectQueued(new LlmWikiError('ABORTED', 'The operation was aborted.'))
    this.queued.add(rejectQueued)
    signal?.addEventListener('abort', onAbort, { once: true })
    if (signal?.aborted) onAbort()

    const scheduled = this.queue.then(async () => {
      started = true
      this.queued.delete(rejectQueued)
      if (cancelled) return
      try {
        if (this.disposed) throw new LlmWikiError('NOT_INITIALIZED', 'The llmwiki service has been disposed.')
        const paths = await getPaths(signal)
        throwIfAborted(signal)
        const value = await work(paths)
        if (!settled) {
          settled = true
          resolveResult(value)
        }
      } catch (cause) {
        if (!settled) {
          settled = true
          try { sanitizeFailure(cause) } catch (error) { rejectResult(error) }
        }
      } finally {
        signal?.removeEventListener('abort', onAbort)
      }
    })
    this.queue = scheduled.then(() => undefined, () => undefined)
    return result
  }

  private async initialize(signal?: AbortSignal): Promise<WikiPaths> {
    if (this.pathsValue !== undefined) return this.pathsValue
    const paths = await initializeWikiPaths(this[configKey].root, signal)
    await paths.assertSafe(paths.schema, signal)
    let created = false
    try {
      const handle = await open(paths.schema, 'wx', 0o600)
      created = true
      try {
        throwIfAborted(signal)
        await handle.writeFile(encodeUtf8(DEFAULT_SCHEMA))
        throwIfAborted(signal)
        await handle.sync()
      } finally {
        await handle.close()
      }
    } catch (cause) {
      if (created) await unlink(paths.schema).catch(() => undefined)
      throwIfAborted(signal)
      if ((cause as NodeJS.ErrnoException).code !== 'EEXIST') throw cause
    }
    if (!await regularFile(paths.schema, paths, signal)) throw new LlmWikiError('UNSAFE_FILESYSTEM', 'Wiki schema must be a regular file.')
    this.pathsValue = paths
    return paths
  }
  async status(signal?: AbortSignal): Promise<WikiStatus> {
    return this.enqueue(async paths => {
      if (!await wikiRootPresent(paths, signal)) {
        return { initialized: false, sourceCount: 0, pageCount: 0, schemaText: null, index: EMPTY_INDEX_STATUS }
      }
      const [schemaPresent, sourcesPresent, pagesPresent, indexPresent] = await Promise.all([
        regularFile(paths.schema, paths, signal),
        regularDirectory(paths.sources, paths, signal),
        regularDirectory(paths.pages, paths, signal),
        regularDirectory(paths.index, paths, signal),
      ])
      const [schemaBytes, sourceCount, pageCount, index] = await Promise.all([
        schemaPresent ? readFile(paths.schema) : null,
        sourcesPresent ? countSources(paths, signal) : 0,
        pagesPresent ? countFiles(paths.pages, '.md', paths, signal) : 0,
        indexPresent ? this.indexStatus(paths, signal) : EMPTY_INDEX_STATUS,
      ])
      throwIfAborted(signal)
      return {
        initialized: schemaPresent && sourcesPresent && pagesPresent && indexPresent,
        sourceCount,
        pageCount,
        schemaText: schemaBytes === null ? null : decodeUtf8(schemaBytes),
        index,
      }
    }, signal, operationSignal => acquireWikiPaths(this[configKey].root, operationSignal))
  }

  async addSource(input: AddSourceInput, signal?: AbortSignal): Promise<SourceReceipt> {
    if (this.disposed) return Promise.reject(new LlmWikiError('NOT_INITIALIZED', 'The llmwiki service has been disposed.'))
    throwIfAborted(signal)
    validateText(input.name, 'Source name')
    const mediaType = input.mediaType ?? 'text/plain; charset=utf-8'
    validateText(mediaType, 'Source media type')
    if (input.origin !== undefined) validateText(input.origin, 'Source origin')
    if (input.content.length === 0) throw new LlmWikiError('INVALID_PAGE', 'Source content must not be empty.')
    const content = encodeUtf8(input.content)
    if (content.byteLength > this[configKey].maxSourceBytes) throw limit('Source content exceeds maxSourceBytes.')
    const id = sourceId(hash(content))
    return this.enqueue(async paths => {
      const directory = paths.sourceDirectory(id)
      await paths.assertSafe(directory, signal)
      try {
        await mkdir(directory)
      } catch (cause) {
        throwIfAborted(signal)
        if ((cause as NodeJS.ErrnoException).code !== 'EEXIST') throw cause
        const existing = await this.readSourceRecord(paths, id, signal)
        return { id, deduplicated: true, metadata: existing.metadata }
      }
      try {
        const metadata: SourceMetadata = {
          id,
          name: input.name,
          mediaType,
          byteCount: content.byteLength,
          capturedAt: new Date().toISOString(),
          ...(input.origin === undefined ? {} : { origin: input.origin }),
        }
        const options = {
          ...(signal === undefined ? {} : { signal }),
          assertSafe: (path: string, optionSignal?: AbortSignal) => paths.assertSafe(path, optionSignal),
        }
        await atomicWriteFile(paths.sourceContent(id), content, options)
        throwIfAborted(signal)
        await atomicWriteFile(paths.sourceMetadata(id), canonicalJson(metadata), options)
        await Promise.all([
          regularFile(paths.sourceContent(id), paths, signal),
          regularFile(paths.sourceMetadata(id), paths, signal),
        ])
        return { id, deduplicated: false, metadata }
      } catch (cause) {
        await rm(directory, { recursive: true, force: true }).catch(() => undefined)
        throw cause
      }
    }, signal)
  }

  async readSource(id: SourceId, range?: ByteRange, signal?: AbortSignal): Promise<SourceRead> {
    sourceId(id)
    return this.enqueue(async paths => {
      const record = await this.readSourceRecord(paths, id, signal)
      const offset = range?.offset ?? 0
      const limitValue = range?.limit ?? this[configKey].maxSourceBytes
      if (!Number.isSafeInteger(offset) || offset < 0 || offset > record.content.byteLength) throw limit('Source byte offset is outside the source.')
      if (!Number.isSafeInteger(limitValue) || limitValue < 1 || limitValue > this[configKey].maxSourceBytes) throw limit('Source byte limit is outside the configured range.')
      const { start, end } = alignedRange(record.content, offset, limitValue)
      if (offset < record.content.byteLength && end === start) throw limit(INCOMPLETE_UTF8_RANGE)
      return { id, content: decodeUtf8(record.content.subarray(start, end)), metadata: record.metadata, byteStart: start, byteEnd: end, byteCount: record.content.byteLength }
    }, signal)
  }

  async listSources(request: CatalogRequest = {}, signal?: AbortSignal): Promise<SourceCatalogPage> {
    throwIfAborted(signal)
    const limitValue = catalogLimit(request, this[configKey].maxResults)
    const after = decodeCursor(request.cursor, 'sources')
    return this.enqueue(async paths => {
      if (!await wikiRootPresent(paths, signal) || !await regularDirectory(paths.sources, paths, signal)) return { items: [], nextCursor: null }
      const items: SourceCatalogEntry[] = []
      const snapshots: StableCatalogSnapshot[] = []
      let hasMore = false
      const sourceDirectory = await readSafeCatalogDirectory(paths.sources, paths, signal)
      snapshots.push(sourceDirectory.snapshot)
      const discovered = sourceDirectory.entries.sort((a, b) => compareCodeUnits(a.name, b.name))
      for (const entry of discovered) {
        throwIfAborted(signal)
        if (entry.isSymbolicLink()) throw new LlmWikiError('UNSAFE_FILESYSTEM', 'Symbolic links are not allowed in the wiki.')
        if (!entry.isDirectory()) throw new LlmWikiError('UNSAFE_FILESYSTEM', 'The sources tree may contain only regular source directories.')
        if (!isSourceId(entry.name)) {
          await revalidateCatalogSnapshot(sourceDirectory.snapshot, paths, signal)
          throw catalogCorrupt('The source catalog contains an invalid record.')
        }
        const recordDirectory = await readSafeCatalogDirectory(join(paths.sources, entry.name), paths, signal)
        snapshots.push(recordDirectory.snapshot)
        const children = recordDirectory.entries.sort((a, b) => compareCodeUnits(a.name, b.name))
        for (const child of children) {
          throwIfAborted(signal)
          if (child.isSymbolicLink() || !child.isFile()) throw new LlmWikiError('UNSAFE_FILESYSTEM', 'Source records must contain only regular files.')
        }
        if (children.length !== 2 || children[0]?.name !== 'content' || children[1]?.name !== 'metadata.json') {
          await revalidateCatalogSnapshot(recordDirectory.snapshot, paths, signal)
          throw catalogCorrupt('The source catalog contains an invalid record.')
        }
        try {
          const record = await this.readSourceRecord(paths, sourceId(entry.name), signal)
          snapshots.push(...record.snapshots)
          hasMore ||= appendCatalogItem(items, record.metadata.id, after, limitValue, () => ({
            id: record.metadata.id,
            name: record.metadata.name,
            mediaType: record.metadata.mediaType,
            byteCount: record.metadata.byteCount,
            capturedAt: record.metadata.capturedAt,
            ...(record.metadata.origin === undefined ? {} : { origin: record.metadata.origin }),
          }))
        } catch (cause) {
          if (cause instanceof LlmWikiError && (cause.code === 'ABORTED' || cause.code === 'UNSAFE_FILESYSTEM')) throw cause
          throw catalogCorrupt('The source catalog contains an invalid record.')
        }
      }
      for (const snapshot of snapshots) await revalidateCatalogSnapshot(snapshot, paths, signal)
      throwIfAborted(signal)
      return finishCatalogPage('sources', items, hasMore)
    }, signal, operationSignal => acquireWikiPaths(this[configKey].root, operationSignal))
  }

  async listPages(request: CatalogRequest = {}, signal?: AbortSignal): Promise<PageCatalogPage> {
    throwIfAborted(signal)
    const limitValue = catalogLimit(request, this[configKey].maxResults)
    const after = decodeCursor(request.cursor, 'pages')
    return this.enqueue(async paths => {
      if (!await wikiRootPresent(paths, signal) || !await regularDirectory(paths.pages, paths, signal)) return { items: [], nextCursor: null }
      const files: string[] = []
      await collectCatalogPageFiles(paths.pages, paths, files, signal)
      files.sort(compareCodeUnits)
      const items: PageCatalogEntry[] = []
      const snapshots: StableCatalogSnapshot[] = []
      let hasMore = false
      for (const path of files) {
        throwIfAborted(signal)
        const logical = path.slice(paths.pages.length + 1).split('\\').join('/')
        if (!logical.endsWith('.md') || !isPageId(logical.slice(0, -3))) {
          const currentFiles: string[] = []
          await collectCatalogPageFiles(paths.pages, paths, currentFiles, signal)
          currentFiles.sort(compareCodeUnits)
          if (currentFiles.length !== files.length || currentFiles.some((current, index) => current !== files[index])) {
            throw new LlmWikiError('UNSAFE_FILESYSTEM', 'Page catalog membership changed while it was being read.')
          }
          throw catalogCorrupt('The page catalog contains an invalid record.')
        }
        let fileSnapshot: StableCatalogSnapshot | undefined
        try {
          const read = await readSafeCatalogFile(path, paths, signal)
          fileSnapshot = read.snapshot
          snapshots.push(read.snapshot)
          const parsed = parsePageMarkdown(decodeUtf8(read.bytes))
          const id = pageId(logical.slice(0, -3))
          hasMore ||= appendCatalogItem(items, id, after, limitValue, () => ({
            id,
            title: parsed.metadata.title,
            summary: parsed.metadata.summary,
            sources: [...parsed.metadata.sources],
            byteCount: read.bytes.byteLength,
            sha256: hash(read.bytes),
          }))
        } catch (cause) {
          if (cause instanceof LlmWikiError && (cause.code === 'ABORTED' || cause.code === 'UNSAFE_FILESYSTEM')) throw cause
          if (fileSnapshot !== undefined) await revalidateCatalogSnapshot(fileSnapshot, paths, signal)
          throw catalogCorrupt('The page catalog contains an invalid record.')
        }
      }
      const currentFiles: string[] = []
      await collectCatalogPageFiles(paths.pages, paths, currentFiles, signal)
      currentFiles.sort(compareCodeUnits)
      if (currentFiles.length !== files.length || currentFiles.some((path, index) => path !== files[index])) {
        throw new LlmWikiError('UNSAFE_FILESYSTEM', 'Page catalog membership changed while it was being read.')
      }
      for (const snapshot of snapshots) await revalidateCatalogSnapshot(snapshot, paths, signal)
      throwIfAborted(signal)
      return finishCatalogPage('pages', items, hasMore)
    }, signal, operationSignal => acquireWikiPaths(this[configKey].root, operationSignal))
  }

  private async readSourceRecord(paths: WikiPaths, id: SourceId, signal?: AbortSignal): Promise<{ content: Uint8Array; metadata: SourceMetadata; snapshots: readonly StableCatalogSnapshot[] }> {
    try {
      const contentPath = paths.sourceContent(id)
      const metadataPath = paths.sourceMetadata(id)
      const present = await Promise.all([
        regularFile(contentPath, paths, signal),
        regularFile(metadataPath, paths, signal),
      ])
      if (present.some(value => !value)) throw missing('SOURCE_NOT_FOUND', 'Source was not found.')
      const [contentRead, metadataRead] = await Promise.all([
        readSafeCatalogFile(contentPath, paths, signal),
        readSafeCatalogFile(metadataPath, paths, signal),
      ])
      const snapshots = [contentRead.snapshot, metadataRead.snapshot] as const
      try {
        const metadata = parseMetadata(metadataRead.bytes, id)
        if (hash(contentRead.bytes) !== id || metadata.byteCount !== contentRead.bytes.byteLength) throw new LlmWikiError('INVALID_PAGE', 'Source record content does not match its immutable identity.')
        decodeUtf8(contentRead.bytes)
        return { content: contentRead.bytes, metadata, snapshots }
      } catch (cause) {
        for (const snapshot of snapshots) await revalidateCatalogSnapshot(snapshot, paths, signal)
        throw cause
      }
    } catch (cause) {
      throwIfAborted(signal)
      if (isMissing(cause)) throw missing('SOURCE_NOT_FOUND', 'Source was not found.')
      throw cause
    }
  }

  async readPage(id: PageId, signal?: AbortSignal): Promise<PageRead> {
    pageId(id)
    return this.enqueue(async paths => {
      try {
        const target = paths.page(id)
        if (!await regularFile(target, paths, signal)) throw missing('PAGE_NOT_FOUND', 'Page was not found.')
        const bytes = await readFile(target)
        throwIfAborted(signal)
        const markdown = decodeUtf8(bytes)
        return { id, markdown, metadata: parsePageMarkdown(markdown).metadata }
      } catch (cause) {
        throwIfAborted(signal)
        if (isMissing(cause)) throw missing('PAGE_NOT_FOUND', 'Page was not found.')
        throw cause
      }
    }, signal)
  }

  async upsertPage(input: UpsertPageInput, signal?: AbortSignal): Promise<PageReceipt> {
    pageId(input.id)
    return this.enqueue(async paths => {
      const markdown = renderPageMarkdown(input, input.body)
      const bytes = encodeUtf8(markdown)
      if (bytes.byteLength > this[configKey].maxPageBytes) throw limit('Page content exceeds maxPageBytes.')
      for (const id of input.sources) await this.readSourceRecord(paths, id, signal)
      const target = paths.page(input.id)
      await paths.assertSafe(target, signal)
      await mkdir(dirname(target), { recursive: true })
      await paths.assertSafe(target, signal)
      const created = !await regularFile(target, paths, signal)
      for (const id of input.sources) await this.readSourceRecord(paths, id, signal)
      await atomicWriteFile(target, bytes, {
        ...(signal === undefined ? {} : { signal }),
        assertSafe: (path, optionSignal) => paths.assertSafe(path, optionSignal),
      })
      return { id: input.id, created, sha256: hash(bytes) }
    }, signal)
  }

  async lint(signal?: AbortSignal): Promise<LintReport> {
    return this.enqueue(paths => lintWiki(paths, signal), signal, operationSignal => acquireWikiPaths(this[configKey].root, operationSignal))
  }

  async search(query: string, limitValue = this[configKey].maxResults, signal?: AbortSignal): Promise<SearchHit[]> {
    throwIfAborted(signal)
    if (!Number.isSafeInteger(limitValue)
      || limitValue < 1
      || !Number.isSafeInteger(this[configKey].maxResults)
      || this[configKey].maxResults < 1
      || !Number.isSafeInteger(this[configKey].maxSnippetBytes)
      || this[configKey].maxSnippetBytes < 1) throw limit('Search limits must be positive safe integers.')
    if (tokenize(query).length === 0) throw new LlmWikiError('INVALID_PAGE', 'Search query must contain at least one Unicode letter or number.')
    return this.enqueue(async paths => {
      const index = await this.ensureIndex(paths, signal)
      return [...searchBuiltIndex(index, query, {
        limit: limitValue,
        maxResults: this[configKey].maxResults,
        maxSnippetBytes: this[configKey].maxSnippetBytes,
        ...(signal === undefined ? {} : { signal }),
      })]
    }, signal)
  }

  async reindex(signal?: AbortSignal): Promise<ReindexReceipt> {
    return this.enqueue(async paths => {
      await countFiles(paths.pages, '.md', paths, signal)
      await this.indexTargetPresence(paths, signal)
      const built = await buildSearchIndex(paths, signal)
      await writeIndex(paths, built, signal)
      return {
        pageCount: built.search.pageFingerprints.length,
        sectionCount: built.search.sections.length,
        formatVersion: built.search.formatVersion,
      }
    }, signal)
  }

  private async indexTargetPresence(paths: WikiPaths, signal?: AbortSignal): Promise<readonly [boolean, boolean]> {
    const [searchPresent, statePresent] = await Promise.all([
      regularFile(paths.indexFile('search.json'), paths, signal),
      regularFile(paths.indexFile('state.json'), paths, signal),
    ])
    return [searchPresent, statePresent]
  }

  private async ensureIndex(paths: WikiPaths, signal?: AbortSignal) {
    await countFiles(paths.pages, '.md', paths, signal)
    const expected = await buildSearchIndex(paths, signal)
    const [searchPresent, statePresent] = await this.indexTargetPresence(paths, signal)
    if (searchPresent && statePresent) {
      try {
        const [searchBytes, stateBytes] = await Promise.all([readFile(paths.indexFile('search.json')), readFile(paths.indexFile('state.json'))])
        const search = trustedSearchIndex(searchBytes, stateBytes, expected)
        await validateBuiltIndexSnapshot(paths, expected, signal)
        if (search !== null) return search
      } catch (cause) {
        throwIfAborted(signal)
        if (!(cause instanceof LlmWikiError && cause.code === 'INDEX_CORRUPT') && !isMissing(cause)) throw cause
      }
    }
    await this.indexTargetPresence(paths, signal)
    await writeIndex(paths, expected, signal)
    return expected.search
  }

  private async indexStatus(paths: WikiPaths, signal?: AbortSignal): Promise<IndexStatus> {
    const [searchPresent, statePresent] = await this.indexTargetPresence(paths, signal)
    if (!searchPresent && !statePresent) return EMPTY_INDEX_STATUS
    if (!searchPresent || !statePresent) return { present: true, fresh: false, formatVersion: null, sectionCount: 0 }
    try {
      const [searchBytes, stateBytes] = await Promise.all([
        readFile(paths.indexFile('search.json')),
        readFile(paths.indexFile('state.json')),
      ])
      parseSearchIndex(searchBytes)
      parseIndexState(stateBytes)
      let expected: BuiltIndex
      try {
        expected = await buildSearchIndex(paths, signal)
      } catch (cause) {
        throwIfAborted(signal)
        if (cause instanceof LlmWikiError && (cause.code === 'INVALID_PAGE' || cause.code === 'INVALID_PATH')) {
          return { present: true, fresh: false, formatVersion: INDEX_FORMAT_VERSION, sectionCount: 0 }
        }
        throw cause
      }
      const search = trustedSearchIndex(searchBytes, stateBytes, expected)
      await validateBuiltIndexSnapshot(paths, expected, signal)
      return {
        present: true,
        fresh: search !== null,
        formatVersion: INDEX_FORMAT_VERSION,
        sectionCount: expected.search.sections.length,
      }
    } catch (cause) {
      throwIfAborted(signal)
      if (isMissing(cause) || (cause instanceof LlmWikiError && cause.code === 'INDEX_CORRUPT')) {
        return { present: true, fresh: false, formatVersion: null, sectionCount: 0 }
      }
      throw cause
    }
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    llmwiki: LlmWikiService
  }
}
