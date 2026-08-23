import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as LlmWiki from '../lib/index.js'

const TOOL_NAMES = [
  'llmwiki_add_source',
  'llmwiki_lint',
  'llmwiki_read_page',
  'llmwiki_read_source',
  'llmwiki_search',
  'llmwiki_status',
  'llmwiki_upsert_page',
]

function assert(condition: unknown, name: string): asserts condition {
  if (!condition) throw new Error(`assertion failed: ${name}`)
}

function commandAgent() {
  const session = { append: () => ({ seq: 0 }) }
  return new Proxy({ session }, { get: (target, property) => property === 'session' ? target.session : () => undefined })
}

let temporary: string | undefined
const ctx = new Context()
const fibers: { dispose(): Promise<void> }[] = []
try {
  const patchUrl = import.meta.resolve('@evegoodevening/dsh-llmwiki/cordis.patch.yml')
  assert(patchUrl.endsWith('/cordis.patch.yml'), 'package exports cordis.patch.yml')
  assert((await stat(new URL(patchUrl))).isFile(), 'exported cordis.patch.yml is a file')

  temporary = await mkdtemp(join(tmpdir(), 'dsh-llmwiki-smoke-'))
  const root = join(temporary, '.llmwiki')
  for (const plugin of [ToolRuntime, CommandRuntime, SystemPrompt]) {
    const fiber = ctx.plugin(plugin as never, plugin === ToolRuntime ? { mode: 'native' } : {})
    fibers.push(fiber)
    await fiber.await()
  }
  const wikiFiber = ctx.plugin(LlmWiki, { root, maxResults: 5, maxSnippetBytes: 256 })
  fibers.push(wikiFiber)
  await wikiFiber.await()

  assert(JSON.stringify(ctx.tools.schemas().map(schema => schema.name).sort()) === JSON.stringify(TOOL_NAMES), 'all llmwiki tools register')
  const signal = new AbortController().signal
  const execute = async (name: string, argumentsValue: unknown) => {
    const result = await ctx.tools.execute({ callId: `smoke-${name}`, name, arguments: argumentsValue, signal })
    if (result.isError) throw new Error(`${name}: ${result.error.message}`)
    return result.value
  }

  const initialStatus = await execute('llmwiki_status', {}) as { initialized: boolean; sourceCount: number; pageCount: number }
  assert(initialStatus.initialized && initialStatus.sourceCount === 0 && initialStatus.pageCount === 0, 'initial status is empty and initialized')

  const sourceContent = 'Smoke evidence is immutable and searchable.\n'
  const source = await execute('llmwiki_add_source', { name: 'Smoke evidence', content: sourceContent, origin: 'scripts/smoke.ts' }) as { id: string }
  const expectedSourceId = createHash('sha256').update(sourceContent).digest('hex')
  assert(source.id === expectedSourceId, 'source id equals exact content hash')
  const readSource = await execute('llmwiki_read_source', { id: source.id }) as { content: string; byteStart: number; byteEnd: number; metadata: { id: string } }
  assert(readSource.content === sourceContent, 'read_source returns exact source content')
  assert(readSource.byteStart === 0 && readSource.byteEnd === Buffer.byteLength(sourceContent) && readSource.metadata.id === source.id, 'read_source returns exact range and identity')

  const body = '# Smoke Getting Started\n\nSmoke evidence is immutable and searchable.'
  await execute('llmwiki_upsert_page', {
    id: 'smoke/getting-started',
    title: 'Smoke Getting Started',
    summary: 'End-to-end smoke evidence.',
    sources: [source.id],
    body,
  })
  const canonicalPage = `---\ntitle: "Smoke Getting Started"\nsummary: "End-to-end smoke evidence."\nsources:\n  - "${source.id}"\n---\n\n${body}\n`
  const page = await execute('llmwiki_read_page', { id: 'smoke/getting-started' }) as { markdown: string }
  assert(page.markdown === canonicalPage, 'read_page returns canonical page bytes')

  const search = await execute('llmwiki_search', { query: 'searchable', limit: 5 }) as { pageId: string }[]
  assert(search.length === 1 && search[0]?.pageId === 'smoke/getting-started', 'search returns the written page')
  const lint = await execute('llmwiki_lint', {}) as { errorCount: number; warningCount: number }
  assert(lint.errorCount === 0 && lint.warningCount === 0, 'tool lint is clean')
  const populatedStatus = await execute('llmwiki_status', {}) as { sourceCount: number; pageCount: number }
  assert(populatedStatus.sourceCount === 1 && populatedStatus.pageCount === 1, 'populated status counts durable records')

  const agent = commandAgent() as never
  const runCommand = async (line: string) => {
    const execution = await ctx.commands.execute(agent, line, [], signal)
    assert(execution?.result.kind === 'success', `${line} succeeds`)
    return execution.result.text
  }
  assert((await runCommand('/wiki status')).includes('Sources: 1'), '/wiki status reports the source')
  assert((await runCommand('/wiki lint')).includes('0 errors'), '/wiki lint reports no errors')
  assert((await runCommand('/wiki reindex')).includes('1 pages'), '/wiki reindex rebuilds the page index')
  const indexedStatus = await execute('llmwiki_status', {}) as { index: { present: boolean; fresh: boolean; sectionCount: number } }
  assert(indexedStatus.index.present && indexedStatus.index.fresh && indexedStatus.index.sectionCount === 1, 'reindex lifecycle publishes a fresh index')

  assert((await readFile(join(root, 'sources', source.id, 'content'))).equals(Buffer.from(sourceContent)), 'persisted source bytes are exact')
  assert(await readFile(join(root, 'pages', 'smoke', 'getting-started.md'), 'utf8') === canonicalPage, 'persisted page bytes are canonical')

  await wikiFiber.dispose()
  fibers.pop()
  assert(ctx.llmwiki === undefined, 'llmwiki service registration removed after disposal')
  assert(!ctx.tools.schemas().some(schema => schema.name.startsWith('llmwiki_')), 'llmwiki tool registrations removed after disposal')
  assert(!ctx.commands.list(agent).some(entry => entry.name === 'wiki'), 'llmwiki command registration removed after disposal')
  assert(!(await ctx.systemPrompt.assemble()).sections.some(section => section.name === 'tool:llmwiki'), 'llmwiki prompt registration removed after disposal')

  console.log('smoke ok: patch export, tools, bytes, status, search, lint, commands, reindex, and disposal verified')
} finally {
  await Promise.allSettled([...fibers].reverse().map(fiber => fiber.dispose()))
  if (temporary !== undefined) await rm(temporary, { recursive: true, force: true })
}
