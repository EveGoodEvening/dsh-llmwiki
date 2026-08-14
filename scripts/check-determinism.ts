import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, stat, utimes } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { Fiber, Plugin } from '@deepseek-ai/cordis'
import { CommandRuntime } from '@deepseek-ai/dsh-commands'
import { SystemPrompt } from '@deepseek-ai/dsh-system-prompt'
import { ToolRuntime } from '@deepseek-ai/dsh-tools'

interface BuiltLlmWikiConfig {
  readonly root?: string
  readonly maxSourceBytes?: number
  readonly maxPageBytes?: number
  readonly maxResults?: number
  readonly maxSnippetBytes?: number
  readonly commandDiagnosticLimit?: number
}

interface ResolvedBuiltLlmWikiConfig {
  readonly root: string
  readonly maxSourceBytes: number
  readonly maxPageBytes: number
  readonly maxResults: number
  readonly maxSnippetBytes: number
  readonly commandDiagnosticLimit: number
}
interface BuiltSourceReceipt {
  readonly id: string
  readonly deduplicated: boolean
  readonly metadata: Readonly<Record<string, unknown>>
}

interface BuiltPageReceipt {
  readonly id: string
  readonly created: boolean
  readonly sha256: string
}

interface BuiltSearchHit {
  readonly pageId: string
  readonly title: string
  readonly headingTrail: readonly string[]
  readonly startLine: number
  readonly score: number
  readonly snippet: string
  readonly sourceIds: readonly string[]
}

interface BuiltLlmWikiService {
  addSource(input: {
    readonly name: string
    readonly content: string
    readonly mediaType?: string
    readonly origin?: string
  }, signal?: AbortSignal): Promise<BuiltSourceReceipt>
  upsertPage(input: {
    readonly id: string
    readonly title: string
    readonly summary: string
    readonly sources: readonly string[]
    readonly body: string
  }, signal?: AbortSignal): Promise<BuiltPageReceipt>
  search(query: string, limit?: number, signal?: AbortSignal): Promise<BuiltSearchHit[]>
  lint(signal?: AbortSignal): Promise<{ readonly errorCount: number }>
}


interface BuiltLlmWikiModule extends Plugin.Object<BuiltLlmWikiConfig> {
  readonly Config: NonNullable<Plugin.Object<BuiltLlmWikiConfig>['Config']>
    & ((config?: BuiltLlmWikiConfig) => ResolvedBuiltLlmWikiConfig)
  readonly LLMWIKI_ERROR_CODES: readonly string[]
  readonly LlmWikiError: (...args: unknown[]) => unknown
  readonly LlmWikiService: new (...args: unknown[]) => BuiltLlmWikiService
  readonly apply: (ctx: Context, config?: BuiltLlmWikiConfig) => void
  readonly inject: string[]
  readonly isLlmWikiError: (value: unknown) => boolean
  readonly isPageId: (value: unknown) => boolean
  readonly isSourceId: (value: unknown) => boolean
  readonly name: string
  readonly pageId: (value: string) => string
  readonly sourceId: (value: string) => string
}

type CommandAgent = Parameters<CommandRuntime['list']>[0]

const TOOL_NAMES = [
  'llmwiki_add_source',
  'llmwiki_lint',
  'llmwiki_read_page',
  'llmwiki_read_source',
  'llmwiki_search',
  'llmwiki_status',
  'llmwiki_upsert_page',
]

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

