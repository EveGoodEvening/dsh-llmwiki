import { lstat, mkdir, realpath } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { LlmWikiError, throwIfAborted, unsafeFilesystem } from './errors.ts'
import type { PageId, SourceId } from './ids.ts'

export interface WikiPaths {
  readonly root: string
  readonly schema: string
  readonly sources: string
  readonly pages: string
  readonly index: string
  sourceDirectory(id: SourceId): string
  sourceContent(id: SourceId): string
  sourceMetadata(id: SourceId): string
  page(id: PageId): string
  indexFile(name: 'search.json' | 'state.json'): string
  assertSafe(path: string, signal?: AbortSignal): Promise<void>
}

function containedRelativePath(root: string, target: string): string {
  const result = relative(root, target)
  if (result.length === 0 || result === '..' || result.startsWith(`..${sep}`) || isAbsolute(result)) {
    throw unsafeFilesystem('Derived path escapes the wiki root.')
  }
  return result
}

async function checkedLstat(path: string, signal?: AbortSignal) {
  throwIfAborted(signal)
  try {
    const result = await lstat(path)
    throwIfAborted(signal)
    return result
  } catch (cause) {
    throwIfAborted(signal)
    if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw unsafeFilesystem('Unable to inspect the wiki filesystem safely.', { cause })
  }
}

async function assertRootIdentity(root: string, signal?: AbortSignal): Promise<void> {
  const rootStat = await checkedLstat(root, signal)
  if (rootStat === null || !rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw unsafeFilesystem('Wiki root is missing, is not a directory, or is a symbolic link.')
  }
  throwIfAborted(signal)
  let canonicalRoot: string
  try {
    canonicalRoot = await realpath(root)
  } catch (cause) {
    throwIfAborted(signal)
    throw unsafeFilesystem('Unable to resolve the wiki root safely.', { cause })
  }
  throwIfAborted(signal)
  if (canonicalRoot !== root) {
    throw unsafeFilesystem('Wiki root identity changed or is not canonical.')
  }
}

export async function assertSafeWikiPath(
  root: string,
  target: string,
  signal?: AbortSignal,
): Promise<void> {
  const relativeTarget = containedRelativePath(root, resolve(target))
  await assertRootIdentity(root, signal)

  let current = root
  for (const segment of relativeTarget.split(sep)) {
    current = join(current, segment)
    const stat = await checkedLstat(current, signal)
    if (stat === null) return
    if (stat.isSymbolicLink()) {
      throw unsafeFilesystem('Symbolic links are not allowed below the wiki root.')
    }
    if (current !== resolve(target) && !stat.isDirectory()) {
      throw unsafeFilesystem('A wiki path parent is not a directory.')
    }
  }
  throwIfAborted(signal)
}

async function createSafeDirectory(root: string, target: string, signal?: AbortSignal): Promise<void> {
  await assertSafeWikiPath(root, target, signal)
  const existing = await checkedLstat(target, signal)
  if (existing !== null) {
    if (!existing.isDirectory() || existing.isSymbolicLink()) {
      throw unsafeFilesystem('Required wiki path is not a safe directory.')
    }
    return
  }

  throwIfAborted(signal)
  try {
    await mkdir(target)
  } catch (cause) {
    throwIfAborted(signal)
    if ((cause as NodeJS.ErrnoException).code !== 'EEXIST') {
      throw unsafeFilesystem('Unable to create a required wiki directory.', { cause })
    }
  }
  throwIfAborted(signal)
  const created = await checkedLstat(target, signal)
  if (created === null || !created.isDirectory() || created.isSymbolicLink()) {
    throw unsafeFilesystem('Required wiki directory was replaced during initialization.')
  }
}

async function assertNoSymlinkAncestors(path: string, signal?: AbortSignal): Promise<void> {
  const ancestors: string[] = []
  let current = path
  while (true) {
    ancestors.push(current)
    const parent = dirname(current)
    if (parent === current) break
    current = parent
  }

  ancestors.reverse()
  for (let index = 0; index < ancestors.length; index += 1) {
    const stat = await checkedLstat(ancestors[index]!, signal)
    if (stat === null) return
    if (stat.isSymbolicLink()) {
      throw unsafeFilesystem('Configured wiki root must not traverse a symbolic link.')
    }
    if (index < ancestors.length - 1 && !stat.isDirectory()) {
      throw unsafeFilesystem('Configured wiki root has an unsafe existing path component.')
    }
  }
}

