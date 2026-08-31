import { createHash } from 'node:crypto'
import { lstat, readFile, readdir } from 'node:fs/promises'
import { extname, join, posix, relative, sep } from 'node:path'
import { LlmWikiError, throwIfAborted } from './errors.ts'
import { buildSearchIndex, trustedSearchIndex, validateBuiltIndexSnapshot } from './indexer.ts'
import { isPageId, isSourceId } from './ids.ts'
import { decodeUtf8, parsePageMarkdown } from './markdown.ts'
import type { WikiPaths } from './paths.ts'
import type { LintDiagnostic, LintReport, LintSeverity, SourceMetadata } from './types.ts'

export const LINT_DIAGNOSTIC_CODES = [
  'ROOT_MISSING',
  'ROOT_NOT_DIRECTORY',
  'UNSAFE_SYMLINK',
  'REQUIRED_DIRECTORY_MISSING',
  'REQUIRED_PATH_NOT_DIRECTORY',
  'SCHEMA_MISSING',
  'INVALID_UTF8',
  'SOURCE_INVALID_ID',
  'SOURCE_CONTENT_MISSING',
  'SOURCE_CONTENT_NOT_FILE',
  'SOURCE_HASH_MISMATCH',
  'SOURCE_METADATA_MISSING',
  'SOURCE_METADATA_NOT_FILE',
  'SOURCE_METADATA_MALFORMED',
  'SOURCE_METADATA_INVALID',
  'SOURCE_METADATA_UNKNOWN_KEY',
  'SOURCE_METADATA_ID_MISMATCH',
  'SOURCE_METADATA_BYTE_COUNT_MISMATCH',
  'PAGE_INVALID_PATH',
  'PAGE_INVALID_MARKDOWN',
  'PAGE_MISSING_SOURCE',
  'DUPLICATE_TITLE',
  'ORPHAN_PAGE',
  'LINK_ESCAPES_PAGES',
  'BROKEN_PAGE_LINK',
  'INDEX_MISSING',
  'INDEX_MALFORMED',
  'INDEX_INCOMPATIBLE',
  'INDEX_STALE',
  'TEMP_FILE_ABANDONED',
] as const

export type LintDiagnosticCode = (typeof LINT_DIAGNOSTIC_CODES)[number]

interface MutableContext {
  readonly paths: WikiPaths
  readonly signal: AbortSignal | undefined
  readonly diagnostics: LintDiagnostic[]
  readonly examinedPaths: Set<string>
}

interface PageInfo {
  readonly id: string
  readonly path: string
  readonly bytes: Uint8Array
  readonly title: string
  readonly sourceIds: readonly string[]
  readonly body: string
  readonly bodyStartLine: number
}

interface IndexState {
  readonly formatVersion: 1
  readonly pages: readonly { readonly pageId: string; readonly sha256: string }[]
  readonly searchSha256: string
}

