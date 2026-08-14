import { createHash } from 'node:crypto'
import { mkdir, readFile, readdir, rename, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Config, resolveConfig } from '../src/config.ts'
import { LlmWikiError } from '../src/errors.ts'
import { pageId } from '../src/ids.ts'
import { encodeUtf8, renderPageMarkdown } from '../src/markdown.ts'
import { createServiceHarness } from './harness.ts'
import { LlmWikiService } from '../src/service.ts'
import type { SourceReceipt } from '../src/types.ts'
import type { ServiceHarness } from './harness.ts'

const harnesses: ServiceHarness[] = []
const sha256 = (bytes: Uint8Array | string): string => createHash('sha256').update(bytes).digest('hex')
const hasErrorCode = (value: unknown): value is Error & { readonly code: string } =>
  value instanceof Error && 'code' in value && typeof value.code === 'string'

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

async function waitUntil(predicate: () => boolean | Promise<boolean>): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (await predicate()) return
    const { promise, resolve } = Promise.withResolvers<void>()
    setTimeout(resolve, 1)
    await promise
  }
  throw new Error('condition was not observed')
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
      await value.service.status()
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

  it('initializes partial layouts idempotently, disposes the child fiber, and rejects later calls', async () => {
    const value = await harness()
    await mkdir(value.root, { recursive: true })
    await mkdir(join(value.root, 'sources'))
    await writeFile(join(value.root, 'schema.md'), '# User schema\n')
    expect(await value.service.status()).toEqual(await value.service.status())
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

  it('uses fresh capture times across roots while same-root dedupe preserves canonical bytes', async () => {
    const firstRoot = await harness()
    const content = 'shared accounting bytes'
    const first = await firstRoot.service.addSource({ name: 'first', content })
    const directory = join(firstRoot.root, 'sources', first.id)
    const contentBytes = await readFile(join(directory, 'content'))
    const metadataBytes = await readFile(join(directory, 'metadata.json'))
    const duplicate = await firstRoot.service.addSource({ name: 'ignored', content, origin: 'ignored' })
    expect(duplicate.metadata.capturedAt).toBe(first.metadata.capturedAt)
    expect(await readFile(join(directory, 'content'))).toStrictEqual(contentBytes)
    expect(await readFile(join(directory, 'metadata.json'))).toStrictEqual(metadataBytes)
    await waitUntil(() => new Date().toISOString() !== first.metadata.capturedAt)
    const secondRoot = await harness()
    const fresh = await secondRoot.service.addSource({ name: 'second', content })
    expect(fresh.id).toBe(first.id)
    expect(fresh.deduplicated).toBe(false)
    expect(fresh.metadata.capturedAt).not.toBe(first.metadata.capturedAt)
  })

  it('rejects over-cap sources without leaving a source record', async () => {
    const value = await harness({ maxSourceBytes: 4 })
    const content = '12345'
    await expectStableFailure(value.service.addSource({ name: 'too-large', content }), 'LIMIT_EXCEEDED', value.root)
    expect(await readdir(join(value.root, 'sources'))).toEqual([])
    await expect(stat(join(value.root, 'sources', sha256(encodeUtf8(content))))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('accounts for zero, EOF, and multibyte ranges and rejects limits above the configured cap', async () => {
    const value = await harness({ maxSourceBytes: 10 })
    const receipt = await value.service.addSource({ name: 'ranges', content: 'aé漢z' })
    await expect(value.service.readSource(receipt.id, { offset: 0, limit: 1 })).resolves.toMatchObject({ content: 'a', byteStart: 0, byteEnd: 1, byteCount: 7 })
    await expect(value.service.readSource(receipt.id, { offset: 7, limit: 1 })).resolves.toMatchObject({ content: '', byteStart: 7, byteEnd: 7, byteCount: 7 })
    await expect(value.service.readSource(receipt.id, { offset: 2, limit: 4 })).resolves.toMatchObject({ content: '漢', byteStart: 3, byteEnd: 6, byteCount: 7 })
    await expectStableFailure(value.service.readSource(receipt.id, { offset: 0, limit: 11 }), 'LIMIT_EXCEEDED', value.root)
    await expectStableFailure(value.service.readSource(receipt.id, { offset: 0, limit: 0 }), 'LIMIT_EXCEEDED', value.root)
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

  it('always returns ordered in-bounds UTF-8 byte ranges for multibyte offsets and tiny limits', async () => {
    const value = await harness({ maxSourceBytes: 16 })
    const receipt = await value.service.addSource({ name: 'bytes', content: 'aé漢🙂z' })
    const cases = [[0, 1], [1, 1], [2, 1], [3, 1], [4, 2], [6, 1], [7, 2], [9, 1], [10, 1]] as const
    for (const [offset, limit] of cases) {
      const result = await value.service.readSource(receipt.id, { offset, limit })
      expect(result.byteStart).toBeGreaterThanOrEqual(0)
      expect(result.byteEnd).toBeGreaterThanOrEqual(result.byteStart)
      expect(result.byteEnd).toBeLessThanOrEqual(result.byteCount)
      expect(Buffer.byteLength(result.content)).toBe(result.byteEnd - result.byteStart)
      expect(result.content).not.toContain('\uFFFD')
    }
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
    await expectStableFailure(value.service.addSource({ name: 'blank origin', content: 'x', origin: '' }), 'INVALID_PAGE', value.root)

    const receipt = await addEvidence(value)
    const directory = join(value.root, 'sources', receipt.id)
    const metadataPath = join(directory, 'metadata.json')
    const original = JSON.parse(await readFile(metadataPath, 'utf8')) as Record<string, unknown>
    for (const metadata of [
      { ...original, mediaType: ' ' },
      { ...original, origin: 1 },
      { ...original, origin: '' },
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
  it('creates canonical pages and invalidates a fresh index', async () => {
    const value = await harness()
    const page = await addPage(value)
    expect(await readFile(join(value.root, 'pages', 'notes', 'alpha.md'), 'utf8')).toBe(renderPageMarkdown(page.input, page.input.body))
    await value.service.reindex()
    await value.service.upsertPage({ ...page.input, body: '# Finding\n\nUpdated.\n' })
    expect(await readdir(join(value.root, '.index'))).toEqual([])
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

  it('does not ignore failed derived invalidation and never leaks raw filesystem paths', async () => {
    const value = await harness()
    const page = await addPage(value)
    await value.service.reindex()
    const state = join(value.root, '.index', 'state.json')
    await rm(state)
    await mkdir(state)
    await expectStableFailure(value.service.upsertPage({ ...page.input, body: '# changed\n' }), 'UNSAFE_FILESYSTEM', value.root)
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

  it('returns success when abort arrives only after the durable page commit', async () => {
    const value = await harness()
    const evidence = await addEvidence(value)
    const input = { id: pageId('race/commit'), title: 'Commit', summary: 'Commit', sources: [evidence.id], body: '# Commit\n' }
    const controller = new AbortController()
    const operation = observeRejection(value.service.upsertPage(input, controller.signal))
    await waitUntil(async () => stat(join(value.root, 'pages', 'race', 'commit.md')).then(() => true, () => false))
    controller.abort()
    await expect(operation).resolves.toMatchObject({ id: input.id })
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
