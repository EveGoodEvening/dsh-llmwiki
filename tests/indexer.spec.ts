import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  buildSearchIndex,
  ensureSearchIndex,
  parseIndexState,
  parseSearchIndex,
  searchBuiltIndex,
  searchWiki,
  writeIndex,
} from '../src/indexer.ts'
import { LlmWikiError } from '../src/errors.ts'
import { encodeUtf8 } from '../src/markdown.ts'
import { initializeWikiPaths } from '../src/paths.ts'
import type { WikiPaths } from '../src/paths.ts'
import { tokenize } from '../src/tokenizer.ts'

const FIXTURES = join(import.meta.dirname, 'fixtures')
const SOURCE = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
const roots: string[] = []
function hash(bytes: Uint8Array): string {
  const digest = createHash('sha256')
  digest.update(bytes)
  return digest.digest('hex')
}

function expectCanonicalBytes(actual: Uint8Array, expected: Uint8Array): void {
  expect(new Uint8Array(actual)).toStrictEqual(new Uint8Array(expected))
}

async function root(): Promise<WikiPaths> {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-llmwiki-indexer-'))
  roots.push(directory)
  return initializeWikiPaths('.llmwiki', undefined, directory)
}

async function installAlpha(paths: WikiPaths): Promise<void> {
  await writeFile(join(paths.pages, 'alpha.md'), await readFile(join(FIXTURES, 'corpus', 'alpha.md')))
}

function validSearchObject(): Record<string, unknown> {
  return {
    formatVersion: 1,
    pageFingerprints: [],
    documentCount: 0,
    averageSectionLength: 0,
    documentFrequencies: [],
    sections: [],
  }
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(async (directory) => rm(directory, { recursive: true, force: true })))
})

describe('Unicode tokenizer', () => {
  it('normalizes NFKC, lowercases without locale APIs, and keeps letter-number runs', () => {
    expect(tokenize('ＡLPHA café １２3')).toEqual(['alpha', 'café', '123'])
  })

  it('retains CJK runs and emits overlapping two-code-point grams', () => {
    expect(tokenize('漢字仮名 한글')).toEqual(['漢字仮名', '漢字', '字仮', '仮名', '한글', '한글'])
  })

  it('drops punctuation but no language-specific stop words', () => {
    expect(tokenize('The—and...42')).toEqual(['the', 'and', '42'])
  })
})

describe('canonical index persistence', () => {
  it('matches the exact golden bytes, field ordering, fingerprints, and section line', async () => {
    const paths = await root()
    await installAlpha(paths)
    const built = await buildSearchIndex(paths)
    const golden = await readFile(join(FIXTURES, 'expected', 'search.json'))
    expectCanonicalBytes(built.searchBytes, golden)
    expect(built.search.sections[0]?.startLine).toBe(8)
    expect(built.state.searchSha256).toBe(hash(golden))
    expect(Buffer.from(built.stateBytes).at(-1)).toBe(10)
  })

  it('is byte-identical across roots, creation order, mtimes, timezone, and locale', async () => {
    const first = await root()
    const second = await root()
    await mkdir(join(first.pages, 'nested'))
    await writeFile(join(first.pages, 'nested', 'zeta.md'), (await readFile(join(FIXTURES, 'corpus', 'alpha.md'))).toString().replace('"Alpha"', '"Zeta"'))
    await installAlpha(first)
    await installAlpha(second)
    await mkdir(join(second.pages, 'nested'))
    await writeFile(join(second.pages, 'nested', 'zeta.md'), (await readFile(join(FIXTURES, 'corpus', 'alpha.md'))).toString().replace('"Alpha"', '"Zeta"'))
    await utimes(join(first.pages, 'alpha.md'), new Date(1), new Date(2))
    await utimes(join(second.pages, 'alpha.md'), new Date(10_000), new Date(20_000))
    const left = await buildSearchIndex(first)
    const right = await buildSearchIndex(second)
    expectCanonicalBytes(left.searchBytes, right.searchBytes)
    expectCanonicalBytes(left.stateBytes, right.stateBytes)
  })

  it('deletes and deterministically rebuilds only disposable derived data', async () => {
    const paths = await root()
    await installAlpha(paths)
    const pageBefore = hash(await readFile(join(paths.pages, 'alpha.md')))
    const first = await buildSearchIndex(paths)
    await writeIndex(paths, first)
    await rm(paths.index, { recursive: true })
    await mkdir(paths.index)
    await searchWiki(paths, 'alpha', { limit: 5, maxResults: 20, maxSnippetBytes: 100 })
    expect(hash(await readFile(join(paths.pages, 'alpha.md')))).toBe(pageBefore)
    expectCanonicalBytes(await readFile(paths.indexFile('search.json')), first.searchBytes)
    expectCanonicalBytes(await readFile(paths.indexFile('state.json')), first.stateBytes)
  })

  it('uses exact content hashes rather than mtimes for freshness', async () => {
    const paths = await root()
    await installAlpha(paths)
    const original = await buildSearchIndex(paths)
    await writeIndex(paths, original)
    const before = await stat(join(paths.pages, 'alpha.md'))
    await writeFile(join(paths.pages, 'alpha.md'), (await readFile(join(paths.pages, 'alpha.md'))).toString().replace('knowledge', 'evidence'))
    await utimes(join(paths.pages, 'alpha.md'), before.atime, before.mtime)
    const rebuilt = await ensureSearchIndex(paths)
    expect(rebuilt.pageFingerprints[0]?.sha256).not.toBe(original.search.pageFingerprints[0]?.sha256)
  })

  it.each([
    ['missing state', async (paths: WikiPaths) => rm(paths.indexFile('state.json'))],
    ['malformed search', async (paths: WikiPaths) => writeFile(paths.indexFile('search.json'), '{')],
    ['unknown version', async (paths: WikiPaths) => writeFile(paths.indexFile('state.json'), '{"formatVersion":2}')],
    ['mismatched hash', async (paths: WikiPaths) => writeFile(paths.indexFile('state.json'), '{"formatVersion":1,"pages":[],"searchSha256":"0000000000000000000000000000000000000000000000000000000000000000"}\n')],
  ])('rebuilds a %s derived pair', async (_name, damage) => {
    const paths = await root()
    await installAlpha(paths)
    const expected = await buildSearchIndex(paths)
    await writeIndex(paths, expected)
    await damage(paths)
    await ensureSearchIndex(paths)
    expectCanonicalBytes(await readFile(paths.indexFile('search.json')), expected.searchBytes)
    expectCanonicalBytes(await readFile(paths.indexFile('state.json')), expected.stateBytes)
  })
})

