import { createHash } from 'node:crypto'
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { LlmWikiError } from '../src/errors.ts'
import { lintWiki, LINT_DIAGNOSTIC_CODES, serializeLintReport } from '../src/lint.ts'
import { buildSearchIndex, buildSearchIndexFromPages, writeIndex } from '../src/indexer.ts'
import type { SearchIndexV1 } from '../src/indexer.ts'
import { pageId, sourceId } from '../src/ids.ts'
import { renderPageMarkdown } from '../src/markdown.ts'
import { initializeWikiPaths } from '../src/paths.ts'
import type { WikiPaths } from '../src/paths.ts'
import type { LintDiagnostic, LintReport } from '../src/types.ts'

const roots = new Set<string>()
const SOURCE_CONTENT = Buffer.from('Primary evidence: ASCII, café, naïve, and 中文。\nSecond line ends with a newline.\n', 'utf8')
const SOURCE_ID = createHash('sha256').update(SOURCE_CONTENT).digest('hex')
const OTHER_SOURCE_ID = 'f'.repeat(64)
const FIXED_CAPTURE_TIME = '2026-01-02T03:04:05.000Z'

interface FileSnapshot {
  readonly bytes: string
  readonly mtimeMs: number
}

async function temporaryPaths(): Promise<WikiPaths> {
  const parent = await mkdtemp(join(tmpdir(), 'dsh-llmwiki-c05-'))
  roots.add(parent)
  return initializeWikiPaths('wiki', undefined, parent)
}

async function addSource(paths: WikiPaths, overrides: Record<string, unknown> = {}): Promise<void> {
  const directory = join(paths.sources, SOURCE_ID)
  await mkdir(directory)
  await writeFile(join(directory, 'content'), SOURCE_CONTENT)
  await writeFile(join(directory, 'metadata.json'), `${JSON.stringify({
    id: SOURCE_ID,
    name: 'Fixture source',
    mediaType: 'text/plain',
    byteCount: SOURCE_CONTENT.byteLength,
    capturedAt: FIXED_CAPTURE_TIME,
    ...overrides,
  }, null, 2)}\n`)
}

async function addPage(paths: WikiPaths, id: string, title = 'Beta', body = '# Beta\nEvidence.'): Promise<void> {
  const target = join(paths.pages, `${id}.md`)
  await mkdir(join(target, '..'), { recursive: true })
  await writeFile(target, renderPageMarkdown({ title, summary: 'Summary', sources: [sourceId(SOURCE_ID)] }, body))
}

async function makeCorpus(): Promise<WikiPaths> {
  const paths = await temporaryPaths()
  await writeFile(paths.schema, '# Wiki schema\n')
  await addSource(paths)
  await addPage(paths, 'beta')
  return paths
}

async function writeDerivedObjects(paths: WikiPaths, search: unknown, statePages: unknown): Promise<void> {
  const searchBytes = `${JSON.stringify(search, null, 2)}\n`
  await writeFile(paths.indexFile('search.json'), searchBytes)
  await writeFile(paths.indexFile('state.json'), `${JSON.stringify({
    formatVersion: 1,
    pages: statePages,
    searchSha256: createHash('sha256').update(searchBytes).digest('hex'),
  }, null, 2)}\n`)
}

async function snapshotTree(root: string): Promise<Map<string, FileSnapshot>> {
  const snapshot = new Map<string, FileSnapshot>()
  async function visit(directory: string): Promise<void> {
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
      const path = join(directory, entry.name)
      const key = relative(root, path).split('\\').join('/')
      const info = await lstat(path)
      if (entry.isDirectory()) await visit(path)
      else if (entry.isSymbolicLink()) snapshot.set(key, { bytes: '<symlink>', mtimeMs: info.mtimeMs })
      else snapshot.set(key, { bytes: createHash('sha256').update(await readFile(path)).digest('hex'), mtimeMs: info.mtimeMs })
    }
  }
  await visit(root)
  return snapshot
}

function codes(report: LintReport): readonly string[] {
  return report.diagnostics.map(({ code }) => code)
}

function withCorpusValidationHook(paths: WikiPaths, hook: () => Promise<void>, triggerCheck = 2): { readonly paths: WikiPaths; readonly rootChecks: () => number } {
  let rootChecks = 0
  let invoked = false
  return {
    paths: {
      ...paths,
      assertSafe: async (path, signal) => {
        await paths.assertSafe(path, signal)
        if (path === paths.pages) {
          rootChecks += 1
          if (rootChecks === triggerCheck && !invoked) {
            invoked = true
            await hook()
          }
        }
      },
    },
    rootChecks: () => rootChecks,
  }
}

function diagnosticMatcher(overrides: Partial<LintDiagnostic>[]): readonly Partial<LintDiagnostic>[] {
  const matchers = overrides.map((override) => expect.objectContaining(override) as unknown)
  const matcher: unknown = expect.arrayContaining(matchers)
  return matcher as readonly Partial<LintDiagnostic>[]
}

