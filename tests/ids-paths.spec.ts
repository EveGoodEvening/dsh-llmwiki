import { lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } from 'node:fs/promises'
import type * as FsPromises from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative, sep } from 'node:path'
import { afterEach, describe, expect, expectTypeOf, it, vi } from 'vitest'
import { LlmWikiError, throwIfAborted } from '../src/errors.ts'
import { isPageId, isSourceId, pageId, sourceId } from '../src/ids.ts'
import type { PageId, SourceId } from '../src/ids.ts'
import { acquireWikiPaths, assertContainedWikiPath, createWikiPaths, initializeWikiPaths, withWikiRoot } from '../src/paths.ts'

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
  it('maps descriptor-anchored directory creation failures without creating required children', async () => {
    const parent = await temporaryRoot()
    const root = join(parent, 'wiki')
    vi.resetModules()
    vi.doMock('node:fs/promises', async importOriginal => {
      const actual = await importOriginal<typeof FsPromises>()
      return { ...actual, mkdir: async (path: Parameters<typeof actual.mkdir>[0], options?: Parameters<typeof actual.mkdir>[1]) => {
        if (String(path).endsWith('/sources')) throw Object.assign(new Error('private mkdir failure'), { code: 'EACCES' })
        return actual.mkdir(path, options as never)
      } }
    })
    try {
      // Reload intentionally: the syscall adapter must capture this test's mocked module.
      const { initializeWikiPaths: initialize } = await import('../src/paths.ts')
      await expect(initialize(root)).rejects.toMatchObject({ code: 'UNSAFE_FILESYSTEM' })
      await expect(lstat(join(root, 'sources'))).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      vi.doUnmock('node:fs/promises')
      vi.resetModules()
    }
  })

  it('reuses verified existing directories without mkdir and rejects readonly new allocations', async () => {
    const root = await temporaryRoot()
    await mkdir(join(root, 'existing'))
    await symlink(join(root, 'existing'), join(root, 'linked'))
    vi.resetModules()
    vi.doMock('node:fs/promises', async importOriginal => {
      const actual = await importOriginal<typeof FsPromises>()
      return { ...actual, mkdir: () => Promise.reject(Object.assign(new Error('read-only filesystem'), { code: 'EROFS' })) }
    })
    try {
      // Reload intentionally: static imports cannot capture this test's mocked syscall adapter.
      const { createWikiPaths: createPaths, withWikiRoot: withRoot } = await import('../src/paths.ts')
      await withRoot(createPaths(root).authority, {}, async directory => {
        const expected = await lstat(join(root, 'existing'), { bigint: true })
        const allocation = await directory.createDirectory('existing')
        expect(allocation.created).toBe(false)
        expect(allocation.identity.dev).toBe(expected.dev)
        expect(allocation.identity.ino).toBe(expected.ino)
        await expect(directory.createDirectory('linked')).rejects.toMatchObject({ code: 'UNSAFE_FILESYSTEM' })
        await expect(directory.createDirectory('new')).rejects.toMatchObject({
          code: 'UNSAFE_FILESYSTEM', cause: { code: 'EROFS' },
        })
        await expect(directory.directory(['nested'], { create: true }, () => Promise.resolve(true))).rejects.toMatchObject({
          code: 'UNSAFE_FILESYSTEM', cause: { code: 'EROFS' },
        })
      })
      expect((await readdir(root)).sort()).toEqual(['existing', 'linked'])
    } finally {
      vi.doUnmock('node:fs/promises')
      vi.resetModules()
    }
  })

  it.each(['root', 'required child'] as const)('descriptor-anchored initialization rejects a swapped %s before directory open', async boundary => {
    const parent = await temporaryRoot()
    const root = join(parent, 'wiki')
    const outside = join(parent, 'outside')
    await mkdir(outside)
    await writeFile(join(outside, 'sentinel'), 'outside unchanged')
    const victim = boundary === 'root' ? root : join(root, 'sources')
    const displaced = join(parent, 'displaced')
    const handles: FsPromises.FileHandle[] = []
    let swapped = false
    vi.resetModules()
    vi.doMock('node:fs/promises', async importOriginal => {
      const actual = await importOriginal<typeof FsPromises>()
      return {
        ...actual,
        mkdir: async (path: Parameters<typeof actual.mkdir>[0], options?: Parameters<typeof actual.mkdir>[1]) => {
          const result = await actual.mkdir(path, options as never)
          if (!swapped && String(path).endsWith(boundary === 'root' ? '/wiki' : '/sources')) {
            swapped = true
            await actual.rename(victim, displaced)
            await actual.symlink(outside, victim)
          }
          return result
        },
        open: async (...args: Parameters<typeof actual.open>) => {
          const handle = await actual.open(...args)
          handles.push(handle)
          return handle
        },
      }
    })
    try {
      // Reload intentionally: the syscall adapter must capture this test's mocked module.
      const { initializeWikiPaths: initialize } = await import('../src/paths.ts')
      await expect(initialize(root)).rejects.toMatchObject({ code: 'UNSAFE_FILESYSTEM' })
      expect(swapped).toBe(true)
      expect(await readdir(outside)).toEqual(['sentinel'])
      expect(await readFile(join(outside, 'sentinel'), 'utf8')).toBe('outside unchanged')
      for (const handle of handles) expect(handle.fd).toBe(-1)
    } finally {
      vi.doUnmock('node:fs/promises')
      vi.resetModules()
    }
  })

  it('reads regular-file leaves and reports absent entries without creating them', async () => {
    const parent = await temporaryRoot()
    const paths = await initializeWikiPaths('wiki', undefined, parent)
    await writeFile(join(paths.pages, 'existing.md'), 'page')
    await withWikiRoot(paths.authority, {}, async root => {
      await root.directory(['pages'], {}, async pages => {
        expect(await pages.read('missing.md')).toBeNull()
        expect((await pages.read('existing.md'))?.bytes.toString()).toBe('page')
      })
    })
    await rm(paths.root, { recursive: true })
    await expect(withWikiRoot(paths.authority, {}, async root => root.identity())).rejects.toMatchObject({ code: 'UNSAFE_FILESYSTEM' })
  })

  it.each(['read parent', 'read leaf', 'create parent', 'root'] as const)('descriptor-anchored %s swap cannot reach the outside tree', async boundary => {
    const parent = await temporaryRoot()
    const paths = await initializeWikiPaths('wiki', undefined, parent)
    const outside = join(parent, 'outside')
    await mkdir(outside)
    await writeFile(join(outside, 'page.md'), 'outside secret')
    await writeFile(join(paths.pages, 'page.md'), 'authorized bytes')
    const victim = boundary === 'root' ? paths.root : boundary === 'read leaf' ? join(paths.pages, 'page.md') : paths.pages
    const displaced = join(parent, 'displaced')
    const handles: FsPromises.FileHandle[] = []
    let swapped = false
    vi.resetModules()
    vi.doMock('node:fs/promises', async importOriginal => {
      const actual = await importOriginal<typeof FsPromises>()
      return { ...actual, open: async (...args: Parameters<typeof actual.open>) => {
        const path = String(args[0])
        const suffix = boundary === 'root' ? '/wiki' : boundary === 'read leaf' ? '/page.md' : '/pages'
        if (!swapped && path.endsWith(suffix)) {
          swapped = true
          await actual.rename(victim, displaced)
          await actual.symlink(boundary === 'read leaf' ? join(outside, 'page.md') : outside, victim)
        }
        const handle = await actual.open(...args)
        handles.push(handle)
        return handle
      } }
    })
    try {
      // Reload intentionally: the syscall adapter must capture this test's mocked module.
      const { withWikiRoot: pin } = await import('../src/paths.ts')
      await expect(pin(paths.authority, {}, root => root.directory(['pages'], {}, async pages => {
        if (boundary === 'create parent') return pages.directory(['new', 'nested'], { create: true }, child => child.identity())
        return pages.read('page.md')
      }))).rejects.toMatchObject({ code: 'UNSAFE_FILESYSTEM' })
      expect(swapped).toBe(true)
      expect(await readdir(outside)).toEqual(['page.md'])
      expect(await readFile(join(outside, 'page.md'), 'utf8')).toBe('outside secret')
      for (const handle of handles) expect(handle.fd).toBe(-1)
    } finally {
      vi.doUnmock('node:fs/promises')
      vi.resetModules()
    }
  })

  it('descriptor-anchored creation continues only in the pinned parent after its lexical name is replaced', async () => {
    const parent = await temporaryRoot()
    const paths = await initializeWikiPaths('wiki', undefined, parent)
    const outside = join(parent, 'outside')
    const displaced = join(parent, 'displaced')
    await mkdir(outside)
    await writeFile(join(outside, 'sentinel'), 'unchanged')
    const handles: FsPromises.FileHandle[] = []
    let swapped = false
    vi.resetModules()
    vi.doMock('node:fs/promises', async importOriginal => {
      const actual = await importOriginal<typeof FsPromises>()
      return {
        ...actual,
        open: async (...args: Parameters<typeof actual.open>) => {
          const handle = await actual.open(...args)
          handles.push(handle)
          return handle
        },
        mkdir: async (path: Parameters<typeof actual.mkdir>[0], options?: Parameters<typeof actual.mkdir>[1]) => {
          if (!swapped && String(path).endsWith('/new')) {
            swapped = true
            await actual.rename(paths.pages, displaced)
            await actual.symlink(outside, paths.pages)
          }
          return actual.mkdir(path, options as never)
        },
      }
    })
    try {
      // Reload intentionally: the syscall adapter must capture this test's mocked module.
      const { withWikiRoot: pin } = await import('../src/paths.ts')
      await pin(paths.authority, {}, root => root.directory(['pages', 'new', 'nested'], { create: true }, directory => directory.identity()))
      expect(swapped).toBe(true)
      expect((await lstat(join(displaced, 'new', 'nested'))).isDirectory()).toBe(true)
      expect(await readdir(outside)).toEqual(['sentinel'])
      expect(await readFile(join(outside, 'sentinel'), 'utf8')).toBe('unchanged')
      for (const handle of handles) expect(handle.fd).toBe(-1)
    } finally {
      vi.doUnmock('node:fs/promises')
      vi.resetModules()
    }
  })

  it('descriptor-anchored initialized authority refuses an ordinary replacement root', async () => {
    const parent = await temporaryRoot()
    const paths = await initializeWikiPaths('wiki', undefined, parent)
    await writeFile(join(paths.root, 'marker'), 'authorized')
    const displaced = join(parent, 'original')
    await rename(paths.root, displaced)
    await mkdir(paths.root)
    await writeFile(join(paths.root, 'marker'), 'replacement')
    await expect(withWikiRoot(paths.authority, {}, root => root.read('marker'))).rejects.toMatchObject({ code: 'UNSAFE_FILESYSTEM' })
    expect(await readFile(join(displaced, 'marker'), 'utf8')).toBe('authorized')
    expect(await readFile(join(paths.root, 'marker'), 'utf8')).toBe('replacement')
  })
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

  it('opens existing initialization directories without mkdir and preserves genuine read-only creation denial', async () => {
    const parent = await temporaryRoot()
    const root = join(parent, 'wiki')
    await initializeWikiPaths(root)
    await writeFile(join(root, 'pages', 'existing.md'), 'readable evidence')
    const readOnly = Object.assign(new Error('read-only filesystem'), { code: 'EROFS' })
    vi.resetModules()
    vi.doMock('node:fs/promises', async importOriginal => {
      const actual = await importOriginal<typeof FsPromises>()
      return { ...actual, mkdir: () => Promise.reject(readOnly) }
    })
    try {
      // Reload intentionally so the filesystem adapter captures this test's read-only syscall seam.
      const { initializeWikiPaths: initialize, withWikiRoot: pin } = await import('../src/paths.ts')
      const paths = await initialize(root)
      const record = await pin(paths.authority, { create: true }, directory => directory.directory(['pages'], { create: true }, pages => pages.read('existing.md')))
      expect(record?.bytes.toString()).toBe('readable evidence')
      await expect(pin(paths.authority, {}, directory => directory.directory(['pages', 'missing'], { create: true }, child => child.identity()))).rejects.toMatchObject({ code: 'UNSAFE_FILESYSTEM', cause: readOnly })
      await expect(initialize(join(parent, 'absent'))).rejects.toMatchObject({ code: 'UNSAFE_FILESYSTEM', cause: readOnly })
      expect(await readdir(join(root, 'pages'))).toEqual(['existing.md'])
      await expect(lstat(join(parent, 'absent'))).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      vi.doUnmock('node:fs/promises')
      vi.resetModules()
    }
  })

  it('rejects a symlinked root child and target file', async () => {
    const parent = await temporaryRoot()
    const paths = await initializeWikiPaths('wiki', undefined, parent)
    const outside = join(parent, 'outside')
    await mkdir(outside)
    await symlink(outside, join(paths.root, 'linked-child'))
    await expect(withWikiRoot(paths.authority, {}, root => root.directory(['linked-child'], {}, child => child.read('page.md')))).rejects.toMatchObject({
      code: 'UNSAFE_FILESYSTEM',
    })

    const outsideFile = join(outside, 'content')
    await writeFile(outsideFile, 'evidence')
    const linkedTarget = join(paths.pages, 'target.md')
    await symlink(outsideFile, linkedTarget)
    await expect(withWikiRoot(paths.authority, {}, root => root.directory(['pages'], {}, pages => pages.read('target.md')))).rejects.toMatchObject({ code: 'UNSAFE_FILESYSTEM' })
  })

  it('rejects symlinked parent segments and broken symlinks', async () => {
    const parent = await temporaryRoot()
    const paths = await initializeWikiPaths('wiki', undefined, parent)
    const realParent = join(paths.pages, 'real')
    await mkdir(realParent)
    await symlink(realParent, join(paths.pages, 'linked-parent'))
    await expect(withWikiRoot(paths.authority, {}, root => root.directory(['pages', 'linked-parent'], {}, child => child.read('missing.md')))).rejects.toMatchObject({
      code: 'UNSAFE_FILESYSTEM',
    })

    const broken = join(paths.pages, 'broken.md')
    await symlink(join(parent, 'does-not-exist'), broken)
    await expect(withWikiRoot(paths.authority, {}, root => root.directory(['pages'], {}, pages => pages.read('broken.md')))).rejects.toMatchObject({ code: 'UNSAFE_FILESYSTEM' })
  })

  it('rejects regular-file parent components', async () => {
    const parent = await temporaryRoot()
    const paths = await initializeWikiPaths('wiki', undefined, parent)
    const fileParent = join(paths.pages, 'file-parent')
    await writeFile(fileParent, 'not a directory')
    await expect(withWikiRoot(paths.authority, {}, root => root.directory(['pages', 'file-parent'], {}, child => child.read('child.md')))).rejects.toMatchObject({
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

  it('closes descriptors and stops creation after an abort at the actual root-open boundary', async () => {
    const parent = await temporaryRoot()
    const root = join(parent, 'wiki')
    await mkdir(root)
    const controller = new AbortController()
    const handles: FsPromises.FileHandle[] = []
    vi.resetModules()
    vi.doMock('node:fs/promises', async importOriginal => {
      const actual = await importOriginal<typeof FsPromises>()
      return { ...actual, open: async (...args: Parameters<typeof actual.open>) => {
        const handle = await actual.open(...args)
        handles.push(handle)
        if (String(args[0]).endsWith('/wiki')) controller.abort()
        return handle
      } }
    })
    try {
      // Reload intentionally: the syscall adapter must capture this test's mocked module.
      const { initializeWikiPaths: initialize } = await import('../src/paths.ts')
      await expect(initialize(root, controller.signal)).rejects.toMatchObject({ code: 'ABORTED' })
      expect(await readdir(root)).toEqual([])
      for (const handle of handles) expect(handle.fd).toBe(-1)
    } finally {
      vi.doUnmock('node:fs/promises')
      vi.resetModules()
    }
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
