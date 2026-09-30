import { createHash } from 'node:crypto'
import type { BigIntStats } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { atomicWriteFile } from './atomic.ts'
import { LlmWikiError, throwIfAborted } from './errors.ts'
import { pageId, sourceId } from './ids.ts'
import { decodeUtf8, encodeUtf8, parsePageMarkdown, splitMarkdownSections } from './markdown.ts'
import { withWikiRoot, wikiRelativeSegments } from './paths.ts'
import type { EntrySnapshot, WikiDirectory, WikiPaths } from './paths.ts'
import { tokenize, visitNormalizedTokenSpans } from './tokenizer.ts'
import type { SearchHit } from './types.ts'

export const INDEX_FORMAT_VERSION = 1 as const
const HASH_PATTERN = /^[0-9a-f]{64}$/u
const K1 = 1.2
const B = 0.75
const BOOST_TITLE = 2
const BOOST_HEADING = 1.5
const BOOST_BODY = 1

interface Fingerprint { readonly pageId: string; readonly sha256: string }
interface TermCount { readonly term: string; readonly count: number }

export interface IndexStateV1 {
  readonly formatVersion: 1
  readonly pages: readonly Fingerprint[]
  readonly searchSha256: string
}

export interface SearchSectionV1 {
  readonly pageId: string
  readonly title: string
  readonly headingTrail: readonly string[]
  readonly startLine: number
  readonly sourceIds: readonly string[]
  readonly normalizedText: string
  readonly length: number
  readonly titleTermFrequencies: readonly TermCount[]
  readonly headingTermFrequencies: readonly TermCount[]
  readonly bodyTermFrequencies: readonly TermCount[]
}

export interface SearchIndexV1 {
  readonly formatVersion: 1
  readonly pageFingerprints: readonly Fingerprint[]
  readonly documentCount: number
  readonly averageSectionLength: number
  readonly documentFrequencies: readonly TermCount[]
  readonly sections: readonly SearchSectionV1[]
}

export interface SearchOptions {
  readonly limit: number
  readonly maxResults: number
  readonly maxSnippetBytes: number
  readonly signal?: AbortSignal
}

export interface BuiltIndex {
  readonly state: IndexStateV1
  readonly search: SearchIndexV1
  readonly stateBytes: Uint8Array
  readonly searchBytes: Uint8Array
}

export interface IndexPage {
  readonly pageId: string
  readonly bytes: Uint8Array
  readonly title: string
  readonly sourceIds: readonly string[]
  readonly body: string
  readonly bodyStartLine: number
}

const codeUnitCompare = (left: string, right: string): number => left < right ? -1 : left > right ? 1 : 0
function sha256(bytes: Uint8Array): string {
  const digest = createHash('sha256')
  digest.update(bytes)
  return digest.digest('hex')
}
const canonicalBytes = (value: unknown): Uint8Array => encodeUtf8(`${JSON.stringify(value, null, 2)}\n`)

function corrupt(message: string, cause?: unknown): LlmWikiError {
  return new LlmWikiError('INDEX_CORRUPT', message, cause === undefined ? undefined : { cause })
}

function exactObject(value: unknown, keys: readonly string[], name: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw corrupt(`${name} must be an object.`)
  const object = value as Record<string, unknown>
  const actual = Object.keys(object)
  if (actual.length !== keys.length || actual.some((key) => !keys.includes(key))) throw corrupt(`${name} contains missing or unknown fields.`)
  return object
}

function safeInteger(value: unknown, name: string, positive = false): number {
  if (!Number.isSafeInteger(value) || (value as number) < (positive ? 1 : 0)) throw corrupt(`${name} must be a ${positive ? 'positive' : 'non-negative'} safe integer.`)
  return value as number
}

function finiteAverage(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) throw corrupt('averageSectionLength must be finite and non-negative.')
  return value
}

function stringValue(value: unknown, name: string): string {
  if (typeof value !== 'string') throw corrupt(`${name} must be a string.`)
  return value
}