function isUnknownArray(value: unknown): value is readonly unknown[] {
  return Array.isArray(value)
}

function isUnknownRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !isUnknownArray(value)
}

type Mutable<T> = T extends readonly (infer Item)[]
  ? Mutable<Item>[]
  : T extends object
    ? { -readonly [Key in keyof T]: Mutable<T[Key]> }
    : T

function cloneFixture<T>(value: T): Mutable<T> {
  if (isUnknownArray(value)) {
    return value.map((item) => cloneFixture(item)) as Mutable<T>
  }
  if (isUnknownRecord(value)) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, cloneFixture(item)])) as Mutable<T>
  }
  return value as Mutable<T>
}

afterEach(async () => {
  const pending = [...roots]
  roots.clear()
  await Promise.all(pending.map(async (root) => rm(root, { recursive: true, force: true })))
})

describe('deterministic read-only lint', () => {
  it('matches the canonical fixture twice without exposing its absolute root or mutating any file', async () => {
    const paths = await temporaryPaths()
    await writeFile(paths.schema, '# Wiki schema\n')
    await mkdir(join(paths.sources, SOURCE_ID))
    await writeFile(join(paths.sources, SOURCE_ID, 'content'), await readFile(new URL('./fixtures/corpus/source-a.txt', import.meta.url)))
    const fixtureBytes = await readFile(new URL('./fixtures/corpus/source-a.txt', import.meta.url))
    await writeFile(join(paths.sources, SOURCE_ID, 'metadata.json'), `${JSON.stringify({ id: SOURCE_ID, name: 'Fixture source', mediaType: 'text/plain', byteCount: fixtureBytes.byteLength, capturedAt: FIXED_CAPTURE_TIME }, null, 2)}\n`)
    await writeFile(join(paths.pages, 'beta.md'), await readFile(new URL('./fixtures/corpus/beta.md', import.meta.url)))

    const before = await snapshotTree(paths.root)
    const first = await lintWiki(paths)
    const middle = await snapshotTree(paths.root)
    const second = await lintWiki(paths)
    const after = await snapshotTree(paths.root)
    const expected = await readFile(new URL('./fixtures/expected/lint.json', import.meta.url), 'utf8')

    expect(serializeLintReport(first)).toBe(expected)
    expect(serializeLintReport(second)).toBe(expected)
    expect(serializeLintReport(second)).toBe(serializeLintReport(first))
    expect(first.diagnostics.every(({ path }) => !path.startsWith(paths.root))).toBe(true)
    expect(middle).toEqual(before)
    expect(after).toEqual(before)
  })

  it('reports source hash, missing content, metadata byte count, malformed JSON, and unknown keys', async () => {
    const paths = await temporaryPaths()
    await writeFile(paths.schema, 'schema')
    const mismatched = join(paths.sources, 'a'.repeat(64))
    await mkdir(mismatched)
    await writeFile(join(mismatched, 'content'), 'wrong')
    await writeFile(join(mismatched, 'metadata.json'), '{bad json')
    const missing = join(paths.sources, 'b'.repeat(64))
    await mkdir(missing)
    await writeFile(join(missing, 'metadata.json'), '{}')
    await addSource(paths, { byteCount: 1, extra: true })

    const report = await lintWiki(paths)
    expect(codes(report)).toEqual(expect.arrayContaining([
      'SOURCE_HASH_MISMATCH',
      'SOURCE_CONTENT_MISSING',
      'SOURCE_METADATA_BYTE_COUNT_MISMATCH',
      'SOURCE_METADATA_MALFORMED',
      'SOURCE_METADATA_UNKNOWN_KEY',
      'SOURCE_METADATA_INVALID',
    ]))
  })
  it('diagnoses trim-empty source origins deterministically without mutating persisted bytes', async () => {
    const paths = await temporaryPaths()
    await writeFile(paths.schema, 'schema')
    await addSource(paths, { origin: '   ' })
    const before = await snapshotTree(paths.root)

    const first = await lintWiki(paths)
    const middle = await snapshotTree(paths.root)
    const second = await lintWiki(paths)
    const after = await snapshotTree(paths.root)
    const expected = {
      code: 'SOURCE_METADATA_INVALID',
      severity: 'error',
      path: `sources/${SOURCE_ID}/metadata.json`,
      message: 'Source metadata does not match the required schema.',
    }
    expect(first.diagnostics).toContainEqual(expected)
    expect(second).toEqual(first)
    expect(middle).toEqual(before)
    expect(after).toEqual(before)
    expect(JSON.stringify(first)).not.toContain(paths.root)
  })


  it('reports malformed pages, missing evidence, invalid page names, and duplicate normalized titles', async () => {
    const paths = await makeCorpus()
    await addPage(paths, 'nested/duplicate', 'ＢＥＴＡ')
    await writeFile(join(paths.pages, 'bad.MD'), 'not wiki markdown')
    await writeFile(join(paths.pages, 'malformed.md'), 'not wiki markdown')
    await writeFile(join(paths.pages, 'missing-source.md'), renderPageMarkdown({ title: 'Missing', summary: 'Summary', sources: [sourceId(OTHER_SOURCE_ID)] }, 'body'))

    const report = await lintWiki(paths)
    expect(codes(report)).toEqual(expect.arrayContaining(['DUPLICATE_TITLE', 'PAGE_INVALID_PATH', 'PAGE_INVALID_MARKDOWN', 'PAGE_MISSING_SOURCE']))
    expect(report.diagnostics.filter(({ code }) => code === 'DUPLICATE_TITLE').map(({ path }) => path)).toEqual([
      'pages/beta.md',
      'pages/nested/duplicate.md',
    ])
  })

  it('validates Markdown links and wikilinks without false positives for anchors, URLs, images, or fences', async () => {
    const paths = await makeCorpus()
    await addPage(paths, 'nested/target', 'Target')
    await addPage(paths, 'nested/links', 'Links', [
      '[valid](./target.md#part)',
      '[[target]]',
      '[broken](./absent.md)',
      '[[missing]]',
      '[escape](../../outside.md)',
      '[anchor](#local)',
      '[external](https://example.test/page.md)',
      '![image](./missing.png)',
      '```md',
      '[fenced](./missing.md)',
      '[[fenced-missing]]',
      '```',
    ].join('\n'))

    const report = await lintWiki(paths)
    expect(report.diagnostics.filter(({ code }) => code === 'BROKEN_PAGE_LINK')).toEqual([
      expect.objectContaining({ path: 'pages/nested/links.md', line: 10, message: 'Linked page "nested/absent" does not exist.' }),
      expect.objectContaining({ path: 'pages/nested/links.md', line: 11, message: 'Linked page "nested/missing" does not exist.' }),
    ])
    expect(report.diagnostics.filter(({ code }) => code === 'LINK_ESCAPES_PAGES')).toEqual([
      expect.objectContaining({ path: 'pages/nested/links.md', line: 12 }),
    ])
  })

  it('reports missing, malformed, incompatible, and stale derived indexes with stable severities', async () => {
    const paths = await makeCorpus()
    expect((await lintWiki(paths)).diagnostics).toContainEqual(expect.objectContaining({ code: 'INDEX_MISSING', severity: 'warning' }))

    await writeFile(paths.indexFile('state.json'), '{bad')
    await writeFile(paths.indexFile('search.json'), '{}')
    expect((await lintWiki(paths)).diagnostics).toContainEqual(expect.objectContaining({ code: 'INDEX_MALFORMED', severity: 'error', path: '.index/state.json' }))

    await writeFile(paths.indexFile('state.json'), '{"formatVersion":2}')
    expect((await lintWiki(paths)).diagnostics).toContainEqual(expect.objectContaining({ code: 'INDEX_INCOMPATIBLE', severity: 'error' }))

    const search = `${JSON.stringify({ formatVersion: 1, pageFingerprints: [], documentCount: 0, averageSectionLength: 0, documentFrequencies: [], sections: [] }, null, 2)}\n`
    await writeFile(paths.indexFile('search.json'), search)
    await writeFile(paths.indexFile('state.json'), `${JSON.stringify({ formatVersion: 1, pages: [], searchSha256: createHash('sha256').update(search).digest('hex') }, null, 2)}\n`)
    expect((await lintWiki(paths)).diagnostics).toContainEqual(expect.objectContaining({ code: 'INDEX_STALE', severity: 'warning' }))
  })

  it.each(['.md', 'nested/.md', 'foo.md.md', 'percent%2Fencoded.md'])(
    'preserves invalid-path diagnostics and classifies an existing index as stale for %s',
    async (relativePath) => {
      const paths = await makeCorpus()
      await writeIndex(paths, await buildSearchIndex(paths))
      const target = join(paths.pages, relativePath)
      await mkdir(join(target, '..'), { recursive: true })
      await writeFile(target, 'invalid path fixture\n')

      const report = await lintWiki(paths)

      expect(report.diagnostics).toContainEqual(expect.objectContaining({
        code: 'PAGE_INVALID_PATH',
        severity: 'error',
      }))
      expect(report.diagnostics).toContainEqual(expect.objectContaining({
        code: 'INDEX_STALE',
        severity: 'warning',
        path: '.index',
      }))
    },
  )

  it('diagnoses a canonical forged pair without mutating derived files', async () => {
    const paths = await makeCorpus()
    const built = await buildSearchIndex(paths)
    const pageBytes = await readFile(join(paths.pages, 'beta.md'))
    const section = built.search.sections[0]!
    const forged = buildSearchIndexFromPages([{
      pageId: section.pageId,
      bytes: pageBytes,
      title: section.title,
      sourceIds: section.sourceIds,
      body: 'forged phantom text',
      bodyStartLine: section.startLine,
    }])
    await writeFile(paths.indexFile('search.json'), forged.searchBytes)
    await writeFile(paths.indexFile('state.json'), forged.stateBytes)
    const before = await snapshotTree(paths.root)

    expect((await lintWiki(paths)).diagnostics).toContainEqual(expect.objectContaining({
      code: 'INDEX_STALE',
      severity: 'warning',
      path: '.index',
    }))
    expect(await snapshotTree(paths.root)).toEqual(before)
  })

  it('counts unique files examined across diagnostic and verification reads, including race-discovered pages', async () => {
    const paths = await makeCorpus()
    await writeIndex(paths, await buildSearchIndex(paths))
    const stable = await lintWiki(paths)
    expect(stable.filesExamined).toBe(6)

    const raced = withCorpusValidationHook(paths, async () => addPage(paths, 'added', 'Added'), 1)
    const report = await lintWiki(raced.paths)

    expect(raced.rootChecks()).toBeGreaterThanOrEqual(2)
    expect(report.filesExamined).toBe(7)
    expect(report.diagnostics).toContainEqual(expect.objectContaining({
      code: 'INDEX_STALE',
      message: 'Derived search index is stale or has a hash mismatch.',
    }))
  })

  it('propagates unexpected filesystem and programming failures from index verification', async () => {
    const paths = await makeCorpus()
    await writeIndex(paths, await buildSearchIndex(paths))
    const filesystemFailure = new LlmWikiError('UNSAFE_FILESYSTEM', 'wrapped failure', { cause: Object.assign(new Error('denied'), { code: 'EACCES' }) })
    const failedFilesystem = withCorpusValidationHook(paths, () => Promise.reject(filesystemFailure))
    await expect(lintWiki(failedFilesystem.paths)).rejects.toBe(filesystemFailure)

    const programmingFailure = new Error('verification bug')
    const failedProgramming = withCorpusValidationHook(paths, () => Promise.reject(programmingFailure))
    await expect(lintWiki(failedProgramming.paths)).rejects.toMatchObject({
      code: 'UNSAFE_FILESYSTEM',
      cause: programmingFailure,
    })
  })

  it.each(['in-place mutation', 'pathname replacement'] as const)('does not report a matching index fresh after %s following corpus inspection', async (change) => {
    const paths = await makeCorpus()
    await writeIndex(paths, await buildSearchIndex(paths))
    const target = join(paths.pages, 'beta.md')
    const raced = withCorpusValidationHook(paths, async () => {
      const changed = `${await readFile(target, 'utf8')}\nchanged after inspection\n`
      if (change === 'pathname replacement') await rm(target)
      await writeFile(target, changed)
    })

    const report = await lintWiki(raced.paths)

    expect(raced.rootChecks()).toBeGreaterThanOrEqual(2)
    expect(codes(report)).toContain('INDEX_STALE')
  })

  it('accepts a matching index when the inspected corpus does not mutate', async () => {
    const paths = await makeCorpus()
    await writeIndex(paths, await buildSearchIndex(paths))
    const stable = withCorpusValidationHook(paths, () => Promise.resolve())
    const before = await snapshotTree(paths.root)

    const report = await lintWiki(stable.paths)

    expect(stable.rootChecks()).toBeGreaterThanOrEqual(2)
    expect(codes(report)).not.toContain('INDEX_STALE')
    expect(await snapshotTree(paths.root)).toEqual(before)
  })

  it('preserves invalid and symlink page diagnostics when safe index construction fails', async () => {
    const paths = await makeCorpus()
    await writeIndex(paths, await buildSearchIndex(paths))
    await writeFile(join(paths.pages, 'malformed.md'), 'not wiki markdown')
    const outside = join(paths.root, 'outside.md')
    await writeFile(outside, 'outside')
    await symlink(outside, join(paths.pages, 'linked.md'))

    const report = await lintWiki(paths)

    expect(report.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'PAGE_INVALID_MARKDOWN', path: 'pages/malformed.md' }),
      expect.objectContaining({ code: 'UNSAFE_SYMLINK', path: 'pages/linked.md' }),
      expect.objectContaining({ code: 'INDEX_STALE', path: '.index' }),
    ]))
  })

  it('accepts a complete canonical index and diagnoses partial or wrong-type index layouts', async () => {
    const valid = await makeCorpus()
    await writeIndex(valid, await buildSearchIndex(valid))
    expect(codes(await lintWiki(valid))).not.toContain('INDEX_MISSING')
    expect(codes(await lintWiki(valid))).not.toContain('INDEX_MALFORMED')

    const partial = await makeCorpus()
    await writeFile(partial.indexFile('state.json'), '{}')
    expect(await lintWiki(partial)).toEqual(expect.objectContaining({
      diagnostics: diagnosticMatcher([{ code: 'INDEX_MISSING', path: '.index' }]),
    }))

    const wrongType = await makeCorpus()
    await rm(wrongType.index, { recursive: true })
    await writeFile(wrongType.index, 'not a directory')
    expect(codes(await lintWiki(wrongType))).toContain('REQUIRED_PATH_NOT_DIRECTORY')
  })

  it('rejects noncanonical bytes and malformed search numeric, order, hash, and section fields', async () => {
    const mutations: ((search: Mutable<SearchIndexV1>) => void)[] = [
      (search) => { search.documentCount = -1 },
      (search) => { search.averageSectionLength = Number.POSITIVE_INFINITY },
      (search) => { search.documentFrequencies = [{ term: 'z', count: 1 }, { term: 'a', count: 1 }] },
      (search) => { search.pageFingerprints = [{ pageId: 'beta', sha256: 'bad' }] },
      (search) => { search.sections = [{ ...search.sections[0]!, startLine: 0 }] },
      (search) => { search.sections = [{ ...search.sections[0]!, sourceIds: [SOURCE_ID, SOURCE_ID] }] },
      (search) => { search.sections = [{ ...search.sections[0]!, bodyTermFrequencies: [{ term: 'x', count: 0 }] }] },
    ]

    for (const mutate of mutations) {
      const paths = await makeCorpus()
      const built = await buildSearchIndex(paths)
      const search = cloneFixture(built.search)
      mutate(search)
      await writeDerivedObjects(paths, search, built.state.pages)
      expect(await lintWiki(paths)).toEqual(expect.objectContaining({
        diagnostics: diagnosticMatcher([{ code: 'INDEX_MALFORMED', path: '.index/search.json' }]),
      }))
    }

    const noncanonicalState = await makeCorpus()
    const built = await buildSearchIndex(noncanonicalState)
    await writeIndex(noncanonicalState, built)
    await writeFile(noncanonicalState.indexFile('state.json'), JSON.stringify(built.state))
    expect(await lintWiki(noncanonicalState)).toEqual(expect.objectContaining({
      diagnostics: diagnosticMatcher([{ code: 'INDEX_MALFORMED', path: '.index/state.json', message: 'Index state is not canonically serialized.' }]),
    }))

    const noncanonicalSearch = await makeCorpus()
    const second = await buildSearchIndex(noncanonicalSearch)
    const compactSearch = JSON.stringify(second.search)
    await writeFile(noncanonicalSearch.indexFile('search.json'), compactSearch)
    await writeFile(noncanonicalSearch.indexFile('state.json'), `${JSON.stringify({ ...second.state, searchSha256: createHash('sha256').update(compactSearch).digest('hex') }, null, 2)}\n`)
    expect(await lintWiki(noncanonicalSearch)).toEqual(expect.objectContaining({
      diagnostics: diagnosticMatcher([{ code: 'INDEX_MALFORMED', path: '.index/search.json', message: 'Search index is not canonically serialized.' }]),
    }))
  })

  it('reports malformed search JSON and search-version incompatibility at the search path', async () => {
    const malformed = await makeCorpus()
    await writeFile(malformed.indexFile('state.json'), '{}')
    await writeFile(malformed.indexFile('search.json'), '{')
    expect(await lintWiki(malformed)).toEqual(expect.objectContaining({
      diagnostics: diagnosticMatcher([{ code: 'INDEX_MALFORMED', path: '.index/search.json' }]),
    }))

    const incompatible = await makeCorpus()
    await writeFile(incompatible.indexFile('state.json'), '{}')
    await writeFile(incompatible.indexFile('search.json'), '{"formatVersion":2}')
    expect(await lintWiki(incompatible)).toEqual(expect.objectContaining({
      diagnostics: diagnosticMatcher([{ code: 'INDEX_INCOMPATIBLE', path: '.index/search.json' }]),
    }))
  })

  it('reports symlinks and abandoned atomic files but never follows or deletes them', async () => {
    const paths = await makeCorpus()
    const outside = join(paths.root, '..', 'outside')
    await writeFile(outside, 'outside')
    await symlink(outside, join(paths.pages, 'escape.md'))
    const abandoned = join(paths.pages, '.beta.md.tmp-123-abcdef')
    await writeFile(abandoned, 'partial')

    const before = await snapshotTree(paths.root)
    const report = await lintWiki(paths)
    expect(codes(report)).toEqual(expect.arrayContaining(['UNSAFE_SYMLINK', 'TEMP_FILE_ABANDONED']))
    expect(await snapshotTree(paths.root)).toEqual(before)
  })

  it('never follows symlinked index files and reports only their global relative-path diagnostics', async () => {
    const paths = await makeCorpus()
    const outsideState = join(paths.root, '..', 'private-state.json')
    const outsideSearch = join(paths.root, '..', 'private-search.json')
    await writeFile(outsideState, '{private state')
    await writeFile(outsideSearch, '{private search')
    await symlink(outsideState, paths.indexFile('state.json'))
    await symlink(outsideSearch, paths.indexFile('search.json'))

    const before = await snapshotTree(paths.root)
    const report = await lintWiki(paths)

    expect(report.diagnostics).toEqual([
      expect.objectContaining({ code: 'UNSAFE_SYMLINK', severity: 'error', path: '.index/search.json' }),
      expect.objectContaining({ code: 'UNSAFE_SYMLINK', severity: 'error', path: '.index/state.json' }),
    ])
    expect(report.errorCount).toBe(2)
    expect(report.warningCount).toBe(0)
    expect(report.filesExamined).toBe(4)
    expect(serializeLintReport(report)).not.toContain(paths.root)
    expect(serializeLintReport(report)).not.toContain(outsideState)
    expect(serializeLintReport(report)).not.toContain(outsideSearch)
    expect(await snapshotTree(paths.root)).toEqual(before)
    expect(await readFile(outsideState, 'utf8')).toBe('{private state')
    expect(await readFile(outsideSearch, 'utf8')).toBe('{private search')
  })

  it('reports each symlinked required top-level directory exactly once without following it', async () => {
    const cases = [
      { key: 'sources', expectedPath: 'sources', filesExamined: 2, errorCount: 2, warningCount: 1 },
      { key: 'pages', expectedPath: 'pages', filesExamined: 3, errorCount: 1, warningCount: 2 },
    ] as const

    for (const testCase of cases) {
      const paths = await makeCorpus()
      const requiredPath = paths[testCase.key]
      const outside = join(paths.root, '..', `private-${testCase.key}`)
      await mkdir(outside)
      await writeFile(join(outside, 'secret'), `private ${testCase.key}`)
      await rm(requiredPath, { recursive: true })
      await symlink(outside, requiredPath)

      const before = await snapshotTree(paths.root)
      const report = await lintWiki(paths)
      const unsafe = report.diagnostics.filter(({ code }) => code === 'UNSAFE_SYMLINK')

      expect(unsafe).toEqual([
        expect.objectContaining({ severity: 'error', path: testCase.expectedPath }),
      ])
      expect(report.errorCount).toBe(testCase.errorCount)
      expect(report.warningCount).toBe(testCase.warningCount)
      expect(report.filesExamined).toBe(testCase.filesExamined)
      expect(serializeLintReport(report)).not.toContain(paths.root)
      expect(serializeLintReport(report)).not.toContain(outside)
      expect(await snapshotTree(paths.root)).toEqual(before)
      expect(await readFile(join(outside, 'secret'), 'utf8')).toBe(`private ${testCase.key}`)
    }
  })

  it('sorts diagnostics by path, line with missing last, code, and message', async () => {
    const paths = await makeCorpus()
    await addPage(paths, 'a', 'A', '[z](missing.md)\n[y](../escape.md)')
    await writeFile(join(paths.pages, '.a.md.tmp-4-abcd'), 'temp')
    const report = await lintWiki(paths)
    const sorted = [...report.diagnostics].sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : (left.line ?? Infinity) - (right.line ?? Infinity) || (left.code < right.code ? -1 : left.code > right.code ? 1 : left.message < right.message ? -1 : left.message > right.message ? 1 : 0))
    expect(report.diagnostics).toEqual(sorted)
    expect(report.errorCount + report.warningCount).toBe(report.diagnostics.length)
  })

  it('emits every root, layout, UTF-8, source-type, metadata, and orphan diagnostic code', async () => {
    const seen = new Set<string>()
    const collect = async (paths: WikiPaths): Promise<void> => {
      for (const code of codes(await lintWiki(paths))) seen.add(code)
    }

    const missingRoot = await makeCorpus()
    await rm(missingRoot.root, { recursive: true })
    await collect(missingRoot)

    const fileRoot = await makeCorpus()
    await rm(fileRoot.root, { recursive: true })
    await writeFile(fileRoot.root, 'file')
    await collect(fileRoot)

    const missingLayout = await makeCorpus()
    await rm(missingLayout.sources, { recursive: true })
    await rm(missingLayout.schema)
    await collect(missingLayout)

    const wrongSchemaType = await makeCorpus()
    await rm(wrongSchemaType.schema)
    await mkdir(wrongSchemaType.schema)
    await collect(wrongSchemaType)

    const invalidUtf8 = await makeCorpus()
    await writeFile(invalidUtf8.schema, Uint8Array.from([0xc3, 0x28]))
    await collect(invalidUtf8)

    const sourceShapes = await makeCorpus()
    await mkdir(join(sourceShapes.sources, 'not-a-source-id'))
    const sourceDirectory = join(sourceShapes.sources, SOURCE_ID)
    await rm(join(sourceDirectory, 'content'))
    await mkdir(join(sourceDirectory, 'content'))
    await rm(join(sourceDirectory, 'metadata.json'))
    await mkdir(join(sourceDirectory, 'metadata.json'))
    await collect(sourceShapes)

    const missingMetadata = await makeCorpus()
    await rm(join(missingMetadata.sources, SOURCE_ID, 'metadata.json'))
    await collect(missingMetadata)

    const mismatchedMetadata = await makeCorpus()
    await writeFile(join(mismatchedMetadata.sources, SOURCE_ID, 'metadata.json'), `${JSON.stringify({ id: OTHER_SOURCE_ID, name: 'name', mediaType: 'text/plain', byteCount: SOURCE_CONTENT.byteLength, capturedAt: FIXED_CAPTURE_TIME }, null, 2)}\n`)
    await collect(mismatchedMetadata)

    const orphans = await makeCorpus()
    await addPage(orphans, 'second', 'Second')
    await collect(orphans)

    expect([...seen]).toEqual(expect.arrayContaining([
      'ROOT_MISSING', 'ROOT_NOT_DIRECTORY', 'REQUIRED_DIRECTORY_MISSING', 'REQUIRED_PATH_NOT_DIRECTORY',
      'SCHEMA_MISSING', 'INVALID_UTF8', 'SOURCE_INVALID_ID', 'SOURCE_CONTENT_NOT_FILE',
      'SOURCE_METADATA_MISSING', 'SOURCE_METADATA_NOT_FILE', 'SOURCE_METADATA_ID_MISMATCH', 'ORPHAN_PAGE',
    ]))
  })

  it('maps every stable diagnostic code to a tested invariant family', () => {
    const coverage: Record<(typeof LINT_DIAGNOSTIC_CODES)[number], 'lint' | 'operation-time'> = {
      ROOT_MISSING: 'lint', ROOT_NOT_DIRECTORY: 'lint', UNSAFE_SYMLINK: 'lint',
      REQUIRED_DIRECTORY_MISSING: 'lint', REQUIRED_PATH_NOT_DIRECTORY: 'lint', SCHEMA_MISSING: 'lint', INVALID_UTF8: 'lint',
      SOURCE_INVALID_ID: 'lint', SOURCE_CONTENT_MISSING: 'lint', SOURCE_CONTENT_NOT_FILE: 'lint', SOURCE_HASH_MISMATCH: 'lint',
      SOURCE_METADATA_MISSING: 'lint', SOURCE_METADATA_NOT_FILE: 'lint', SOURCE_METADATA_MALFORMED: 'lint', SOURCE_METADATA_INVALID: 'lint',
      SOURCE_METADATA_UNKNOWN_KEY: 'lint', SOURCE_METADATA_ID_MISMATCH: 'lint', SOURCE_METADATA_BYTE_COUNT_MISMATCH: 'lint', SOURCE_UNREFERENCED: 'lint',
      PAGE_INVALID_PATH: 'lint', PAGE_INVALID_MARKDOWN: 'lint', PAGE_MISSING_SOURCE: 'lint', DUPLICATE_TITLE: 'lint', ORPHAN_PAGE: 'lint',
      LINK_ESCAPES_PAGES: 'lint', BROKEN_PAGE_LINK: 'lint', INDEX_MISSING: 'lint', INDEX_MALFORMED: 'lint',
      INDEX_INCOMPATIBLE: 'lint', INDEX_STALE: 'lint', TEMP_FILE_ABANDONED: 'lint',
    }
    expect(Object.keys(coverage).sort()).toEqual([...LINT_DIAGNOSTIC_CODES].sort())
  })

  it('honors cancellation before and during traversal using the stable domain error', async () => {
    const paths = await makeCorpus()
    const controller = new AbortController()
    controller.abort()
    await expect(lintWiki(paths, controller.signal)).rejects.toEqual(expect.objectContaining({ code: 'ABORTED' }))

    let checks = 0
    const signal = { get aborted() { checks += 1; return checks > 4 } } as AbortSignal
    await expect(lintWiki(paths, signal)).rejects.toBeInstanceOf(LlmWikiError)
    await expect(lintWiki(paths, signal)).rejects.toMatchObject({ code: 'ABORTED' })
  })
})

