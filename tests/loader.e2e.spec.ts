import { createHash } from 'node:crypto'
import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type CommandRuntime from '@deepseek-ai/dsh-commands'
import type { ToolExecutionInput } from '@deepseek-ai/dsh-tools'
import { afterEach, describe, expect, it } from 'vitest'
import { createCordisHarness } from './harness.ts'
import type { CordisHarness } from './harness.ts'

const TOOL_NAMES = [
  'llmwiki_add_source',
  'llmwiki_lint',
  'llmwiki_read_page',
  'llmwiki_read_source',
  'llmwiki_search',
  'llmwiki_status',
  'llmwiki_upsert_page',
]
const active: CordisHarness[] = []
afterEach(async () => Promise.all(active.splice(0).map(harness => harness.dispose())))

function execution(name: string, args: unknown): ToolExecutionInput {
  return { callId: `loader-${name}` as ToolExecutionInput['callId'], name, arguments: args, signal: new AbortController().signal }
}

async function invoke(ctx: Context, name: string, args: unknown) {
  const result = await ctx.tools.execute(execution(name, args))
  if (result.isError) throw new Error(result.error.message)
  return result.value
}

function commandAgent(): Parameters<CommandRuntime['execute']>[0] {
  return { session: { append: () => ({ seq: 0 }) } } as unknown as Parameters<CommandRuntime['execute']>[0]
}

async function hashTree(root: string): Promise<string> {
  const hash = createHash('sha256')
  async function visit(directory: string, relative = ''): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true })
    entries.sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0)
    for (const entry of entries) {
      const logical = relative ? `${relative}/${entry.name}` : entry.name
      if (logical === '.index' || logical.startsWith('.index/')) continue
      const path = join(directory, entry.name)
      hash.update(logical).update(entry.isDirectory() ? 'directory' : await readFile(path))
      if (entry.isDirectory()) await visit(path, logical)
    }
  }
  await visit(root)
  return hash.digest('hex')
}

async function createHarness(): Promise<CordisHarness> {
  const harness = await createCordisHarness()
  active.push(harness)
  return harness
}

async function mountDependencies(harness: CordisHarness): Promise<void> {
  await Promise.all([
    harness.loader.create({ id: 'tools', name: '@deepseek-ai/dsh-tools', config: { mode: 'native' } }),
    harness.loader.create({ id: 'commands', name: '@deepseek-ai/dsh-commands' }),
    harness.loader.create({ id: 'system-prompt', name: '@deepseek-ai/dsh-system-prompt' }),
  ])
  await harness.loader.await()
}

async function mountComposition(harness: CordisHarness): Promise<string> {
  const pending = harness.loader.create({ id: 'llmwiki', name: '@evegoodevening/dsh-llmwiki', config: { root: harness.root } })
  await Promise.resolve()
  await mountDependencies(harness)
  return pending
}