function parseFingerprints(value: unknown, name: string): readonly Fingerprint[] {
  if (!Array.isArray(value)) throw corrupt(`${name} must be an array.`)
  let previous: string | undefined
  return value.map((entry, index) => {
    const object = exactObject(entry, ['pageId', 'sha256'], `${name}[${index}]`)
    const id = stringValue(object.pageId, `${name}[${index}].pageId`)
    pageId(id)
    const hash = stringValue(object.sha256, `${name}[${index}].sha256`)
    if (!HASH_PATTERN.test(hash)) throw corrupt(`${name}[${index}].sha256 is invalid.`)
    if (previous !== undefined && codeUnitCompare(previous, id) >= 0) throw corrupt(`${name} must be uniquely sorted by pageId.`)
    previous = id
    return { pageId: id, sha256: hash }
  })
}

function parseTermCounts(value: unknown, name: string): readonly TermCount[] {
  if (!Array.isArray(value)) throw corrupt(`${name} must be an array.`)
  let previous: string | undefined
  return value.map((entry, index) => {
    const object = exactObject(entry, ['term', 'count'], `${name}[${index}]`)
    const term = stringValue(object.term, `${name}[${index}].term`)
    if (term.length === 0 || tokenize(term).length === 0) throw corrupt(`${name}[${index}].term is invalid.`)
    if (previous !== undefined && codeUnitCompare(previous, term) >= 0) throw corrupt(`${name} must be uniquely sorted by term.`)
    previous = term
    return { term, count: safeInteger(object.count, `${name}[${index}].count`, true) }
  })
}

function stringArray(value: unknown, name: string): readonly string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) throw corrupt(`${name} must be a string array.`)
  return value as string[]
}

export function parseSearchIndex(bytes: Uint8Array): SearchIndexV1 {
  let value: unknown
  try { value = JSON.parse(decodeUtf8(bytes)) } catch (cause) { throw corrupt('search.json is malformed.', cause) }
  const root = exactObject(value, ['formatVersion', 'pageFingerprints', 'documentCount', 'averageSectionLength', 'documentFrequencies', 'sections'], 'search.json')
  if (root.formatVersion !== INDEX_FORMAT_VERSION) throw corrupt('search.json has an incompatible format version.')
  const pageFingerprints = parseFingerprints(root.pageFingerprints, 'pageFingerprints')
  const documentCount = safeInteger(root.documentCount, 'documentCount')
  const averageSectionLength = finiteAverage(root.averageSectionLength)
  const documentFrequencies = parseTermCounts(root.documentFrequencies, 'documentFrequencies')
  if (!Array.isArray(root.sections)) throw corrupt('sections must be an array.')
  let previousPage = ''
  let previousLine = 0
  const sections = root.sections.map((entry, index) => {
    const object = exactObject(entry, ['pageId', 'title', 'headingTrail', 'startLine', 'sourceIds', 'normalizedText', 'length', 'titleTermFrequencies', 'headingTermFrequencies', 'bodyTermFrequencies'], `sections[${index}]`)
    const id = stringValue(object.pageId, `sections[${index}].pageId`); pageId(id)
    const startLine = safeInteger(object.startLine, `sections[${index}].startLine`, true)
    if (codeUnitCompare(previousPage, id) > 0 || (previousPage === id && previousLine >= startLine)) throw corrupt('sections must be uniquely sorted by pageId and startLine.')
    previousPage = id; previousLine = startLine
    const sourceIds = stringArray(object.sourceIds, `sections[${index}].sourceIds`)
    let priorSource: string | undefined
    for (const idValue of sourceIds) { sourceId(idValue); if (priorSource !== undefined && codeUnitCompare(priorSource, idValue) >= 0) throw corrupt('section sourceIds must be uniquely sorted.'); priorSource = idValue }
    return {
      pageId: id,
      title: stringValue(object.title, `sections[${index}].title`),
      headingTrail: stringArray(object.headingTrail, `sections[${index}].headingTrail`),
      startLine,
      sourceIds,
      normalizedText: stringValue(object.normalizedText, `sections[${index}].normalizedText`),
      length: safeInteger(object.length, `sections[${index}].length`),
      titleTermFrequencies: parseTermCounts(object.titleTermFrequencies, `sections[${index}].titleTermFrequencies`),
      headingTermFrequencies: parseTermCounts(object.headingTermFrequencies, `sections[${index}].headingTermFrequencies`),
      bodyTermFrequencies: parseTermCounts(object.bodyTermFrequencies, `sections[${index}].bodyTermFrequencies`),
    }
  })
  if (documentCount !== sections.length) throw corrupt('documentCount does not match sections.')
  return { formatVersion: 1, pageFingerprints, documentCount, averageSectionLength, documentFrequencies, sections }
}