describe('closed index codecs', () => {
  it('accepts a finite non-negative fractional average', () => {
    const value = validSearchObject(); value.averageSectionLength = 0.5
    expect(parseSearchIndex(encodeUtf8(JSON.stringify(value))).averageSectionLength).toBe(0.5)
  })

  it.each([-1, 0.5, Number.MAX_SAFE_INTEGER + 1])('rejects invalid integer count %s', (count) => {
    const value = validSearchObject(); value.documentCount = count
    expect(() => parseSearchIndex(encodeUtf8(JSON.stringify(value)))).toThrow(LlmWikiError)
  })

  it.each([-1, Number.NaN, Number.POSITIVE_INFINITY])('rejects invalid average %s', (average) => {
    const value = validSearchObject(); value.averageSectionLength = average
    const text = Number.isFinite(average) ? JSON.stringify(value) : JSON.stringify(value).replace('null', String(average))
    expect(() => parseSearchIndex(encodeUtf8(text))).toThrow(LlmWikiError)
  })

  it('rejects unknown fields, malformed hashes, unsafe lines, fractional counts, and incompatible versions', () => {
    const unknown = { ...validSearchObject(), extra: true }
    expect(() => parseSearchIndex(encodeUtf8(JSON.stringify(unknown)))).toThrow(/unknown fields/u)
    expect(() => parseIndexState(encodeUtf8('{"formatVersion":1,"pages":[],"searchSha256":"bad"}'))).toThrow(/invalid/u)
    const section = {
      pageId: 'alpha', title: 'Alpha', headingTrail: [], startLine: Number.MAX_SAFE_INTEGER + 1, sourceIds: [SOURCE], normalizedText: '', length: 0,
      titleTermFrequencies: [], headingTermFrequencies: [], bodyTermFrequencies: [],
    }
    const invalid = { ...validSearchObject(), documentCount: 1, sections: [section] }
    expect(() => parseSearchIndex(encodeUtf8(JSON.stringify(invalid)))).toThrow(/safe integer/u)
    const fractional = { ...validSearchObject(), documentFrequencies: [{ term: 'x', count: 1.5 }] }
    expect(() => parseSearchIndex(encodeUtf8(JSON.stringify(fractional)))).toThrow(/safe integer/u)
    expect(() => parseSearchIndex(encodeUtf8(JSON.stringify({ ...validSearchObject(), formatVersion: 2 })))).toThrow(/incompatible/u)
  })
})

