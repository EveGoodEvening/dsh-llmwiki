import { createHash } from 'node:crypto'
import type { BigIntStats } from 'node:fs'
import { join, resolve } from 'node:path'
import { Service } from '@deepseek-ai/cordis'
import type { Context } from '@deepseek-ai/cordis'
import { Config as ConfigSchema, resolveConfig } from './config.ts'
import type { Config, ResolvedConfig } from './config.ts'
import { atomicWriteFile, isAtomicTemporaryName } from './atomic.ts'
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
import { allSettledOnFailure, createWikiPaths, sameFileSnapshot, withWikiRoot, wikiRelativeSegments } from './paths.ts'
import type { FileSnapshot, WikiPaths, WikiDirectory } from './paths.ts'
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
// Workflow-guidance attribution and license: ../THIRD_PARTY_NOTICES.md.
const DEFAULT_SCHEMA = `# LLM Wiki Schema

This schema is human-owned organization and workflow guidance. The plugin creates it only when absent, exposes it through status, and never rewrites it; system and user instructions take precedence. There is no schema mutation API; schema evolution remains intentionally unresolved pending authorization/confirmation, visible audit evidence, and optimistic-concurrency/lost-update product decisions.

Pages are durable source-linked Markdown notes. Keep titles and summaries concise, organize related claims under headings, maintain useful page links, preserve material disagreements and dated supersessions, and cite every relevant existing immutable source ID in frontmatter. Source citation proves record existence, not claim-level support.

Evidence maintenance: call llmwiki_status first and read schemaText when non-null. On a fresh root, status returns schemaText null without creating storage; supplied material alone is not authorization to preserve it. Only with explicit authorization to preserve the source, call llmwiki_add_source to initialize storage, then call status again and read the schema before classification or page maintenance. List sources and pages, then search and read relevant records before writing. Only with explicit authorization to preserve candidate material, add it if the fresh-root branch did not, then classify its effect as new, update, contradiction, or no material change. Separately, only when the user request authorizes maintenance, update every materially affected page, preserve disagreements and links, and cite existing source IDs. Run llmwiki_lint unconditionally before any semantic-review pass, including read-only, no-write, and no-material-change cases; it is structural only and never repairs artifacts or makes semantic judgments. After any authorized durable updates, rerun structural lint.

Page writes require expectedSha256: null for a new page, or the exact current raw-byte sha256 from llmwiki_read_page or llmwiki_list_pages for an update. On PAGE_CONFLICT, reread the winning page and reconcile before any further authorized write; never automatically retry or overwrite blindly. This concurrency protection is limited to one service activation, not cross-process writers.

Semantic review (separate from structural lint): only after the unconditional structural lint, list pages and sources. Select and state the review scope, compare dated and qualified claims across every scoped page, every source it cites, and every new candidate source relevant to that scope, and report classified contradiction, superseded, unsupported, and missing-link findings with visible page and source IDs. These semantic findings are agent judgments, never llmwiki_lint diagnostics. Only when the user request authorizes maintenance, update affected pages while preserving disagreements or dated supersessions and maintain links; after any such durable updates, rerun structural lint.
`
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

interface OperationPaths extends WikiPaths {
  readonly rootDirectory: WikiDirectory | null
}

interface CatalogEntry {
  readonly name: string
  isFile(): boolean
  isDirectory(): boolean
  isSymbolicLink(): boolean
}

function unsafe(): never {
  throw new LlmWikiError('UNSAFE_FILESYSTEM', 'The wiki filesystem changed or contains an unsafe entry.')
}

async function inDirectory<T>(paths: OperationPaths, path: string, signal: AbortSignal | undefined, work: (directory: WikiDirectory) => Promise<T>): Promise<T | null> {
  if (paths.rootDirectory === null) return null
  return paths.rootDirectory.directory(wikiRelativeSegments(paths, path), { signal }, work)
}

async function inspectPath(paths: OperationPaths, path: string, signal?: AbortSignal): Promise<BigIntStats | null> {
  const segments = wikiRelativeSegments(paths, path)
  const name = segments.at(-1)!
  return inDirectory(paths, join(paths.root, ...segments.slice(0, -1)), signal, directory => directory.inspect(name, signal))
}