export function parseIndexState(bytes: Uint8Array): IndexStateV1 {
  let value: unknown
  try { value = JSON.parse(decodeUtf8(bytes)) } catch (cause) { throw corrupt('state.json is malformed.', cause) }
  const root = exactObject(value, ['formatVersion', 'pages', 'searchSha256'], 'state.json')
  if (root.formatVersion !== INDEX_FORMAT_VERSION) throw corrupt('state.json has an incompatible format version.')
  const searchHash = stringValue(root.searchSha256, 'searchSha256')
  if (!HASH_PATTERN.test(searchHash)) throw corrupt('searchSha256 is invalid.')
  return { formatVersion: 1, pages: parseFingerprints(root.pages, 'pages'), searchSha256: searchHash }
}

async function pinned<T>(paths: WikiPaths, signal: AbortSignal | undefined, root: WikiDirectory | undefined, callback: (root: WikiDirectory) => Promise<T>): Promise<T> {
  if (root !== undefined) return callback(root)
  const result = await withWikiRoot(paths.authority, { signal }, callback)
  if (result === null) throw new LlmWikiError('UNSAFE_FILESYSTEM', 'Wiki root is missing.')
  return result
}

async function discoverDirectory(directory: string, pagesRoot: string, paths: WikiPaths, root: WikiDirectory, signal?: AbortSignal): Promise<PageSnapshot[]> {
  const result = await root.directory(wikiRelativeSegments(paths, directory), { signal }, async (held) => {
    const pages: PageSnapshot[] = []
    for (const entry of await held.list(signal)) {
      throwIfAborted(signal)
      const path = join(directory, entry.name)
      if (entry.stat.isSymbolicLink()) throw new LlmWikiError('UNSAFE_FILESYSTEM', 'Symbolic links are not allowed in the pages tree.')
      if (entry.stat.isDirectory()) pages.push(...await discoverDirectory(path, pagesRoot, paths, root, signal))
      else if (entry.stat.isFile() && entry.name.endsWith('.md')) pages.push({ ...entry, path, key: relative(pagesRoot, path).split(sep).join('/') })
      if (!await root.validate(entry, signal)) throw new LlmWikiError('UNSAFE_FILESYSTEM', 'Wiki page identity changed during discovery.')
    }
    return pages.sort((a, b) => codeUnitCompare(a.key, b.key))
  })
  if (result === null) throw new LlmWikiError('UNSAFE_FILESYSTEM', 'Wiki pages directory is missing.')
  return result
}

function sameStableFileSnapshot(before: BigIntStats, after: BigIntStats): boolean {
  return before.dev === after.dev
    && before.ino === after.ino
    && before.size === after.size
    && before.mtimeNs === after.mtimeNs
    && before.ctimeNs === after.ctimeNs
}

interface PageSnapshot extends EntrySnapshot {
  readonly path: string
  readonly key: string
}

interface CorpusSnapshot {
  readonly pages: readonly PageSnapshot[]
}

interface SafePageRead {
  readonly bytes: Uint8Array
  readonly snapshot: PageSnapshot
}