function assertLlmWikiPublic(value: unknown): asserts value is BuiltLlmWikiModule {
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

function assertBuiltLlmWikiService(value: unknown): asserts value is BuiltLlmWikiService {
  if (typeof value !== 'object' || value === null
    || typeof Reflect.get(value, 'addSource') !== 'function'
    || typeof Reflect.get(value, 'upsertPage') !== 'function'
    || typeof Reflect.get(value, 'search') !== 'function'
    || typeof Reflect.get(value, 'lint') !== 'function') {
    throw new TypeError('built llmwiki service does not expose the required persistence and search methods')
  }
}

function commandAgent(): CommandAgent {
  const session = { append: () => ({ seq: 0 }) }
  return new Proxy({ session }, {
    get(target, property): unknown {
      if (property === 'session') return target.session
      return () => undefined
    },
  }) as unknown as CommandAgent
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
function assertEqual(name: string, actual: unknown, expected: unknown): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${name} mismatch: README=${JSON.stringify(actual)} runtime=${JSON.stringify(expected)}`)
  }
}

function readSection(markdown: string, heading: string): string {
  const start = markdown.indexOf(heading)
  if (start === -1) throw new Error(`README section not found: ${heading}`)
  const end = markdown.indexOf('\n## ', start + heading.length)
  return markdown.slice(start, end === -1 ? markdown.length : end)
}
function parseConfigurationRow(match: RegExpMatchArray): readonly [string, string] {
  const captures: unknown = match.slice(1, 3)
  if (!Array.isArray(captures) || captures.length !== 2) {
    throw new Error('README configuration table row is malformed')
  }
  const key: unknown = captures[0]
  const value: unknown = captures[1]
  if (typeof key !== 'string' || typeof value !== 'string') {
    throw new Error('README configuration table row contains a non-string value')
  }
  return [key, value]
}


async function auditDocumentation(root: string): Promise<void> {
  const readme = await readFile('README.md', 'utf8')
  const configuration = readSection(readme, '## Configuration / 配置')
  const documentedDefaults = Object.fromEntries(
    [...configuration.matchAll(/^\| `([^`]+)` \| `([^`]+)` \|/gmu)].map(parseConfigurationRow),
  )
  const runtimeDefaults = LlmWiki.Config({})
  assertEqual('README configuration defaults', documentedDefaults, Object.fromEntries(
    Object.entries(runtimeDefaults).map(([key, value]) => [key, String(value)]),
  ))

  const ctx = new Context()
  const fibers: Fiber[] = []
  try {
    const toolsFiber = ctx.plugin(ToolRuntime, { mode: 'native' })
    fibers.push(toolsFiber)
    await toolsFiber.await()

    const commandsFiber = ctx.plugin(CommandRuntime)
    fibers.push(commandsFiber)
    await commandsFiber.await()

    const promptFiber = ctx.plugin(SystemPrompt, {})
    fibers.push(promptFiber)
    await promptFiber.await()

    const wikiFiber = ctx.plugin(LlmWiki, { ...runtimeDefaults, root })
    fibers.push(wikiFiber)
    await wikiFiber.await()

    const documentedTools = [...readSection(readme, '## Model tools / 模型工具').matchAll(/^\| `(llmwiki_[a-z_]+)` \|/gmu)].map(match => match[1])
    const runtimeTools = ctx.tools.schemas()
      .map(schema => schema.name)
      .filter(name => name.startsWith('llmwiki_'))
    assertEqual('exact runtime tool names', runtimeTools.toSorted(), TOOL_NAMES.toSorted())
    assertEqual('README tool names', [...documentedTools].sort(), [...runtimeTools].sort())

    const wikiCommands = ctx.commands.list(commandAgent()).filter(command => command.name === 'wiki')
    assertEqual('wiki command descriptor', wikiCommands, [{
      name: 'wiki',
      description: 'Inspect, lint, or reindex the local wiki',
      input: { hint: '[status|lint|reindex]' },
    }])
    const wikiCommand = wikiCommands[0]
    if (wikiCommand?.input === undefined) throw new Error('wiki command has no registered input hint')
    const runtimeTokens = wikiCommand.input.hint.replace(/^\[/u, '').replace(/\]$/u, '').split('|')
    const documentedCommandSection = readSection(readme, '## Human command / 人工命令')
    const documentedTokens = [...documentedCommandSection.matchAll(/`\/wiki (status|lint|reindex)`/gu)].map(match => match[1])
    assertEqual('README command tokens', [...new Set(documentedTokens)], runtimeTokens)

    const assembly = await ctx.systemPrompt.assemble()
    const promptDocumentation = readSection(readme, '## Model experience')
    const promptMetadata = /named `([^`]+)`, ordered at `(\d+)`/u.exec(promptDocumentation)
    const promptText = /```text\n([\s\S]*?)\n```/u.exec(promptDocumentation)?.[1]
    if (promptMetadata === null || promptText === undefined) throw new Error('README prompt contract is malformed')
    assertEqual('README documented prompt order', Number(promptMetadata[2]), 116)
    assertEqual('assembled prompt section names', assembly.sections.map(section => section.name), [
      'harness:identity',
      'deployment:persona',
      promptMetadata[1],
    ])
    const promptSection = assembly.sections[2]
    if (promptSection === undefined) throw new Error('tool:llmwiki prompt section is not assembled at its documented sorted position')
    assertEqual('README prompt section', promptSection.name, 'tool:llmwiki')
    assertEqual('README prompt text', promptSection.text, promptText)
  } finally {
    await Promise.allSettled([...fibers].reverse().map(fiber => fiber.dispose()))
  }
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
    const receipts: Record<string, BuiltSourceReceipt> = {}
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
    if (lint.errorCount !== 0) throw new Error(`lint returned ${lint.errorCount} errors`)
    return {
      searchIndex: await readFile(join(root, '.index', 'search.json')),
      state: await readFile(join(root, '.index', 'state.json')),
      search: canonical(search),
      lint: canonical(lint),
    }
  } finally {
    await fiber.dispose()
  }
}

const patchUrl = import.meta.resolve('dsh-llmwiki/cordis.patch.yml')
if (!patchUrl.endsWith('/cordis.patch.yml')) throw new Error(`package patch export resolved unexpectedly: ${patchUrl}`)
const patch = await stat(new URL(patchUrl))
if (!patch.isFile()) throw new Error('package patch export is not a file')

const temporary = await mkdtemp(join(tmpdir(), 'dsh-llmwiki-determinism-'))
try {
  const firstRoot = join(temporary, 'first')
  const secondRoot = join(temporary, 'second')
  await mkdir(firstRoot)
  await mkdir(secondRoot)
  await auditDocumentation(join(temporary, 'documentation-audit'))
  const first = await populate(firstRoot, false)
  const second = await populate(secondRoot, true)
  for (const name of ['searchIndex', 'state', 'search', 'lint'] as const) assertBytes(name, first[name], second[name])
  const digest = createHash('sha256').update(first.searchIndex).digest('hex')
  const roots = await Promise.all([stat(firstRoot), stat(secondRoot)])
  if (!roots.every(value => value.isDirectory())) throw new Error('temporary roots are not directories')
  console.log(`determinism ok: search.json sha256=${digest}`)
} finally {
  await rm(temporary, { recursive: true, force: true })
}