describe('catalog structural diagnostics', () => {
  it('reports and clears SOURCE_UNREFERENCED without mutating the corpus', async () => {
    const paths = await makeCorpus()
    const extraContent = Buffer.from('Unreferenced evidence')
    const extraId = createHash('sha256').update(extraContent).digest('hex')
    const extraDirectory = join(paths.sources, extraId)
    await mkdir(extraDirectory)
    await writeFile(join(extraDirectory, 'content'), extraContent)
    await writeFile(join(extraDirectory, 'metadata.json'), `${JSON.stringify({ id: extraId, name: 'Extra', mediaType: 'text/plain', byteCount: extraContent.byteLength, capturedAt: FIXED_CAPTURE_TIME }, null, 2)}\n`)
    const before = await snapshotTree(paths.root)
    const first = await lintWiki(paths)
    expect(first.diagnostics).toContainEqual({ code: 'SOURCE_UNREFERENCED', severity: 'warning', path: `sources/${extraId}/metadata.json`, message: 'Source is not referenced by any valid page.' })
    expect(await snapshotTree(paths.root)).toEqual(before)

    await writeFile(paths.page(pageId('beta')), renderPageMarkdown({ title: 'Beta', summary: 'Summary', sources: [sourceId(SOURCE_ID), sourceId(extraId)] }, '# Beta\nEvidence.'))
    expect((await lintWiki(paths)).diagnostics.some(diagnostic => diagnostic.code === 'SOURCE_UNREFERENCED' && diagnostic.path.includes(extraId))).toBe(false)
    await writeFile(paths.page(pageId('beta')), renderPageMarkdown({ title: 'Beta', summary: 'Summary', sources: [sourceId(SOURCE_ID)] }, '# Beta\nEvidence.'))
    expect((await lintWiki(paths)).diagnostics).toContainEqual({ code: 'SOURCE_UNREFERENCED', severity: 'warning', path: `sources/${extraId}/metadata.json`, message: 'Source is not referenced by any valid page.' })
  })

  it('counts source references only from canonical valid pages without mutating the corpus', async () => {
    const paths = await makeCorpus()
    const extraContent = Buffer.from('Evidence cited by a noncanonical page')
    const extraId = createHash('sha256').update(extraContent).digest('hex')
    const extraDirectory = join(paths.sources, extraId)
    await mkdir(extraDirectory)
    await writeFile(join(extraDirectory, 'content'), extraContent)
    await writeFile(join(extraDirectory, 'metadata.json'), `${JSON.stringify({ id: extraId, name: 'Extra', mediaType: 'text/plain', byteCount: extraContent.byteLength, capturedAt: FIXED_CAPTURE_TIME }, null, 2)}\n`)

    const target = paths.page(pageId('beta'))
    const canonical = renderPageMarkdown({ title: 'Beta', summary: 'Summary', sources: [sourceId(SOURCE_ID), sourceId(extraId)] }, '# Beta\nEvidence.')
    await writeFile(target, canonical.replace(/title: (.*)\nsummary: (.*)\n/u, 'summary: $2\ntitle: $1\n'))
    const noncanonicalSnapshot = await snapshotTree(paths.root)
    const noncanonicalReport = await lintWiki(paths)
    expect(noncanonicalReport.diagnostics).toEqual(expect.arrayContaining([
      { code: 'PAGE_INVALID_MARKDOWN', severity: 'error', path: 'pages/beta.md', message: 'Page is not valid canonical wiki Markdown.' },
      { code: 'SOURCE_UNREFERENCED', severity: 'warning', path: `sources/${extraId}/metadata.json`, message: 'Source is not referenced by any valid page.' },
    ]))
    expect(await snapshotTree(paths.root)).toEqual(noncanonicalSnapshot)

    await writeFile(target, canonical)
    const canonicalSnapshot = await snapshotTree(paths.root)
    const canonicalReport = await lintWiki(paths)
    expect(canonicalReport.diagnostics.some(({ code, path }) => code === 'PAGE_INVALID_MARKDOWN' && path === 'pages/beta.md')).toBe(false)
    expect(canonicalReport.diagnostics.some(({ code, path }) => code === 'SOURCE_UNREFERENCED' && path === `sources/${extraId}/metadata.json`)).toBe(false)
    expect(await snapshotTree(paths.root)).toEqual(canonicalSnapshot)
  })

  it.each([
    ['reordered frontmatter', (value: string) => value.replace(/title: (.*)\nsummary: (.*)\n/u, 'summary: $2\ntitle: $1\n')],
    ['alternate quoted serialization', (value: string) => value.replace('title: "Beta"', 'title: "\\u0042eta"')],
    ['CRLF', (value: string) => value.replaceAll('\n', '\r\n')],
    ['extra blank lines', (value: string) => `${value}\n`],
    ['missing final newline', (value: string) => value.slice(0, -1)],
  ])('diagnoses parseable noncanonical bytes: %s', async (_name, mutate) => {
    const paths = await makeCorpus()
    const target = paths.page(pageId('beta'))
    const canonical = await readFile(target, 'utf8')
    await writeFile(target, mutate(canonical))
    const before = await snapshotTree(paths.root)
    const report = await lintWiki(paths)
    expect(report.diagnostics).toContainEqual({ code: 'PAGE_INVALID_MARKDOWN', severity: 'error', path: 'pages/beta.md', message: 'Page is not valid canonical wiki Markdown.' })
    expect(await snapshotTree(paths.root)).toEqual(before)
  })
})