const HASH = /^[0-9a-f]{64}$/u
const TEMP_FILE = /^\..+\.tmp-\d+-[0-9a-f]+$/u
const EXTERNAL_SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:/u
const FENCE_OPEN = /^[ \t]{0,3}(`{3,}|~{3,})/u
const MARKDOWN_LINK = /(?<!!)\[[^\]]*\]\(([^\s)]+)(?:\s+(?:"[^"]*"|'[^']*'|\([^)]*\)))?\)/gu
const WIKILINK = /\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|[^\]]*)?\]\]/gu

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function relativePath(paths: WikiPaths, path: string): string {
  const value = relative(paths.root, path).split(sep).join('/')
  return value.length === 0 ? '.' : value
}

function diagnostic(
  context: MutableContext,
  code: LintDiagnosticCode,
  severity: LintSeverity,
  path: string,
  message: string,
  line?: number,
): void {
  context.diagnostics.push(line === undefined
    ? { code, severity, path: relativePath(context.paths, path), message }
    : { code, severity, path: relativePath(context.paths, path), line, message })
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

async function stat(path: string, context: MutableContext) {
  throwIfAborted(context.signal)
  try {
    const result = await lstat(path)
    throwIfAborted(context.signal)
    return result
  } catch (cause) {
    throwIfAborted(context.signal)
    if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw cause
  }
}

async function readBytes(path: string, context: MutableContext): Promise<Uint8Array | null> {
  throwIfAborted(context.signal)
  try {
    const bytes = await readFile(path)
    context.examinedPaths.add(path)
    throwIfAborted(context.signal)
    return bytes
  } catch (cause) {
    throwIfAborted(context.signal)
    if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw cause
  }
}

async function entries(path: string, context: MutableContext) {
  throwIfAborted(context.signal)
  const result = await readdir(path, { withFileTypes: true })
  throwIfAborted(context.signal)
  return result.sort((a, b) => compareCodeUnits(a.name, b.name))
}

async function inspectRequiredDirectory(path: string, context: MutableContext): Promise<boolean> {
  const info = await stat(path, context)
  if (info === null) {
    diagnostic(context, 'REQUIRED_DIRECTORY_MISSING', 'error', path, 'Required wiki directory is missing.')
    return false
  }
  if (info.isSymbolicLink()) return false
  if (!info.isDirectory()) {
    diagnostic(context, 'REQUIRED_PATH_NOT_DIRECTORY', 'error', path, 'Required wiki path is not a directory.')
    return false
  }
  return true
}

async function scanTempsAndSymlinks(path: string, context: MutableContext): Promise<void> {
  const info = await stat(path, context)
  if (info === null || !info.isDirectory() || info.isSymbolicLink()) return
  for (const entry of await entries(path, context)) {
    const child = join(path, entry.name)
    if (entry.isSymbolicLink()) {
      diagnostic(context, 'UNSAFE_SYMLINK', 'error', child, 'Symbolic links are not allowed in the wiki.')
      continue
    }
    if (entry.isDirectory()) {
      await scanTempsAndSymlinks(child, context)
      continue
    }
    if (TEMP_FILE.test(entry.name)) {
      diagnostic(context, 'TEMP_FILE_ABANDONED', 'warning', child, 'Abandoned atomic-write temporary file.')
    }
  }
}

function validSourceMetadata(value: unknown): value is SourceMetadata {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const object = value as Record<string, unknown>
  return typeof object.id === 'string' && isSourceId(object.id)
    && typeof object.name === 'string' && object.name.trim().length > 0
    && typeof object.mediaType === 'string' && object.mediaType.trim().length > 0
    && Number.isSafeInteger(object.byteCount) && (object.byteCount as number) >= 0
    && typeof object.capturedAt === 'string'
    && !Number.isNaN(Date.parse(object.capturedAt))
    && new Date(object.capturedAt).toISOString() === object.capturedAt
    && (object.origin === undefined || (typeof object.origin === 'string' && object.origin.length > 0))
}

async function inspectSources(context: MutableContext): Promise<Set<string>> {
  const validSources = new Set<string>()
  if (!await inspectRequiredDirectory(context.paths.sources, context)) return validSources
  for (const entry of await entries(context.paths.sources, context)) {
    const directory = join(context.paths.sources, entry.name)
    if (entry.isSymbolicLink()) continue
    if (!entry.isDirectory() || !isSourceId(entry.name)) {
      diagnostic(context, 'SOURCE_INVALID_ID', 'error', directory, 'Source directory name must be a lowercase SHA-256 ID.')
      continue
    }
    const contentPath = join(directory, 'content')
    const contentStat = await stat(contentPath, context)
    let content: Uint8Array | null = null
    if (contentStat === null) diagnostic(context, 'SOURCE_CONTENT_MISSING', 'error', contentPath, 'Source content is missing.')
    else if (contentStat.isSymbolicLink()) { /* globally diagnosed */ }
    else if (!contentStat.isFile()) diagnostic(context, 'SOURCE_CONTENT_NOT_FILE', 'error', contentPath, 'Source content must be a regular file.')
    else content = await readBytes(contentPath, context)

    if (content !== null && sha256(content) !== entry.name) {
      diagnostic(context, 'SOURCE_HASH_MISMATCH', 'error', contentPath, 'Source ID does not match the SHA-256 hash of content.')
    }

    const metadataPath = join(directory, 'metadata.json')
    const metadataStat = await stat(metadataPath, context)
    let metadata: SourceMetadata | null = null
    if (metadataStat === null) diagnostic(context, 'SOURCE_METADATA_MISSING', 'error', metadataPath, 'Source metadata is missing.')
    else if (metadataStat.isSymbolicLink()) { /* globally diagnosed */ }
    else if (!metadataStat.isFile()) diagnostic(context, 'SOURCE_METADATA_NOT_FILE', 'error', metadataPath, 'Source metadata must be a regular file.')
    else {
      const bytes = await readBytes(metadataPath, context)
      if (bytes !== null) {
        try {
          const parsed = JSON.parse(decodeUtf8(bytes)) as unknown
          if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
            const allowed: Readonly<Record<string, true>> = { id: true, name: true, mediaType: true, byteCount: true, capturedAt: true, origin: true }
            for (const key of Object.keys(parsed).sort(compareCodeUnits)) {
              if (allowed[key] !== true) diagnostic(context, 'SOURCE_METADATA_UNKNOWN_KEY', 'error', metadataPath, `Source metadata contains unknown key ${JSON.stringify(key)}.`)
            }
          }
          if (!validSourceMetadata(parsed)) diagnostic(context, 'SOURCE_METADATA_INVALID', 'error', metadataPath, 'Source metadata does not match the required schema.')
          else metadata = parsed
        } catch {
          diagnostic(context, 'SOURCE_METADATA_MALFORMED', 'error', metadataPath, 'Source metadata is not valid UTF-8 JSON.')
        }
      }
    }
    if (metadata !== null && metadata.id !== entry.name) diagnostic(context, 'SOURCE_METADATA_ID_MISMATCH', 'error', metadataPath, 'Source metadata ID does not match its directory name.')
    if (metadata !== null && content !== null && metadata.byteCount !== content.byteLength) diagnostic(context, 'SOURCE_METADATA_BYTE_COUNT_MISMATCH', 'error', metadataPath, 'Source metadata byteCount does not match content bytes.')
    if (content !== null && sha256(content) === entry.name && metadata !== null && metadata.id === entry.name && metadata.byteCount === content.byteLength) validSources.add(entry.name)
  }
  return validSources
}

async function collectPageFiles(directory: string, context: MutableContext, output: string[]): Promise<void> {
  for (const entry of await entries(directory, context)) {
    const path = join(directory, entry.name)
    if (entry.isSymbolicLink()) continue
    if (entry.isDirectory()) await collectPageFiles(path, context, output)
    else output.push(path)
  }
}

function linkTargets(body: string, firstLine: number): readonly { readonly target: string; readonly line: number; readonly wiki: boolean }[] {
  const result: { target: string; line: number; wiki: boolean }[] = []
  const lines = body.replaceAll('\r\n', '\n').replaceAll('\r', '\n').split('\n')
  let fence: { character: string; length: number } | null = null
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? ''
    if (fence !== null) {
      if (new RegExp(`^[ \\t]{0,3}${fence.character === '`' ? '`' : '~'}{${fence.length},}[ \\t]*$`, 'u').test(line)) fence = null
      continue
    }
    const opening = FENCE_OPEN.exec(line)
    if (opening !== null) {
      const marker = opening[1] ?? ''
      fence = { character: marker[0] ?? '`', length: marker.length }
      continue
    }
    for (const match of line.matchAll(MARKDOWN_LINK)) result.push({ target: match[1] ?? '', line: firstLine + index, wiki: false })
    for (const match of line.matchAll(WIKILINK)) result.push({ target: match[1]?.trim() ?? '', line: firstLine + index, wiki: true })
  }
  return result
}

