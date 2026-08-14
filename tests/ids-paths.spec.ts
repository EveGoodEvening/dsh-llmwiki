import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative, sep } from 'node:path'
import { afterEach, describe, expect, expectTypeOf, it } from 'vitest'
import { LlmWikiError, throwIfAborted } from '../src/errors.ts'
import { isPageId, isSourceId, pageId, sourceId } from '../src/ids.ts'
import type { PageId, SourceId } from '../src/ids.ts'
import { assertContainedWikiPath, assertSafeWikiPath, initializeWikiPaths } from '../src/paths.ts'

const temporaryRoots = new Set<string>()

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-llmwiki-c02-'))
  temporaryRoots.add(root)
  return root
}

afterEach(async () => {
  const roots = [...temporaryRoots]
  temporaryRoots.clear()
  await Promise.all(roots.map(async (root) => rm(root, { recursive: true, force: true })))
  await Promise.all(roots.map(async (root) => expect(lstat(root)).rejects.toMatchObject({ code: 'ENOENT' })))
})

describe('branded identifiers', () => {
  it('accepts canonical source and page IDs and round-trips their strings', () => {
    const hash = '0123456789abcdef'.repeat(4)
    expect(sourceId(hash)).toBe(hash)
    expect(isSourceId(hash)).toBe(true)
    expect(pageId('guides/intro')).toBe('guides/intro')
    expect(isPageId('guides/intro')).toBe(true)
  })

  it('keeps source and page brands distinct from each other and unvalidated strings', () => {
    expectTypeOf<SourceId>().toMatchTypeOf<string>()
    expectTypeOf<PageId>().toMatchTypeOf<string>()
    expectTypeOf<SourceId>().not.toMatchTypeOf<PageId>()
    expectTypeOf<PageId>().not.toMatchTypeOf<SourceId>()
    expectTypeOf<string>().not.toMatchTypeOf<SourceId>()
    expectTypeOf<string>().not.toMatchTypeOf<PageId>()

    const sourceCandidate: string = 'a'.repeat(64)
    const pageCandidate = 'guides/intro'
    if (isSourceId(sourceCandidate)) {
      expectTypeOf(sourceCandidate).toEqualTypeOf<SourceId>()
    }
    if (isPageId(pageCandidate)) {
      expectTypeOf(pageCandidate).toEqualTypeOf<PageId>()
    }
  })

  it.each([
    '',
    'a'.repeat(63),
    'A'.repeat(64),
    `${'a'.repeat(63)}g`,
  ])('rejects non-canonical source ID %j', (value) => {
    expect(() => sourceId(value)).toThrowError(LlmWikiError)
    expect(isSourceId(value)).toBe(false)
  })

  it.each([
    '',
    '/absolute',
    '//server/share',
    'C:/drive',
    'C:\\drive',
    '../escape',
    'a/../escape',
    '.',
    'a/./b',
    'a//b',
    'a/',
    'a\\b',
    'page.md',
    'PAGE.MD',
    'percent%2fescape',
    'nul\0byte',
    'control\u001fbyte',
    'delete\u007fbyte',
  ])('rejects unsafe or non-canonical page ID %j', (value) => {
    expect(() => pageId(value)).toThrowError(LlmWikiError)
    expect(isPageId(value)).toBe(false)
  })
})

describe('wiki-root containment', () => {
  it('derives every artifact strictly below the canonical root', async () => {
    const parent = await temporaryRoot()
    const paths = await initializeWikiPaths('wiki', undefined, parent)
    const id = sourceId('a'.repeat(64))
    const derived = [
      paths.schema,
      paths.sources,
      paths.pages,
      paths.index,
      paths.sourceDirectory(id),
      paths.sourceContent(id),
      paths.sourceMetadata(id),
      paths.page(pageId('nested/page')),
      paths.indexFile('search.json'),
      paths.indexFile('state.json'),
    ]

    for (const path of derived) {
      const rel = relative(paths.root, path)
      expect(rel).not.toBe('')
      expect(rel).not.toBe('..')
      expect(rel.startsWith(`..${sep}`)).toBe(false)
    }
  })

  it('rejects prefix-collision escapes instead of using string-prefix containment', async () => {
    const parent = await temporaryRoot()
    const root = join(parent, 'wiki')
    await mkdir(root)
    expect(() => assertContainedWikiPath(root, join(parent, 'wiki-escape', 'page.md'))).toThrowError(
      expect.objectContaining({ code: 'UNSAFE_FILESYSTEM' }),
    )
  })

  it('rejects an existing non-directory root', async () => {
    const parent = await temporaryRoot()
    await writeFile(join(parent, 'wiki'), 'not a directory')
    await expect(initializeWikiPaths('wiki', undefined, parent)).rejects.toMatchObject({
      code: 'UNSAFE_FILESYSTEM',
    })
  })
})

