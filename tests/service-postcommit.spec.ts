import { createHash } from 'node:crypto'
import * as fsPromises from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import type * as FsPromises from 'node:fs/promises'
import type { PathLike } from 'node:fs'

const disposals: (() => Promise<void>)[] = []

afterEach(async () => {
  await Promise.allSettled(disposals.splice(0).map(dispose => dispose()))
  vi.doUnmock('node:fs/promises')
  vi.resetModules()
})

it('keeps a committed update successful when abort and denied index cleanup follow the actual rename', async () => {
  const controller = new AbortController()
  const indexUnlinks: string[] = []
  let pagePath: string | undefined
  let pageRenameHits = 0
  let abortOnPageRename = false
  const indexPaths = new Set<string>()

  vi.resetModules()
  vi.doMock('node:fs/promises', async importOriginal => {
    const actual = await importOriginal<typeof FsPromises>()
    return {
      ...actual,
      async rename(from: PathLike, to: PathLike) {
        await actual.rename(from, to)
        if (pagePath !== undefined && resolve(String(to)) === pagePath) {
          pageRenameHits += 1
          if (abortOnPageRename) controller.abort()
        }
      },
      async unlink(path: PathLike) {
        const resolvedPath = resolve(String(path))
        if (indexPaths.has(resolvedPath)) {
          indexUnlinks.push(resolvedPath)
          const error = new Error('injected index cleanup denial') as NodeJS.ErrnoException
          error.code = 'EACCES'
          throw error
        }
        await actual.unlink(path)
      },
    }
  })

  const [{ createServiceHarness }, { pageId }, { encodeUtf8, renderPageMarkdown }] = await Promise.all([
    import('./harness.ts'),
    import('../src/ids.ts'),
    import('../src/markdown.ts'),
  ])
  const value = await createServiceHarness()
  disposals.push(() => value.dispose())
  const source = await value.service.addSource({ name: 'evidence', content: 'immutable source bytes' })
  const id = pageId('race/commit')
  const initial = { id, title: 'Commit', summary: 'Initial', sources: [source.id], body: '# Initial\n' }
  await value.service.upsertPage(initial)
  await value.service.reindex()
  abortOnPageRename = true

  pagePath = resolve(value.root, 'pages', 'race', 'commit.md')
  const sourcePath = join(value.root, 'sources', source.id, 'content')
  const searchPath = resolve(value.root, '.index', 'search.json')
  const statePath = resolve(value.root, '.index', 'state.json')
  indexPaths.add(searchPath)
  indexPaths.add(statePath)
  const sourceBytes = await fsPromises.readFile(sourcePath)
  const searchBytes = await fsPromises.readFile(searchPath)
  const stateBytes = await fsPromises.readFile(statePath)
  const update = { ...initial, summary: 'Updated', body: '# Updated\n\nPost-commit truth.\n' }
  const expectedPageBytes = encodeUtf8(renderPageMarkdown(update, update.body))
  const expectedHash = createHash('sha256').update(expectedPageBytes).digest('hex')

  await expect(value.service.upsertPage(update, controller.signal)).resolves.toEqual({ id, created: false, sha256: expectedHash })
  expect(pageRenameHits).toBe(1)
  expect(controller.signal.aborted).toBe(true)
  expect(await fsPromises.readFile(pagePath)).toStrictEqual(Buffer.from(expectedPageBytes))
  expect(await fsPromises.readFile(sourcePath)).toStrictEqual(sourceBytes)
  expect(await fsPromises.readFile(searchPath)).toStrictEqual(searchBytes)
  expect(await fsPromises.readFile(statePath)).toStrictEqual(stateBytes)
  expect(indexUnlinks).toEqual([])
})