const corpusSnapshots = new WeakMap<BuiltIndex, CorpusSnapshot>()

function samePathIdentity(snapshot: BigIntStats, current: BigIntStats): boolean {
  return current.isFile() && !current.isSymbolicLink() && sameStableFileSnapshot(snapshot, current)
}

async function validatePageSnapshot(page: PageSnapshot, root: WikiDirectory, signal?: AbortSignal): Promise<void> {
  if (!await root.validate(page, signal)) throw new LlmWikiError('UNSAFE_FILESYSTEM', 'Wiki page changed while the corpus was being read.')
}

async function validateCorpusSnapshot(snapshot: CorpusSnapshot, paths: WikiPaths, root: WikiDirectory, signal?: AbortSignal): Promise<void> {
  try {
    throwIfAborted(signal)
    const currentPages = await discoverDirectory(paths.pages, paths.pages, paths, root, signal)
    if (currentPages.length !== snapshot.pages.length) {
      throw new LlmWikiError('UNSAFE_FILESYSTEM', 'Wiki page membership changed while the corpus was being read.')
    }
    for (let index = 0; index < snapshot.pages.length; index += 1) {
      const expected = snapshot.pages[index]!
      const current = currentPages[index]!
      if (current.key !== expected.key || current.path !== expected.path || !samePathIdentity(expected.stat, current.stat)) {
        throw new LlmWikiError('UNSAFE_FILESYSTEM', 'Wiki page changed while the corpus was being read.')
      }
    }
  } catch (cause) {
    throwIfAborted(signal)
    if (cause instanceof LlmWikiError) throw cause
    throw new LlmWikiError('UNSAFE_FILESYSTEM', 'Unable to validate a stable wiki corpus.', { cause })
  }
}

async function readSafePage(path: string, paths: WikiPaths, root: WikiDirectory, signal?: AbortSignal, onExamined?: (path: string) => void): Promise<SafePageRead> {
  try {
    const segments = wikiRelativeSegments(paths, path)
    const read = await root.directory(segments.slice(0, -1), { signal }, (parent) => parent.read(segments.at(-1)!, signal))
    if (read === null) throw new LlmWikiError('UNSAFE_FILESYSTEM', 'Wiki page disappeared while being read.')
    onExamined?.(path)
    throwIfAborted(signal)
    const snapshot = { ...read.snapshot, path, key: relative(paths.pages, path).split(sep).join('/') }
    await validatePageSnapshot(snapshot, root, signal)
    return { bytes: read.bytes, snapshot }
  } catch (cause) {
    throwIfAborted(signal)
    if (cause instanceof LlmWikiError) throw cause
    throw new LlmWikiError('UNSAFE_FILESYSTEM', 'Unable to read a wiki page safely.', { cause })
  }
}

export async function fingerprintPages(paths: WikiPaths, signal?: AbortSignal, root?: WikiDirectory): Promise<readonly Fingerprint[]> {
  return pinned(paths, signal, root, async (held) => {
  const discovered = await discoverDirectory(paths.pages, paths.pages, paths, held, signal)
  const fingerprints: Fingerprint[] = []
  const pages: PageSnapshot[] = []
  for (const page of discovered) {
    const { bytes, snapshot } = await readSafePage(page.path, paths, held, signal)
    pages.push(snapshot)
    const logical = page.key.replace(/\.md$/u, '')
    fingerprints.push({ pageId: pageId(logical), sha256: sha256(bytes) })
  }
  fingerprints.sort((a, b) => codeUnitCompare(a.pageId, b.pageId))
  await validateCorpusSnapshot({ pages }, paths, held, signal)
  return fingerprints
  })
}

function frequencies(tokens: readonly string[]): readonly TermCount[] {
  const counts = new Map<string, number>()
  for (const token of tokens) counts.set(token, (counts.get(token) ?? 0) + 1)
  return [...counts].sort(([a], [b]) => codeUnitCompare(a, b)).map(([term, count]) => ({ term, count }))
}