async function createWikiRoot(requestedRoot: string, signal?: AbortSignal): Promise<void> {
  const missingSegments: string[] = []
  let current = requestedRoot

  while (true) {
    const stat = await checkedLstat(current, signal)
    if (stat !== null) {
      if (!stat.isDirectory() || stat.isSymbolicLink()) {
        throw unsafeFilesystem('Configured wiki root has an unsafe existing path component.')
      }
      break
    }

    const parent = dirname(current)
    if (parent === current) {
      throw unsafeFilesystem('Configured wiki root has no existing directory ancestor.')
    }
    missingSegments.push(basename(current))
    current = parent
  }

  for (const segment of missingSegments.reverse()) {
    current = join(current, segment)
    throwIfAborted(signal)
    try {
      await mkdir(current)
    } catch (cause) {
      throwIfAborted(signal)
      if ((cause as NodeJS.ErrnoException).code !== 'EEXIST') {
        throw unsafeFilesystem('Unable to create the configured wiki root.', { cause })
      }
    }
    throwIfAborted(signal)
    const created = await checkedLstat(current, signal)
    if (created === null || !created.isDirectory() || created.isSymbolicLink()) {
      throw unsafeFilesystem('Configured wiki root path was replaced during initialization.')
    }
  }
}

export function createWikiPaths(root: string): WikiPaths {
  if (!isAbsolute(root) || root.includes('\0')) {
    throw new LlmWikiError('INVALID_PATH', 'Wiki root must be an absolute filesystem path.')
  }

  const resolvedRoot = resolve(root)
  const derive = (target: string): string => {
    containedRelativePath(resolvedRoot, target)
    return target
  }
  const sources = derive(join(resolvedRoot, 'sources'))
  const pages = derive(join(resolvedRoot, 'pages'))
  const index = derive(join(resolvedRoot, '.index'))

  return Object.freeze({
    root: resolvedRoot,
    schema: derive(join(resolvedRoot, 'schema.md')),
    sources,
    pages,
    index,
    sourceDirectory: (id: SourceId) => derive(join(sources, id)),
    sourceContent: (id: SourceId) => derive(join(sources, id, 'content')),
    sourceMetadata: (id: SourceId) => derive(join(sources, id, 'metadata.json')),
    page: (id: PageId) => derive(join(pages, `${id}.md`)),
    indexFile: (name: 'search.json' | 'state.json') => derive(join(index, name)),
    assertSafe: async (path: string, operationSignal?: AbortSignal) => {
      await assertSafeWikiPath(resolvedRoot, path, operationSignal)
    },
  })
}

export async function acquireWikiPaths(
  configuredRoot: string,
  signal?: AbortSignal,
  cwd = process.cwd(),
): Promise<WikiPaths> {
  throwIfAborted(signal)
  if (configuredRoot.length === 0 || configuredRoot.includes('\0')) {
    throw new LlmWikiError('INVALID_PATH', 'Configured wiki root must be a non-empty filesystem path.')
  }

  const requestedRoot = resolve(cwd, configuredRoot)
  await assertNoSymlinkAncestors(requestedRoot, signal)
  return createWikiPaths(requestedRoot)
}

export async function initializeWikiPaths(
  configuredRoot: string,
  signal?: AbortSignal,
  cwd = process.cwd(),
): Promise<WikiPaths> {
  const requestedPaths = await acquireWikiPaths(configuredRoot, signal, cwd)
  const requestedRoot = requestedPaths.root
  await createWikiRoot(requestedRoot, signal)

  throwIfAborted(signal)
  let root: string
  try {
    root = await realpath(requestedRoot)
  } catch (cause) {
    throwIfAborted(signal)
    throw unsafeFilesystem('Unable to resolve the configured wiki root.', { cause })
  }
  throwIfAborted(signal)
  const rootStat = await checkedLstat(requestedRoot, signal)
  if (rootStat === null || !rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw unsafeFilesystem('Configured wiki root changed during initialization.')
  }
  const paths = createWikiPaths(root)
  await createSafeDirectory(root, paths.sources, signal)
  await createSafeDirectory(root, paths.pages, signal)
  await createSafeDirectory(root, paths.index, signal)
  return paths
}

export function assertContainedWikiPath(root: string, target: string): void {
  containedRelativePath(resolve(root), resolve(target))
}

