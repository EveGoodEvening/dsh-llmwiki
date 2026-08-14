import type { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { validateJsonSchemaValue } from '@deepseek-ai/dsh-tools'
import type { ToolExecutionInput } from '@deepseek-ai/dsh-tools'
import { afterEach, describe, expect, it } from 'vitest'
import { LLMWIKI_PROMPT_ORDER, LLMWIKI_PROMPT_SECTION, LLMWIKI_SYSTEM_PROMPT, registerLlmWikiPrompt } from '../src/prompt.ts'
import { presentLlmWikiCall, presentLlmWikiResult } from '../src/presentation.ts'
import { registerLlmWikiTools } from '../src/tools.ts'
import { createServiceHarness } from './harness.ts'

const TOOL_NAMES = [
  'llmwiki_add_source',
  'llmwiki_lint',
  'llmwiki_read_page',
  'llmwiki_read_source',
  'llmwiki_search',
  'llmwiki_status',
  'llmwiki_upsert_page',
] as const

const active: (() => Promise<void>)[] = []
afterEach(async () => {
  await Promise.all(active.splice(0).map(dispose => dispose()))
})

async function createPluginHarness(config: Parameters<typeof createServiceHarness>[0] = {}) {
  const serviceHarness = await createServiceHarness(config)
  active.push(() => serviceHarness.dispose())
  const toolsFiber = serviceHarness.ctx.plugin(ToolRuntime, { mode: 'native' })
  const promptFiber = serviceHarness.ctx.plugin(SystemPrompt, {})
  await Promise.all([toolsFiber.await(), promptFiber.await()])
  const adapterFiber = serviceHarness.ctx.inject(['tools', 'systemPrompt', 'llmwiki'], (ctx: Context) => {
    registerLlmWikiPrompt(ctx)
    registerLlmWikiTools(ctx)
  })
  await adapterFiber.await()
  return { ...serviceHarness, adapterFiber }
}

function execution(name: string, args: unknown, signal = new AbortController().signal): ToolExecutionInput {
  return { callId: `plugin-test-${name}` as ToolExecutionInput['callId'], name, arguments: args, signal }
}

async function invoke(ctx: Context, name: string, args: unknown, signal?: AbortSignal) {
  const result = await ctx.tools.execute(execution(name, args, signal))
  if (result.isError) throw new Error(result.error.message)
  return result.value
}

describe('llmwiki tools', () => {
  it('registers exactly seven tools and exercises the complete workflow through the real registry', async () => {
    const harness = await createPluginHarness({ maxResults: 1, maxSnippetBytes: 64, maxSourceBytes: 1024, maxPageBytes: 2048 })
    expect(harness.ctx.tools.schemas().map(schema => schema.name).sort()).toEqual(TOOL_NAMES)

    const initial = await invoke(harness.ctx, 'llmwiki_status', { ignored: 'cannot affect behavior' })
    expect(initial).toMatchObject({ initialized: true, sourceCount: 0, pageCount: 0 })
    expect(await invoke(harness.ctx, 'llmwiki_status', {})).toEqual(initial)

    const source = await invoke(harness.ctx, 'llmwiki_add_source', { name: 'Evidence', content: 'Durable evidence about alpha.', origin: 'conversation', unknown: '/etc/passwd' }) as { id: string }
    expect(source.id).toMatch(/^[0-9a-f]{64}$/u)
    const readSource = await invoke(harness.ctx, 'llmwiki_read_source', { id: source.id, offset: 0, limit: 8, unknown: 999 }) as { content: string; metadata: { id: string } }
    expect(readSource).toMatchObject({ content: 'Durable ', metadata: { id: source.id } })
    await expect(invoke(harness.ctx, 'llmwiki_read_source', { id: source.id, offset: 8 })).resolves.toMatchObject({ content: 'evidence about alpha.', byteStart: 8 })
    await expect(invoke(harness.ctx, 'llmwiki_read_source', { id: source.id, limit: 8 })).resolves.toMatchObject({ content: 'Durable ', byteStart: 0, byteEnd: 8 })
    await expect(invoke(harness.ctx, 'llmwiki_read_source', { id: source.id })).resolves.toMatchObject({ content: 'Durable evidence about alpha.', byteStart: 0, byteEnd: 29 })

    const upsert = await invoke(harness.ctx, 'llmwiki_upsert_page', { id: 'alpha', title: 'Alpha', summary: 'Evidence-backed alpha.', sources: [source.id], body: '# Alpha\n\nDurable evidence.', path: '/tmp/escape' })
    expect(upsert).toMatchObject({ id: 'alpha', created: true })
    const page = await invoke(harness.ctx, 'llmwiki_read_page', { id: 'alpha' }) as { markdown: string; metadata: { sources: string[] } }
    expect(page.markdown).toContain('Durable evidence.')
    expect(page.metadata.sources).toEqual([source.id])

    const search = await invoke(harness.ctx, 'llmwiki_search', { query: 'durable', limit: 1, unknown: 100 }) as unknown[]
    expect(search).toHaveLength(1)
    const lint = await invoke(harness.ctx, 'llmwiki_lint', {})
    expect(lint).toMatchObject({ errorCount: 0 })

    for (const schema of harness.ctx.tools.schemas()) {
      const definition = harness.ctx.tools.get(schema.name)
      expect(definition).toBeDefined()
      const value = schema.name === 'llmwiki_status' ? initial
        : schema.name === 'llmwiki_add_source' ? source
        : schema.name === 'llmwiki_read_source' ? readSource
        : schema.name === 'llmwiki_search' ? search
        : schema.name === 'llmwiki_read_page' ? page
        : schema.name === 'llmwiki_upsert_page' ? upsert
        : lint
      expect(() => validateJsonSchemaValue(definition!.output.schema, value)).not.toThrow()
      expect(JSON.parse(JSON.stringify(value))).toEqual(value)
    }
  })

  it('rejects invalid declared fields, maps domain failures, and honors abort', async () => {
    const harness = await createPluginHarness()
    const invalid = await harness.ctx.tools.execute(execution('llmwiki_search', { query: '', limit: 0 }))
    expect(invalid.isError).toBe(true)
    const missing = await harness.ctx.tools.execute(execution('llmwiki_read_page', { id: 'missing' }))
    expect(missing.isError).toBe(true)
    if (missing.isError) {
      expect(missing.error.message).toContain('Page was not found.')
      expect(missing.error.message).not.toContain(harness.root)
      expect(missing.error.message).not.toContain('stack')
    }
    const controller = new AbortController()
    controller.abort()
    const aborted = await harness.ctx.tools.execute(execution('llmwiki_status', {}, controller.signal))
    expect(aborted.isError).toBe(true)
  })

  it('removes and remounts all lifecycle-owned registrations', async () => {
    const harness = await createPluginHarness()
    await harness.adapterFiber.dispose()
    expect(harness.ctx.tools.schemas()).toEqual([])
    expect((await harness.ctx.systemPrompt.assemble()).sections.some(section => section.name === 'tool:llmwiki')).toBe(false)
    const remount = harness.ctx.inject(['tools', 'systemPrompt', 'llmwiki'], (ctx: Context) => {
      registerLlmWikiPrompt(ctx)
      registerLlmWikiTools(ctx)
    })
    await remount.await()
    expect(harness.ctx.tools.schemas().map(schema => schema.name).sort()).toEqual(TOOL_NAMES)
    expect((await harness.ctx.systemPrompt.assemble()).sections.filter(section => section.name === 'tool:llmwiki')).toHaveLength(1)
  })
})

describe('llmwiki prompt and presentation', () => {
  it('registers the exact stable order-116 workflow prompt', async () => {
    const harness = await createPluginHarness()
    const section = (await harness.ctx.systemPrompt.assemble()).sections.find(candidate => candidate.name === 'tool:llmwiki')
    expect(section).toEqual({ name: LLMWIKI_PROMPT_SECTION, text: LLMWIKI_SYSTEM_PROMPT })
    expect(LLMWIKI_PROMPT_ORDER).toBe(116)
    expect(LLMWIKI_SYSTEM_PROMPT).toMatchInlineSnapshot(`
      "Use the llmwiki as durable, evidence-backed memory:
      - Call llmwiki_status before relying on the wiki.
      - Search first, then read only the relevant pages and immutable source records.
      - Treat wiki pages as synthesized notes; source records are the preserved evidence.
      - Cite real source IDs in every page write. Never invent a source ID.
      - Use llmwiki_upsert_page only when new evidence changes durable knowledge.
      - llmwiki_lint is read-only. Do not claim that it repaired anything."
    `)
  })

  it('presents calls and results deterministically without service state', () => {
    const args = { query: 'alpha' }
    const call = presentLlmWikiCall('llmwiki_search', args)
    const result = presentLlmWikiResult('llmwiki_search', args, { content: [{ type: 'text', text: '[]' }], isError: false })
    expect(call).toEqual({ card: 'generic', title: 'Search wiki', kind: 'search', rawInput: 'alpha' })
    expect(result).toEqual({ card: 'generic', title: 'Search wiki' })
    expect(presentLlmWikiCall('llmwiki_search', args)).toEqual(call)
  })
})