function normalizeText(text: string): string { return text.normalize('NFKC').toLowerCase() }

export function buildSearchIndexFromPages(pages: readonly IndexPage[]): BuiltIndex {
  const pageFingerprints = pages.map(({ pageId, bytes }) => ({ pageId, sha256: sha256(bytes) })).sort((a, b) => codeUnitCompare(a.pageId, b.pageId))
  const pagesById = new Map(pages.map(page => [page.pageId, page]))
  const sections: SearchSectionV1[] = []
  const documentFrequency = new Map<string, number>()
  for (const fingerprint of pageFingerprints) {
    const page = pagesById.get(fingerprint.pageId)!
    for (const section of splitMarkdownSections(page.body, page.bodyStartLine)) {
      const titleTokens = tokenize(page.title)
      const headingTokens = tokenize(section.headingTrail.join(' '))
      const bodyTokens = tokenize(section.text)
      const sectionTokens = [...headingTokens, ...bodyTokens]
      const indexedTokens = [...titleTokens, ...sectionTokens]
      for (const term of new Set(indexedTokens)) documentFrequency.set(term, (documentFrequency.get(term) ?? 0) + 1)
      sections.push({
        pageId: fingerprint.pageId,
        title: page.title,
        headingTrail: [...section.headingTrail],
        startLine: section.startLine,
        sourceIds: [...page.sourceIds].sort(codeUnitCompare),
        normalizedText: normalizeText(section.text),
        length: sectionTokens.length,
        titleTermFrequencies: frequencies(titleTokens),
        headingTermFrequencies: frequencies(headingTokens),
        bodyTermFrequencies: frequencies(bodyTokens),
      })
    }
  }
  sections.sort((a, b) => codeUnitCompare(a.pageId, b.pageId) || a.startLine - b.startLine)
  const documentCount = sections.length
  const averageSectionLength = documentCount === 0 ? 0 : sections.reduce((sum, section) => sum + section.length, 0) / documentCount
  const documentFrequencies = [...documentFrequency].sort(([a], [b]) => codeUnitCompare(a, b)).map(([term, count]) => ({ term, count }))
  const search: SearchIndexV1 = { formatVersion: 1, pageFingerprints, documentCount, averageSectionLength, documentFrequencies, sections }
  const searchBytes = canonicalBytes(search)
  const state: IndexStateV1 = { formatVersion: 1, pages: pageFingerprints, searchSha256: sha256(searchBytes) }
  return { state, search, searchBytes, stateBytes: canonicalBytes(state) }
}

export async function buildSearchIndex(paths: WikiPaths, signal?: AbortSignal, onPageExamined?: (path: string) => void, root?: WikiDirectory): Promise<BuiltIndex> {
  return pinned(paths, signal, root, async (held) => {
  const discovered = await discoverDirectory(paths.pages, paths.pages, paths, held, signal)
  const pages: IndexPage[] = []
  const pageSnapshots: PageSnapshot[] = []
  for (const page of discovered) {
    const { bytes, snapshot } = await readSafePage(page.path, paths, held, signal, onPageExamined)
    pageSnapshots.push(snapshot)
    const id = pageId(page.key.replace(/\.md$/u, ''))
    const parsed = parsePageMarkdown(decodeUtf8(bytes))
    pages.push({ pageId: id, bytes, title: parsed.metadata.title, sourceIds: parsed.metadata.sources, body: parsed.body, bodyStartLine: parsed.bodyStartLine })
  }
  const corpusSnapshot = { pages: pageSnapshots }
  const built = buildSearchIndexFromPages(pages)
  await validateCorpusSnapshot(corpusSnapshot, paths, held, signal)
  corpusSnapshots.set(built, corpusSnapshot)
  return built
  })
}

