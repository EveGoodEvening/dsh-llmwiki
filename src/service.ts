import { createHash } from 'node:crypto'
import { lstat, mkdir, open, readFile, readdir, rm, unlink } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { Service } from '@deepseek-ai/cordis'
import type { Context } from '@deepseek-ai/cordis'
import { Config as ConfigSchema, resolveConfig } from './config.ts'
import type { Config, ResolvedConfig } from './config.ts'
import { atomicWriteFile } from './atomic.ts'
import { LlmWikiError, throwIfAborted } from './errors.ts'
import { pageId, sourceId } from './ids.ts'
import type { PageId, SourceId } from './ids.ts'
import {
  buildSearchIndex,
  fingerprintPages,
  INDEX_FORMAT_VERSION,
  parseIndexState,
  parseSearchIndex,
  searchBuiltIndex,
  writeIndex,
} from './indexer.ts'
import { lintWiki } from './lint.ts'
import { decodeUtf8, encodeUtf8, parsePageMarkdown, renderPageMarkdown } from './markdown.ts'
import { acquireWikiPaths, initializeWikiPaths } from './paths.ts'
import type { WikiPaths } from './paths.ts'
import { tokenize } from './tokenizer.ts'
import type {
  AddSourceInput,
  ByteRange,
  IndexStatus,
  LintReport,
  PageRead,
  PageReceipt,
  ReindexReceipt,
  SearchHit,
  SourceMetadata,
  SourceRead,
  SourceReceipt,
  UpsertPageInput,
  WikiStatus,
} from './types.ts'

const DEFAULT_SCHEMA = `# LLM Wiki Schema\n\nPages are durable Markdown notes grounded in immutable source records. Keep titles and summaries concise, organize related facts under headings, and cite every supporting source ID in frontmatter.\n`
const HASH = /^[0-9a-f]{64}$/u
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
  if (value.trim().length === 0) throw new LlmWikiError('INVALID_PAGE', `${field} must not be empty.`)
}

function parseMetadata(bytes: Uint8Array, expectedId: SourceId): SourceMetadata {
  let value: unknown
  try { value = JSON.parse(decodeUtf8(bytes)) } catch (cause) {
    throw new LlmWikiError('INVALID_PAGE', 'Source metadata is malformed.', { cause })
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new LlmWikiError('INVALID_PAGE', 'Source metadata is malformed.')
  const object = value as Record<string, unknown>
  const allowed = ['id', 'name', 'mediaType', 'byteCount', 'capturedAt', 'origin']
  if (Object.keys(object).some(key => !allowed.includes(key))
    || object.id !== expectedId
    || typeof object.name !== 'string' || object.name.trim().length === 0
    || typeof object.mediaType !== 'string' || object.mediaType.trim().length === 0
    || typeof object.byteCount !== 'number' || !Number.isSafeInteger(object.byteCount) || object.byteCount < 0
    || typeof object.capturedAt !== 'string' || Number.isNaN(Date.parse(object.capturedAt))
    || new Date(object.capturedAt).toISOString() !== object.capturedAt
    || (object.origin !== undefined && (typeof object.origin !== 'string' || object.origin.length === 0))) {
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
    if (signal?.aborted === true) onAbort()

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
    return this.enqueue(async paths => {
      validateText(input.name, 'Source name')
      const mediaType = input.mediaType ?? 'text/plain; charset=utf-8'
      validateText(mediaType, 'Source media type')
      if (input.origin?.length === 0) throw new LlmWikiError('INVALID_PAGE', 'Source origin must not be empty.')
      const content = encodeUtf8(input.content)
      if (content.byteLength > this[configKey].maxSourceBytes) throw limit('Source content exceeds maxSourceBytes.')
      const id = sourceId(hash(content))
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
      return { id, content: decodeUtf8(record.content.subarray(start, end)), metadata: record.metadata, byteStart: start, byteEnd: end, byteCount: record.content.byteLength }
    }, signal)
  }

  private async readSourceRecord(paths: WikiPaths, id: SourceId, signal?: AbortSignal): Promise<{ content: Uint8Array; metadata: SourceMetadata }> {
    try {
      const contentPath = paths.sourceContent(id)
      const metadataPath = paths.sourceMetadata(id)
      const present = await Promise.all([
        regularFile(contentPath, paths, signal),
        regularFile(metadataPath, paths, signal),
      ])
      if (present.some(value => !value)) throw missing('SOURCE_NOT_FOUND', 'Source was not found.')
      const [content, metadataBytes] = await Promise.all([readFile(contentPath), readFile(metadataPath)])
      throwIfAborted(signal)
      const metadata = parseMetadata(metadataBytes, id)
      if (hash(content) !== id || metadata.byteCount !== content.byteLength) throw new LlmWikiError('INVALID_PAGE', 'Source record content does not match its immutable identity.')
      decodeUtf8(content)
      return { content, metadata }
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
      for (const name of ['search.json', 'state.json'] as const) {
        await unlink(paths.indexFile(name)).catch(cause => {
          if (!isMissing(cause)) throw cause
        })
      }
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
    const fingerprints = await fingerprintPages(paths, signal)
    const [searchPresent, statePresent] = await this.indexTargetPresence(paths, signal)
    if (searchPresent && statePresent) {
      try {
        const [searchBytes, stateBytes] = await Promise.all([readFile(paths.indexFile('search.json')), readFile(paths.indexFile('state.json'))])
        const search = parseSearchIndex(searchBytes)
        const state = parseIndexState(stateBytes)
        if (state.searchSha256 === hash(searchBytes)
          && JSON.stringify(state.pages) === JSON.stringify(fingerprints)
          && JSON.stringify(search.pageFingerprints) === JSON.stringify(fingerprints)) return search
      } catch (cause) {
        throwIfAborted(signal)
        if (!(cause instanceof LlmWikiError && cause.code === 'INDEX_CORRUPT') && !isMissing(cause)) throw cause
      }
    }
    await this.indexTargetPresence(paths, signal)
    const built = await buildSearchIndex(paths, signal)
    await writeIndex(paths, built, signal)
    return built.search
  }

  private async indexStatus(paths: WikiPaths, signal?: AbortSignal): Promise<IndexStatus> {
    const [searchPresent, statePresent] = await this.indexTargetPresence(paths, signal)
    if (!searchPresent && !statePresent) return EMPTY_INDEX_STATUS
    if (!searchPresent || !statePresent) return { present: true, fresh: false, formatVersion: null, sectionCount: 0 }
    try {
      const [searchBytes, stateBytes, fingerprints] = await Promise.all([
        readFile(paths.indexFile('search.json')),
        readFile(paths.indexFile('state.json')),
        fingerprintPages(paths, signal),
      ])
      const search = parseSearchIndex(searchBytes)
      const state = parseIndexState(stateBytes)
      const fresh = state.searchSha256 === hash(searchBytes)
        && JSON.stringify(state.pages) === JSON.stringify(fingerprints)
        && JSON.stringify(search.pageFingerprints) === JSON.stringify(fingerprints)
      return { present: true, fresh, formatVersion: INDEX_FORMAT_VERSION, sectionCount: search.sections.length }
    } catch (cause) {
      throwIfAborted(signal)
      if (isMissing(cause) || cause instanceof LlmWikiError && cause.code === 'INDEX_CORRUPT') {
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