function validateLinks(page: PageInfo, pageIds: ReadonlySet<string>, context: MutableContext): ReadonlySet<string> {
  const linkedPages = new Set<string>()
  const pageDirectory = posix.dirname(page.id)
  for (const link of linkTargets(page.body, page.bodyStartLine)) {
    let target = link.target
    if (target.length === 0 || target.startsWith('#') || target.startsWith('//') || EXTERNAL_SCHEME.test(target)) continue
    target = target.split('#', 1)[0] ?? ''
    target = target.split('?', 1)[0] ?? ''
    if (target.length === 0) continue
    const hadExtension = target.toLowerCase().endsWith('.md')
    if (hadExtension) target = target.slice(0, -3)
    const resolved = posix.normalize(posix.join(pageDirectory, target))
    if (resolved === '..' || resolved.startsWith('../') || target.startsWith('/') || target.includes('\\')) {
      diagnostic(context, 'LINK_ESCAPES_PAGES', 'error', page.path, 'Relative page link escapes the pages directory.', link.line)
      continue
    }
    if (!isPageId(resolved) || (!hadExtension && !link.wiki)) continue
    if (!pageIds.has(resolved)) diagnostic(context, 'BROKEN_PAGE_LINK', 'error', page.path, `Linked page ${JSON.stringify(resolved)} does not exist.`, link.line)
    else if (resolved !== page.id) linkedPages.add(resolved)
  }
  return linkedPages
}