export function trustedSearchIndex(searchBytes: Uint8Array, stateBytes: Uint8Array, expected: BuiltIndex): SearchIndexV1 | null {
  const search = parseSearchIndex(searchBytes)
  parseIndexState(stateBytes)
  const searchMatches = searchBytes.byteLength === expected.searchBytes.byteLength && searchBytes.every((byte, index) => byte === expected.searchBytes[index])
  const stateMatches = stateBytes.byteLength === expected.stateBytes.byteLength && stateBytes.every((byte, index) => byte === expected.stateBytes[index])
  return searchMatches && stateMatches ? search : null
}

export async function validateBuiltIndexSnapshot(paths: WikiPaths, built: BuiltIndex, signal?: AbortSignal, root?: WikiDirectory): Promise<void> {
  const snapshot = corpusSnapshots.get(built)
  if (snapshot !== undefined) await pinned(paths, signal, root, (held) => validateCorpusSnapshot(snapshot, paths, held, signal))
}

export async function writeIndex(paths: WikiPaths, built: BuiltIndex, signal?: AbortSignal, root?: WikiDirectory): Promise<void> {
  await pinned(paths, signal, root, async (held) => {
    await validateBuiltIndexSnapshot(paths, built, signal, held)
    await held.directory(wikiRelativeSegments(paths, paths.index), { create: true, signal }, async (index) => {
      await validateBuiltIndexSnapshot(paths, built, signal, held)
      await atomicWriteFile(index, 'search.json', built.searchBytes, { signal })
      throwIfAborted(signal)
      await validateBuiltIndexSnapshot(paths, built, signal, held)
      await atomicWriteFile(index, 'state.json', built.stateBytes, { signal })
      await validateBuiltIndexSnapshot(paths, built, signal, held)
    })
  })
}

async function loadFreshIndex(paths: WikiPaths, expected: BuiltIndex, root: WikiDirectory, signal?: AbortSignal): Promise<SearchIndexV1 | null> {
  try {
    return await root.directory(wikiRelativeSegments(paths, paths.index), { signal }, async (index) => {
      const search = await index.read('search.json', signal)
      const state = await index.read('state.json', signal)
      if (search === null || state === null) return null
      if (!await root.validate(search.snapshot, signal) || !await root.validate(state.snapshot, signal)) throw new LlmWikiError('UNSAFE_FILESYSTEM', 'Wiki index changed while being read.')
      return trustedSearchIndex(search.bytes, state.bytes, expected)
    })
  } catch (cause) {
    throwIfAborted(signal)
    if ((cause as NodeJS.ErrnoException).code === 'ENOENT' || cause instanceof LlmWikiError && cause.code === 'INDEX_CORRUPT') return null
    throw cause
  }
}

export async function ensureSearchIndex(paths: WikiPaths, signal?: AbortSignal, root?: WikiDirectory): Promise<SearchIndexV1> {
  return pinned(paths, signal, root, async (held) => {
    const expected = await buildSearchIndex(paths, signal, undefined, held)
    const existing = await loadFreshIndex(paths, expected, held, signal)
    await validateBuiltIndexSnapshot(paths, expected, signal, held)
    if (existing !== null) return existing
    await writeIndex(paths, expected, signal, held)
    await validateBuiltIndexSnapshot(paths, expected, signal, held)
    return expected.search
  })
}

function countFor(items: readonly TermCount[], term: string): number {
  const found = items.find((item) => item.term === term)
  return found?.count ?? 0
}

function utf8Snippet(text: string, maxBytes: number): string {
  const lines = text.split('\n')
  let result = ''
  for (const line of lines) {
    const candidate = result.length === 0 ? line : `${result}\n${line}`
    if (encodeUtf8(candidate).byteLength <= maxBytes) { result = candidate; continue }
    if (result.length > 0) break
    for (const character of line) {
      if (encodeUtf8(result + character).byteLength > maxBytes) break
      result += character
    }
    break
  }
  return result
}