async function readBytes(paths: OperationPaths, path: string, signal?: AbortSignal): Promise<Uint8Array | null> {
  const segments = wikiRelativeSegments(paths, path)
  return inDirectory(paths, join(paths.root, ...segments.slice(0, -1)), signal, async directory => (await directory.read(segments.at(-1)!, signal))?.bytes ?? null)
}

interface StableCatalogFile {
  readonly path: string
  readonly logicalPath: string
  readonly snapshot: StableCatalogSnapshot
}

async function collectCatalogPageFiles(directory: string, paths: OperationPaths, output: StableCatalogFile[], snapshots: StableCatalogSnapshot[], signal?: AbortSignal): Promise<void> {
  const pending = [{ path: directory, logicalPath: '' }]
  while (pending.length > 0) {
    throwIfAborted(signal)
    const current = pending.pop()!
    const read = await readSafeCatalogDirectory(current.path, paths, signal)
    snapshots.push(read.snapshot)
    for (const entry of read.entries) {
      const logicalPath = current.logicalPath === '' ? entry.name : `${current.logicalPath}/${entry.name}`
      const child = join(current.path, entry.name)
      if (entry.isSymbolicLink()) unsafe()
      if (entry.isDirectory()) pending.push({ path: child, logicalPath })
      else if (entry.isFile()) {
        const snapshot = await snapshotSafeCatalogFile(child, paths, signal)
        snapshots.push(snapshot)
        output.push({ path: child, logicalPath, snapshot })
      } else unsafe()
    }
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

async function revalidateCatalogSnapshot(snapshot: StableCatalogSnapshot, paths: OperationPaths, signal?: AbortSignal): Promise<void> {
  try {
    const current = snapshot.kind === 'file'
      ? await snapshotSafeCatalogFile(snapshot.path, paths, signal)
      : (await readSafeCatalogDirectory(snapshot.path, paths, signal)).snapshot
    if (!sameStableSnapshot(snapshot.stats, current.stats)) unsafe()
    if (snapshot.children !== undefined && (current.children?.length !== snapshot.children.length || current.children.some((child, index) => child !== snapshot.children![index]))) unsafe()
  } catch (cause) {
    throwIfAborted(signal)
    if (cause instanceof LlmWikiError) throw cause
    throw new LlmWikiError('UNSAFE_FILESYSTEM', 'Unable to revalidate the catalog safely.', { cause })
  }
}

async function readSafeCatalogDirectory(path: string, paths: OperationPaths, signal?: AbortSignal): Promise<{ entries: CatalogEntry[]; snapshot: StableCatalogSnapshot }> {
  const before = await inspectPath(paths, path, signal)
  if (before === null || !before.isDirectory() || before.isSymbolicLink()) unsafe()
  const listed = await inDirectory(paths, path, signal, directory => directory.list(signal))
  if (listed === null) unsafe()
  const final = await inspectPath(paths, path, signal)
  if (final === null || !sameStableSnapshot(before, final)) unsafe()
  const entries = listed.map(entry => ({ name: entry.name, isFile: () => entry.stat.isFile(), isDirectory: () => entry.stat.isDirectory(), isSymbolicLink: () => entry.stat.isSymbolicLink() }))
  const children = entries.map(entry => `${entry.name}\0${entry.isFile() ? 'file' : entry.isDirectory() ? 'directory' : entry.isSymbolicLink() ? 'symlink' : 'other'}`).sort(compareCodeUnits)
  return { entries, snapshot: { path, stats: final, kind: 'directory', children } }
}

async function snapshotSafeCatalogFile(path: string, paths: OperationPaths, signal?: AbortSignal): Promise<StableCatalogSnapshot> {
  const stats = await inspectPath(paths, path, signal)
  if (stats === null || !stats.isFile() || stats.isSymbolicLink()) unsafe()
  return { path, stats, kind: 'file' }
}

async function readSafeCatalogFile(path: string, paths: OperationPaths, signal?: AbortSignal): Promise<{ bytes: Uint8Array; snapshot: StableCatalogSnapshot }> {
  const segments = wikiRelativeSegments(paths, path)
  const read = await inDirectory(paths, join(paths.root, ...segments.slice(0, -1)), signal, directory => directory.read(segments.at(-1)!, signal))
  if (read === null) throw Object.assign(new Error('Wiki file is missing.'), { code: 'ENOENT' })
  return { bytes: read.bytes, snapshot: { path, stats: read.snapshot.stat, kind: 'file' } }
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

async function regularFile(path: string, paths: OperationPaths, signal?: AbortSignal): Promise<boolean> {
  const stat = await inspectPath(paths, path, signal)
  if (stat === null) return false
  if (!stat.isFile() || stat.isSymbolicLink()) unsafe()
  return true
}

async function regularDirectory(path: string, paths: OperationPaths, signal?: AbortSignal): Promise<boolean> {
  const stat = await inspectPath(paths, path, signal)
  if (stat === null) return false
  if (!stat.isDirectory() || stat.isSymbolicLink()) unsafe()
  return true
}

function wikiRootPresent(paths: OperationPaths, signal?: AbortSignal): boolean {
  throwIfAborted(signal)
  return paths.rootDirectory !== null
}

async function countFiles(directory: string, suffix: string | undefined, paths: OperationPaths, signal?: AbortSignal): Promise<number> {
  let total = 0
  const pending = [directory]
  while (pending.length > 0) {
    const current = pending.pop()!
    const entries = await inDirectory(paths, current, signal, capability => capability.list(signal))
    if (entries === null) unsafe()
    for (const entry of entries) {
      throwIfAborted(signal)
      if (entry.stat.isSymbolicLink()) unsafe()
      if (entry.stat.isDirectory()) {
        if (suffix !== undefined && entry.name.endsWith(suffix)) unsafe()
        pending.push(join(current, entry.name))
      } else if (!entry.stat.isFile()) unsafe()
      else if (suffix === undefined || entry.name.endsWith(suffix)) total += 1
    }
  }
  return total
}

async function countSources(paths: OperationPaths, signal?: AbortSignal): Promise<number> {
  const entries = await inDirectory(paths, paths.sources, signal, directory => directory.list(signal))
  if (entries === null) unsafe()
  let total = 0
  for (const entry of entries) {
    if (entry.stat.isSymbolicLink() || !entry.stat.isDirectory()) unsafe()
    const directory = join(paths.sources, entry.name)
    await countFiles(directory, undefined, paths, signal)
    if (HASH.test(entry.name)) {
      if (!await regularFile(join(directory, 'content'), paths, signal) || !await regularFile(join(directory, 'metadata.json'), paths, signal)) unsafe()
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

  private enqueue<T>(work: (paths: OperationPaths) => Promise<T>, signal?: AbortSignal, initialize = true): Promise<T> {
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
        const paths = this.pathsValue ?? createWikiPaths(this[configKey].root)
        let ran = false
        const pinned = await withWikiRoot(paths.authority, { create: initialize, signal }, async rootDirectory => {
          ran = true
          const operationPaths = { ...paths, rootDirectory }
          if (initialize) await this.initialize(operationPaths, signal)
          throwIfAborted(signal)
          return work(operationPaths)
        })
        const value = ran ? pinned as T : await work({ ...paths, rootDirectory: null })
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

  private async initialize(paths: OperationPaths, signal?: AbortSignal): Promise<void> {
    if (this.pathsValue !== undefined) return
    const root = paths.rootDirectory!
    for (const name of ['sources', 'pages', '.index']) {
      if (await root.directory([name], { create: true, signal }, () => Promise.resolve(true)) === null) unsafe()
    }
    if (!await regularFile(paths.schema, paths, signal)) {
      try {
        await root.createFileExclusive('schema.md', encodeUtf8(DEFAULT_SCHEMA), { mode: 0o600, signal })
      } catch (cause) {
        throwIfAborted(signal)
        if ((cause as NodeJS.ErrnoException).code !== 'EEXIST') throw cause
      }
    }
    if (await root.read('schema.md', signal) === null) unsafe()
    paths.authority.identity = await root.identity()
    this.pathsValue = createWikiPaths(paths.root, paths.authority)
  }
  async status(signal?: AbortSignal): Promise<WikiStatus> {
    return this.enqueue(async paths => {
      if (!wikiRootPresent(paths, signal)) {
        return { initialized: false, sourceCount: 0, pageCount: 0, schemaText: null, index: EMPTY_INDEX_STATUS }
      }
      const [schemaPresent, sourcesPresent, pagesPresent, indexPresent] = await allSettledOnFailure([
        regularFile(paths.schema, paths, signal),
        regularDirectory(paths.sources, paths, signal),
        regularDirectory(paths.pages, paths, signal),
        regularDirectory(paths.index, paths, signal),
      ])
      const [schemaBytes, sourceCount, pageCount, index] = await allSettledOnFailure([
        schemaPresent ? readBytes(paths, paths.schema, signal) : null,
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
    }, signal, false)
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
      const result = await paths.rootDirectory!.directory(['sources'], { signal }, async sources => {
        const allocation = await sources.createDirectory(id, signal)
        try {
          const result = await sources.directory([id], { signal }, async directory => {
            const identity = await directory.identity()
            if (identity.dev !== allocation.identity.dev || identity.ino !== allocation.identity.ino) unsafe()
            const children = await directory.list(signal)
            if (children.some(child => child.name === 'metadata.json')) {
              const existing = await this.readSourceRecord(paths, id, signal)
              if (children.length !== 2 || children[0]?.name !== 'content' || children[1]?.name !== 'metadata.json') unsafe()
              for (const child of children) {
                if (!child.stat.isFile() || !await directory.validate(child, signal)) unsafe()
              }
              for (const snapshot of existing.snapshots) await revalidateCatalogSnapshot(snapshot, paths, signal)
              throwIfAborted(signal)
              return { id, deduplicated: true, metadata: existing.metadata }
            }
            // Inspect the entire candidate before deleting even one recognized temp.
            let contentPresent = false
            for (const child of children) {
              if (!child.stat.isFile() || (child.name !== 'content' && !isAtomicTemporaryName(child.name, 'content') && !isAtomicTemporaryName(child.name, 'metadata.json'))) unsafe()
              if (child.name === 'content') {
                if (child.stat.size !== BigInt(content.byteLength)) throw new LlmWikiError('INVALID_PAGE', 'Source record content does not match its immutable identity.')
                const read = await directory.read(child.name, signal)
                if (!read || !sameFileSnapshot(child.stat, read.snapshot.stat)) unsafe()
                if (hash(read.bytes) !== id || !read.bytes.equals(content)) throw new LlmWikiError('INVALID_PAGE', 'Source record content does not match its immutable identity.')
                contentPresent = true
              }
            }
            const currentChildren = await directory.list(signal)
            if (currentChildren.length !== children.length || currentChildren.some((child, index) => {
              const previous = children[index]
              return child.name !== previous?.name || !sameFileSnapshot(child.stat, previous.stat)
            })) unsafe()
            for (const child of children) if (!await directory.validate(child, signal)) unsafe()
            throwIfAborted(signal)
            for (const child of children) {
              if (child.name !== 'content') {
                throwIfAborted(signal)
                await directory.unlink(child.name, child.stat)
              }
            }
            const metadata: SourceMetadata = {
              id, name: input.name, mediaType, byteCount: content.byteLength,
              capturedAt: new Date().toISOString(),
              ...(input.origin === undefined ? {} : { origin: input.origin }),
            }
            let ownedContent: FileSnapshot | undefined
            try {
              if (!contentPresent) {
                await atomicWriteFile(directory, 'content', content, { signal })
                const written = await directory.read('content', signal)
                if (!written?.bytes.equals(content)) unsafe()
                ownedContent = written.snapshot
              }
              throwIfAborted(signal)
              // Publication is metadata-last. After its atomic commit, return the receipt
              // without an abort-sensitive read or deleting already published bytes.
              await atomicWriteFile(directory, 'metadata.json', canonicalJson(metadata), { signal })
              return { id, deduplicated: false, metadata }
            } catch (cause) {
              if (ownedContent) await directory.unlink('content', ownedContent.stat).catch(() => undefined)
              throw cause
            }
          })
          if (result === null) unsafe()
          return result
        } catch (cause) {
          // Only a newly allocated, still-empty directory belongs to this attempt.
          // Durable content left by an interrupted attempt is a future retry candidate.
          if (allocation.created) await sources.removeCreatedSource(id, allocation.identity, []).catch(() => undefined)
          throw cause
        }
      })
      if (result === null) unsafe()
      return result
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
      if (!wikiRootPresent(paths, signal) || !await regularDirectory(paths.sources, paths, signal)) return { items: [], nextCursor: null }
      const items: SourceCatalogEntry[] = []
      const snapshots: StableCatalogSnapshot[] = []
      let hasMore = false
      const root = await readSafeCatalogDirectory(paths.sources, paths, signal)
      throwIfAborted(signal)
      snapshots.push(root.snapshot)
      const discovered = root.entries.sort((a, b) => compareCodeUnits(a.name, b.name))
      for (const entry of discovered) {
        throwIfAborted(signal)
        if (entry.isSymbolicLink()) throw new LlmWikiError('UNSAFE_FILESYSTEM', 'Symbolic links are not allowed in the wiki.')
        if (!entry.isDirectory()) throw new LlmWikiError('UNSAFE_FILESYSTEM', 'The sources tree may contain only regular source directories.')
        if (!isSourceId(entry.name)) throw catalogCorrupt('The source catalog contains an invalid record.')
        const id = sourceId(entry.name)
        const recordPath = join(paths.sources, entry.name)
        const recordDirectory = await readSafeCatalogDirectory(recordPath, paths, signal)
        throwIfAborted(signal)
        snapshots.push(recordDirectory.snapshot)
        const children = recordDirectory.entries.sort((a, b) => compareCodeUnits(a.name, b.name))
        for (const child of children) {
          throwIfAborted(signal)
          if (child.isSymbolicLink() || !child.isFile()) throw new LlmWikiError('UNSAFE_FILESYSTEM', 'Source records must contain only regular files.')
        }
        if (children.length !== 2 || children[0]?.name !== 'content' || children[1]?.name !== 'metadata.json') {
          throw catalogCorrupt('The source catalog contains an invalid record.')
        }
        const contentSnapshot = await snapshotSafeCatalogFile(join(recordPath, 'content'), paths, signal)
        throwIfAborted(signal)
        const metadataSnapshot = await snapshotSafeCatalogFile(join(recordPath, 'metadata.json'), paths, signal)
        throwIfAborted(signal)
        snapshots.push(contentSnapshot, metadataSnapshot)
        try {
          const record = await this.readSourceRecord(paths, id, signal)
          throwIfAborted(signal)
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
          if (!isMissing(cause) && typeof (cause as NodeJS.ErrnoException).code === 'string' && !(cause instanceof LlmWikiError)) throw cause
          await revalidateCatalogSnapshot(recordDirectory.snapshot, paths, signal)
          throwIfAborted(signal)
          await revalidateCatalogSnapshot(contentSnapshot, paths, signal)
          throwIfAborted(signal)
          await revalidateCatalogSnapshot(metadataSnapshot, paths, signal)
          throwIfAborted(signal)
          throw catalogCorrupt('The source catalog contains an invalid record.')
        }
      }
      for (const snapshot of snapshots) {
        throwIfAborted(signal)
        await revalidateCatalogSnapshot(snapshot, paths, signal)
        throwIfAborted(signal)
      }
      return finishCatalogPage('sources', items, hasMore)
    }, signal, false)
  }

  async listPages(request: CatalogRequest = {}, signal?: AbortSignal): Promise<PageCatalogPage> {
    throwIfAborted(signal)
    const limitValue = catalogLimit(request, this[configKey].maxResults)
    const after = decodeCursor(request.cursor, 'pages')
    return this.enqueue(async paths => {
      if (!wikiRootPresent(paths, signal) || !await regularDirectory(paths.pages, paths, signal)) return { items: [], nextCursor: null }
      const files: StableCatalogFile[] = []
      const snapshots: StableCatalogSnapshot[] = []
      await collectCatalogPageFiles(paths.pages, paths, files, snapshots, signal)
      throwIfAborted(signal)
      files.sort((left, right) => compareCodeUnits(left.logicalPath, right.logicalPath))
      const items: PageCatalogEntry[] = []
      let hasMore = false
      for (const file of files) {
        throwIfAborted(signal)
        const logical = file.logicalPath
        if (!logical.endsWith('.md') || !isPageId(logical.slice(0, -3))) {
          for (const snapshot of snapshots) {
            throwIfAborted(signal)
            await revalidateCatalogSnapshot(snapshot, paths, signal)
            throwIfAborted(signal)
          }
          throw catalogCorrupt('The page catalog contains an invalid record.')
        }
        try {
          const read = await readSafeCatalogFile(file.path, paths, signal)
          throwIfAborted(signal)
          if (!sameStableSnapshot(file.snapshot.stats, read.snapshot.stats)) {
            throw new LlmWikiError('UNSAFE_FILESYSTEM', 'The catalog changed while it was being read.')
          }
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
          if (!isMissing(cause) && typeof (cause as NodeJS.ErrnoException).code === 'string' && !(cause instanceof LlmWikiError)) throw cause
          await revalidateCatalogSnapshot(file.snapshot, paths, signal)
          throwIfAborted(signal)
          throw catalogCorrupt('The page catalog contains an invalid record.')
        }
      }
      for (const snapshot of snapshots) {
        throwIfAborted(signal)
        await revalidateCatalogSnapshot(snapshot, paths, signal)
        throwIfAborted(signal)
      }
      return finishCatalogPage('pages', items, hasMore)
    }, signal, false)
  }

  private async readSourceRecord(paths: OperationPaths, id: SourceId, signal?: AbortSignal): Promise<{ content: Uint8Array; metadata: SourceMetadata; snapshots: readonly StableCatalogSnapshot[] }> {
    try {
      const contentPath = paths.sourceContent(id)
      const metadataPath = paths.sourceMetadata(id)
      const contentPresent = await regularFile(contentPath, paths, signal)
      throwIfAborted(signal)
      const metadataPresent = await regularFile(metadataPath, paths, signal)
      throwIfAborted(signal)
      if (!contentPresent || !metadataPresent) throw missing('SOURCE_NOT_FOUND', 'Source was not found.')
      const metadataRead = await readSafeCatalogFile(metadataPath, paths, signal)
      throwIfAborted(signal)
      const metadata = parseMetadata(metadataRead.bytes, id)
      const contentRead = await readSafeCatalogFile(contentPath, paths, signal)
      throwIfAborted(signal)
      const snapshots = [metadataRead.snapshot, contentRead.snapshot] as const
      try {
        if (hash(contentRead.bytes) !== id || metadata.byteCount !== contentRead.bytes.byteLength) throw new LlmWikiError('INVALID_PAGE', 'Source record content does not match its immutable identity.')
        decodeUtf8(contentRead.bytes)
        return { content: contentRead.bytes, metadata, snapshots }
      } catch (cause) {
        for (const snapshot of snapshots) {
          throwIfAborted(signal)
          await revalidateCatalogSnapshot(snapshot, paths, signal)
          throwIfAborted(signal)
        }
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
        const bytes = await readBytes(paths, target, signal)
        if (bytes === null) throw missing('PAGE_NOT_FOUND', 'Page was not found.')
        throwIfAborted(signal)
        const markdown = decodeUtf8(bytes)
        return { id, markdown, metadata: parsePageMarkdown(markdown).metadata, sha256: hash(bytes) }
      } catch (cause) {
        throwIfAborted(signal)
        if (isMissing(cause)) throw missing('PAGE_NOT_FOUND', 'Page was not found.')
        throw cause
      }
    }, signal)
  }

  async upsertPage(input: UpsertPageInput, signal?: AbortSignal): Promise<PageReceipt> {
    if (this.disposed) return Promise.reject(new LlmWikiError('NOT_INITIALIZED', 'The llmwiki service has been disposed.'))
    throwIfAborted(signal)
    const expectedSha256 = input.expectedSha256
    if (expectedSha256 !== null && (typeof expectedSha256 !== 'string' || !HASH.test(expectedSha256))) {
      throw new LlmWikiError('INVALID_PRECONDITION', 'expectedSha256 must be null or a 64-character lowercase hexadecimal SHA-256 hash.')
    }
    pageId(input.id)
    return this.enqueue(async paths => {
      const markdown = renderPageMarkdown(input, input.body)
      const bytes = encodeUtf8(markdown)
      if (bytes.byteLength > this[configKey].maxPageBytes) throw limit('Page content exceeds maxPageBytes.')
      for (const id of input.sources) await this.readSourceRecord(paths, id, signal)
      const target = paths.page(input.id)
      const segments = wikiRelativeSegments(paths, target)
      const receipt = await paths.rootDirectory!.directory(segments.slice(0, -1), { create: expectedSha256 === null, signal }, async directory => {
        for (const id of input.sources) await this.readSourceRecord(paths, id, signal)
        const existing = await directory.read(segments.at(-1)!, signal)
        if (expectedSha256 === null ? existing !== null : existing === null || hash(existing.bytes) !== expectedSha256) {
          throw new LlmWikiError('PAGE_CONFLICT', 'Page does not match expectedSha256; reread and reconcile before writing.')
        }
        await atomicWriteFile(directory, segments.at(-1)!, bytes, { signal })
        return { id: input.id, created: existing === null, sha256: hash(bytes) }
      })
      if (receipt === null) {
        if (expectedSha256 !== null) throw new LlmWikiError('PAGE_CONFLICT', 'Page does not match expectedSha256; reread and reconcile before writing.')
        unsafe()
      }
      return receipt
    }, signal)
  }

  async lint(signal?: AbortSignal): Promise<LintReport> {
    return this.enqueue(paths => lintWiki(paths, signal, paths.rootDirectory), signal, false)
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
      const built = await buildSearchIndex(paths, signal, undefined, paths.rootDirectory!)
      await writeIndex(paths, built, signal, paths.rootDirectory!)
      return {
        pageCount: built.search.pageFingerprints.length,
        sectionCount: built.search.sections.length,
        formatVersion: built.search.formatVersion,
      }
    }, signal)
  }

  private async indexTargetPresence(paths: OperationPaths, signal?: AbortSignal): Promise<readonly [boolean, boolean]> {
    const [searchPresent, statePresent] = await allSettledOnFailure([
      regularFile(paths.indexFile('search.json'), paths, signal),
      regularFile(paths.indexFile('state.json'), paths, signal),
    ])
    return [searchPresent, statePresent]
  }

  private async ensureIndex(paths: OperationPaths, signal?: AbortSignal) {
    await countFiles(paths.pages, '.md', paths, signal)
    const expected = await buildSearchIndex(paths, signal, undefined, paths.rootDirectory!)
    const [searchPresent, statePresent] = await this.indexTargetPresence(paths, signal)
    if (searchPresent && statePresent) {
      try {
        const [searchBytes, stateBytes] = await allSettledOnFailure([readBytes(paths, paths.indexFile('search.json'), signal), readBytes(paths, paths.indexFile('state.json'), signal)])
        if (searchBytes === null || stateBytes === null) unsafe()
        const search = trustedSearchIndex(searchBytes, stateBytes, expected)
        await validateBuiltIndexSnapshot(paths, expected, signal, paths.rootDirectory!)
        if (search !== null) return search
      } catch (cause) {
        throwIfAborted(signal)
        if (!(cause instanceof LlmWikiError && cause.code === 'INDEX_CORRUPT') && !isMissing(cause)) throw cause
      }
    }
    await this.indexTargetPresence(paths, signal)
    await writeIndex(paths, expected, signal, paths.rootDirectory!)
    return expected.search
  }

  private async indexStatus(paths: OperationPaths, signal?: AbortSignal): Promise<IndexStatus> {
    const [searchPresent, statePresent] = await this.indexTargetPresence(paths, signal)
    if (!searchPresent && !statePresent) return EMPTY_INDEX_STATUS
    if (!searchPresent || !statePresent) return { present: true, fresh: false, formatVersion: null, sectionCount: 0 }
    try {
      const [searchBytes, stateBytes] = await allSettledOnFailure([
        readBytes(paths, paths.indexFile('search.json'), signal),
        readBytes(paths, paths.indexFile('state.json'), signal),
      ])
      if (searchBytes === null || stateBytes === null) unsafe()
      parseSearchIndex(searchBytes)
      parseIndexState(stateBytes)
      let expected: BuiltIndex
      try {
        expected = await buildSearchIndex(paths, signal, undefined, paths.rootDirectory!)
      } catch (cause) {
        throwIfAborted(signal)
        if (cause instanceof LlmWikiError && (cause.code === 'INVALID_PAGE' || cause.code === 'INVALID_PATH')) {
          return { present: true, fresh: false, formatVersion: INDEX_FORMAT_VERSION, sectionCount: 0 }
        }
        throw cause
      }
      const search = trustedSearchIndex(searchBytes, stateBytes, expected)
      await validateBuiltIndexSnapshot(paths, expected, signal, paths.rootDirectory!)
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