describe('real Loader composition from the scoped package specifier', () => {
  it('activates after dependencies regardless of row order and runs every registry surface', async () => {
    const harness = await createHarness()
    const pending = harness.loader.create({
      id: 'llmwiki',
      name: '@evegoodevening/dsh-llmwiki',
      config: { root: harness.root, maxResults: 2, maxSnippetBytes: 80 },
    })
    await Promise.resolve()
    expect(harness.ctx.llmwiki).toBeUndefined()
    await mountDependencies(harness)
    const id = await pending
    await harness.loader.await()
    expect(id).toBe('llmwiki')
    expect(harness.ctx.tools.schemas().map(schema => schema.name).sort()).toEqual(TOOL_NAMES)

    const status = await invoke(harness.ctx, 'llmwiki_status', { irrelevant: true })
    expect(await invoke(harness.ctx, 'llmwiki_status', {})).toEqual(status)
    const source = await invoke(harness.ctx, 'llmwiki_add_source', { name: 'Loader evidence', content: 'alpha evidence', unknown: 1 }) as { id: string }
    await expect(invoke(harness.ctx, 'llmwiki_read_source', { id: source.id })).resolves.toMatchObject({ content: 'alpha evidence' })
    await invoke(harness.ctx, 'llmwiki_upsert_page', {
      id: 'alpha', title: 'Alpha', summary: 'Loader composition.', sources: [source.id], body: '# Alpha\n\nalpha evidence', ignored: '/tmp',
    })
    await expect(invoke(harness.ctx, 'llmwiki_search', { query: 'alpha' })).resolves.toHaveLength(1)
    await expect(invoke(harness.ctx, 'llmwiki_read_page', { id: 'alpha' })).resolves.toEqual({
      id: 'alpha',
      markdown: `---\ntitle: "Alpha"\nsummary: "Loader composition."\nsources:\n  - "${source.id}"\n---\n\n# Alpha\n\nalpha evidence\n`,
      metadata: { title: 'Alpha', summary: 'Loader composition.', sources: [source.id] },
    })
    await expect(invoke(harness.ctx, 'llmwiki_lint', {})).resolves.toMatchObject({ errorCount: 0 })
    const command = await harness.ctx.commands.execute(commandAgent(), '/wiki status', [], new AbortController().signal)
    expect(command?.result).toMatchObject({ kind: 'success' })
    expect(await readFile(join(harness.root, 'pages', 'alpha.md'), 'utf8')).toContain('alpha evidence')
    expect(await readFile(join(harness.root, 'sources', source.id, 'content'), 'utf8')).toBe('alpha evidence')
  }, 120_000)

  it('disables, removes, and re-enables without duplicates or changing durable wiki bytes', async () => {
    const harness = await createHarness()
    const id = await mountComposition(harness)
    const source = await invoke(harness.ctx, 'llmwiki_add_source', { name: 'Evidence', content: 'persistent alpha' }) as { id: string }
    await invoke(harness.ctx, 'llmwiki_upsert_page', { id: 'alpha', title: 'Alpha', summary: 'Persistent.', sources: [source.id], body: '# Alpha\n\npersistent alpha' })
    const before = await hashTree(harness.root)

    await harness.loader.resolve(id).update({ disabled: true })
    expect(harness.ctx.tools.schemas()).toEqual([])
    await harness.loader.resolve(id).update({ disabled: false })
    expect(harness.ctx.tools.schemas().map(schema => schema.name).sort()).toEqual(TOOL_NAMES)
    expect((await harness.ctx.systemPrompt.assemble()).sections.filter(section => section.name === 'tool:llmwiki')).toHaveLength(1)
    expect(await invoke(harness.ctx, 'llmwiki_read_page', { id: 'alpha' })).toEqual({
      id: 'alpha',
      markdown: `---\ntitle: "Alpha"\nsummary: "Persistent."\nsources:\n  - "${source.id}"\n---\n\n# Alpha\n\npersistent alpha\n`,
      metadata: { title: 'Alpha', summary: 'Persistent.', sources: [source.id] },
    })

    await harness.loader.remove(id)
    expect(harness.ctx.tools.schemas()).toEqual([])
    await harness.loader.create({ id, name: '@evegoodevening/dsh-llmwiki', config: { root: harness.root } })
    expect(harness.ctx.tools.schemas().map(schema => schema.name).sort()).toEqual(TOOL_NAMES)
    expect((await harness.ctx.systemPrompt.assemble()).sections.filter(section => section.name === 'tool:llmwiki')).toHaveLength(1)
    expect(await hashTree(harness.root)).toBe(before)
  }, 120_000)

  it('keeps activation pending while a required service is missing and unloads when it disappears', async () => {
    const harness = await createCordisHarness()
    active.push(harness)
    const pending = harness.loader.create({ id: 'llmwiki', name: '@evegoodevening/dsh-llmwiki', config: { root: harness.root } })
    await Promise.resolve()
    expect(harness.ctx.llmwiki).toBeUndefined()
    await Promise.all([
      harness.loader.create({ id: 'tools', name: '@deepseek-ai/dsh-tools', config: { mode: 'native' } }),
      harness.loader.create({ id: 'commands', name: '@deepseek-ai/dsh-commands' }),
    ])
    expect(harness.ctx.llmwiki).toBeUndefined()
    await harness.loader.create({ id: 'system-prompt', name: '@deepseek-ai/dsh-system-prompt' })
    await pending
    await harness.loader.await()
    expect(harness.ctx.llmwiki).toBeDefined()
    await harness.loader.remove('system-prompt')
    expect(harness.ctx.llmwiki).toBeUndefined()
    expect(harness.ctx.systemPrompt).toBeUndefined()
    expect(harness.ctx.tools?.schemas() ?? []).toEqual([])
    await harness.loader.create({ id: 'system-prompt', name: '@deepseek-ai/dsh-system-prompt' })
    await harness.loader.await()
    expect(harness.ctx.llmwiki).toBeDefined()
    expect((await harness.ctx.systemPrompt.assemble()).sections.filter(section => section.name === 'tool:llmwiki')).toHaveLength(1)
    expect(harness.ctx.tools.schemas().map(schema => schema.name).sort()).toEqual(TOOL_NAMES)
  }, 120_000)

  it('rejects malformed and missing package compositions', async () => {
    const harness = await createHarness()
    await expect(harness.loader.create({ id: 'missing', name: 'definitely-missing-llmwiki-package' })).rejects.toThrow(/failed to import loader entry/u)
    await expect(harness.loader.create({ id: 'malformed', name: 'node:fs' })).rejects.toThrow(/failed to apply loader entry/u)
  }, 120_000)
})