async function inspectPages(validSources: ReadonlySet<string>, context: MutableContext): Promise<PageInfo[]> {
  const pages: PageInfo[] = []
  if (!await inspectRequiredDirectory(context.paths.pages, context)) return pages
  const files: string[] = []
  await collectPageFiles(context.paths.pages, context, files)
  files.sort(compareCodeUnits)
  for (const path of files) {
    const logical = relative(context.paths.pages, path).split(sep).join('/')
    if (extname(logical) !== '.md' || !isPageId(logical.slice(0, -3))) {
      diagnostic(context, 'PAGE_INVALID_PATH', 'error', path, 'Page path must be a normalized relative path ending in lowercase .md.')
      continue
    }
    const bytes = await readBytes(path, context)
    if (bytes === null) continue
    try {
      const parsed = parsePageMarkdown(decodeUtf8(bytes))
      for (const source of parsed.metadata.sources) {
        if (!validSources.has(source)) diagnostic(context, 'PAGE_MISSING_SOURCE', 'error', path, `Page references missing or invalid source ${JSON.stringify(source)}.`)
      }
      pages.push({ id: logical.slice(0, -3), path, bytes, title: parsed.metadata.title, sourceIds: parsed.metadata.sources, body: parsed.body, bodyStartLine: parsed.bodyStartLine })
    } catch {
      diagnostic(context, 'PAGE_INVALID_MARKDOWN', 'error', path, 'Page is not valid canonical wiki Markdown.')
    }
  }
  const titles = new Map<string, PageInfo[]>()
  for (const page of pages) {
    const normalized = page.title.normalize('NFKC').toLowerCase()
    const group = titles.get(normalized) ?? []
    group.push(page)
    titles.set(normalized, group)
  }
  for (const group of titles.values()) {
    if (group.length < 2) continue
    for (const page of group) diagnostic(context, 'DUPLICATE_TITLE', 'warning', page.path, 'Page title duplicates another title after Unicode normalization.')
  }
  const pageIds = new Set(pages.map(({ id }) => id))
  const inbound = new Set<string>()
  for (const page of pages) {
    for (const target of validateLinks(page, pageIds, context)) inbound.add(target)
  }
  if (pages.length > 1) {
    for (const page of pages) {
      if (!inbound.has(page.id)) diagnostic(context, 'ORPHAN_PAGE', 'warning', page.path, 'Page has no incoming links from another page.')
    }
  }
  return pages
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key))
}
function record(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value) }
function safeNonnegativeInteger(value: unknown): value is number { return Number.isSafeInteger(value) && (value as number) >= 0 }
function positiveInteger(value: unknown): value is number { return Number.isSafeInteger(value) && (value as number) > 0 }
function sortedUniqueStrings(value: unknown): value is string[] {
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'string')) return false
  let previous: string | undefined
  for (const item of value) {
    if (previous !== undefined && previous >= item) return false
    previous = item
  }
  return true
}
function validFrequencyArray(value: unknown): boolean {
  if (!Array.isArray(value)) return false
  let previousTerm: string | undefined
  for (const item of value) {
    if (!record(item) || !exactKeys(item, ['term', 'count']) || typeof item.term !== 'string' || item.term.length === 0 || !positiveInteger(item.count)) return false
    if (previousTerm !== undefined && previousTerm >= item.term) return false
    previousTerm = item.term
  }
  return true
}
function validFingerprints(value: unknown): value is { pageId: string; sha256: string }[] {
  if (!Array.isArray(value)) return false
  let previousPageId: string | undefined
  for (const item of value) {
    if (!record(item) || !exactKeys(item, ['pageId', 'sha256']) || typeof item.pageId !== 'string' || !isPageId(item.pageId) || typeof item.sha256 !== 'string' || !HASH.test(item.sha256)) return false
    if (previousPageId !== undefined && previousPageId >= item.pageId) return false
    previousPageId = item.pageId
  }
  return true
}
function validState(value: unknown): value is IndexState {
  return record(value) && exactKeys(value, ['formatVersion', 'pages', 'searchSha256']) && value.formatVersion === 1 && validFingerprints(value.pages) && typeof value.searchSha256 === 'string' && HASH.test(value.searchSha256)
}
function validSearch(value: unknown): value is Record<string, unknown> {
  if (!record(value) || !exactKeys(value, ['formatVersion', 'pageFingerprints', 'documentCount', 'averageSectionLength', 'documentFrequencies', 'sections']) || value.formatVersion !== 1 || !validFingerprints(value.pageFingerprints) || !safeNonnegativeInteger(value.documentCount) || typeof value.averageSectionLength !== 'number' || !Number.isFinite(value.averageSectionLength) || value.averageSectionLength < 0 || !validFrequencyArray(value.documentFrequencies) || !Array.isArray(value.sections)) return false
  let previous: { pageId: string; startLine: number } | undefined
  for (const item of value.sections) {
    if (!record(item) || !exactKeys(item, ['pageId', 'title', 'headingTrail', 'startLine', 'sourceIds', 'normalizedText', 'length', 'titleTermFrequencies', 'headingTermFrequencies', 'bodyTermFrequencies']) || typeof item.pageId !== 'string' || !isPageId(item.pageId) || typeof item.title !== 'string' || !Array.isArray(item.headingTrail) || !item.headingTrail.every((part) => typeof part === 'string') || !positiveInteger(item.startLine) || !sortedUniqueStrings(item.sourceIds) || !item.sourceIds.every(isSourceId) || typeof item.normalizedText !== 'string' || !safeNonnegativeInteger(item.length) || !validFrequencyArray(item.titleTermFrequencies) || !validFrequencyArray(item.headingTermFrequencies) || !validFrequencyArray(item.bodyTermFrequencies)) return false
    if (previous !== undefined && (previous.pageId > item.pageId || (previous.pageId === item.pageId && previous.startLine >= item.startLine))) return false
    previous = { pageId: item.pageId, startLine: item.startLine }
  }
  return value.documentCount === value.sections.length
}

