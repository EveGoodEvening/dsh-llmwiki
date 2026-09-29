import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, stat, utimes } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type * as BuiltLlmWiki from '../src/index.ts'

const PUBLIC_RUNTIME_EXPORTS = [
  'Config',
  'LLMWIKI_ERROR_CODES',
  'LlmWikiError',
  'LlmWikiService',
  'apply',
  'inject',
  'isLlmWikiError',
  'isPageId',
  'isSourceId',
  'name',
  'pageId',
  'sourceId',
]

function assertLlmWikiPublic(value: unknown): asserts value is typeof BuiltLlmWiki {
  if (typeof value !== 'object' || value === null) {
    throw new TypeError('built dsh-llmwiki artifact is not a module namespace object')
  }
  const exportNames = Object.keys(value).sort()
  if (JSON.stringify(exportNames) !== JSON.stringify(PUBLIC_RUNTIME_EXPORTS)
    || typeof Reflect.get(value, 'Config') !== 'function'
    || !Array.isArray(Reflect.get(value, 'LLMWIKI_ERROR_CODES'))
    || typeof Reflect.get(value, 'LlmWikiError') !== 'function'
    || typeof Reflect.get(value, 'LlmWikiService') !== 'function'
    || typeof Reflect.get(value, 'apply') !== 'function'
    || JSON.stringify(Reflect.get(value, 'inject')) !== JSON.stringify(['tools', 'commands', 'systemPrompt'])
    || typeof Reflect.get(value, 'isLlmWikiError') !== 'function'
    || typeof Reflect.get(value, 'isPageId') !== 'function'
    || typeof Reflect.get(value, 'isSourceId') !== 'function'
    || Reflect.get(value, 'name') !== 'llmwiki'
    || typeof Reflect.get(value, 'pageId') !== 'function'
    || typeof Reflect.get(value, 'sourceId') !== 'function') {
    throw new TypeError('built dsh-llmwiki artifact does not expose the complete public runtime shape')
  }
}

function assertBuiltLlmWikiService(value: unknown): asserts value is BuiltLlmWiki.LlmWikiService {
  if (typeof value !== 'object' || value === null
    || typeof Reflect.get(value, 'status') !== 'function'
    || typeof Reflect.get(value, 'addSource') !== 'function'
    || typeof Reflect.get(value, 'listSources') !== 'function'
    || typeof Reflect.get(value, 'upsertPage') !== 'function'
    || typeof Reflect.get(value, 'listPages') !== 'function'
    || typeof Reflect.get(value, 'search') !== 'function'
    || typeof Reflect.get(value, 'lint') !== 'function') {
    throw new TypeError('built llmwiki service does not expose the required persistence and search methods')
  }
}

// This audit intentionally loads the built package artifact rather than source TypeScript.
const builtEntryUrl = new URL('../lib/index.js', import.meta.url)
const loadedLlmWiki: unknown = await import(builtEntryUrl.href)
assertLlmWikiPublic(loadedLlmWiki)
const LlmWiki = loadedLlmWiki
const encoder = new TextEncoder()

function canonical(value: unknown): Uint8Array {
  return encoder.encode(`${JSON.stringify(value)}\n`)
}

function firstDifference(left: Uint8Array, right: Uint8Array): number {
  const length = Math.min(left.byteLength, right.byteLength)
  for (let index = 0; index < length; index += 1) if (left[index] !== right[index]) return index
  return left.byteLength === right.byteLength ? -1 : length
}

function assertBytes(name: string, left: Uint8Array, right: Uint8Array): void {
  const offset = firstDifference(left, right)
  if (offset !== -1) throw new Error(`${name} differs at byte offset ${offset} (${left[offset] ?? 'EOF'} != ${right[offset] ?? 'EOF'})`)
}