describe('BM25 search', () => {
  it('applies field boosts, length normalization, query dedupe, stable ties, and caps', () => {
    const index = parseSearchIndex(encodeUtf8(JSON.stringify({
      formatVersion: 1,
      pageFingerprints: [],
      documentCount: 5,
      averageSectionLength: 5.2,
      documentFrequencies: [{ term: 'term', count: 5 }],
      sections: [
        { pageId: 'body', title: 'Body', headingTrail: [], startLine: 1, sourceIds: [SOURCE], normalizedText: 'term', length: 5, titleTermFrequencies: [], headingTermFrequencies: [], bodyTermFrequencies: [{ term: 'term', count: 1 }] },
        { pageId: 'heading', title: 'Heading', headingTrail: ['term'], startLine: 1, sourceIds: [SOURCE], normalizedText: 'text', length: 5, titleTermFrequencies: [], headingTermFrequencies: [{ term: 'term', count: 1 }], bodyTermFrequencies: [] },
        { pageId: 'title-a', title: 'term', headingTrail: [], startLine: 1, sourceIds: [SOURCE], normalizedText: 'text', length: 5, titleTermFrequencies: [{ term: 'term', count: 1 }], headingTermFrequencies: [], bodyTermFrequencies: [] },
        { pageId: 'title-a', title: 'term', headingTrail: [], startLine: 2, sourceIds: [SOURCE], normalizedText: 'text', length: 5, titleTermFrequencies: [{ term: 'term', count: 1 }], headingTermFrequencies: [], bodyTermFrequencies: [] },
        { pageId: 'title-b', title: 'term', headingTrail: [], startLine: 1, sourceIds: [SOURCE], normalizedText: 'text', length: 6, titleTermFrequencies: [{ term: 'term', count: 1 }], headingTermFrequencies: [], bodyTermFrequencies: [] },
      ],
    })))
    const once = searchBuiltIndex(index, 'term', { limit: 4, maxResults: 4, maxSnippetBytes: 100 })
    const repeated = searchBuiltIndex(index, 'term term TERM', { limit: 4, maxResults: 4, maxSnippetBytes: 100 })
    expect(once.map((hit) => [hit.pageId, hit.startLine])).toEqual([['title-a', 1], ['title-a', 2], ['title-b', 1], ['heading', 1]])
    expect(repeated).toEqual(once)
    expect(JSON.stringify(searchBuiltIndex(index, 'term', { limit: 4, maxResults: 4, maxSnippetBytes: 100 }))).toBe(JSON.stringify(once))
  })

  it('returns an empty result for absent terms and rejects tokenless queries and invalid limits', async () => {
    const paths = await root(); await installAlpha(paths)
    expect(await searchWiki(paths, 'absent', { limit: 5, maxResults: 20, maxSnippetBytes: 100 })).toEqual([])
    await expect(searchWiki(paths, '!!!', { limit: 5, maxResults: 20, maxSnippetBytes: 100 })).rejects.toMatchObject({ code: 'INVALID_PAGE' })
    await expect(searchWiki(paths, 'alpha', { limit: 0, maxResults: 20, maxSnippetBytes: 100 })).rejects.toMatchObject({ code: 'LIMIT_EXCEEDED' })
  })

  it('caps snippets by UTF-8 bytes without splitting a code point', async () => {
    const paths = await root(); await installAlpha(paths)
    const [hit] = await searchWiki(paths, '世界', { limit: 1, maxResults: 1, maxSnippetBytes: 14 })
    expect(hit).toBeDefined()
    expect(Buffer.byteLength(hit?.snippet ?? '', 'utf8')).toBeLessThanOrEqual(14)
    expect(Buffer.from(hit?.snippet ?? '').toString('utf8')).toBe(hit?.snippet)
  })
})

describe('filesystem and cancellation safety', () => {
  it('rejects symlinked page files and directories', async () => {
    const paths = await root()
    const outside = join(paths.root, 'outside.md')
    await writeFile(outside, await readFile(join(FIXTURES, 'corpus', 'alpha.md')))
    await symlink(outside, join(paths.pages, 'linked.md'))
    await expect(buildSearchIndex(paths)).rejects.toMatchObject({ code: 'UNSAFE_FILESYSTEM' })
    await rm(join(paths.pages, 'linked.md'))
    await mkdir(join(paths.root, 'outside-directory'))
    await symlink(join(paths.root, 'outside-directory'), join(paths.pages, 'linked-directory'))
    await expect(buildSearchIndex(paths)).rejects.toMatchObject({ code: 'UNSAFE_FILESYSTEM' })
  })

  it('maps pre-aborted build and search to the stable domain error', async () => {
    const paths = await root(); await installAlpha(paths)
    const controller = new AbortController(); controller.abort()
    await expect(buildSearchIndex(paths, controller.signal)).rejects.toMatchObject({ code: 'ABORTED' })
    await expect(searchWiki(paths, 'alpha', { limit: 1, maxResults: 1, maxSnippetBytes: 100, signal: controller.signal })).rejects.toMatchObject({ code: 'ABORTED' })
  })
})