async function inspectIndex(context: MutableContext): Promise<void> {
  const indexStat = await stat(context.paths.index, context)
  if (indexStat === null) {
    diagnostic(context, 'INDEX_MISSING', 'warning', context.paths.index, 'Derived search index is missing.')
    return
  }
  if (indexStat.isSymbolicLink()) return
  if (!indexStat.isDirectory()) {
    diagnostic(context, 'REQUIRED_PATH_NOT_DIRECTORY', 'error', context.paths.index, 'Required wiki path is not a directory.')
    return
  }
  const statePath = context.paths.indexFile('state.json')
  const searchPath = context.paths.indexFile('search.json')
  const [stateStat, searchStat] = await Promise.all([stat(statePath, context), stat(searchPath, context)])
  if (stateStat?.isSymbolicLink() === true || searchStat?.isSymbolicLink() === true) return
  if (stateStat === null || searchStat === null) {
    diagnostic(context, 'INDEX_MISSING', 'warning', context.paths.index, 'Derived search index is missing.')
    return
  }
  const [stateBytes, searchBytes] = await Promise.all([readBytes(statePath, context), readBytes(searchPath, context)])
  if (stateBytes === null || searchBytes === null) {
    diagnostic(context, 'INDEX_MISSING', 'warning', context.paths.index, 'Derived search index is missing.')
    return
  }
  let stateUnknown: unknown
  let searchUnknown: unknown
  try { stateUnknown = JSON.parse(decodeUtf8(stateBytes)) } catch { diagnostic(context, 'INDEX_MALFORMED', 'error', statePath, 'Index state is not valid UTF-8 JSON.'); return }
  try { searchUnknown = JSON.parse(decodeUtf8(searchBytes)) } catch { diagnostic(context, 'INDEX_MALFORMED', 'error', searchPath, 'Search index is not valid UTF-8 JSON.'); return }
  if (record(stateUnknown) && Object.hasOwn(stateUnknown, 'formatVersion') && stateUnknown.formatVersion !== 1) { diagnostic(context, 'INDEX_INCOMPATIBLE', 'error', statePath, 'Index state uses an unsupported format version.'); return }
  if (record(searchUnknown) && Object.hasOwn(searchUnknown, 'formatVersion') && searchUnknown.formatVersion !== 1) { diagnostic(context, 'INDEX_INCOMPATIBLE', 'error', searchPath, 'Search index uses an unsupported format version.'); return }
  if (!validState(stateUnknown)) { diagnostic(context, 'INDEX_MALFORMED', 'error', statePath, 'Index state does not match formatVersion 1.'); return }
  if (!validSearch(searchUnknown)) { diagnostic(context, 'INDEX_MALFORMED', 'error', searchPath, 'Search index does not match formatVersion 1.'); return }
  if (`${JSON.stringify(stateUnknown, null, 2)}\n` !== decodeUtf8(stateBytes)) { diagnostic(context, 'INDEX_MALFORMED', 'error', statePath, 'Index state is not canonically serialized.'); return }
  if (`${JSON.stringify(searchUnknown, null, 2)}\n` !== decodeUtf8(searchBytes)) { diagnostic(context, 'INDEX_MALFORMED', 'error', searchPath, 'Search index is not canonically serialized.'); return }
  try {
    const expected = await buildSearchIndex(context.paths, context.signal, (path) => context.examinedPaths.add(path))
    const matches = trustedSearchIndex(searchBytes, stateBytes, expected) !== null
    await validateBuiltIndexSnapshot(context.paths, expected, context.signal)
    if (!matches) {
      diagnostic(context, 'INDEX_STALE', 'warning', context.paths.index, 'Derived search index is stale or has a hash mismatch.')
    }
  } catch (cause) {
    if (cause instanceof LlmWikiError && cause.code === 'ABORTED') throw cause
    throwIfAborted(context.signal)
    const nestedCode = cause instanceof Error && cause.cause !== undefined
      ? (cause.cause as NodeJS.ErrnoException).code
      : undefined
    const recoverable = cause instanceof LlmWikiError
      && (cause.code === 'INVALID_PAGE'
        || cause.code === 'INVALID_PATH'
        || cause.code === 'UNSAFE_FILESYSTEM' && (cause.cause === undefined || nestedCode === 'ENOENT' || nestedCode === 'ENOTDIR'))
    if (!recoverable) throw cause
    diagnostic(context, 'INDEX_STALE', 'warning', context.paths.index, 'Derived search index is stale or has a hash mismatch.')
  }
}

