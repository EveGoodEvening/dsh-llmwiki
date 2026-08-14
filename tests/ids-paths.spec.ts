import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import type * as FsPromises from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative, sep } from 'node:path'
import { afterEach, describe, expect, expectTypeOf, it, vi } from 'vitest'
import { LlmWikiError, throwIfAborted } from '../src/errors.ts'
import { isPageId, isSourceId, pageId, sourceId } from '../src/ids.ts'
import type { PageId, SourceId } from '../src/ids.ts'
import { acquireWikiPaths, assertContainedWikiPath, assertSafeWikiPath, createWikiPaths, initializeWikiPaths } from '../src/paths.ts'

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

  it('rejects invalid root forms before touching the filesystem', async () => {
    const parent = await temporaryRoot()
    expect(() => createWikiPaths('relative/wiki')).toThrowError(expect.objectContaining({ code: 'INVALID_PATH' }))
    expect(() => createWikiPaths(`${join(parent, 'wiki')}\0suffix`)).toThrowError(
      expect.objectContaining({ code: 'INVALID_PATH' }),
    )
    await expect(acquireWikiPaths('', undefined, parent)).rejects.toMatchObject({ code: 'INVALID_PATH' })
    await expect(acquireWikiPaths('wiki\0suffix', undefined, parent)).rejects.toMatchObject({ code: 'INVALID_PATH' })
  })

  it('creates a fully absent nested root and rejects unsafe required directory replacements', async () => {
    const parent = await temporaryRoot()
    const paths = await initializeWikiPaths('nested/wiki', undefined, parent)
    expect((await lstat(paths.root)).isDirectory()).toBe(true)
    expect((await lstat(paths.sources)).isDirectory()).toBe(true)

    await rm(paths.pages, { recursive: true })
    await writeFile(paths.pages, 'replacement file')
    await expect(initializeWikiPaths('nested/wiki', undefined, parent)).rejects.toMatchObject({ code: 'UNSAFE_FILESYSTEM' })
    expect(await readFile(paths.pages, 'utf8')).toBe('replacement file')
  })
  it('maps required directory creation failures and detects a replaced directory leaf', async () => {
    const parent = await temporaryRoot()
    const root = join(parent, 'wiki')
    let replaceCreatedSources = false
    vi.resetModules()
    vi.doMock('node:fs/promises', async importOriginal => {
      const actual = await importOriginal<typeof FsPromises>()
      return {
        ...actual,
        mkdir: async (path: Parameters<typeof actual.mkdir>[0], options?: Parameters<typeof actual.mkdir>[1]) => {
          if (path === join(root, 'sources') && !replaceCreatedSources) {
            replaceCreatedSources = true
            throw Object.assign(new Error('private mkdir failure'), { code: 'EACCES' })
          }
          return actual.mkdir(path, options as never)
        },
      }
    })
    try {
      const { initializeWikiPaths: initializeWithFailingMkdir } = await import('../src/paths.ts')
      await expect(initializeWithFailingMkdir(root)).rejects.toMatchObject({
        code: 'UNSAFE_FILESYSTEM',
        message: 'Unable to create a required wiki directory.',
      })
    } finally {
      vi.doUnmock('node:fs/promises')
      vi.resetModules()
    }

    await rm(root, { recursive: true, force: true })
    let sourcesCreated = false
    vi.doMock('node:fs/promises', async importOriginal => {
      const actual = await importOriginal<typeof FsPromises>()
      return {
        ...actual,
        mkdir: async (path: Parameters<typeof actual.mkdir>[0], options?: Parameters<typeof actual.mkdir>[1]) => {
          const result = await actual.mkdir(path, options as never)
          if (path === join(root, 'sources')) sourcesCreated = true
          return result
        },
        lstat: async (path: Parameters<typeof actual.lstat>[0], options?: Parameters<typeof actual.lstat>[1]) => {
          const result = await actual.lstat(path, options as never)
          if (path === join(root, 'sources') && sourcesCreated) {
            return { ...result, isDirectory: () => false, isSymbolicLink: () => false }
          }
          return result
        },
      }
    })
    try {
      const { initializeWikiPaths: initializeWithReplacedLeaf } = await import('../src/paths.ts')
      await expect(initializeWithReplacedLeaf(root)).rejects.toMatchObject({
        code: 'UNSAFE_FILESYSTEM',
        message: 'Required wiki directory was replaced during initialization.',
      })
    } finally {
      vi.doUnmock('node:fs/promises')
      vi.resetModules()
    }
  })

  it('detects replaced root leaves and maps root resolution failures', async () => {
    const parent = await temporaryRoot()
    const root = join(parent, 'nested', 'wiki')
    let rootCreated = false
    vi.resetModules()
    vi.doMock('node:fs/promises', async importOriginal => {
      const actual = await importOriginal<typeof FsPromises>()
      return {
        ...actual,
        mkdir: async (path: Parameters<typeof actual.mkdir>[0], options?: Parameters<typeof actual.mkdir>[1]) => {
          const result = await actual.mkdir(path, options as never)
          if (path === root) rootCreated = true
          return result
        },
        lstat: async (path: Parameters<typeof actual.lstat>[0], options?: Parameters<typeof actual.lstat>[1]) => {
          const result = await actual.lstat(path, options as never)
          if (path === root && rootCreated) {
            return { ...result, isDirectory: () => false, isSymbolicLink: () => false }
          }
          return result
        },
      }
    })
    try {
      const { initializeWikiPaths: initializeWithReplacedRoot } = await import('../src/paths.ts')
      await expect(initializeWithReplacedRoot(root)).rejects.toMatchObject({
        code: 'UNSAFE_FILESYSTEM',
        message: 'Configured wiki root path was replaced during initialization.',
      })
    } finally {
      vi.doUnmock('node:fs/promises')
      vi.resetModules()
    }

    await rm(root, { recursive: true, force: true })
    await mkdir(root, { recursive: true })
    vi.doMock('node:fs/promises', async importOriginal => {
      const actual = await importOriginal<typeof FsPromises>()
      return {
        ...actual,
        realpath: async (path: Parameters<typeof actual.realpath>[0], options?: Parameters<typeof actual.realpath>[1]) => {
          if (path === root) throw Object.assign(new Error('private realpath failure'), { code: 'EIO' })
          return actual.realpath(path, options as never)
        },
      }
    })
    try {
      const { initializeWikiPaths: initializeWithFailingRealpath } = await import('../src/paths.ts')
      await expect(initializeWithFailingRealpath(root)).rejects.toMatchObject({
        code: 'UNSAFE_FILESYSTEM',
        message: 'Unable to resolve the configured wiki root.',
      })
    } finally {
      vi.doUnmock('node:fs/promises')
      vi.resetModules()
    }
  })

  it('rejects a root replaced after canonical resolution', async () => {
    const parent = await temporaryRoot()
    const root = join(parent, 'wiki')
    await mkdir(root)
    let resolvedRoot = false
    vi.resetModules()
    vi.doMock('node:fs/promises', async importOriginal => {
      const actual = await importOriginal<typeof FsPromises>()
      return {
        ...actual,
        realpath: async (path: Parameters<typeof actual.realpath>[0], options?: Parameters<typeof actual.realpath>[1]) => {
          const result = await actual.realpath(path, options as never)
          if (path === root) resolvedRoot = true
          return result
        },
        lstat: async (path: Parameters<typeof actual.lstat>[0], options?: Parameters<typeof actual.lstat>[1]) => {
          const result = await actual.lstat(path, options as never)
          if (path === root && resolvedRoot) {
            return { ...result, isDirectory: () => false, isSymbolicLink: () => false }
          }
          return result
        },
      }
    })
    try {
      const { initializeWikiPaths: initializeWithLateReplacement } = await import('../src/paths.ts')
      await expect(initializeWithLateReplacement(root)).rejects.toMatchObject({
        code: 'UNSAFE_FILESYSTEM',
        message: 'Configured wiki root changed during initialization.',
      })
    } finally {
      vi.doUnmock('node:fs/promises')
      vi.resetModules()
    }
  })

  it('accepts absent and regular-file leaf targets but rejects an absent root', async () => {
    const parent = await temporaryRoot()
    const paths = await initializeWikiPaths('wiki', undefined, parent)
    const absent = join(paths.pages, 'missing', 'page.md')
    await expect(paths.assertSafe(absent)).resolves.toBeUndefined()

    const existing = join(paths.pages, 'existing.md')
    await writeFile(existing, 'page')
    await expect(assertSafeWikiPath(paths.root, existing)).resolves.toBeUndefined()

    await rm(paths.root, { recursive: true })
    await expect(assertSafeWikiPath(paths.root, existing)).rejects.toMatchObject({ code: 'UNSAFE_FILESYSTEM' })
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

  it('acquires safe paths without traversing configured-root or ancestor symlinks', async () => {
    const parent = await temporaryRoot()
    const outside = join(parent, 'outside')
    const marker = join(outside, 'marker')
    await mkdir(outside)
    await writeFile(marker, 'unchanged')

    const configuredRoot = join(parent, 'linked-root')
    await symlink(outside, configuredRoot)
    await expect(acquireWikiPaths(configuredRoot)).rejects.toMatchObject({ code: 'UNSAFE_FILESYSTEM' })
    expect(await readFile(marker, 'utf8')).toBe('unchanged')

    await rm(configuredRoot)
    const linkedAncestor = join(parent, 'linked-ancestor')
    await symlink(outside, linkedAncestor)
    const absentRoot = join(linkedAncestor, 'wiki')
    await expect(acquireWikiPaths(absentRoot)).rejects.toMatchObject({ code: 'UNSAFE_FILESYSTEM' })
    expect(await readFile(marker, 'utf8')).toBe('unchanged')
    await expect(lstat(join(outside, 'wiki'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('acquires an absent root without creating it', async () => {
    const parent = await temporaryRoot()
    const root = join(parent, 'absent', 'wiki')

    const paths = await acquireWikiPaths(root)

    expect(paths.root).toBe(root)
    await expect(lstat(root)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(lstat(join(parent, 'absent'))).rejects.toMatchObject({ code: 'ENOENT' })
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
