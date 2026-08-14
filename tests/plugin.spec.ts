import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Context, Fiber } from '@deepseek-ai/cordis'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { validateJsonSchemaValue } from '@deepseek-ai/dsh-tools'
import type { ToolExecutionInput } from '@deepseek-ai/dsh-tools'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Mock } from 'vitest'
import { registerLlmWikiCommand } from '../src/command.ts'
import { resolveConfig } from '../src/config.ts'
import { LlmWikiError } from '../src/errors.ts'
import { pageId } from '../src/ids.ts'
import { LLMWIKI_PROMPT_ORDER, LLMWIKI_PROMPT_SECTION, LLMWIKI_SYSTEM_PROMPT, registerLlmWikiPrompt } from '../src/prompt.ts'
import { presentLlmWikiCall, presentLlmWikiResult } from '../src/presentation.ts'
import { registerLlmWikiTools } from '../src/tools.ts'
import { createRuntimeHarness, createServiceHarness, mountRuntimeServices, mountSourcePlugin } from './harness.ts'

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
  let toolsFiber: Fiber | undefined
  let promptFiber: Fiber | undefined
  let adapterFiber: Fiber | undefined
  active.push(async () => {
    await adapterFiber?.dispose()
    await promptFiber?.dispose()
    await toolsFiber?.dispose()
    await serviceHarness.dispose()
  })
  toolsFiber = serviceHarness.ctx.plugin(ToolRuntime, { mode: 'native' })
  promptFiber = serviceHarness.ctx.plugin(SystemPrompt, {})
  await Promise.all([toolsFiber.await(), promptFiber.await()])
  adapterFiber = serviceHarness.ctx.inject(['tools', 'systemPrompt', 'llmwiki'], (ctx: Context) => {
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

type CommandAgent = Parameters<CommandRuntime['execute']>[0]

interface CommandHarnessTarget {
  readonly ctx: Context
  readonly agent: CommandAgent
}

interface CommandLifecycleEvent {
  readonly type: string
  readonly data: Readonly<Record<string, unknown>>
}
interface CommandAgentInstrumentation {
  readonly agent: CommandAgent
  readonly lifecycle: CommandLifecycleEvent[]
  readonly modelServiceCall: Mock<(property: PropertyKey, args: readonly unknown[]) => unknown>
}

function isUnknownRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null
}

function commandAgent(): CommandAgentInstrumentation {
  const lifecycle: CommandLifecycleEvent[] = []
  const modelServiceCall = vi.fn<(property: PropertyKey, args: readonly unknown[]) => unknown>()
  const session = {
    append: (type: string, data: unknown) => {
      if (!isUnknownRecord(data)) throw new TypeError(`Expected object data for ${type}`)
      lifecycle.push({ type, data })
      return { seq: lifecycle.length - 1 }
    },
  }
  const agent = new Proxy({ session }, {
    get(target, property): unknown {
      if (property === 'session') return target.session
      return (...args: unknown[]): unknown => modelServiceCall(property, args)
    },
  }) as unknown as CommandAgent
  return { agent, lifecycle, modelServiceCall }
}

async function createCommandHarness(config: Parameters<typeof createServiceHarness>[0] = {}) {
  const serviceHarness = await createServiceHarness(config)
  let commandsFiber: Fiber | undefined
  let adapterFiber: Fiber | undefined
  active.push(async () => {
    await adapterFiber?.dispose()
    await commandsFiber?.dispose()
    await serviceHarness.dispose()
  })
  commandsFiber = serviceHarness.ctx.plugin(CommandRuntime)
  await commandsFiber.await()
  const commandTarget = commandAgent()
  adapterFiber = serviceHarness.ctx.inject(['commands', 'llmwiki'], (ctx: Context) => {
    registerLlmWikiCommand(ctx, resolveConfig({ ...config, root: serviceHarness.root }))
  })
  await adapterFiber.await()
  return { ...serviceHarness, commandsFiber, adapterFiber, ...commandTarget }
}

async function runCommand(
  harness: CommandHarnessTarget,
  line: string,
  signal = new AbortController().signal,
) {
  const execution = await harness.ctx.commands.execute(harness.agent, line, signal)
  expect(execution).toBeDefined()
  return execution!.result
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

  it('classifies read-only tools for parallel execution through the real registry', async () => {
    const harness = await createPluginHarness()
    for (const name of ['llmwiki_status', 'llmwiki_read_source', 'llmwiki_read_page', 'llmwiki_lint']) {
      expect(harness.ctx.tools.executionMode(execution(name, name === 'llmwiki_status' || name === 'llmwiki_lint' ? {} : { id: 'a'.repeat(64) }))).toEqual({ kind: 'parallel' })
    }
    expect(harness.ctx.tools.executionMode(execution('llmwiki_add_source', { name: 'Evidence', content: 'data' }))).toEqual({ kind: 'exclusive' })
  })

  it('preserves unexpected service failures through registry execution', async () => {
    const harness = await createPluginHarness()
    vi.spyOn(harness.service, 'status').mockRejectedValue(new Error('backend exploded'))

    const result = await harness.ctx.tools.execute(execution('llmwiki_status', {}))
    expect(result).toMatchObject({ isError: true })
    if (result.isError) expect(result.error.message).toContain('backend exploded')
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

  it('declares every supported parameter and rejects invalid values in every parameter category', async () => {
    const harness = await createPluginHarness()
    const schemas = Object.fromEntries(harness.ctx.tools.schemas().map(schema => [schema.name, schema.parameters]))
    expect(Object.fromEntries(Object.entries(schemas).map(([name, schema]) => [name, Object.keys(schema.properties ?? {}).sort()]))).toEqual({
      llmwiki_add_source: ['content', 'mediaType', 'name', 'origin'],
      llmwiki_lint: [],
      llmwiki_read_page: ['id'],
      llmwiki_read_source: ['id', 'limit', 'offset'],
      llmwiki_search: ['limit', 'query'],
      llmwiki_status: [],
      llmwiki_upsert_page: ['body', 'id', 'sources', 'summary', 'title'],
    })
    const invalidCases: readonly [string, unknown][] = [
      ['llmwiki_add_source', { name: 1, content: 'evidence' }],
      ['llmwiki_add_source', { name: 'Evidence', content: false }],
      ['llmwiki_add_source', { name: 'Evidence', content: 'evidence', mediaType: 1 }],
      ['llmwiki_add_source', { name: 'Evidence', content: 'evidence', origin: [] }],
      ['llmwiki_read_source', { id: 'not-a-hash' }],
      ['llmwiki_read_source', { id: '0'.repeat(64), offset: -1 }],
      ['llmwiki_read_source', { id: '0'.repeat(64), limit: 0 }],
      ['llmwiki_search', { query: 1 }],
      ['llmwiki_search', { query: 'alpha', limit: 0 }],
      ['llmwiki_read_page', { id: '../escape' }],
      ['llmwiki_upsert_page', { id: '../escape', title: 'Alpha', summary: 'Summary', sources: [], body: '# Alpha' }],
      ['llmwiki_upsert_page', { id: 'alpha', title: 1, summary: 'Summary', sources: [], body: '# Alpha' }],
      ['llmwiki_upsert_page', { id: 'alpha', title: 'Alpha', summary: false, sources: [], body: '# Alpha' }],
      ['llmwiki_upsert_page', { id: 'alpha', title: 'Alpha', summary: 'Summary', sources: 'invalid', body: '# Alpha' }],
      ['llmwiki_upsert_page', { id: 'alpha', title: 'Alpha', summary: 'Summary', sources: [], body: 1 }],
    ]
    for (const [name, args] of invalidCases) {
      await expect(harness.ctx.tools.execute(execution(name, args))).resolves.toMatchObject({ isError: true })
    }
  })

  it('maps every service result and optional field through registry validation', async () => {
    const harness = await createPluginHarness()
    const signal = new AbortController().signal
    const sourceHash = 'a'.repeat(64)
    const status = vi.spyOn(harness.service, 'status').mockResolvedValue({
      initialized: true,
      sourceCount: 2,
      pageCount: 1,
      schemaText: null,
      index: { present: true, fresh: false, formatVersion: null, sectionCount: 3 },
    })
    const addSource = vi.spyOn(harness.service, 'addSource').mockResolvedValue({
      id: sourceHash,
      deduplicated: false,
      metadata: { id: sourceHash, name: 'Mapped', mediaType: 'text/plain', byteCount: 4, capturedAt: '2026-08-14T00:00:00.000Z' },
    } as never)
    const readSource = vi.spyOn(harness.service, 'readSource').mockResolvedValue({
      id: sourceHash,
      content: 'data',
      metadata: { id: sourceHash, name: 'Mapped', mediaType: 'text/plain', byteCount: 4, capturedAt: '2026-08-14T00:00:00.000Z', origin: 'registry' },
      byteStart: 1,
      byteEnd: 4,
      byteCount: 3,
    } as never)
    const search = vi.spyOn(harness.service, 'search').mockResolvedValue([{
      pageId: 'mapped', title: 'Mapped', headingTrail: ['Mapped', 'Detail'], startLine: 7, score: 0.75, snippet: 'dat', sourceIds: [sourceHash],
    }] as never)
    const readPage = vi.spyOn(harness.service, 'readPage').mockResolvedValue({
      id: 'mapped', markdown: '# Mapped', metadata: { title: 'Mapped', summary: 'Summary', sources: [sourceHash] },
    } as never)
    const upsertPage = vi.spyOn(harness.service, 'upsertPage').mockResolvedValue({ id: 'mapped', created: false, sha256: 'b'.repeat(64) } as never)
    const lint = vi.spyOn(harness.service, 'lint').mockResolvedValue({
      diagnostics: [
        { code: 'NO_LINE', severity: 'warning', path: 'wiki.md', message: 'Whole-file warning' },
        { code: 'AT_LINE', severity: 'error', path: 'wiki.md', line: 4, message: 'Line error' },
      ],
      errorCount: 1,
      warningCount: 1,
      filesExamined: 1,
    })

    await expect(invoke(harness.ctx, 'llmwiki_status', {}, signal)).resolves.toEqual({
      initialized: true, sourceCount: 2, pageCount: 1, schemaText: null, index: { present: true, fresh: false, formatVersion: null, sectionCount: 3 },
    })
    await expect(invoke(harness.ctx, 'llmwiki_add_source', { name: 'Mapped', content: 'data' }, signal)).resolves.toEqual({
      id: sourceHash,
      deduplicated: false,
      metadata: { id: sourceHash, name: 'Mapped', mediaType: 'text/plain', byteCount: 4, capturedAt: '2026-08-14T00:00:00.000Z' },
    })
    await expect(invoke(harness.ctx, 'llmwiki_read_source', { id: sourceHash, limit: 3 }, signal)).resolves.toMatchObject({
      content: 'data', metadata: { origin: 'registry' }, byteStart: 1, byteEnd: 4, byteCount: 3,
    })
    await expect(invoke(harness.ctx, 'llmwiki_search', { query: 'data' }, signal)).resolves.toEqual([{
      pageId: 'mapped', title: 'Mapped', headingTrail: ['Mapped', 'Detail'], startLine: 7, score: 0.75, snippet: 'dat', sourceIds: [sourceHash],
    }])
    await expect(invoke(harness.ctx, 'llmwiki_read_page', { id: 'mapped' }, signal)).resolves.toEqual({
      id: 'mapped', markdown: '# Mapped', metadata: { title: 'Mapped', summary: 'Summary', sources: [sourceHash] },
    })
    await expect(invoke(harness.ctx, 'llmwiki_upsert_page', { id: 'mapped', title: 'Mapped', summary: 'Summary', sources: [sourceHash], body: 'Body' }, signal)).resolves.toEqual({
      id: 'mapped', created: false, sha256: 'b'.repeat(64),
    })
    await expect(invoke(harness.ctx, 'llmwiki_lint', {}, signal)).resolves.toEqual({
      diagnostics: [
        { code: 'NO_LINE', severity: 'warning', path: 'wiki.md', line: null, message: 'Whole-file warning' },
        { code: 'AT_LINE', severity: 'error', path: 'wiki.md', line: 4, message: 'Line error' },
      ],
      errorCount: 1,
      warningCount: 1,
      filesExamined: 1,
    })

    expect(status).toHaveBeenCalledWith(signal)
    expect(addSource).toHaveBeenCalledWith({ name: 'Mapped', content: 'data' }, signal)
    expect(readSource).toHaveBeenCalledWith(sourceHash, { limit: 3 }, signal)
    expect(search).toHaveBeenCalledWith('data', undefined, signal)
    expect(readPage).toHaveBeenCalledWith('mapped', signal)
    expect(upsertPage).toHaveBeenCalledWith({ id: 'mapped', title: 'Mapped', summary: 'Summary', sources: [sourceHash], body: 'Body' }, signal)
    expect(lint).toHaveBeenCalledWith(signal)
  })

  it('rejects a service value that violates a tool output schema', async () => {
    const harness = await createPluginHarness()
    vi.spyOn(harness.service, 'status').mockResolvedValue({
      initialized: true,
      sourceCount: 'not-an-integer',
      pageCount: 0,
      schemaText: null,
      index: { present: false, fresh: false, formatVersion: null, sectionCount: 0 },
    } as never)
    const result = await harness.ctx.tools.execute(execution('llmwiki_status', {}))
    expect(result).toMatchObject({ isError: true })
    if (result.isError) expect(result.error.message).toContain('sourceCount')
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

describe('complete plugin HMR lifecycle', () => {
  it('mounts all services, removes every registration, and remounts without duplicates', async () => {
    const harness = await createRuntimeHarness()
    active.push(() => harness.dispose())
    await mountRuntimeServices(harness)
    const pluginFiber = await mountSourcePlugin(harness)
    const target = commandAgent()

    expect(harness.ctx.llmwiki).toBeDefined()
    expect(harness.ctx.tools.schemas().map(schema => schema.name).sort()).toEqual(TOOL_NAMES)
    expect((await harness.ctx.systemPrompt.assemble()).sections.filter(section => section.name === LLMWIKI_PROMPT_SECTION)).toHaveLength(1)
    expect(harness.ctx.commands.list(target.agent).filter(command => command.name === 'wiki')).toHaveLength(1)

    await pluginFiber.dispose()
    expect(harness.ctx.llmwiki).toBeUndefined()
    expect(harness.ctx.tools.schemas()).toEqual([])
    expect((await harness.ctx.systemPrompt.assemble()).sections.some(section => section.name === LLMWIKI_PROMPT_SECTION)).toBe(false)
    expect(harness.ctx.commands.list(target.agent).filter(command => command.name === 'wiki')).toHaveLength(0)

    await mountSourcePlugin(harness)
    expect(harness.ctx.llmwiki).toBeDefined()
    expect(harness.ctx.tools.schemas().map(schema => schema.name).sort()).toEqual(TOOL_NAMES)
    expect((await harness.ctx.systemPrompt.assemble()).sections.filter(section => section.name === LLMWIKI_PROMPT_SECTION)).toHaveLength(1)
    expect(harness.ctx.commands.list(target.agent).filter(command => command.name === 'wiki')).toHaveLength(1)
  })
})

describe('llmwiki command', () => {
  it('registers the stable descriptor and reports exact status aliases and reindex state', async () => {
    const harness = await createCommandHarness()
    expect(harness.ctx.commands.list(harness.agent)).toEqual([{
      name: 'wiki',
      description: 'Inspect, lint, or reindex the local wiki',
      input: { hint: '[status|lint|reindex]' },
    }])

    const source = await harness.service.addSource({ name: 'Alpha evidence', content: 'Evidence for alpha.' })
    await harness.service.upsertPage({
      id: pageId('alpha'),
      title: 'Alpha',
      summary: 'Evidence-backed alpha.',
      sources: [source.id],
      body: '# Alpha\n\nDurable evidence.',
    })
    const statusText = 'Wiki status\nInitialized: yes\nSources: 1\nPages: 1\nIndex: missing'
    await expect(runCommand(harness, '/wiki')).resolves.toEqual({ kind: 'success', text: statusText })
    await expect(runCommand(harness, '/wiki   ')).resolves.toEqual({ kind: 'success', text: statusText })
    await expect(runCommand(harness, '/wiki status')).resolves.toEqual({ kind: 'success', text: statusText })
    await expect(runCommand(harness, '/wiki\tstatus  ')).resolves.toEqual({ kind: 'success', text: statusText })

    await expect(runCommand(harness, '/wiki reindex')).resolves.toEqual({
      kind: 'success',
      text: 'Wiki reindexed: 1 pages, 1 sections, index version 1.',
    })
    await expect(runCommand(harness, '/wiki status')).resolves.toEqual({
      kind: 'success',
      text: 'Wiki status\nInitialized: yes\nSources: 1\nPages: 1\nIndex: fresh (version 1, 1 sections)',
    })
    expect(harness.modelServiceCall).not.toHaveBeenCalled()
  })

  it('formats clean lint and deterministically truncates sorted diagnostics at the configured limit', async () => {
    const harness = await createCommandHarness({ commandDiagnosticLimit: 2 })
    await harness.service.reindex()
    await expect(runCommand(harness, '/wiki lint')).resolves.toEqual({
      kind: 'success',
      text: 'Wiki lint: 0 errors, 0 warnings across 3 files.',
    })

    await Promise.all([
      writeFile(join(harness.root, '.z.tmp-3-cafe'), ''),
      writeFile(join(harness.root, '.a.tmp-1-dead'), ''),
      mkdir(join(harness.root, 'pages', 'nested')).then(() => writeFile(join(harness.root, 'pages', 'nested', '.b.tmp-2-beef'), '')),
    ])
    await expect(runCommand(harness, '/wiki lint')).resolves.toEqual({
      kind: 'success',
      text: [
        'Wiki lint: 1 errors, 3 warnings across 3 files.',
        '- WARNING TEMP_FILE_ABANDONED .a.tmp-1-dead: Abandoned atomic-write temporary file.',
        '- WARNING TEMP_FILE_ABANDONED .z.tmp-3-cafe: Abandoned atomic-write temporary file.',
        '... 2 more diagnostics omitted.',
      ].join('\n'),
    })
    expect(harness.modelServiceCall).not.toHaveBeenCalled()
  })

  it.each([
    '/wiki unknown',
    '/wiki status extra',
    '/wiki STATUS',
    '/wiki Lint',
    '/wiki ReIndex',
  ])('returns only stable usage text for invalid input %s', async line => {
    const harness = await createCommandHarness()
    const result = await runCommand(harness, line)
    expect(result).toEqual({ kind: 'error', text: 'Usage: /wiki [status|lint|reindex]' })
    expect(JSON.stringify(result)).not.toContain(harness.root)
    expect(JSON.stringify(result)).not.toMatch(/stack|cause/u)
  })

  it('forwards the invocation signal, maps safe domain errors, and honors abort', async () => {
    const harness = await createCommandHarness()
    const controller = new AbortController()
    const status = vi.spyOn(harness.service, 'status').mockImplementation(signal => {
      expect(signal).toBe(controller.signal)
      return Promise.reject(new LlmWikiError('UNSAFE_FILESYSTEM', 'The wiki filesystem operation failed.', { cause: new Error(harness.root) }))
    })
    const mapped = await runCommand(harness, '/wiki status', controller.signal)
    expect(mapped).toEqual({
      kind: 'error',
      text: 'UNSAFE_FILESYSTEM: The wiki filesystem operation failed.',
    })
    expect(JSON.stringify(mapped)).not.toMatch(/stack|cause/u)
    expect(JSON.stringify(mapped)).not.toContain(harness.root)
    expect(status).toHaveBeenCalledTimes(1)

    status.mockRestore()
    let forwardedSignal: AbortSignal | undefined
    const pending = Promise.withResolvers<never>()
    const pendingStatus = vi.spyOn(harness.service, 'status').mockImplementation(signal => {
      forwardedSignal = signal
      return pending.promise
    })
    const aborted = new AbortController()
    const cancellation = harness.ctx.commands.execute(harness.agent, '/wiki status', aborted.signal)
    expect(pendingStatus).toHaveBeenCalledTimes(1)
    expect(forwardedSignal).toBe(aborted.signal)
    const reason = new Error('command cancelled')
    aborted.abort(reason)
    await expect(cancellation).rejects.toBe(reason)
    const [runEvent, doneEvent]: (CommandLifecycleEvent | undefined)[] = harness.lifecycle.slice(-2)
    if (runEvent === undefined || doneEvent === undefined) {
      throw new TypeError('Expected command cancellation lifecycle events')
    }
    expect(runEvent.type).toBe('command/run')
    expect(runEvent.data.name).toBe('wiki')
    expect(doneEvent.type).toBe('command/done')
    expect(doneEvent.data.kind).toBe('error')
    expect(doneEvent.data.text).toBe(reason.message)
    expect(doneEvent.data.commandId).toBe(runEvent.data.commandId)
    expect(harness.modelServiceCall).not.toHaveBeenCalled()
  })

  it('rethrows unexpected failures instead of exposing them as command output', async () => {
    const harness = await createCommandHarness()
    const failure = new Error(`unexpected ${harness.root}`)
    vi.spyOn(harness.service, 'status').mockRejectedValue(failure)
    await expect(runCommand(harness, '/wiki status')).rejects.toBe(failure)
  })

  it('removes the lifecycle-owned command and remounts it exactly once', async () => {
    const harness = await createCommandHarness()
    await harness.adapterFiber.dispose()
    expect(harness.ctx.commands.list(harness.agent)).toEqual([])
    expect(await harness.ctx.commands.execute(harness.agent, '/wiki status', new AbortController().signal)).toBeUndefined()

    const remount = harness.ctx.inject(['commands', 'llmwiki'], (ctx: Context) => {
      registerLlmWikiCommand(ctx, resolveConfig({ root: harness.root }))
    })
    await remount.await()
    active.push(async () => remount.dispose())
    expect(harness.ctx.commands.list(harness.agent)).toEqual([{
      name: 'wiki',
      description: 'Inspect, lint, or reindex the local wiki',
      input: { hint: '[status|lint|reindex]' },
    }])
    await expect(runCommand(harness, '/wiki status')).resolves.toMatchObject({ kind: 'success' })
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

  it('presents every registered call and result variant, including optional and long inputs', async () => {
    const harness = await createPluginHarness()
    const longQuery = 'q'.repeat(2_048)
    const cases = [
      ['llmwiki_status', {}, { card: 'generic', title: 'Inspect wiki status', kind: 'read' }],
      ['llmwiki_add_source', { name: 'Evidence', content: 'durable evidence' }, { card: 'generic', title: 'Preserve wiki source', kind: 'edit', rawInput: 'Evidence' }],
      ['llmwiki_read_source', { id: 'a'.repeat(64) }, { card: 'generic', title: 'Read wiki source', kind: 'read', rawInput: 'a'.repeat(64) }],
      ['llmwiki_search', { query: longQuery }, { card: 'generic', title: 'Search wiki', kind: 'search', rawInput: longQuery }],
      ['llmwiki_read_page', { id: 'page-id' }, { card: 'generic', title: 'Read wiki page', kind: 'read', rawInput: 'page-id' }],
      ['llmwiki_upsert_page', { id: 'page-id', title: 'Page', summary: 'Summary', sources: ['a'.repeat(64)], body: 'Body' }, { card: 'generic', title: 'Update wiki page', kind: 'edit', rawInput: 'page-id' }],
      ['llmwiki_lint', {}, { card: 'generic', title: 'Lint wiki', kind: 'read' }],
    ] as const
    const success = { content: [{ type: 'text' as const, text: 'ok' }], isError: false, meta: { retained: 1, total: 2, truncated: true } }
    const failure = { content: [{ type: 'text' as const, text: 'failed' }], isError: true }

    for (const [name, args, expectedCall] of cases) {
      const definition = harness.ctx.tools.get(name)
      expect(definition?.presentCall?.(args)).toEqual(expectedCall)
      expect(definition?.presentResult?.(args, success)).toEqual({ card: 'generic', title: expectedCall.title })
      expect(definition?.presentResult?.(args, failure)).toEqual({ card: 'generic', title: `${expectedCall.title} failed` })
    }

    expect(presentLlmWikiCall('llmwiki_search', { query: 42 })).toEqual({ card: 'generic', title: 'Search wiki', kind: 'search' })
    expect(presentLlmWikiCall('llmwiki_add_source', {})).toEqual({ card: 'generic', title: 'Preserve wiki source', kind: 'edit' })
    expect(presentLlmWikiCall('llmwiki_search', { query: longQuery })).toEqual(cases[3][2])
    expect(presentLlmWikiResult('llmwiki_search', {}, success)).toEqual({ card: 'generic', title: 'Search wiki' })
  })
})