export async function lintWiki(paths: WikiPaths, signal?: AbortSignal): Promise<LintReport> {
  const context: MutableContext = { paths, signal, diagnostics: [], examinedPaths: new Set() }
  throwIfAborted(signal)
  const root = await stat(paths.root, context)
  if (root === null) diagnostic(context, 'ROOT_MISSING', 'error', paths.root, 'Wiki root is missing.')
  else if (root.isSymbolicLink()) diagnostic(context, 'UNSAFE_SYMLINK', 'error', paths.root, 'Wiki root must not be a symbolic link.')
  else if (!root.isDirectory()) diagnostic(context, 'ROOT_NOT_DIRECTORY', 'error', paths.root, 'Wiki root is not a directory.')
  else {
    await scanTempsAndSymlinks(paths.root, context)
    const schemaStat = await stat(paths.schema, context)
    if (schemaStat === null) diagnostic(context, 'SCHEMA_MISSING', 'error', paths.schema, 'Wiki schema is missing.')
    else if (schemaStat.isSymbolicLink()) { /* globally diagnosed */ }
    else if (!schemaStat.isFile()) diagnostic(context, 'REQUIRED_PATH_NOT_DIRECTORY', 'error', paths.schema, 'Wiki schema must be a regular file.')
    else {
      const bytes = await readBytes(paths.schema, context)
      if (bytes !== null) try { decodeUtf8(bytes) } catch { diagnostic(context, 'INVALID_UTF8', 'error', paths.schema, 'Wiki schema is not valid UTF-8.') }
    }
    const sources = await inspectSources(context)
    await inspectPages(sources, context)
    await inspectIndex(context)
  }
  throwIfAborted(signal)
  context.diagnostics.sort((left, right) => compareCodeUnits(left.path, right.path)
    || ((left.line ?? Number.POSITIVE_INFINITY) - (right.line ?? Number.POSITIVE_INFINITY))
    || compareCodeUnits(left.code, right.code)
    || compareCodeUnits(left.message, right.message))
  return {
    diagnostics: context.diagnostics,
    errorCount: context.diagnostics.filter(({ severity }) => severity === 'error').length,
    warningCount: context.diagnostics.filter(({ severity }) => severity === 'warning').length,
    filesExamined: context.examinedPaths.size,
  }
}

export function serializeLintReport(report: LintReport): string {
  return `${JSON.stringify(report, null, 2)}\n`
}