async function populate(root: string, reverse: boolean) {
  const ctx = new Context()
  const fiber = ctx.plugin(LlmWiki.LlmWikiService, { root, maxResults: 10, maxSnippetBytes: 256 })
  try {
    await fiber.await()
    const inputs = [
      { name: 'Alpha evidence', content: 'Alpha is durable evidence.\n确定性索引可以重建。', origin: 'determinism-check' },
      { name: 'Beta evidence', content: 'Beta confirms repeatable retrieval.', origin: 'determinism-check' },
    ]
    const ordered = reverse ? [...inputs].reverse() : inputs
    assertBuiltLlmWikiService(ctx.llmwiki)
    const receipts: Record<string, BuiltLlmWiki.SourceReceipt> = {}
    for (const input of ordered) receipts[input.name] = await ctx.llmwiki.addSource(input)
    const alpha = receipts['Alpha evidence']
    const beta = receipts['Beta evidence']
    if (alpha === undefined || beta === undefined) throw new Error('source receipts are incomplete')
    const pages = [
      { id: LlmWiki.pageId('alpha'), title: 'Alpha', summary: 'Durable alpha facts.', sources: [alpha.id], body: '# Alpha\n\nAlpha is durable evidence.\n\n## Index\n\n确定性索引可以重建。' },
      { id: LlmWiki.pageId('nested/beta'), title: 'Beta', summary: 'Repeatable beta facts.', sources: [beta.id], body: '# Beta\n\nBeta confirms repeatable retrieval.' },
    ]
    for (const page of reverse ? [...pages].reverse() : pages) await ctx.llmwiki.upsertPage(page)
    const timestamp = reverse ? new Date('2031-04-05T06:07:08.000Z') : new Date('2001-02-03T04:05:06.000Z')
    for (const id of ['alpha', 'nested/beta']) await utimes(join(root, 'pages', `${id}.md`), timestamp, timestamp)
    const search = await ctx.llmwiki.search('durable 确定性', 10)
    const lint = await ctx.llmwiki.lint()
    const sourceCatalog = await ctx.llmwiki.listSources()
    const pageCatalog = await ctx.llmwiki.listPages()
    if (lint.errorCount !== 0) throw new Error(`lint returned ${lint.errorCount} errors`)
    return {
      searchIndex: await readFile(join(root, '.index', 'search.json')),
      state: await readFile(join(root, '.index', 'state.json')),
      search: canonical(search),
      lint: canonical(lint),
      sourceCatalog: canonical({ items: sourceCatalog.items.map(({ capturedAt: _capturedAt, ...item }) => item), nextCursor: sourceCatalog.nextCursor }),
      pageCatalog: canonical(pageCatalog),
    }
  } finally {
    await fiber.dispose()
  }
}

const patchUrl = import.meta.resolve('@evegoodevening/dsh-llmwiki/cordis.patch.yml')
if (!patchUrl.endsWith('/cordis.patch.yml')) throw new Error(`package patch export resolved unexpectedly: ${patchUrl}`)
const patch = await stat(new URL(patchUrl))
if (!patch.isFile()) throw new Error('package patch export is not a file')

const temporary = await mkdtemp(join(tmpdir(), 'dsh-llmwiki-determinism-'))
try {
  const firstRoot = join(temporary, 'first')
  const secondRoot = join(temporary, 'second')
  await mkdir(firstRoot)
  await mkdir(secondRoot)
  const first = await populate(firstRoot, false)
  const second = await populate(secondRoot, true)
  for (const name of ['searchIndex', 'state', 'search', 'lint', 'sourceCatalog', 'pageCatalog'] as const) assertBytes(name, first[name], second[name])
  const digest = createHash('sha256').update(first.searchIndex).digest('hex')
  const roots = await Promise.all([stat(firstRoot), stat(secondRoot)])
  if (!roots.every(value => value.isDirectory())) throw new Error('temporary roots are not directories')
  console.log(`determinism ok: search.json sha256=${digest}`)
} finally {
  await rm(temporary, { recursive: true, force: true })
}