it('centralizes domain imports in the C02 primitive modules', async () => {
  const [idsSource, typesSource, pathsSource] = await Promise.all([
    readFile(new URL('../src/ids.ts', import.meta.url), 'utf8'),
    readFile(new URL('../src/types.ts', import.meta.url), 'utf8'),
    readFile(new URL('../src/paths.ts', import.meta.url), 'utf8'),
  ])
  expect(idsSource).toContain("import type { Branded } from '@deepseek-ai/dsh-brand'")
  expect(idsSource).not.toContain('unique symbol')
  expect(typesSource).toContain("from './ids.ts'")
  expect(pathsSource).toContain("from './ids.ts'")
  expect(pathsSource).toContain("from './errors.ts'")
})

describe.runIf(process.platform !== 'win32')('symlink rejection', () => {
  it('rejects a symlinked configured root', async () => {
    const parent = await temporaryRoot()
    const actual = join(parent, 'actual')
    await mkdir(actual)
    await symlink(actual, join(parent, 'wiki'))
    await expect(initializeWikiPaths('wiki', undefined, parent)).rejects.toMatchObject({
      code: 'UNSAFE_FILESYSTEM',
    })
  })

  it('rejects a symlinked root child and target file', async () => {
    const parent = await temporaryRoot()
    const paths = await initializeWikiPaths('wiki', undefined, parent)
    const outside = join(parent, 'outside')
    await mkdir(outside)
    await symlink(outside, join(paths.root, 'linked-child'))
    await expect(assertSafeWikiPath(paths.root, join(paths.root, 'linked-child', 'page.md'))).rejects.toMatchObject({
      code: 'UNSAFE_FILESYSTEM',
    })

    const outsideFile = join(outside, 'content')
    await writeFile(outsideFile, 'evidence')
    const linkedTarget = join(paths.pages, 'target.md')
    await symlink(outsideFile, linkedTarget)
    await expect(paths.assertSafe(linkedTarget)).rejects.toMatchObject({ code: 'UNSAFE_FILESYSTEM' })
  })

  it('rejects symlinked parent segments and broken symlinks', async () => {
    const parent = await temporaryRoot()
    const paths = await initializeWikiPaths('wiki', undefined, parent)
    const realParent = join(paths.pages, 'real')
    await mkdir(realParent)
    await symlink(realParent, join(paths.pages, 'linked-parent'))
    await expect(paths.assertSafe(join(paths.pages, 'linked-parent', 'missing.md'))).rejects.toMatchObject({
      code: 'UNSAFE_FILESYSTEM',
    })

    const broken = join(paths.pages, 'broken.md')
    await symlink(join(parent, 'does-not-exist'), broken)
    await expect(paths.assertSafe(broken)).rejects.toMatchObject({ code: 'UNSAFE_FILESYSTEM' })
  })

  it('rejects regular-file parent components', async () => {
    const parent = await temporaryRoot()
    const paths = await initializeWikiPaths('wiki', undefined, parent)
    const fileParent = join(paths.pages, 'file-parent')
    await writeFile(fileParent, 'not a directory')
    await expect(paths.assertSafe(join(fileParent, 'child.md'))).rejects.toMatchObject({
      code: 'UNSAFE_FILESYSTEM',
    })
  })
})

describe('abort and public errors', () => {
  it('maps a pre-aborted signal to the stable ABORTED error', async () => {
    const controller = new AbortController()
    controller.abort(new Error('private reason'))
    expect(() => throwIfAborted(controller.signal)).toThrowError(
      expect.objectContaining({ code: 'ABORTED', message: 'The operation was aborted.' }),
    )
    await expect(initializeWikiPaths('wiki', controller.signal, await temporaryRoot())).rejects.toMatchObject({
      code: 'ABORTED',
    })
  })

  it('checks cancellation again between asynchronous filesystem phases', async () => {
    const parent = await temporaryRoot()
    let reads = 0
    const signal = {
      get aborted() {
        reads += 1
        return reads >= 3
      },
    } as AbortSignal

    await expect(initializeWikiPaths('wiki', signal, parent)).rejects.toMatchObject({ code: 'ABORTED' })
  })

  it('serializes only a stable code and safe message while retaining an internal cause', () => {
    const cause = new Error('/private/wiki/path')
    const error = new LlmWikiError('UNSAFE_FILESYSTEM', 'Wiki filesystem is unsafe.', { cause })
    expect(error.cause).toBe(cause)
    expect(JSON.parse(JSON.stringify(error))).toEqual({
      code: 'UNSAFE_FILESYSTEM',
      message: 'Wiki filesystem is unsafe.',
    })
    expect(JSON.stringify(error)).not.toContain('/private/wiki/path')
    expect(JSON.stringify(error)).not.toContain('stack')
  })
})
