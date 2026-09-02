import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import * as fsPromises from 'node:fs/promises'
import { mkdir, mkdtemp, readFile, readdir, rename, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Config, resolveConfig } from '../src/config.ts'
import { LlmWikiError } from '../src/errors.ts'
import { buildSearchIndexFromPages, parseSearchIndex } from '../src/indexer.ts'
import { pageId } from '../src/ids.ts'
import { encodeUtf8, renderPageMarkdown } from '../src/markdown.ts'
import { createServiceHarness } from './harness.ts'
import { catalogDescriptorAlias, LlmWikiService } from '../src/service.ts'
import type { WikiPaths } from '../src/paths.ts'
import type { SourceReceipt } from '../src/types.ts'

import type { ServiceHarness } from './harness.ts'

vi.mock('node:fs/promises', { spy: true })

const harnesses: ServiceHarness[] = []
const sha256 = (bytes: Uint8Array | string): string => createHash('sha256').update(bytes).digest('hex')
const hasErrorCode = (value: unknown): value is Error & { readonly code: string } =>
  value instanceof Error && 'code' in value && typeof value.code === 'string'
const hasMkfifo = (() => {
  if (process.platform !== 'linux') return false
  try {
    execFileSync('sh', ['-c', 'command -v mkfifo'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
})()


function observeRejection<T>(promise: Promise<T>): Promise<T> {
  void promise.catch(() => undefined)
  return promise
}

async function harness(config = {}): Promise<ServiceHarness> {
  const value = await createServiceHarness(config)
  harnesses.push(value)
  return value
}

async function addEvidence(value: ServiceHarness, content = 'Evidence café 漢字\n'): Promise<SourceReceipt> {
  return value.service.addSource({ name: 'evidence.txt', content, origin: 'conversation' })
}

async function addPage(value: ServiceHarness, source?: SourceReceipt) {
  const evidence = source ?? await addEvidence(value)
  const id = pageId('notes/alpha')
  const input = {
    id,
    title: 'Alpha',
    summary: 'Grounded summary',
    sources: [evidence.id],
    body: '# Finding\n\nEvidence café 漢字.\n',
  }
  return { evidence, id, input, receipt: await value.service.upsertPage(input) }
}

async function expectStableFailure(operation: Promise<unknown>, code: string, root: string): Promise<LlmWikiError> {
  const error: unknown = await operation.then(
    () => undefined,
    (cause: unknown) => cause,
  )
  if (!(error instanceof LlmWikiError)) throw new TypeError('operation did not reject with LlmWikiError')
  expect(error).toMatchObject({ code })
  expect(error.message).not.toContain(root)
  expect(JSON.stringify(error)).not.toContain(root)
  return error
}

interface TreeSnapshotEntry {
  readonly path: string
  readonly kind: 'directory' | 'file'
  readonly bytes?: string
  readonly mtimeMs: number
}

async function snapshotTree(root: string): Promise<readonly TreeSnapshotEntry[] | null> {
  let rootInfo
  try {
    rootInfo = await stat(root)
  } catch (cause) {
    if (hasErrorCode(cause) && cause.code === 'ENOENT') return null
    throw cause
  }

  const snapshot: TreeSnapshotEntry[] = [{ path: '.', kind: rootInfo.isDirectory() ? 'directory' : 'file', mtimeMs: rootInfo.mtimeMs }]
  if (!rootInfo.isDirectory()) {
    snapshot[0] = { ...snapshot[0], bytes: (await readFile(root)).toString('base64') }
    return snapshot
  }

  async function visit(directory: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true })
    entries.sort((left, right) => left.name.localeCompare(right.name, 'en'))
    for (const entry of entries) {
      const absolute = join(directory, entry.name)
      const path = relative(root, absolute).split('\\').join('/')
      const info = await stat(absolute)
      if (entry.isDirectory()) {
        snapshot.push({ path, kind: 'directory', mtimeMs: info.mtimeMs })
        await visit(absolute)
      } else {
        snapshot.push({ path, kind: 'file', bytes: (await readFile(absolute)).toString('base64'), mtimeMs: info.mtimeMs })
      }
    }
  }

  await visit(root)
  return snapshot
}

afterEach(async () => {
  const pending = harnesses.splice(0)
  await Promise.all(pending.map(async value => {
    try {
      await value.dispose()
    } finally {
      await rm(value.temporaryDirectory, { recursive: true, force: true })
    }
  }))
})

describe('configuration and lifecycle', () => {
  it('resolves immutable defaults without exposing mutable service configuration', async () => {
    expect(resolveConfig()).toEqual({
      root: '.llmwiki',
      maxSourceBytes: 2 * 1024 * 1024,
      maxPageBytes: 512 * 1024,
      maxResults: 20,
      maxSnippetBytes: 1200,
      commandDiagnosticLimit: 20,
    })
    expect(Object.isFrozen(resolveConfig())).toBe(true)
    const value = await harness()
    expect('config' in value.service).toBe(false)
  })

  it('declares exact defaults, ranges, integer constraints, and rejects unknown configuration', () => {
    expect(Config({})).toEqual(resolveConfig())
    for (const [name, value] of [
      ['maxSourceBytes', 0], ['maxPageBytes', 0], ['maxResults', 0], ['maxResults', 101],
      ['maxSnippetBytes', 63], ['maxSnippetBytes', 16_385], ['commandDiagnosticLimit', 0],
      ['commandDiagnosticLimit', 101], ['maxResults', 1.5],
    ] as const) expect(() => Config({ [name]: value })).toThrow()
    expect(() => Config({ root: '' })).toThrow()
    const unexpectedConfig: Config & { readonly unexpected: boolean } = { unexpected: true }
    expect(() => Config(unexpectedConfig)).toThrow()
  })

  it('supports schema call and construction defaults while rejecting every unknown own key', () => {
    expect(Config()).toEqual(resolveConfig())
    expect(new Config()).toEqual(resolveConfig())
    expect(new Config({ maxResults: 7 })).toMatchObject({ maxResults: 7 })

    expect(Config(null)).toEqual(resolveConfig())
    expect(() => Config('invalid' as never)).toThrow()
    expect(() => new Config({ unknown: true } as never)).toThrowError('unknown config key unknown')

    const symbol = Symbol('private')
    expect(() => Config({ [symbol]: true })).toThrowError('unknown config key Symbol(private)')
  })

  it('captures the absolute cwd at construction and ignores later cwd changes', async () => {
    const original = process.cwd()
    const base = await harness()
    const activationCwd = join(base.temporaryDirectory, 'activation')
    const laterCwd = join(base.temporaryDirectory, 'later')
    await mkdir(activationCwd)
    await mkdir(laterCwd)
    process.chdir(activationCwd)
    let value: ServiceHarness
    try {
      value = await harness({ root: 'relative-wiki' })
    } finally {
      process.chdir(original)
    }
    process.chdir(laterCwd)
    try {
      await expect(value.service.status()).resolves.toMatchObject({ initialized: false })
      await value.service.addSource({ name: 'cwd evidence', content: 'captured activation root' })
    } finally {
      process.chdir(original)
    }
    expect((await stat(join(activationCwd, 'relative-wiki'))).isDirectory()).toBe(true)
    const missingDirectoryError: unknown = await stat(join(laterCwd, 'relative-wiki')).then(
      () => undefined,
      (cause: unknown) => cause,
    )
    if (!hasErrorCode(missingDirectoryError)) throw new TypeError('missing directory did not reject with an error code')
    expect(missingDirectoryError.code).toBe('ENOENT')
  })

  it('shares one durable root across sequential activations and isolates distinct roots', async () => {
    const temporaryDirectory = await mkdtemp(join(tmpdir(), 'dsh-llmwiki-shared-root-'))
    const sharedRoot = join(temporaryDirectory, 'shared')
    const distinctRoot = join(temporaryDirectory, 'distinct')
    const mounted: ServiceHarness[] = []
    try {
      const writer = await createServiceHarness({ root: sharedRoot })
      const reader = await createServiceHarness({ root: sharedRoot })
      mounted.push(writer, reader)

      const source = await writer.service.addSource({ name: 'sequential writer', content: 'shared durable evidence' })
      await expect(reader.service.readSource(source.id)).resolves.toMatchObject({ id: source.id, content: 'shared durable evidence' })
      await expect(reader.service.listSources()).resolves.toMatchObject({ items: [{ id: source.id }] })

      await writer.dispose()
      await reader.dispose()
      const remounted = await createServiceHarness({ root: sharedRoot })
      const isolated = await createServiceHarness({ root: distinctRoot })
      mounted.push(remounted, isolated)
      await expect(remounted.service.readSource(source.id)).resolves.toMatchObject({ id: source.id, content: 'shared durable evidence' })
      await expect(remounted.service.listSources()).resolves.toMatchObject({ items: [{ id: source.id }] })
      await expect(isolated.service.status()).resolves.toMatchObject({ initialized: false, sourceCount: 0 })
      await expect(isolated.service.listSources()).resolves.toMatchObject({ items: [] })
    } finally {
      await Promise.allSettled(mounted.map(value => value.dispose()))
      await rm(temporaryDirectory, { recursive: true, force: true })
    }
  })

  it('creates the exact human-owned default schema only after authorized fresh-root source preservation', async () => {
    const value = await harness()
    await expect(value.service.status()).resolves.toEqual({
      initialized: false,
      sourceCount: 0,
      pageCount: 0,
      schemaText: null,
      index: { present: false, fresh: false, formatVersion: null, sectionCount: 0 },
    })
    await expect(snapshotTree(value.root)).resolves.toBeNull()
    await value.service.addSource({ name: 'authorized schema initialization', content: 'explicitly authorized source preservation' })

    const expected = `# LLM Wiki Schema

This schema is human-owned organization and workflow guidance. The plugin creates it only when absent, exposes it through status, and never rewrites it; system and user instructions take precedence. There is no schema mutation API; schema evolution remains intentionally unresolved pending authorization/confirmation, visible audit evidence, and optimistic-concurrency/lost-update product decisions.

Pages are durable source-linked Markdown notes. Keep titles and summaries concise, organize related claims under headings, maintain useful page links, preserve material disagreements and dated supersessions, and cite every relevant existing immutable source ID in frontmatter. Source citation proves record existence, not claim-level support.

Evidence maintenance: call llmwiki_status first and read schemaText when non-null. On a fresh root, status returns schemaText null without creating storage; supplied material alone is not authorization to preserve it. Only with explicit authorization to preserve the source, call llmwiki_add_source to initialize storage, then call status again and read the schema before classification or page maintenance. List sources and pages, then search and read relevant records before writing. Only with explicit authorization to preserve candidate material, add it if the fresh-root branch did not, then classify its effect as new, update, contradiction, or no material change. Separately, only when the user request authorizes maintenance, update every materially affected page, preserve disagreements and links, and cite existing source IDs. Run llmwiki_lint unconditionally before any semantic-review pass, including read-only, no-write, and no-material-change cases; it is structural only and never repairs artifacts or makes semantic judgments. After any authorized durable updates, rerun structural lint.

Semantic review (separate from structural lint): only after the unconditional structural lint, list pages and sources. Select and state the review scope, compare dated and qualified claims across every scoped page, every source it cites, and every new candidate source relevant to that scope, and report classified contradiction, superseded, unsupported, and missing-link findings with visible page and source IDs. These semantic findings are agent judgments, never llmwiki_lint diagnostics. Only when the user request authorizes maintenance, update affected pages while preserving disagreements or dated supersessions and maintain links; after any such durable updates, rerun structural lint.
`
    expect(await readFile(join(value.root, 'schema.md'), 'utf8')).toBe(expected)
    await expect(value.service.status()).resolves.toMatchObject({ initialized: true, schemaText: expected })
  })

  it('reports partial layouts without mutating them and lets a writer finish initialization', async () => {
    const value = await harness()
    await mkdir(value.root, { recursive: true })
    await mkdir(join(value.root, 'sources'))
    await writeFile(join(value.root, 'schema.md'), '# User schema\n')
    const before = await snapshotTree(value.root)
    const schemaBytes = await readFile(join(value.root, 'schema.md'))

    const first = await value.service.status()
    const second = await value.service.status()

    expect(first).toEqual({
      initialized: false,
      sourceCount: 0,
      pageCount: 0,
      schemaText: '# User schema\n',
      index: { present: false, fresh: false, formatVersion: null, sectionCount: 0 },
    })
    expect(second).toEqual(first)
    expect(await snapshotTree(value.root)).toEqual(before)

    await addEvidence(value)
    await expect(value.service.status()).resolves.toMatchObject({ initialized: true, sourceCount: 1, schemaText: '# User schema\n' })
    expect(await readFile(join(value.root, 'schema.md'))).toEqual(schemaBytes)
    const service = value.service
    await Promise.resolve(value.fiber.dispose())
    expect(value.ctx.llmwiki).toBeUndefined()
    await expectStableFailure(service.status(), 'NOT_INITIALIZED', value.root)
  })
})

describe('immutable sources and byte-safe reads', () => {
  it('persists exact content, canonical metadata, and deduplicates without rewriting', async () => {
    const value = await harness()
    const content = 'ASCII café 漢字\n'
    const first = await value.service.addSource({ name: 'first', content, mediaType: 'text/plain; charset=utf-8', origin: 'chat' })
    const directory = join(value.root, 'sources', first.id)
    const contentBytes = await readFile(join(directory, 'content'))
    const metadataBytes = await readFile(join(directory, 'metadata.json'))
    expect(first.id).toBe(sha256(contentBytes))
    expect(metadataBytes.toString()).toBe(`${JSON.stringify(first.metadata, null, 2)}\n`)
    const duplicate = await value.service.addSource({ name: 'changed', content })
    expect(duplicate).toEqual({ id: first.id, deduplicated: true, metadata: first.metadata })
    expect(await readFile(join(directory, 'metadata.json'))).toStrictEqual(metadataBytes)
  })

  it('preserves meaningful spaced origins and immutable metadata across dedupe', async () => {
    const value = await harness()
    const content = ' \t\n'
    const origin = '  conversation excerpt  '
    const first = await value.service.addSource({ name: 'first', content, mediaType: 'text/plain', origin })
    const directory = join(value.root, 'sources', first.id)
    const contentBytes = await readFile(join(directory, 'content'))
    const metadataBytes = await readFile(join(directory, 'metadata.json'))
    expect(first.metadata.origin).toBe(origin)
    expect(contentBytes).toStrictEqual(Buffer.from(encodeUtf8(content)))

    const duplicate = await value.service.addSource({ name: 'changed', content, mediaType: 'application/octet-stream', origin: 'different' })
    expect(duplicate).toEqual({ id: first.id, deduplicated: true, metadata: first.metadata })
    expect(await readFile(join(directory, 'content'))).toStrictEqual(contentBytes)
    expect(await readFile(join(directory, 'metadata.json'))).toStrictEqual(metadataBytes)
  })

  it('rejects empty content and trim-empty origins before creating storage while preserving whitespace-only content', async () => {
    const empty = await harness()
    await expectStableFailure(empty.service.addSource({ name: 'empty', content: '' }), 'INVALID_PAGE', empty.root)
    await expect(stat(empty.root)).rejects.toMatchObject({ code: 'ENOENT' })

    for (const origin of ['', '   ', '\t\n']) {
      const value = await harness()
      await expectStableFailure(value.service.addSource({ name: 'blank origin', content: 'evidence', origin }), 'INVALID_PAGE', value.root)
      await expect(stat(value.root)).rejects.toMatchObject({ code: 'ENOENT' })
    }

    const whitespace = await harness()
    const receipt = await whitespace.service.addSource({ name: 'whitespace', content: ' \t\n' })
    await expect(whitespace.service.readSource(receipt.id)).resolves.toMatchObject({ content: ' \t\n' })
  })

  it('rejects over-cap sources without leaving a source record', async () => {
    const value = await harness({ maxSourceBytes: 4 })
    const content = '12345'
    await expectStableFailure(value.service.addSource({ name: 'too-large', content }), 'LIMIT_EXCEEDED', value.root)
    await expect(stat(value.root)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(stat(join(value.root, 'sources', sha256(encodeUtf8(content))))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('accounts for EOF and multibyte ranges, requiring a complete code point within the requested cap', async () => {
    const value = await harness({ maxSourceBytes: 16 })
    const receipt = await value.service.addSource({ name: 'ranges', content: 'aé漢z' })
    await expect(value.service.readSource(receipt.id, { offset: 0, limit: 1 })).resolves.toMatchObject({ content: 'a', byteStart: 0, byteEnd: 1, byteCount: 7 })
    await expect(value.service.readSource(receipt.id, { offset: 7, limit: 1 })).resolves.toMatchObject({ content: '', byteStart: 7, byteEnd: 7, byteCount: 7 })
    const interior = await value.service.readSource(receipt.id, { offset: 2, limit: 4 })
    expect(interior).toMatchObject({ content: '漢', byteStart: 3, byteEnd: 6, byteCount: 7 })
    expect(interior.byteEnd).toBeLessThanOrEqual(2 + 4)
    const tooSmall = await expectStableFailure(value.service.readSource(receipt.id, { offset: 1, limit: 1 }), 'LIMIT_EXCEEDED', value.root)
    expect(tooSmall.message).toBe('Source byte range contains no complete UTF-8 code point; increase the limit.')
    await expect(value.service.readSource(receipt.id, { offset: 1, limit: 2 })).resolves.toMatchObject({ content: 'é', byteStart: 1, byteEnd: 3 })
    await expectStableFailure(value.service.readSource(receipt.id, { offset: 0, limit: 17 }), 'LIMIT_EXCEEDED', value.root)
    await expectStableFailure(value.service.readSource(receipt.id, { offset: 0, limit: 0 }), 'LIMIT_EXCEEDED', value.root)

    const han = await value.service.addSource({ name: 'final han', content: '漢' })
    for (const offset of [1, 2]) {
      for (const limit of [1, 3, 16]) {
        const failure = await expectStableFailure(value.service.readSource(han.id, { offset, limit }), 'LIMIT_EXCEEDED', value.root)
        expect(failure.message).toBe('Source byte range contains no complete UTF-8 code point; increase the limit.')
      }
    }
  })

  it('deduplicates concurrent same-content additions to one immutable record', async () => {
    const value = await harness()
    const content = 'concurrent identity'
    const receipts = await Promise.all(Array.from({ length: 8 }, (_, index) => value.service.addSource({ name: `source-${index}`, content })))
    expect(receipts.every(receipt => receipt.id === sha256(encodeUtf8(content)))).toBe(true)
    expect(receipts.filter(receipt => !receipt.deduplicated)).toHaveLength(1)
    expect(receipts.filter(receipt => receipt.deduplicated)).toHaveLength(7)
    expect(await readdir(join(value.root, 'sources'))).toEqual([receipts[0]!.id])
  })

  it('paginates mixed-width UTF-8 at exact expected boundaries', async () => {
    const value = await harness({ maxSourceBytes: 16 })
    const content = 'aé漢🙂z'
    const contentBytes = encodeUtf8(content)
    const receipt = await value.service.addSource({ name: 'bytes', content })
    const expected = [
      { content: 'aé', byteStart: 0, byteEnd: 3 },
      { content: '漢', byteStart: 3, byteEnd: 6 },
      { content: '🙂', byteStart: 6, byteEnd: 10 },
      { content: 'z', byteStart: 10, byteEnd: 11 },
    ]
    for (const range of expected) {
      const result = await value.service.readSource(receipt.id, { offset: range.byteStart, limit: 4 })
      expect(result).toMatchObject({ ...range, byteCount: 11 })
      expect(result.byteEnd).toBeGreaterThan(range.byteStart)
      expect(result.byteEnd - result.byteStart).toBeLessThanOrEqual(4)
      expect(result.byteEnd).toBeLessThanOrEqual(range.byteStart + 4)
      expect(encodeUtf8(result.content)).toStrictEqual(contentBytes.subarray(result.byteStart, result.byteEnd))
    }

    const han = await value.service.addSource({ name: 'han', content: '漢' })
    const failure = await expectStableFailure(value.service.readSource(han.id, { offset: 0, limit: 1 }), 'LIMIT_EXCEEDED', value.root)
    expect(failure.message).toBe('Source byte range contains no complete UTF-8 code point; increase the limit.')
    await expect(value.service.readSource(han.id, { offset: 0, limit: 3 })).resolves.toMatchObject({ content: '漢', byteStart: 0, byteEnd: 3, byteCount: 3 })
  })

  it('rejects source symlinks and non-regular source records with private stable errors', async () => {
    const value = await harness()
    const receipt = await addEvidence(value)
    const content = join(value.root, 'sources', receipt.id, 'content')
    const outside = join(value.temporaryDirectory, 'outside')
    await writeFile(outside, 'outside')
    await rm(content)
    await symlink(relative(join(value.root, 'sources', receipt.id), outside), content)
    await expectStableFailure(value.service.readSource(receipt.id), 'UNSAFE_FILESYSTEM', value.root)
    await rm(content)
    await mkdir(content)
    await expectStableFailure(value.service.readSource(receipt.id), 'UNSAFE_FILESYSTEM', value.root)
  })

  it('validates source media metadata and rejects partial or tampered immutable records', async () => {
    const value = await harness()
    await expectStableFailure(value.service.addSource({ name: 'blank media', content: 'x', mediaType: '   ' }), 'INVALID_PAGE', value.root)
    await expectStableFailure(value.service.addSource({ name: 'blank origin', content: 'x', origin: '   ' }), 'INVALID_PAGE', value.root)

    const receipt = await addEvidence(value)
    const directory = join(value.root, 'sources', receipt.id)
    const metadataPath = join(directory, 'metadata.json')
    const original = JSON.parse(await readFile(metadataPath, 'utf8')) as Record<string, unknown>
    for (const metadata of [
      { ...original, mediaType: ' ' },
      { ...original, origin: 1 },
      { ...original, origin: '' },
      { ...original, origin: '   ' },
      { ...original, extra: true },
      { ...original, id: '0'.repeat(64) },
      { ...original, byteCount: -1 },
      { ...original, capturedAt: 'yesterday' },
    ]) {
      await writeFile(metadataPath, `${JSON.stringify(metadata)}\n`)
      await expectStableFailure(value.service.readSource(receipt.id), 'INVALID_PAGE', value.root)
    }

    await writeFile(metadataPath, `${JSON.stringify(original)}\n`)
    await writeFile(join(directory, 'content'), 'tampered')
    await expectStableFailure(value.service.readSource(receipt.id), 'INVALID_PAGE', value.root)
    await rm(metadataPath)
    await expectStableFailure(value.service.readSource(receipt.id), 'SOURCE_NOT_FOUND', value.root)
  })

  it('rejects missing sources and invalid byte offsets without exposing filesystem details', async () => {
    const value = await harness()
    const missingId = sha256('missing') as SourceReceipt['id']
    await expectStableFailure(value.service.readSource(missingId), 'SOURCE_NOT_FOUND', value.root)
    const receipt = await addEvidence(value)
    for (const offset of [-1, 1.5, receipt.metadata.byteCount + 1]) {
      await expectStableFailure(value.service.readSource(receipt.id, { offset, limit: 1 }), 'LIMIT_EXCEEDED', value.root)
    }
  })
})

describe('pages, index, search, lint, and status', () => {
  it('retains exact derived index bytes after page commit, reports them stale, and rebuilds on demand', async () => {
    const value = await harness()
    const page = await addPage(value)
    const pagePath = join(value.root, 'pages', 'notes', 'alpha.md')
    const sourcePath = join(value.root, 'sources', page.evidence.id, 'content')
    expect(await readFile(pagePath, 'utf8')).toBe(renderPageMarkdown(page.input, page.input.body))
    await value.service.reindex()
    const searchPath = join(value.root, '.index', 'search.json')
    const statePath = join(value.root, '.index', 'state.json')
    const oldSearchBytes = await readFile(searchPath)
    const oldStateBytes = await readFile(statePath)
    const sourceBytes = await readFile(sourcePath)
    const input = { ...page.input, body: '# Finding\n\nUpdated only after commit.\n' }
    const expectedPageBytes = encodeUtf8(renderPageMarkdown(input, input.body))

    await expect(value.service.upsertPage(input)).resolves.toEqual({ id: page.id, created: false, sha256: sha256(expectedPageBytes) })
    expect(await readFile(pagePath)).toStrictEqual(Buffer.from(expectedPageBytes))
    expect(await readFile(sourcePath)).toStrictEqual(sourceBytes)
    expect(await readFile(searchPath)).toStrictEqual(oldSearchBytes)
    expect(await readFile(statePath)).toStrictEqual(oldStateBytes)
    await expect(value.service.status()).resolves.toMatchObject({ index: { present: true, fresh: false } })
    await expect(value.service.search('updated')).resolves.not.toHaveLength(0)
    await expect(value.service.status()).resolves.toMatchObject({ index: { present: true, fresh: true } })
  })

  it('returns page and section counts from the queued index build', async () => {
    const value = await harness()
    const page = await addPage(value)
    await value.service.upsertPage({ ...page.input, id: pageId('notes/beta'), title: 'Beta' })

    await expect(value.service.reindex()).resolves.toEqual({
      pageCount: 2,
      sectionCount: 2,
      formatVersion: 1,
    })
    await expect(value.service.status()).resolves.toMatchObject({
      pageCount: 2,
      index: { present: true, fresh: true, formatVersion: 1, sectionCount: 2 },
    })
  })

  it('rejects an over-cap rendered page without mutating pages or derived index state', async () => {
    const value = await harness({ maxPageBytes: 64 })
    const evidence = await addEvidence(value)
    await value.service.reindex()
    const indexEntries = await readdir(join(value.root, '.index'))
    const input = { id: pageId('limits/large'), title: 'Large', summary: 'Large', sources: [evidence.id], body: `# Large\n\n${'x'.repeat(128)}\n` }
    await expectStableFailure(value.service.upsertPage(input), 'LIMIT_EXCEEDED', value.root)
    expect(await readdir(join(value.root, 'pages'))).toEqual([])
    expect(await readdir(join(value.root, '.index'))).toEqual(indexEntries)
    await expect(stat(join(value.root, 'pages', 'limits', 'large.md'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('maps missing and malformed page reads and rejects ungrounded page writes', async () => {
    const value = await harness()
    const missing = pageId('missing/page')
    await expectStableFailure(value.service.readPage(missing), 'PAGE_NOT_FOUND', value.root)

    const evidence = await addEvidence(value)
    const unknown = sha256('unknown') as SourceReceipt['id']
    await expectStableFailure(value.service.upsertPage({
      id: pageId('missing/source'), title: 'Missing', summary: 'Missing', sources: [unknown], body: '# Missing\n',
    }), 'SOURCE_NOT_FOUND', value.root)

    const page = await addPage(value, evidence)
    await writeFile(join(value.root, 'pages', 'notes', 'alpha.md'), 'not valid page frontmatter\n')
    await expectStableFailure(value.service.readPage(page.id), 'INVALID_PAGE', value.root)
  })

  it('reports partial indexes as stale and rebuilds them before search', async () => {
    const value = await harness()
    await addPage(value)
    await value.service.reindex()
    await rm(join(value.root, '.index', 'state.json'))
    await expect(value.service.status()).resolves.toMatchObject({
      index: { present: true, fresh: false, formatVersion: null, sectionCount: 0 },
    })
    await expect(value.service.search('evidence')).resolves.not.toHaveLength(0)
    expect((await value.service.status()).index.fresh).toBe(true)
  })

  it.each([
    ['malformed', '{'],
    ['incompatible', `${JSON.stringify({ formatVersion: 999, pages: [], searchSha256: '0'.repeat(64) })}\n`],
  ])('keeps %s index state authoritative when a page is invalid', async (_name, stateBytes) => {
    const value = await harness()
    await addPage(value)
    await value.service.reindex()
    await writeFile(join(value.root, 'pages', 'notes', 'alpha.md'), 'invalid page\n')
    await writeFile(join(value.root, '.index', 'state.json'), stateBytes)

    expect((await value.service.status()).index).toEqual({
      present: true,
      fresh: false,
      formatVersion: null,
      sectionCount: 0,
    })
  })

  it.each(['.md', 'nested/.md', 'foo.md.md', 'percent%2Fencoded.md'])(
    'reports a deterministic stale index status for invalid page path %s',
    async (relativePath) => {
      const value = await harness()
      await addPage(value)
      await value.service.reindex()
      const target = join(value.root, 'pages', relativePath)
      await mkdir(join(target, '..'), { recursive: true })
      await writeFile(target, 'invalid path fixture\n')

      await expect(value.service.status()).resolves.toMatchObject({
        index: { present: true, fresh: false, formatVersion: 1, sectionCount: 0 },
      })
    },
  )

  it('reports forged derived semantics stale and rebuilds before search', async () => {
    const value = await harness()
    await addPage(value)
    await value.service.reindex()
    const searchPath = join(value.root, '.index', 'search.json')
    const statePath = join(value.root, '.index', 'state.json')
    const expectedSearch = await readFile(searchPath)
    const expectedState = await readFile(statePath)
    const pageBytes = await readFile(join(value.root, 'pages', 'notes', 'alpha.md'))
    const section = parseSearchIndex(expectedSearch).sections[0]!
    const forged = buildSearchIndexFromPages([{
      pageId: section.pageId,
      bytes: pageBytes,
      title: section.title,
      sourceIds: section.sourceIds,
      body: '# Forged one\n\nPhantom text.\n\n# Forged two\n\nMore phantom text.\n',
      bodyStartLine: section.startLine,
    }])
    expect(forged.search.sections.length).toBe(2)
    await writeFile(searchPath, forged.searchBytes)
    await writeFile(statePath, forged.stateBytes)

    await expect(value.service.status()).resolves.toMatchObject({
      index: { present: true, fresh: false, formatVersion: 1, sectionCount: 1 },
    })
    await expect(value.service.search('forged')).resolves.toEqual([])
    expect(await readFile(searchPath)).toEqual(expectedSearch)
    expect(await readFile(statePath)).toEqual(expectedState)
    await expect(value.service.search('evidence')).resolves.not.toHaveLength(0)
  })

  it('reports a neutral section count when an invalid page prevents deriving the expected index', async () => {
    const value = await harness()
    await addPage(value)
    await value.service.reindex()
    const searchPath = join(value.root, '.index', 'search.json')
    const statePath = join(value.root, '.index', 'state.json')
    const pagePath = join(value.root, 'pages', 'notes', 'alpha.md')
    const pageBytes = await readFile(pagePath)
    const section = parseSearchIndex(await readFile(searchPath)).sections[0]!
    const forged = buildSearchIndexFromPages([{
      pageId: section.pageId,
      bytes: pageBytes,
      title: section.title,
      sourceIds: section.sourceIds,
      body: '# Forged one\n\nPhantom text.\n\n# Forged two\n\nMore phantom text.\n',
      bodyStartLine: section.startLine,
    }])
    expect(forged.search.sections.length).toBe(2)
    await writeFile(searchPath, forged.searchBytes)
    await writeFile(statePath, forged.stateBytes)
    await writeFile(pagePath, 'invalid page\n')

    expect((await value.service.status()).index).toEqual({
      present: true,
      fresh: false,
      formatVersion: 1,
      sectionCount: 0,
    })
  })

  it('rebuilds identical derived index bytes after the complete index directory is deleted', async () => {
    const value = await harness()
    const page = await addPage(value)
    const originalResults = await value.service.search('evidence')
    const originalSearchBytes = await readFile(join(value.root, '.index', 'search.json'))
    const originalStateBytes = await readFile(join(value.root, '.index', 'state.json'))
    const originalSourceBytes = await readFile(join(value.root, 'sources', page.evidence.id, 'content'))
    const originalPageBytes = await readFile(join(value.root, 'pages', 'notes', 'alpha.md'))

    await rm(join(value.root, '.index'), { recursive: true })

    await expect(value.service.search('evidence')).resolves.toEqual(originalResults)
    expect(await readFile(join(value.root, '.index', 'search.json'))).toEqual(originalSearchBytes)
    expect(await readFile(join(value.root, '.index', 'state.json'))).toEqual(originalStateBytes)
    expect(await readFile(join(value.root, 'sources', page.evidence.id, 'content'))).toEqual(originalSourceBytes)
    expect(await readFile(join(value.root, 'pages', 'notes', 'alpha.md'))).toEqual(originalPageBytes)
  })

  it('rejects unsafe status trees and sanitizes ordinary filesystem failures', async () => {
    const value = await harness()
    const receipt = await addEvidence(value)
    await writeFile(join(value.root, 'pages', 'unexpected.txt'), 'unexpected')
    await expect(value.service.status()).resolves.toMatchObject({ pageCount: 0, sourceCount: 1 })

    await mkdir(join(value.root, 'pages', 'looks-like.md'))
    await expectStableFailure(value.service.status(), 'UNSAFE_FILESYSTEM', value.root)
    await rm(join(value.root, 'pages', 'looks-like.md'), { recursive: true })

    await writeFile(join(value.root, 'sources', 'unexpected'), 'not a directory')
    await expectStableFailure(value.service.status(), 'UNSAFE_FILESYSTEM', value.root)
    await rm(join(value.root, 'sources', 'unexpected'))

    await rm(join(value.root, 'sources', receipt.id, 'metadata.json'))
    await expectStableFailure(value.service.status(), 'UNSAFE_FILESYSTEM', value.root)
  })

  it('reports an absent root deterministically without creating the wiki layout', async () => {
    const value = await harness()
    const before = await snapshotTree(value.root)

    const first = await value.service.status()
    const second = await value.service.status()

    expect(before).toBeNull()
    expect(first).toEqual({
      initialized: false,
      sourceCount: 0,
      pageCount: 0,
      schemaText: null,
      index: { present: false, fresh: false, formatVersion: null, sectionCount: 0 },
    })
    expect(second).toEqual(first)
    expect(await snapshotTree(value.root)).toEqual(before)
  })

  it('lints an absent root deterministically without creating the wiki layout', async () => {
    const value = await harness()
    await rm(value.root, { recursive: true, force: true })
    const before = await snapshotTree(value.root)

    const first = await value.service.lint()
    const second = await value.service.lint()

    expect(before).toBeNull()
    expect(second).toEqual(first)
    expect(first).toEqual({
      diagnostics: [{ code: 'ROOT_MISSING', severity: 'error', path: '.', message: 'Wiki root is missing.' }],
      errorCount: 1,
      warningCount: 0,
      filesExamined: 0,
    })
    expect(await snapshotTree(value.root)).toEqual(before)
  })

  describe.runIf(process.platform !== 'win32')('read-only lint path safety', () => {
    it('rejects configured-root and ancestor symlinks without reading or mutating external targets', async () => {
      const owner = await harness()
      const outside = join(owner.temporaryDirectory, 'outside')
      await mkdir(outside)
      await writeFile(join(outside, 'schema.md'), 'external schema must not be read\n')
      await writeFile(join(outside, 'marker'), 'unchanged\n')
      const before = await snapshotTree(outside)

      const linkedRoot = join(owner.temporaryDirectory, 'linked-root')
      await symlink(outside, linkedRoot)
      const rootService = await harness({ root: linkedRoot })
      const firstRootError = await expectStableFailure(rootService.service.lint(), 'UNSAFE_FILESYSTEM', linkedRoot)
      const secondRootError = await expectStableFailure(rootService.service.lint(), 'UNSAFE_FILESYSTEM', linkedRoot)
      expect(secondRootError.toJSON()).toEqual(firstRootError.toJSON())
      expect(await snapshotTree(outside)).toEqual(before)

      const linkedAncestor = join(owner.temporaryDirectory, 'linked-ancestor')
      await symlink(outside, linkedAncestor)
      const absentRoot = join(linkedAncestor, 'absent-wiki')
      const ancestorService = await harness({ root: absentRoot })
      const firstAncestorError = await expectStableFailure(ancestorService.service.lint(), 'UNSAFE_FILESYSTEM', absentRoot)
      const secondAncestorError = await expectStableFailure(ancestorService.service.lint(), 'UNSAFE_FILESYSTEM', absentRoot)
      expect(secondAncestorError.toJSON()).toEqual(firstAncestorError.toJSON())
      expect(await snapshotTree(outside)).toEqual(before)
      await expect(stat(join(outside, 'absent-wiki'))).rejects.toMatchObject({ code: 'ENOENT' })
    })
  })

  it('enforces the complete service matrix on a private read-only tmpfs mount', async () => {
    const probeDirectory = await mkdtemp(join(tmpdir(), 'dsh-llmwiki-c21-readonly-'))
    const mountpoint = join(probeDirectory, 'mount')
    const runner = join(probeDirectory, 'runner.mjs')
    await mkdir(mountpoint)
    await writeFile(runner, String.raw`
      import { spawnSync } from 'node:child_process'
      import { createHash } from 'node:crypto'
      import { access, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
      import { join, relative } from 'node:path'
      import { pathToFileURL } from 'node:url'

      const [repository, mountpoint, cordisUrl] = process.argv.slice(2)
      const runMount = args => {
        const result = spawnSync('mount', args, { encoding: 'utf8' })
        if (result.status !== 0) throw Object.assign(new Error(result.stderr || 'mount failed'), { capabilityFailure: true })
      }
      const equal = (actual, expected, label) => {
        if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(label + ': ' + JSON.stringify(actual))
      }
      const failure = async (operation, label, message = 'The wiki filesystem operation failed.') => {
        try { await operation; throw new Error(label + ' unexpectedly succeeded') }
        catch (error) {
          if (error?.code !== 'UNSAFE_FILESYSTEM' || error?.message !== message || JSON.stringify(error).includes(mountpoint)) throw error
          return { code: error.code, message: error.message }
        }
      }
      const absent = async path => {
        try { await access(path); return false } catch (error) { if (error?.code === 'ENOENT') return true; throw error }
      }
      const tree = async root => {
        if (await absent(root)) return null
        const output = []
        const visit = async directory => {
          for (const entry of (await readdir(directory, { withFileTypes: true })).toSorted((a, b) => a.name.localeCompare(b.name, 'en'))) {
            const path = join(directory, entry.name)
            const key = relative(root, path).split('\\').join('/')
            if (entry.isDirectory()) { output.push({ path: key, kind: 'directory' }); await visit(path) }
            else if (entry.isFile()) output.push({ path: key, kind: 'file', bytes: (await readFile(path)).toString('base64') })
            else throw new Error('unexpected fixture entry: ' + key)
          }
        }
        output.push({ path: '.', kind: 'directory' })
        await visit(root)
        return output
      }

      try {
        runMount(['-t', 'tmpfs', '-o', 'size=32m,mode=0700', 'tmpfs', mountpoint])
        const { buildSearchIndexFromPages } = await import(pathToFileURL(join(repository, 'src/indexer.ts')).href)
        const { parsePageMarkdown, renderPageMarkdown } = await import(pathToFileURL(join(repository, 'src/markdown.ts')).href)
        const content = 'C21 immutable evidence.\n'
        const sourceId = createHash('sha256').update(content).digest('hex')
        const metadata = { id: sourceId, name: 'C21 evidence', mediaType: 'text/plain; charset=utf-8', byteCount: Buffer.byteLength(content), capturedAt: '2026-01-02T03:04:05.000Z', origin: 'C21 read-only gate' }
        const pageInput = { id: 'c21/page', title: 'C21 page', summary: 'Read-only fixture.', sources: [sourceId], body: '# C21 finding\n\nImmutable evidence.\n' }
        const page = renderPageMarkdown(pageInput, pageInput.body)
        const parsed = parsePageMarkdown(page)
        const built = buildSearchIndexFromPages([{ pageId: pageInput.id, bytes: Buffer.from(page), title: pageInput.title, sourceIds: [sourceId], body: parsed.body, bodyStartLine: parsed.bodyStartLine }])
        const roots = Object.fromEntries(['absent', 'incomplete', 'fresh', 'missing-index', 'stale-index'].map(name => [name, join(mountpoint, name)]))
        const makeComplete = async root => {
          await mkdir(join(root, 'sources', sourceId), { recursive: true })
          await mkdir(join(root, 'pages', 'c21'), { recursive: true })
          await mkdir(join(root, '.index'), { recursive: true })
          await writeFile(join(root, 'schema.md'), '# C21 fixed schema\n')
          await writeFile(join(root, 'sources', sourceId, 'content'), content)
          await writeFile(join(root, 'sources', sourceId, 'metadata.json'), JSON.stringify(metadata, null, 2) + '\n')
          await writeFile(join(root, 'pages', 'c21', 'page.md'), page)
        }
        await mkdir(roots.incomplete)
        await writeFile(join(roots.incomplete, 'schema.md'), '# C21 fixed schema\n')
        for (const name of ['fresh', 'missing-index', 'stale-index']) await makeComplete(roots[name])
        for (const name of ['fresh', 'stale-index']) {
          await writeFile(join(roots[name], '.index', 'search.json'), built.searchBytes)
          await writeFile(join(roots[name], '.index', 'state.json'), built.stateBytes)
        }
        const stalePage = renderPageMarkdown({ ...pageInput, body: '# C21 changed\n\nStale index evidence.\n' }, '# C21 changed\n\nStale index evidence.\n')
        await writeFile(join(roots['stale-index'], 'pages', 'c21', 'page.md'), stalePage)
        const before = Object.fromEntries(await Promise.all(Object.entries(roots).map(async ([name, root]) => [name, await tree(root)])))
        runMount(['-o', 'remount,ro', mountpoint])

        const events = []
        const results = {}
        for (const [name, root] of Object.entries(roots)) {
          const sentinelRoot = name === 'absent' ? mountpoint : root
          for (const [kind, operation] of [
            ['write', () => writeFile(join(sentinelRoot, '.c21-write-sentinel'), 'x', { flag: 'wx' })],
            ['mkdir', () => mkdir(join(sentinelRoot, '.c21-mkdir-sentinel'))],
          ]) {
            try { await operation(); throw new Error(name + ' ' + kind + ' sentinel unexpectedly succeeded') }
            catch (error) { if (error?.code !== 'EROFS') throw error; events.push(name + ':sentinel:' + kind + ':EROFS') }
          }
          if (!await absent(join(sentinelRoot, '.c21-write-sentinel')) || !await absent(join(sentinelRoot, '.c21-mkdir-sentinel'))) throw new Error(name + ' sentinel mutated tree')
        }
        // Runtime-selected absolute imports keep the child inside this checkout while proving sentinels before service loading.
        const { Context } = await import(cordisUrl)
        const { LlmWikiService } = await import(pathToFileURL(join(repository, 'src/service.ts')).href)
        for (const [name, root] of Object.entries(roots)) {
          const ctx = new Context()
          const fiber = ctx.plugin(LlmWikiService, { root })
          events.push(name + ':service:construct')
          await fiber.await()
          const service = ctx.llmwiki
          const scenario = { status: await service.status(), sources: await service.listSources(), pages: await service.listPages(), lint: await service.lint() }
          if (name === 'absent' || name === 'incomplete') {
            const expectedStatus = name === 'absent'
              ? { initialized: false, sourceCount: 0, pageCount: 0, schemaText: null, index: { present: false, fresh: false, formatVersion: null, sectionCount: 0 } }
              : { initialized: false, sourceCount: 0, pageCount: 0, schemaText: '# C21 fixed schema\n', index: { present: false, fresh: false, formatVersion: null, sectionCount: 0 } }
            equal(scenario.status, expectedStatus, name + ' status')
            equal(scenario.sources, { items: [], nextCursor: null }, name + ' source list')
            equal(scenario.pages, { items: [], nextCursor: null }, name + ' page list')
            const expectedLint = name === 'absent'
              ? { diagnostics: [{ code: 'ROOT_MISSING', severity: 'error', path: '.', message: 'Wiki root is missing.' }], errorCount: 1, warningCount: 0, filesExamined: 0 }
              : { diagnostics: [{ code: 'INDEX_MISSING', severity: 'warning', path: '.index', message: 'Derived search index is missing.' }, { code: 'REQUIRED_DIRECTORY_MISSING', severity: 'error', path: 'pages', message: 'Required wiki directory is missing.' }, { code: 'REQUIRED_DIRECTORY_MISSING', severity: 'error', path: 'sources', message: 'Required wiki directory is missing.' }], errorCount: 2, warningCount: 1, filesExamined: 1 }
            equal(scenario.lint, expectedLint, name + ' lint')
            const initializationMessage = name === 'absent' ? 'Unable to create the configured wiki root.' : 'Unable to create a required wiki directory.'
            scenario.readSource = await failure(service.readSource(sourceId), name + ' readSource', initializationMessage)
            scenario.readPage = await failure(service.readPage('c21/page'), name + ' readPage', initializationMessage)
            scenario.search = await failure(service.search('immutable'), name + ' search', initializationMessage)
          } else {
            if (!scenario.status.initialized || scenario.status.sourceCount !== 1 || scenario.status.pageCount !== 1 || scenario.sources.items[0]?.id !== sourceId || scenario.pages.items[0]?.id !== 'c21/page') throw new Error(name + ' readable catalog mismatch')
            if ((await service.readSource(sourceId)).content !== content || (await service.readPage('c21/page')).markdown.length === 0) throw new Error(name + ' readable record mismatch')
            if (name === 'fresh') {
              equal(scenario.status.index, { present: true, fresh: true, formatVersion: 1, sectionCount: 1 }, 'fresh index status')
              if (scenario.lint.errorCount !== 0 || scenario.lint.warningCount !== 0 || (await service.search('immutable'))[0]?.pageId !== 'c21/page') throw new Error('fresh read-only behavior mismatch')
            } else {
              const expectedIndex = name === 'missing-index'
                ? { present: false, fresh: false, formatVersion: null, sectionCount: 0 }
                : { present: true, fresh: false, formatVersion: 1, sectionCount: 1 }
              equal(scenario.status.index, expectedIndex, name + ' index status')
              scenario.search = await failure(service.search('immutable'), name + ' search')
              const expectedDiagnostic = name === 'missing-index' ? 'INDEX_MISSING' : 'INDEX_STALE'
              if (scenario.lint.errorCount !== 0 || scenario.lint.warningCount !== 1 || !scenario.lint.diagnostics.some(entry => entry.code === expectedDiagnostic)) throw new Error(name + ' lint mismatch')
            }
          }
          const mutationMessage = name === 'absent'
            ? 'Unable to create the configured wiki root.'
            : name === 'incomplete' ? 'Unable to create a required wiki directory.' : 'The wiki filesystem operation failed.'
          scenario.addSource = await failure(service.addSource({ name: 'denied', content: 'denied' }), name + ' addSource', mutationMessage)
          scenario.upsertPage = await failure(service.upsertPage({ ...pageInput, id: 'c21/nested/denied' }), name + ' upsertPage', mutationMessage)
          scenario.reindex = await failure(service.reindex(), name + ' reindex', mutationMessage)
          results[name] = scenario
          await fiber.dispose()
        }
        for (const name of Object.keys(roots)) {
          const serviceIndex = events.indexOf(name + ':service:construct')
          const writeIndex = events.indexOf(name + ':sentinel:write:EROFS')
          const mkdirIndex = events.indexOf(name + ':sentinel:mkdir:EROFS')
          if (writeIndex < 0 || mkdirIndex < writeIndex || serviceIndex < mkdirIndex) throw new Error(name + ' sentinel order mismatch')
        }
        equal(Object.fromEntries(await Promise.all(Object.entries(roots).map(async ([name, root]) => [name, await tree(root)]))), before, 'read-only tree mutation')
        console.log(JSON.stringify({ uid: process.getuid(), gid: process.getgid(), treeUnchanged: true, events, scenarios: Object.keys(results) }))
      } catch (error) {
        if (error?.capabilityFailure) { console.error('C21_CAPABILITY_UNAVAILABLE:' + error.message); process.exit(77) }
        throw error
      }
    `)
    try {
      const child = spawnSync('unshare', ['--mount', '--propagation', 'private', '--fork', process.execPath, '--import', 'tsx', runner, process.cwd(), mountpoint, import.meta.resolve('@deepseek-ai/cordis')], { encoding: 'utf8' })
      if (child.status === 77 || child.error?.code === 'ENOENT' || (child.status !== 0 && /^unshare:.*Operation not permitted/imu.test(child.stderr))) {
        throw new Error(`C21 required private read-only mount proof is blocked: ${child.error?.message ?? child.stderr.trim()}`)
      }
      expect(child.status, child.stderr).toBe(0)
      const output: unknown = JSON.parse(child.stdout.trim())
      expect(output).toMatchObject({ uid: process.getuid?.(), gid: process.getgid?.(), treeUnchanged: true, scenarios: ['absent', 'incomplete', 'fresh', 'missing-index', 'stale-index'] })
      expect(await readdir(mountpoint)).toEqual([])
    } finally {
      await rm(probeDirectory, { recursive: true, force: true })
    }
  }, 60_000)

  it('lints a pristine existing root deterministically without creating schema, index, or directories', async () => {
    const value = await harness()
    await rm(value.root, { recursive: true, force: true })
    await mkdir(value.root)
    const before = await snapshotTree(value.root)

    const first = await value.service.lint()
    const second = await value.service.lint()

    expect(second).toEqual(first)
    expect(first).toEqual({
      diagnostics: [
        { code: 'INDEX_MISSING', severity: 'warning', path: '.index', message: 'Derived search index is missing.' },
        { code: 'REQUIRED_DIRECTORY_MISSING', severity: 'error', path: 'pages', message: 'Required wiki directory is missing.' },
        { code: 'SCHEMA_MISSING', severity: 'error', path: 'schema.md', message: 'Wiki schema is missing.' },
        { code: 'REQUIRED_DIRECTORY_MISSING', severity: 'error', path: 'sources', message: 'Required wiki directory is missing.' },
      ],
      errorCount: 3,
      warningCount: 1,
      filesExamined: 0,
    })
    expect(await snapshotTree(value.root)).toEqual(before)
    await expect(stat(join(value.root, 'schema.md'))).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(stat(join(value.root, '.index'))).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(stat(join(value.root, 'pages'))).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(stat(join(value.root, 'sources'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('invokes service lint with deterministic corruption diagnostics and root-private paths', async () => {
    const value = await harness()
    const receipt = await addEvidence(value)
    await writeFile(join(value.root, 'sources', receipt.id, 'metadata.json'), '{not-json}\n')
    const first = await value.service.lint()
    const second = await value.service.lint()
    expect(second).toEqual(first)
    expect(first.diagnostics).toContainEqual(expect.objectContaining({
      code: 'SOURCE_METADATA_MALFORMED',
      severity: 'error',
      path: `sources/${receipt.id}/metadata.json`,
    }))
    expect(first.errorCount).toBeGreaterThan(0)
    expect(JSON.stringify(first)).not.toContain(value.root)
    expect(JSON.stringify(first)).not.toContain(value.temporaryDirectory)
  })

  it('validates search input before index writes and caps accepted limits to maxResults', async () => {
    const value = await harness({ maxResults: 1 })
    const page = await addPage(value)
    await value.service.upsertPage({ ...page.input, id: pageId('notes/beta'), title: 'Beta' })

    await expectStableFailure(value.service.search('---'), 'INVALID_PAGE', value.root)
    for (const limit of [0, 1.5]) {
      await expectStableFailure(value.service.search('valid', limit), 'LIMIT_EXCEEDED', value.root)
    }
    expect(await readdir(join(value.root, '.index'))).toEqual([])

    expect(await value.service.search('evidence', 101)).toHaveLength(1)
    expect(await readdir(join(value.root, '.index'))).not.toEqual([])
  })

  it('reports corrupt status deterministically and rebuilds corrupt indexes on valid search', async () => {
    const value = await harness()
    await addPage(value)
    await value.service.reindex()
    await writeFile(join(value.root, '.index', 'state.json'), '{"formatVersion":999}\n')
    expect((await value.service.status()).index).toEqual({ present: true, fresh: false, formatVersion: null, sectionCount: 0 })
    expect(await value.service.search('evidence')).not.toHaveLength(0)
  })

  it('rejects schema, page, and index symlinks or non-regular files', async () => {
    const value = await harness()
    const page = await addPage(value)
    const outside = join(value.temporaryDirectory, 'outside-file')
    await writeFile(outside, 'outside')

    const schema = join(value.root, 'schema.md')
    await rm(schema)
    await symlink(relative(value.root, outside), schema)
    await expectStableFailure(value.service.status(), 'UNSAFE_FILESYSTEM', value.root)
    await rm(schema)
    await mkdir(schema)
    await expectStableFailure(value.service.status(), 'UNSAFE_FILESYSTEM', value.root)
    await rm(schema, { recursive: true })
    await writeFile(schema, '# schema\n')

    const pagePath = join(value.root, 'pages', 'notes', 'alpha.md')
    await rm(pagePath)
    await symlink(relative(join(value.root, 'pages', 'notes'), outside), pagePath)
    await expectStableFailure(value.service.readPage(page.id), 'UNSAFE_FILESYSTEM', value.root)
    await rm(pagePath)
    await mkdir(pagePath)
    await expectStableFailure(value.service.readPage(page.id), 'UNSAFE_FILESYSTEM', value.root)

    await rm(pagePath, { recursive: true })
    await value.service.upsertPage(page.input)
    await value.service.reindex()
    const state = join(value.root, '.index', 'state.json')
    await rm(state)
    await symlink(relative(join(value.root, '.index'), outside), state)
    await expectStableFailure(value.service.status(), 'UNSAFE_FILESYSTEM', value.root)
    await rm(state)
    await mkdir(state)
    await expectStableFailure(value.service.status(), 'UNSAFE_FILESYSTEM', value.root)
  })

  it('commits successfully without attempting fallible derived-index cleanup', async () => {
    const value = await harness()
    const page = await addPage(value)
    await value.service.reindex()
    const state = join(value.root, '.index', 'state.json')
    await rm(state)
    await mkdir(state)
    const input = { ...page.input, body: '# changed\n' }
    await expect(value.service.upsertPage(input)).resolves.toMatchObject({ id: page.id, created: false })
    expect(await readFile(join(value.root, 'pages', 'notes', 'alpha.md'), 'utf8')).toBe(renderPageMarkdown(input, input.body))
    expect((await stat(state)).isDirectory()).toBe(true)
  })

  it('does not commit a page if its source disappears before the page commit', async () => {
    const value = await harness()
    const evidence = await addEvidence(value, 'x'.repeat(2 * 1024 * 1024))
    const sourceDirectory = join(value.root, 'sources', evidence.id)
    const destination = `${sourceDirectory}.deleted`
    const input = { id: pageId('race/source'), title: 'Race', summary: 'Race', sources: [evidence.id], body: '# Race\n' }
    const operation = observeRejection(value.service.upsertPage(input))
    await rename(sourceDirectory, destination)
    await expect(operation).rejects.toMatchObject({ code: 'SOURCE_NOT_FOUND' })
    await expect(stat(join(value.root, 'pages', 'race', 'source.md'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

})

describe('queue and cancellation', () => {
  it('promptly rejects genuinely queued aborted work and preserves FIFO progress', async () => {
    const value = await harness({ maxSourceBytes: 8 * 1024 * 1024 })
    const blocker = observeRejection(value.service.addSource({ name: 'blocker', content: 'x'.repeat(8 * 1024 * 1024) }))
    const controller = new AbortController()
    const cancelled = observeRejection(value.service.addSource({ name: 'cancelled', content: 'cancelled' }, controller.signal))
    const later = observeRejection(value.service.addSource({ name: 'later', content: 'later' }))
    controller.abort()
    const timeout = Promise.withResolvers<string>()
    setTimeout(() => timeout.resolve('timeout'), 100)
    await expect(Promise.race([
      cancelled.then(() => 'resolved', (error: unknown) => error),
      timeout.promise,
    ])).resolves.toMatchObject({ code: 'ABORTED' })
    await blocker
    await expect(later).resolves.toMatchObject({ deduplicated: false })
    await expect(stat(join(value.root, 'sources', sha256(encodeUtf8('cancelled'))))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('rejects already-aborted queued and preflight operations without creating records or indexes', async () => {
    const value = await harness()
    const controller = new AbortController()
    controller.abort()

    await expectStableFailure(value.service.addSource({ name: 'never', content: 'never' }, controller.signal), 'ABORTED', value.root)
    await expectStableFailure(value.service.status(controller.signal), 'ABORTED', value.root)
    await expectStableFailure(value.service.search('valid', undefined, controller.signal), 'ABORTED', value.root)
    await expect(stat(value.root)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(value.service.addSource({ name: 'later', content: 'later' })).resolves.toMatchObject({ deduplicated: false })
  })

  it('preserves abort and disposal precedence over invalid add-source prevalidation', async () => {
    const aborted = await harness()
    const controller = new AbortController()
    controller.abort()
    await expectStableFailure(aborted.service.addSource({ name: '', content: '', origin: '' }, controller.signal), 'ABORTED', aborted.root)
    await expect(stat(aborted.root)).rejects.toMatchObject({ code: 'ENOENT' })

    const disposed = await harness()
    const service = disposed.service
    await Promise.resolve(disposed.fiber.dispose())
    await expectStableFailure(service.addSource({ name: '', content: '', origin: '' }), 'NOT_INITIALIZED', disposed.root)
    await expect(stat(disposed.root)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('rejects queued work on dispose and remounts with fresh queue and service handles', async () => {
    const value = await harness({ maxSourceBytes: 8 * 1024 * 1024 })
    const disposedService = value.service
    const blocker = observeRejection(disposedService.addSource({ name: 'blocker', content: 'x'.repeat(8 * 1024 * 1024) }))
    const queued = observeRejection(disposedService.addSource({ name: 'queued', content: 'queued' }))
    await Promise.resolve(value.fiber.dispose())
    await blocker.catch(() => undefined)
    await expect(queued).rejects.toMatchObject({ code: 'NOT_INITIALIZED' })
    await expectStableFailure(disposedService.status(), 'NOT_INITIALIZED', value.root)
    expect(value.ctx.llmwiki).toBeUndefined()

    const remountedFiber = value.ctx.plugin(LlmWikiService, { root: value.root })
    try {
      await remountedFiber.await()
      expect(value.ctx.llmwiki).not.toBe(disposedService)
      await expect(value.ctx.llmwiki.addSource({ name: 'after-remount', content: 'queued' })).resolves.toMatchObject({ deduplicated: false })
      await expect(value.ctx.llmwiki.status()).resolves.toMatchObject({ initialized: true })
    } finally {
      await Promise.resolve(remountedFiber.dispose())
    }
  })

  it('aborts reindex without publishing a partial index and remains usable', async () => {
    const value = await harness()
    for (let index = 0; index < 100; index += 1) {
      const evidence = await value.service.addSource({ name: `e-${index}`, content: `evidence ${index}` })
      await value.service.upsertPage({ id: pageId(`bulk/${index}`), title: `Page ${index}`, summary: 'bulk', sources: [evidence.id], body: `# Page\n\n${'word '.repeat(200)}\n` })
    }
    const controller = new AbortController()
    const operation = observeRejection(value.service.reindex(controller.signal))
    controller.abort()
    await expect(operation).rejects.toMatchObject({ code: 'ABORTED' })
    expect(await readdir(join(value.root, '.index'))).toEqual([])
    await expect(value.service.status()).resolves.toMatchObject({ initialized: true })
  })
})

describe('adapter boundary', () => {
  it('keeps future adapters on the public service API', async () => {
    for (const name of ['tools.ts', 'command.ts', 'prompt.ts', 'presentation.ts', 'index.ts']) {
      const text = await readFile(join(import.meta.dirname, '..', 'src', name), 'utf8').catch(() => '')
      expect(text).not.toMatch(/from ['"]\.\/(?:atomic|indexer|lint|markdown|paths)\.ts['"]/u)
    }
  })
})

describe('deterministic catalogs', () => {
  it('lists bounded source and page metadata with canonical cursors and no initialization side effects', async () => {
    const value = await harness({ maxResults: 1 })
    const before = await snapshotTree(value.root)
    await expect(value.service.listSources()).resolves.toEqual({ items: [], nextCursor: null })
    await expect(value.service.listPages()).resolves.toEqual({ items: [], nextCursor: null })
    expect(await snapshotTree(value.root)).toEqual(before)

    const firstSource = await addEvidence(value, 'catalog-one')
    const secondSource = await addEvidence(value, 'catalog-two')
    const expectedSources = [firstSource, secondSource].sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0)
    await value.service.upsertPage({ id: pageId('zeta'), title: 'Zeta', summary: 'Second.', sources: [secondSource.id], body: '# Zeta' })
    await value.service.upsertPage({ id: pageId('alpha'), title: 'Alpha', summary: 'First.', sources: [firstSource.id], body: '# Alpha' })

    const sourcePage = await value.service.listSources()
    expect(sourcePage.items).toEqual([{
      id: expectedSources[0]!.id,
      name: expectedSources[0]!.metadata.name,
      mediaType: expectedSources[0]!.metadata.mediaType,
      byteCount: expectedSources[0]!.metadata.byteCount,
      capturedAt: expectedSources[0]!.metadata.capturedAt,
      origin: expectedSources[0]!.metadata.origin,
    }])
    expect(sourcePage.nextCursor).toBe(Buffer.from(JSON.stringify({ v: 1, kind: 'sources', after: expectedSources[0]!.id })).toString('base64url'))
    await expect(value.service.listSources({ cursor: sourcePage.nextCursor! })).resolves.toMatchObject({ items: [{ id: expectedSources[1]!.id }], nextCursor: null })

    const pagePage = await value.service.listPages()
    expect(pagePage.items[0]).toMatchObject({ id: 'alpha', title: 'Alpha', summary: 'First.', sources: [firstSource.id] })
    const alphaMarkdown = (await value.service.readPage(pageId('alpha'))).markdown
    expect(pagePage.items[0]!.byteCount).toBe(Buffer.byteLength(alphaMarkdown))
    expect(pagePage.items[0]!.sha256).toBe(sha256(alphaMarkdown))
    await expect(value.service.listPages({ cursor: pagePage.nextCursor! })).resolves.toMatchObject({ items: [{ id: 'zeta' }], nextCursor: null })
  })

  it('rejects invalid, noncanonical, and cross-kind cursors without leaking paths', async () => {
    const value = await harness()
    const source = await addEvidence(value, 'cursor-source')
    const validSource = Buffer.from(JSON.stringify({ v: 1, kind: 'sources', after: source.id })).toString('base64url')
    const invalid = [
      `${validSource}=`,
      Buffer.from(`{ "v":1,"kind":"sources","after":"${source.id}"}`).toString('base64url'),
      Buffer.from(JSON.stringify({ kind: 'sources', v: 1, after: source.id })).toString('base64url'),
      Buffer.from(JSON.stringify({ v: 1, kind: 'pages', after: 'alpha' })).toString('base64url'),
      Buffer.from(JSON.stringify({ v: 1, kind: 'sources', after: source.id, extra: true })).toString('base64url'),
      '*',
    ]
    for (const cursor of invalid) await expectStableFailure(value.service.listSources({ cursor }), 'INVALID_CURSOR', value.root)
    const aborted = new AbortController()
    aborted.abort()
    await expectStableFailure(value.service.listSources({ cursor: '*' }, aborted.signal), 'ABORTED', value.root)
  })

  it('validates the complete catalog before slicing and maps persisted corruption separately from unsafe filesystems', async () => {
    const value = await harness({ maxResults: 1 })
    await addEvidence(value, 'valid-source')
    await mkdir(join(value.root, 'sources', 'not-an-id'))
    await expectStableFailure(value.service.listSources(), 'CATALOG_CORRUPT', value.root)
    await rm(join(value.root, 'sources', 'not-an-id'), { recursive: true })
    await symlink('/tmp', join(value.root, 'sources', 'unsafe'))
    await expectStableFailure(value.service.listSources(), 'UNSAFE_FILESYSTEM', value.root)
  })

  it.runIf(process.platform !== 'win32')('reads directory and file catalogs through an ordinary symlinked ancestor while rejecting final-target symlinks', async () => {
    const value = await harness()
    const source = await addEvidence(value, 'symlinked-ancestor')
    await value.service.upsertPage({ id: pageId('alias-page'), title: 'Alias page', summary: 'Alias.', sources: [source.id], body: '# Alias' })

    // The regression needs to exercise catalog helpers with an already-authorized lexical path.
    const serviceWithPaths = value.service as unknown as { pathsValue: WikiPaths }
    const canonicalPaths = serviceWithPaths.pathsValue
    const alias = join(value.temporaryDirectory, 'lexical-temp-alias')
    await symlink(value.temporaryDirectory, alias, 'dir')
    const lexicalRoot = join(alias, relative(value.temporaryDirectory, canonicalPaths.root))
    const lexical = (target: string): string => join(lexicalRoot, relative(canonicalPaths.root, target))
    const sourceDirectory: WikiPaths['sourceDirectory'] = id => lexical(canonicalPaths.sourceDirectory(id))
    const sourceContent: WikiPaths['sourceContent'] = id => lexical(canonicalPaths.sourceContent(id))
    const sourceMetadata: WikiPaths['sourceMetadata'] = id => lexical(canonicalPaths.sourceMetadata(id))
    const page: WikiPaths['page'] = id => lexical(canonicalPaths.page(id))
    const indexFile: WikiPaths['indexFile'] = name => lexical(canonicalPaths.indexFile(name))
    const assertSafe: WikiPaths['assertSafe'] = (target, signal) => canonicalPaths.assertSafe(join(canonicalPaths.root, relative(lexicalRoot, target)), signal)
    const lexicalPaths: WikiPaths = Object.freeze({
      ...canonicalPaths,
      root: lexicalRoot,
      schema: lexical(canonicalPaths.schema),
      sources: lexical(canonicalPaths.sources),
      pages: lexical(canonicalPaths.pages),
      index: lexical(canonicalPaths.index),
      sourceDirectory,
      sourceContent,
      sourceMetadata,
      page,
      indexFile,
      assertSafe,
    })
    serviceWithPaths.pathsValue = lexicalPaths

    await expect(value.service.listSources()).resolves.toMatchObject({ items: [{ id: source.id }], nextCursor: null })
    await expect(value.service.listPages()).resolves.toMatchObject({ items: [{ id: 'alias-page' }], nextCursor: null })

    const pagePath = canonicalPaths.page(pageId('alias-page'))
    await rm(pagePath)
    await symlink(canonicalPaths.schema, pagePath)
    await expectStableFailure(value.service.listPages(), 'UNSAFE_FILESYSTEM', lexicalRoot)

    const metadataPath = canonicalPaths.sourceMetadata(source.id)
    await rm(metadataPath)
    await symlink(canonicalPaths.schema, metadataPath)
    await expectStableFailure(value.service.listSources(), 'UNSAFE_FILESYSTEM', lexicalRoot)
  })

  it('recovers complete durable records in a fresh session after an interrupted ingest', async () => {
    const value = await harness({ maxResults: 10, maxSourceBytes: 8 * 1024 * 1024 })
    const source = await addEvidence(value, 'durable recovery')
    await value.service.upsertPage({ id: pageId('recovered'), title: 'Recovered', summary: 'Fresh session.', sources: [source.id], body: '# Recovered' })
    const interrupted = observeRejection(value.service.addSource({ name: 'interrupted', content: 'x'.repeat(8 * 1024 * 1024) }))
    await Promise.resolve(value.fiber.dispose())
    await interrupted.catch(() => undefined)

    const remounted = value.ctx.plugin(LlmWikiService, { root: value.root, maxResults: 10 })
    try {
      await remounted.await()
      await expect(value.ctx.llmwiki.listSources()).resolves.toMatchObject({ items: [{ id: source.id }], nextCursor: null })
      await expect(value.ctx.llmwiki.listPages()).resolves.toMatchObject({ items: [{ id: 'recovered' }], nextCursor: null })
    } finally {
      await Promise.resolve(remounted.dispose())
    }
  })

  it('enforces configured and requested caps with repeatable serialization and live seek cursors', async () => {
    const value = await harness({ maxResults: 2 })
    const receipts = await Promise.all(['one', 'two', 'three'].map(content => addEvidence(value, content)))
    const sorted = receipts.map(receipt => receipt.id).sort()
    await expectStableFailure(value.service.listSources({ limit: 3 }), 'LIMIT_EXCEEDED', value.root)
    await expectStableFailure(value.service.listSources({ limit: 0 }), 'LIMIT_EXCEEDED', value.root)

    const first = await value.service.listSources({ limit: 1 })
    expect(JSON.stringify(await value.service.listSources({ limit: 1 }))).toBe(JSON.stringify(first))
    expect(first.items.map(item => item.id)).toEqual([sorted[0]])

    const inserted = await addEvidence(value, `between-${sorted[0]}`)
    const expectedAfter = [...sorted.slice(1), inserted.id].filter(id => id > sorted[0]!).sort().slice(0, 2)
    const second = await value.service.listSources({ limit: 2, cursor: first.nextCursor! })
    expect(second.items.map(item => item.id)).toEqual(expectedAfter)
    await rm(join(value.root, 'sources', sorted[0]!), { recursive: true })
    await expect(value.service.listSources({ limit: 2, cursor: first.nextCursor! })).resolves.toEqual(second)
  })

  it('maps stable source and page corruption beyond the page limit without mutating the wiki', async () => {
    const value = await harness({ maxResults: 1 })
    const first = await addEvidence(value, 'corruption-one')
    const second = await addEvidence(value, 'corruption-two')
    await value.service.upsertPage({ id: pageId('alpha'), title: 'Alpha', summary: 'Valid.', sources: [first.id], body: '# Alpha' })
    await value.service.upsertPage({ id: pageId('zeta'), title: 'Zeta', summary: 'Valid.', sources: [second.id], body: '# Zeta' })

    const metadataPath = join(value.root, 'sources', second.id, 'metadata.json')
    await writeFile(metadataPath, '{ bad json\n')
    const beforeSourceFailure = await snapshotTree(value.root)
    await expectStableFailure(value.service.listSources(), 'CATALOG_CORRUPT', value.root)
    expect(await snapshotTree(value.root)).toEqual(beforeSourceFailure)

    await rm(join(value.root, 'sources', second.id), { recursive: true })
    const pagePath = join(value.root, 'pages', 'zeta.md')
    await writeFile(pagePath, Buffer.from([0xff, 0xfe]))
    const beforePageFailure = await snapshotTree(value.root)
    await expectStableFailure(value.service.listPages(), 'CATALOG_CORRUPT', value.root)
    expect(await snapshotTree(value.root)).toEqual(beforePageFailure)
  })

  it('honors abort precedence and rejects stable same-path replacements and extra source children', async () => {
    const value = await harness()
    const source = await addEvidence(value, 'replacement')
    const page = await addPage(value, source)
    const controller = new AbortController()
    controller.abort()
    await expectStableFailure(value.service.listPages({ cursor: '*' }, controller.signal), 'ABORTED', value.root)

    const contentPath = join(value.root, 'sources', source.id, 'content')
    const replacementPath = join(value.root, 'sources', source.id, 'replacement')
    await writeFile(replacementPath, 'mutated')
    await rename(replacementPath, contentPath)
    await expectStableFailure(value.service.listSources(), 'CATALOG_CORRUPT', value.root)

    await writeFile(join(value.root, 'sources', source.id, 'extra'), 'extra')
    await expectStableFailure(value.service.listSources(), 'CATALOG_CORRUPT', value.root)

    const pagePath = join(value.root, 'pages', `${page.id}.md`)
    const pageReplacement = `${pagePath}.replacement`
    await writeFile(pageReplacement, 'not frontmatter')
    await rename(pageReplacement, pagePath)
    await expectStableFailure(value.service.listPages(), 'CATALOG_CORRUPT', value.root)
  })
  it('enumerates a stable directory handle and rejects a pathname swap during catalog discovery', async () => {
    const value = await harness()
    const source = await addEvidence(value, 'directory-swap')
    await value.service.upsertPage({ id: pageId('stable'), title: 'Stable', summary: 'Stable.', sources: [source.id], body: '# Stable' })
    const pages = join(value.root, 'pages')
    const displaced = join(value.root, 'pages.displaced')
    const { opendir: originalOpendir } = await vi.importActual<typeof fsPromises>('node:fs/promises')
    let swapped = false
    const opendirMock = vi.mocked(fsPromises.opendir).mockImplementation(async (...args: Parameters<typeof fsPromises.opendir>) => {
      if (!swapped && String(args[0]).startsWith('/proc/self/fd/')) {
        swapped = true
        await rename(pages, displaced)
        await mkdir(pages)
        await rename(pages, join(value.root, 'pages.replacement'))
        await rename(displaced, pages)
      }
      return originalOpendir(...args)
    })
    try {
      await expectStableFailure(value.service.listPages(), 'UNSAFE_FILESYSTEM', value.root)
      expect(swapped).toBe(true)
    } finally {
      opendirMock.mockImplementation(originalOpendir)
      await rm(join(value.root, 'pages.replacement'), { recursive: true, force: true })
    }
  })

  it('selects supported descriptor aliases and rejects unavailable platforms', () => {
    expect(catalogDescriptorAlias(7, 'linux')).toBe('/proc/self/fd/7')
    for (const operatingSystem of ['darwin', 'freebsd', 'openbsd', 'netbsd']) {
      expect(catalogDescriptorAlias(7, operatingSystem)).toBe('/dev/fd/7')
    }
    expect(() => catalogDescriptorAlias(7, 'win32')).toThrow(expect.objectContaining({ code: 'UNSAFE_FILESYSTEM' }))
    expect(() => catalogDescriptorAlias(-1, 'linux')).toThrow(expect.objectContaining({ code: 'UNSAFE_FILESYSTEM' }))
  })

  it('traverses ordinary wide catalogs with exact counts and one active directory resource', async () => {
    const value = await harness({ maxResults: 100 })
    const source = await addEvidence(value, 'wide-tree')
    const width = 96
    for (let index = 0; index < width; index += 1) {
      const directory = join(value.root, 'pages', `group-${index.toString().padStart(3, '0')}`)
      await mkdir(directory)
      const id = pageId(`group-${index.toString().padStart(3, '0')}/page`)
      const input = { id, title: `Page ${index}`, summary: 'Wide tree.', sources: [source.id], body: '# Wide\n' }
      await writeFile(join(directory, 'page.md'), renderPageMarkdown(input, input.body))
    }

    const { open: originalOpen, opendir: originalOpendir } = await vi.importActual<typeof fsPromises>('node:fs/promises')
    let activeDirectoryHandles = 0
    let maximumDirectoryHandles = 0
    let activeDirectories = 0
    let maximumDirectories = 0
    const openMock = vi.mocked(fsPromises.open).mockImplementation(async (...args: Parameters<typeof fsPromises.open>) => {
      const handle = await originalOpen(...args)
      if ((Number(args[1]) & constants.O_DIRECTORY) !== 0) {
        activeDirectoryHandles += 1
        maximumDirectoryHandles = Math.max(maximumDirectoryHandles, activeDirectoryHandles)
        const originalClose = handle.close.bind(handle)
        let closed = false
        handle.close = async () => {
          if (!closed) {
            closed = true
            activeDirectoryHandles -= 1
          }
          await originalClose()
        }
      }
      return handle
    })
    const opendirMock = vi.mocked(fsPromises.opendir).mockImplementation(async (...args: Parameters<typeof fsPromises.opendir>) => {
      const directory = await originalOpendir(...args)
      activeDirectories += 1
      maximumDirectories = Math.max(maximumDirectories, activeDirectories)
      const originalClose = directory.close.bind(directory)
      let closed = false
      directory.close = async () => {
        if (!closed) {
          closed = true
          activeDirectories -= 1
        }
        await originalClose()
      }
      return directory
    })
    try {
      const catalog = await value.service.listPages({ limit: 100 })
      expect(catalog.items).toHaveLength(width)
      expect(catalog.nextCursor).toBeNull()
      expect({ maximumDirectoryHandles, maximumDirectories }).toEqual({ maximumDirectoryHandles: 1, maximumDirectories: 1 })
      expect({ activeDirectoryHandles, activeDirectories }).toEqual({ activeDirectoryHandles: 0, activeDirectories: 0 })
    } finally {
      openMock.mockImplementation(originalOpen)
      opendirMock.mockImplementation(originalOpendir)
    }
  })

  it('bounds deep catalog traversal handles and closes them on success, error, and abort', async () => {
    const value = await harness()
    const source = await addEvidence(value, 'handle-lifecycle')
    const segments = Array.from({ length: 48 }, (_, index) => `level-${index}`)
    const deepDirectory = join(value.root, 'pages', ...segments)
    await mkdir(deepDirectory, { recursive: true })
    const deepId = pageId(`${segments.join('/')}/deep`)
    const input = { id: deepId, title: 'Deep', summary: 'Deep tree.', sources: [source.id], body: '# Deep\n' }
    await writeFile(join(deepDirectory, 'deep.md'), renderPageMarkdown(input, input.body))

    const { open: originalOpen } = await vi.importActual<typeof fsPromises>('node:fs/promises')
    let activeHandles = 0
    let maximumActiveHandles = 0
    let openedHandles = 0
    let closedHandles = 0
    let abortAfterOpen: number | undefined
    let abortController: AbortController | undefined
    const openMock = vi.mocked(fsPromises.open).mockImplementation(async (...args: Parameters<typeof fsPromises.open>) => {
      const handle = await originalOpen(...args)
      openedHandles += 1
      activeHandles += 1
      maximumActiveHandles = Math.max(maximumActiveHandles, activeHandles)
      const originalClose = handle.close.bind(handle)
      let closed = false
      handle.close = async () => {
        if (!closed) {
          closed = true
          closedHandles += 1
          activeHandles -= 1
        }
        await originalClose()
      }
      if (abortAfterOpen !== undefined && openedHandles === abortAfterOpen) abortController?.abort()
      return handle
    })
    try {
      await expect(value.service.listPages()).resolves.toMatchObject({ items: [{ id: deepId }] })
      expect(maximumActiveHandles).toBeLessThanOrEqual(2)
      expect({ activeHandles, closedHandles }).toEqual({ activeHandles: 0, closedHandles: openedHandles })

      await writeFile(join(value.root, 'pages', 'invalid.md'), 'invalid')
      await expectStableFailure(value.service.listPages(), 'CATALOG_CORRUPT', value.root)
      expect({ activeHandles, closedHandles }).toEqual({ activeHandles: 0, closedHandles: openedHandles })
      await rm(join(value.root, 'pages', 'invalid.md'))

      abortController = new AbortController()
      abortAfterOpen = openedHandles + 4
      await expectStableFailure(value.service.listPages({}, abortController.signal), 'ABORTED', value.root)
      expect({ activeHandles, closedHandles }).toEqual({ activeHandles: 0, closedHandles: openedHandles })
    } finally {
      openMock.mockImplementation(originalOpen)
    }
  })

  it('keeps stable invalid source membership classified as catalog corruption', async () => {
    const value = await harness()
    const source = await addEvidence(value, 'classification')
    await writeFile(join(value.root, 'sources', source.id, 'extra'), 'extra')
    await expectStableFailure(value.service.listSources(), 'CATALOG_CORRUPT', value.root)
  })
  it('rejects malformed cursor encodings and JSON shapes before touching the catalog', async () => {
    const value = await harness()
    const malformed = [
      Buffer.from([0xff]).toString('base64url'),
      'AB',
      Buffer.from('{').toString('base64url'),
      Buffer.from('null').toString('base64url'),
      Buffer.from('[]').toString('base64url'),
      Buffer.from(JSON.stringify({ v: 1, kind: 'sources', after: null })).toString('base64url'),
    ]

    for (const cursor of malformed) {
      await expectStableFailure(value.service.listSources({ cursor }), 'INVALID_CURSOR', value.root)
    }
  })

  it('maps directory, inspection, and read failures to path-safe catalog errors', async () => {
    const value = await harness()
    const source = await addEvidence(value, 'operating-system failures')
    await value.service.upsertPage({ id: pageId('failure'), title: 'Failure', summary: 'Failure paths.', sources: [source.id], body: '# Failure' })
    const pagesPath = join(value.root, 'pages')
    const pagePath = join(pagesPath, 'failure.md')
    const { open: originalOpen } = await vi.importActual<typeof fsPromises>('node:fs/promises')
    const denied = (): NodeJS.ErrnoException => Object.assign(new Error('injected catalog denial'), { code: 'EACCES' })
    const openMock = vi.mocked(fsPromises.open)

    try {
      let directoryOpenHit = false
      openMock.mockImplementation(async (...args: Parameters<typeof fsPromises.open>) => {
        if (String(args[0]) === pagesPath) {
          directoryOpenHit = true
          throw denied()
        }
        return originalOpen(...args)
      })
      await expectStableFailure(value.service.listPages(), 'UNSAFE_FILESYSTEM', value.root)
      expect(directoryOpenHit).toBe(true)

      let inspectionHit = false
      openMock.mockImplementation(async (...args: Parameters<typeof fsPromises.open>) => {
        const handle = await originalOpen(...args)
        if (String(args[0]) === pagePath) {
          handle.stat = () => {
            inspectionHit = true
            return Promise.reject(denied())
          }
        }
        return handle
      })
      await expectStableFailure(value.service.listPages(), 'UNSAFE_FILESYSTEM', value.root)
      expect(inspectionHit).toBe(true)

      let readHit = false
      openMock.mockImplementation(async (...args: Parameters<typeof fsPromises.open>) => {
        const handle = await originalOpen(...args)
        if (String(args[0]) === pagePath) {
          handle.readFile = () => {
            readHit = true
            return Promise.reject(denied())
          }
        }
        return handle
      })
      await expectStableFailure(value.service.listPages(), 'UNSAFE_FILESYSTEM', value.root)
      expect(readHit).toBe(true)
    } finally {
      openMock.mockImplementation(originalOpen)
    }
  })

  it.runIf(hasMkfifo)('rejects special filesystem entries in page catalogs', async () => {
    const value = await harness()
    const pipePath = join(value.root, 'pages', 'named-pipe')
    await mkdir(join(value.root, 'pages'), { recursive: true })
    execFileSync('mkfifo', [pipePath])
    expect((await stat(pipePath)).isFIFO()).toBe(true)

    await expectStableFailure(value.service.listPages(), 'UNSAFE_FILESYSTEM', value.root)
  })

})
