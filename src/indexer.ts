import { createHash } from 'node:crypto'
import { lstat, opendir, readFile } from 'node:fs/promises'
import { extname, join, relative, sep } from 'node:path'
import { atomicWriteFile } from './atomic.ts'
import { LlmWikiError, throwIfAborted } from './errors.ts'
import { pageId, sourceId } from './ids.ts'
import { decodeUtf8, encodeUtf8, parsePageMarkdown, splitMarkdownSections } from './markdown.ts'
import { ensureWikiDirectory } from './paths.ts'
import type { WikiPaths } from './paths.ts'
import { tokenize } from './tokenizer.ts'
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

async function discoverDirectory(directory: string, signal?: AbortSignal): Promise<string[]> {
  throwIfAborted(signal)
  const result: string[] = []
  const handle = await opendir(directory)
  try {
    for await (const entry of handle) {
      throwIfAborted(signal)
      const path = join(directory, entry.name)
      const stat = await lstat(path)
      throwIfAborted(signal)
      if (stat.isSymbolicLink()) throw new LlmWikiError('UNSAFE_FILESYSTEM', 'Symbolic links are not allowed in the pages tree.')
      if (stat.isDirectory()) result.push(...await discoverDirectory(path, signal))
      else if (stat.isFile() && extname(entry.name) === '.md') result.push(path)
    }
  } finally {
    await handle.close().catch(() => undefined)
  }
  return result.sort(codeUnitCompare)
}

export async function fingerprintPages(paths: WikiPaths, signal?: AbortSignal): Promise<readonly Fingerprint[]> {
  await paths.assertSafe(paths.pages, signal)
  const files = await discoverDirectory(paths.pages, signal)
  const fingerprints: Fingerprint[] = []
  for (const file of files) {
    throwIfAborted(signal); await paths.assertSafe(file, signal)
    const bytes = await readFile(file); throwIfAborted(signal)
    const logical = relative(paths.pages, file).split(sep).join('/').replace(/\.md$/u, '')
    fingerprints.push({ pageId: pageId(logical), sha256: sha256(bytes) })
  }
  return fingerprints.sort((a, b) => codeUnitCompare(a.pageId, b.pageId))
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

export async function buildSearchIndex(paths: WikiPaths, signal?: AbortSignal): Promise<BuiltIndex> {
  const fingerprints = await fingerprintPages(paths, signal)
  const pages: IndexPage[] = []
  for (const fingerprint of fingerprints) {
    throwIfAborted(signal)
    const path = paths.page(pageId(fingerprint.pageId))
    await paths.assertSafe(path, signal)
    const bytes = await readFile(path); throwIfAborted(signal)
    const parsed = parsePageMarkdown(decodeUtf8(bytes))
    pages.push({ pageId: fingerprint.pageId, bytes, title: parsed.metadata.title, sourceIds: parsed.metadata.sources, body: parsed.body, bodyStartLine: parsed.bodyStartLine })
  }
  return buildSearchIndexFromPages(pages)
}

export function trustedSearchIndex(searchBytes: Uint8Array, stateBytes: Uint8Array, expected: BuiltIndex): SearchIndexV1 | null {
  const search = parseSearchIndex(searchBytes)
  parseIndexState(stateBytes)
  const searchMatches = searchBytes.byteLength === expected.searchBytes.byteLength && searchBytes.every((byte, index) => byte === expected.searchBytes[index])
  const stateMatches = stateBytes.byteLength === expected.stateBytes.byteLength && stateBytes.every((byte, index) => byte === expected.stateBytes[index])
  return searchMatches && stateMatches ? search : null
}

export async function writeIndex(paths: WikiPaths, built: BuiltIndex, signal?: AbortSignal): Promise<void> {
  await ensureWikiDirectory(paths, paths.index, signal)
  const assertSafe = (path: string, optionSignal?: AbortSignal): Promise<void> => paths.assertSafe(path, optionSignal)
  const options = signal === undefined ? { assertSafe } : { signal, assertSafe }
  await atomicWriteFile(paths.indexFile('search.json'), built.searchBytes, options)
  throwIfAborted(signal)
  await atomicWriteFile(paths.indexFile('state.json'), built.stateBytes, options)
}

async function loadFreshIndex(paths: WikiPaths, expected: BuiltIndex, signal?: AbortSignal): Promise<SearchIndexV1 | null> {
  try {
    const searchPath = paths.indexFile('search.json')
    const statePath = paths.indexFile('state.json')
    await paths.assertSafe(searchPath, signal)
    await paths.assertSafe(statePath, signal)
    const searchBytes = await readFile(searchPath); throwIfAborted(signal)
    const stateBytes = await readFile(statePath); throwIfAborted(signal)
    return trustedSearchIndex(searchBytes, stateBytes, expected)
  } catch (cause) {
    throwIfAborted(signal)
    if ((cause as NodeJS.ErrnoException).code === 'ENOENT' || cause instanceof LlmWikiError) return null
    throw cause
  }
}

export async function ensureSearchIndex(paths: WikiPaths, signal?: AbortSignal): Promise<SearchIndexV1> {
  const expected = await buildSearchIndex(paths, signal)
  const existing = await loadFreshIndex(paths, expected, signal)
  if (existing !== null) return existing
  await writeIndex(paths, expected, signal)
  return expected.search
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

export function searchBuiltIndex(index: SearchIndexV1, query: string, options: SearchOptions): readonly SearchHit[] {
  throwIfAborted(options.signal)
  if (!Number.isSafeInteger(options.limit) || options.limit < 1 || !Number.isSafeInteger(options.maxResults) || options.maxResults < 1 || !Number.isSafeInteger(options.maxSnippetBytes) || options.maxSnippetBytes < 1) throw new LlmWikiError('LIMIT_EXCEEDED', 'Search limits must be positive safe integers.')
  const queryTerms = [...new Set(tokenize(query))]
  if (queryTerms.length === 0) throw new LlmWikiError('INVALID_PAGE', 'Search query must contain at least one Unicode letter or number.')
  const limit = Math.min(options.limit, options.maxResults)
  const hits: SearchHit[] = []
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
    if (score > 0) hits.push({ pageId: pageId(section.pageId), title: section.title, headingTrail: section.headingTrail, startLine: section.startLine, score, snippet: utf8Snippet(section.normalizedText, options.maxSnippetBytes), sourceIds: section.sourceIds.map(sourceId) })
  }
  hits.sort((a, b) => b.score - a.score || codeUnitCompare(a.pageId, b.pageId) || a.startLine - b.startLine)
  return hits.slice(0, limit)
}

export async function searchWiki(paths: WikiPaths, query: string, options: SearchOptions): Promise<readonly SearchHit[]> {
  const index = await ensureSearchIndex(paths, options.signal)
  return searchBuiltIndex(index, query, options)
}