function querySnippet(section: SearchSectionV1, queryTerms: readonly string[], maxBytes: number): string {
  const text = section.normalizedText
  const terms = new Set(queryTerms.filter((term) => countFor(section.bodyTermFrequencies, term) > 0 && Buffer.byteLength(term, 'utf8') <= maxBytes))
  let selected: { term: string; start: number; end: number } | undefined
  if (terms.size > 0) visitNormalizedTokenSpans(text, (term, start, end) => {
    if (terms.has(term) && (!selected || start < selected.start || (start === selected.start && codeUnitCompare(term, selected.term) < 0))) selected = { term, start, end }
  })
  if (!selected) return utf8Snippet(text, maxBytes)
  let start = selected.start
  let end = selected.end
  let remaining = maxBytes - Buffer.byteLength(selected.term, 'utf8')
  const extendLeft = (budget: number): number => {
    let used = 0
    while (start > 0) {
      const last = text.charCodeAt(start - 1)
      const previous = start - (last >= 0xdc00 && last <= 0xdfff ? 2 : 1)
      const bytes = Buffer.byteLength(text.slice(previous, start), 'utf8')
      if (used + bytes > budget) break
      start = previous
      used += bytes
    }
    return used
  }
  remaining -= extendLeft(Math.floor(remaining / 2))
  while (end < text.length) {
    const next = end + (text.codePointAt(end)! > 0xffff ? 2 : 1)
    const bytes = Buffer.byteLength(text.slice(end, next), 'utf8')
    if (bytes > remaining) break
    end = next
    remaining -= bytes
  }
  extendLeft(remaining)
  return text.slice(start, end)
}

export function searchBuiltIndex(index: SearchIndexV1, query: string, options: SearchOptions): readonly SearchHit[] {
  throwIfAborted(options.signal)
  if (!Number.isSafeInteger(options.limit) || options.limit < 1 || !Number.isSafeInteger(options.maxResults) || options.maxResults < 1 || !Number.isSafeInteger(options.maxSnippetBytes) || options.maxSnippetBytes < 1) throw new LlmWikiError('LIMIT_EXCEEDED', 'Search limits must be positive safe integers.')
  const queryTerms = [...new Set(tokenize(query))]
  if (queryTerms.length === 0) throw new LlmWikiError('INVALID_PAGE', 'Search query must contain at least one Unicode letter or number.')
  const limit = Math.min(options.limit, options.maxResults)
  const hits: { section: SearchSectionV1; score: number }[] = []
  for (const section of index.sections) {
    throwIfAborted(options.signal)
    let score = 0
    for (const term of queryTerms) {
      const df = countFor(index.documentFrequencies, term)
      if (df === 0) continue
      const weightedFrequency = BOOST_TITLE * countFor(section.titleTermFrequencies, term) + BOOST_HEADING * countFor(section.headingTermFrequencies, term) + BOOST_BODY * countFor(section.bodyTermFrequencies, term)
      if (weightedFrequency === 0) continue
      const idf = Math.log(1 + (index.documentCount - df + 0.5) / (df + 0.5))
      const normalization = index.averageSectionLength === 0 ? 1 : 1 - B + B * section.length / index.averageSectionLength
      score += idf * (weightedFrequency * (K1 + 1)) / (weightedFrequency + K1 * normalization)
    }
    if (!Number.isFinite(score)) throw corrupt('Search produced a non-finite score.')
    if (score > 0) hits.push({ section, score })
  }
  hits.sort((a, b) => b.score - a.score || codeUnitCompare(a.section.pageId, b.section.pageId) || a.section.startLine - b.section.startLine)
  return hits.slice(0, limit).map(({ section, score }) => ({ pageId: pageId(section.pageId), title: section.title, headingTrail: section.headingTrail, startLine: section.startLine, score, snippet: querySnippet(section, queryTerms, options.maxSnippetBytes), sourceIds: section.sourceIds.map(sourceId) }))
}

export async function searchWiki(paths: WikiPaths, query: string, options: SearchOptions, root?: WikiDirectory): Promise<readonly SearchHit[]> {
  const index = await ensureSearchIndex(paths, options.signal, root)
  return searchBuiltIndex(index, query, options)
}
