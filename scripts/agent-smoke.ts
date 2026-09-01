import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import {
  access,
  cp,
  lstat,
  mkdtemp,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn, type ChildProcess } from 'node:child_process'
import { parsePageMarkdown, type ParsedPageMarkdown } from '../src/markdown.ts'

const PROVIDER = 'deepseek'
const AGENT_VERSION = '0.1.1-rc.2'
const SCENARIO_ID = 'c19a-aurora-supersession-v1'
const DEFAULT_EVIDENCE = 'tests/fixtures/agent-smoke/latest.json'
const FIXTURE_ROOT = resolve('tests/fixtures/agent-smoke')
const MAX_CHILD_OUTPUT = 1024 * 1024
const SETUP_TIMEOUT_MS = 5 * 60_000
const MODEL_TIMEOUT_MS = 10 * 60_000
const NETWORK_OPT_IN = 'allow'
const REQUIRED_FIXTURES = ['source-a.txt', 'source-b.txt', 'instructions.txt', 'schema.md', 'project-aurora.md', 'operations-runbook.md'] as const
export const HISTORICAL_HARBOR_SENTENCE = 'On 2026-01-15, Harbor was the current production synchronization endpoint for Project Aurora.'
export const CURRENT_MERIDIAN_SENTENCE = 'On 2026-08-20, Meridian is the required current production synchronization endpoint for Project Aurora.'
export const RETIRED_HARBOR_SENTENCE = 'On 2026-08-20, Harbor is retired and must not be used for Project Aurora production synchronization.'
const REQUIRED_SUPERSESSION_SENTENCES = [HISTORICAL_HARBOR_SENTENCE, CURRENT_MERIDIAN_SENTENCE, RETIRED_HARBOR_SENTENCE] as const
const RUNNER_FIXTURE_ROOT = join(FIXTURE_ROOT, 'runner')
const RUNNER_LOCK_SHA256 = 'af12c2caeed081804f6d57fcac547a0686d456696d15c4a4d1b60602bd9797b7'
const APPROVED_CORDIS_RUNTIME = {
  '@deepseek-ai/cordis': '4.0.1',
  '@deepseek-ai/cordis-plugin-loader': '1.0.2',
} as const
const activeChildren = new Set<ChildProcess>()

export interface TerminationController {
  readonly signal: NodeJS.Signals | undefined
  observe(signal: NodeJS.Signals): void
  throwIfObserved(): void
}

export function createTerminationController(
  terminateChildren: () => void,
  setNonzeroExitIntent: () => void,
): TerminationController {
  let signal: NodeJS.Signals | undefined
  return {
    get signal() { return signal },
    observe(value) {
      signal ??= value
      setNonzeroExitIntent()
      terminateChildren()
    },
    throwIfObserved() {
      if (signal !== undefined) fail('TERMINATED')
    },
  }
}

function terminateActiveChildren(): void {
  for (const child of activeChildren) {
    if (child.pid !== undefined) try {
      if (process.platform === 'win32') child.kill('SIGKILL')
      else process.kill(-child.pid, 'SIGKILL')
    } catch { /* exited */ }
  }
}

const termination = createTerminationController(terminateActiveChildren, () => { process.exitCode = 1 })

export interface LintCounts { errorCount: number; warningCount: number }
export interface ToolEvent { name: string; seq: number; resultSeq?: number; turn: number; step: number; id?: string; result?: unknown }
export interface SessionTrace { turn: number; tools: ToolEvent[]; finalAssistantText?: string; finalAssistantSeq?: number; provider: string; model: string }
const IGNORED_SESSION_EVENT_TYPES: Readonly<Record<string, true>> = {
  'approval/policy': true,
  'permission/preset': true,
  'request/context': true,
  'request/header': true,
  'sandbox/mode': true,
  'session/title': true,
}

function codeUnitCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function validateRawAssistantChunk(data: Record<string, unknown>): void {
  const chunk = data.chunk
  if (typeof chunk !== 'object' || chunk === null || Array.isArray(chunk)) fail('INVALID_SESSION_TRACE')
  const record = chunk as Record<string, unknown>
  const index = record.index
  const validIndex = Number.isSafeInteger(index) && Number(index) >= 0
  const valid = record.type === 'block-start'
    ? validIndex && typeof record.blockType === 'string' && record.blockType !== ''
    : record.type === 'text-delta' || record.type === 'reasoning-delta'
      ? validIndex && typeof record.text === 'string'
      : record.type === 'tool-call-delta'
        ? validIndex && typeof record.id === 'string' && record.id !== ''
          && (record.name === undefined || typeof record.name === 'string') && typeof record.argumentsDelta === 'string'
        : record.type === 'block-end'
          ? validIndex && typeof record.block === 'object' && record.block !== null && !Array.isArray(record.block)
            && typeof (record.block as Record<string, unknown>).type === 'string'
          : record.type === 'usage'
            ? typeof record.usage === 'object' && record.usage !== null && !Array.isArray(record.usage)
            : record.type === 'finish' && typeof record.reason === 'object' && record.reason !== null && !Array.isArray(record.reason)
              && typeof (record.reason as Record<string, unknown>).kind === 'string'
  if (!valid) fail('INVALID_SESSION_TRACE')
}

function validateIgnoredSessionEvent(
  type: string,
  data: Record<string, unknown>,
  expectedRoute: { provider: string; model: string },
): { provider: string; model: string } | undefined {
  if (type === 'permission/preset') {
    if (typeof data.preset !== 'string' || data.preset === '') fail('INVALID_SESSION_TRACE')
  } else if (type === 'sandbox/mode') {
    if (!['read-only', 'workspace-write', 'danger-full-access'].includes(String(data.mode))
      || (data.source !== undefined && data.source !== 'delegation')) fail('INVALID_SESSION_TRACE')
  } else if (type === 'approval/policy') {
    if (!['ask', 'never'].includes(String(data.policy))
      || (data.source !== undefined && data.source !== 'delegation')) fail('INVALID_SESSION_TRACE')
  } else if (type === 'session/title') {
    const source = data.source
    if (typeof data.title !== 'string' || data.title.trim() === '' || !Array.isArray(data.messageSeqs)
      || !data.messageSeqs.every(seq => Number.isSafeInteger(seq) && Number(seq) >= 0)
      || typeof source !== 'object' || source === null || Array.isArray(source)
      || !['fallback', 'provider', 'user'].includes(String((source as Record<string, unknown>).kind))) fail('INVALID_SESSION_TRACE')
  } else if (type === 'request/header') {
    const header = data.header
    const config = typeof header === 'object' && header !== null && !Array.isArray(header)
      ? (header as Record<string, unknown>).config : undefined
    if (typeof header !== 'object' || header === null || Array.isArray(header)
      || typeof config !== 'object' || config === null || Array.isArray(config)
      || !['initial', 'resume', 'change'].includes(String(data.reason))) fail('INVALID_SESSION_TRACE')
    const route = config as Record<string, unknown>
    if (typeof route.provider !== 'string' || typeof route.model !== 'string'
      || route.provider !== expectedRoute.provider || route.model !== expectedRoute.model) fail('INVALID_SESSION_TRACE')
    return { provider: route.provider, model: route.model }
  } else if (type === 'request/context') {
    if (data.provider !== expectedRoute.provider || data.model !== expectedRoute.model) fail('INVALID_SESSION_TRACE')
  }
  return undefined
}

function pinnedUserMessage(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) fail('INVALID_SESSION_TRACE')
  const message = value as Record<string, unknown>
  const source = message.source
  const content = message.content
  if (typeof message.id !== 'string' || message.id === '' || message.role !== 'user'
    || typeof source !== 'object' || source === null || Array.isArray(source)
    || (source as Record<string, unknown>).kind !== 'user' || !Array.isArray(content) || content.length !== 1) fail('INVALID_SESSION_TRACE')
  const blocks: readonly unknown[] = content
  const block = blocks[0]
  if (typeof block !== 'object' || block === null || Array.isArray(block)) fail('INVALID_SESSION_TRACE')
  const blockRecord = block as Record<string, unknown>
  if (blockRecord.type !== 'text' || typeof blockRecord.text !== 'string' || blockRecord.text === '') fail('INVALID_SESSION_TRACE')
  return message
}

function sameMessage(left: Record<string, unknown>, right: Record<string, unknown>): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}


class SafeFailure extends Error {
  constructor(readonly code: string) {
    super(code)
  }
}

function fail(code: string): never {
  throw new SafeFailure(code)
}

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex')
}

function safeValue(value: string | undefined): string | undefined {
  return value === undefined || value.trim() === '' ? undefined : value
}

async function run(
  command: string,
  args: readonly string[],
  options: { cwd?: string; env: NodeJS.ProcessEnv; timeoutMs: number },
): Promise<string> {
  termination.throwIfObserved()
  const child = spawn(command, args, {
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    env: options.env,
    detached: process.platform !== 'win32',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  activeChildren.add(child)
  const chunks: Buffer[] = []
  let size = 0
  let timedOut = false
  let overflowed = false
  const collect = (chunk: Buffer | string): void => {
    const bytes = Buffer.from(chunk)
    size += bytes.length
    if (size <= MAX_CHILD_OUTPUT) chunks.push(bytes)
    else overflowed = true
  }
  child.stdout.on('data', collect)
  child.stderr.on('data', collect)
  const terminate = (): void => {
    if (child.pid === undefined) return
    try {
      if (process.platform === 'win32') child.kill('SIGKILL')
      else process.kill(-child.pid, 'SIGKILL')
    } catch {
      // The process may already have exited.
    }
  }
  const timer = setTimeout(() => {
    timedOut = true
    terminate()
  }, options.timeoutMs)
  timer.unref()
  const result = await new Promise<{ code: number | null; error?: Error }>(resolveChild => {
    child.once('error', error => resolveChild({ code: null, error }))
    child.once('close', code => resolveChild({ code }))
  })
  clearTimeout(timer)
  activeChildren.delete(child)
  terminate()
  if (timedOut) fail('CHILD_TIMEOUT')
  if (overflowed) fail('CHILD_OUTPUT_LIMIT')
  if (result.error !== undefined || result.code !== 0) fail('CHILD_EXECUTION_FAILED')
  return Buffer.concat(chunks).toString('utf8')
}

async function runPnpm(args: readonly string[], options: { cwd?: string; env: NodeJS.ProcessEnv; timeoutMs?: number }): Promise<string> {
  const pnpmPath = safeValue(process.env.npm_execpath)
  if (pnpmPath === undefined) fail('INVALID_LOCAL_ENVIRONMENT')
  return await run(process.execPath, [pnpmPath, ...args], {
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    env: options.env,
    timeoutMs: options.timeoutMs ?? SETUP_TIMEOUT_MS,
  })
}

export function validateModelIdentifier(model: unknown): string {
  if (typeof model !== 'string' || !/^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,126}[A-Za-z0-9])?$/u.test(model)) fail('INVALID_SMOKE_CONFIGURATION')
  return model
}

function exactEnvironment(): { model: string; apiKey: string; evidencePath: string } {
  const model = validateModelIdentifier(process.env.LLMWIKI_AGENT_SMOKE_MODEL)
  const apiKey = safeValue(process.env.DEEPSEEK_API_KEY)
  delete process.env.DEEPSEEK_API_KEY
  if (apiKey === undefined) fail('BLOCKED_MISSING_CREDENTIAL')
  if (process.env.LLMWIKI_AGENT_SMOKE_NETWORK !== NETWORK_OPT_IN) fail('BLOCKED_NETWORK_NOT_OPTED_IN')
  const evidenceValue = process.env.LLMWIKI_AGENT_SMOKE_EVIDENCE ?? DEFAULT_EVIDENCE
  if (evidenceValue.trim() === '' || /[\u0000]/u.test(evidenceValue)) fail('INVALID_SMOKE_CONFIGURATION')
  return { model, apiKey, evidencePath: resolve(evidenceValue) }
}

export function validateSupportedNodeVersion(version: string): void {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/u.exec(version)
  if (match === null) fail('INVALID_LOCAL_ENVIRONMENT')
  const major = Number(match[1])
  const minor = Number(match[2])
  if (!((major === 22 && minor >= 19) || major >= 24)) fail('INVALID_LOCAL_ENVIRONMENT')
}

async function validateLocalContract(evidencePath: string): Promise<{ packageVersion: string }> {
  const manifest = JSON.parse(await readFile('package.json', 'utf8')) as {
    version?: unknown
    packageManager?: unknown
    devDependencies?: Record<string, string>
    scripts?: Record<string, string>
  }
  if (typeof manifest.version !== 'string'
    || manifest.packageManager !== 'pnpm@11.7.0'
    || manifest.devDependencies?.['@deepseek-ai/dsh-agent'] !== AGENT_VERSION
    || manifest.scripts?.['smoke:agent'] !== 'tsx scripts/agent-smoke.ts') fail('INVALID_LOCAL_PACKAGE')
  const evidenceParent = dirname(evidencePath)
  await validateEvidenceParent(evidencePath)
  await access(evidenceParent, constants.W_OK).catch(() => fail('INVALID_EVIDENCE_LOCATION'))
  const evidenceStat = await lstat(evidencePath).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  })
  if (evidenceStat !== undefined && !evidenceStat.isFile()) fail('INVALID_EVIDENCE_LOCATION')
  for (const name of REQUIRED_FIXTURES) {
    if (!(await stat(join(FIXTURE_ROOT, name)).catch(() => undefined))?.isFile()) fail('INVALID_SCENARIO_FIXTURE')
  }
  for (const name of ['package.json', 'pnpm-lock.yaml']) {
    if (!(await stat(join(RUNNER_FIXTURE_ROOT, name)).catch(() => undefined))?.isFile()) fail('INVALID_RUNNER_FIXTURE')
  }
  return { packageVersion: manifest.version }
}

function setupEnvironment(root: string, dshHome: string): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH,
    HOME: join(root, 'home'),
    XDG_CACHE_HOME: join(root, 'xdg-cache'),
    XDG_CONFIG_HOME: join(root, 'xdg-config'),
    XDG_DATA_HOME: join(root, 'xdg-data'),
    XDG_STATE_HOME: join(root, 'xdg-state'),
    PNPM_HOME: join(root, 'pnpm-home'),
    PNPM_STORE_DIR: join(root, 'pnpm-store'),
    npm_config_store_dir: join(root, 'pnpm-store'),
    npm_config_userconfig: join(root, 'npmrc'),
    DSH_HOME: dshHome,
    DSH_TOOLS_MODE: 'native',
    LANG: 'C.UTF-8',
    LC_ALL: 'C.UTF-8',
    TZ: 'UTC',
    CI: '1',
    COREPACK_ENABLE_PROJECT_SPEC: '0',
  }
}

async function packPlugin(destination: string, sourceRoot: string, env: NodeJS.ProcessEnv): Promise<{ tarball: string; hash: string }> {
  const packageRoot = join(sourceRoot, 'package')
  await cp(resolve('.'), packageRoot, {
    recursive: true,
    filter: source => !['.git', 'node_modules', 'lib', 'coverage', '.tmp', 'tmp'].includes(basename(source)),
  })
  await runPnpm(['install', '--frozen-lockfile', '--ignore-scripts', '--ignore-workspace'], { cwd: packageRoot, env })
  await runPnpm(['run', 'build'], { cwd: packageRoot, env })
  const output = await run('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', destination], {
    cwd: packageRoot,
    env,
    timeoutMs: SETUP_TIMEOUT_MS,
  })
  const parsed: unknown = JSON.parse(output)
  if (!Array.isArray(parsed)) fail('INVALID_PACK_RESULT')
  const records: readonly unknown[] = parsed
  const record = records[0]
  if (records.length !== 1 || typeof record !== 'object' || record === null || Array.isArray(record)) fail('INVALID_PACK_RESULT')
  const filename = (record as Record<string, unknown>).filename
  if (typeof filename !== 'string') fail('INVALID_PACK_RESULT')
  const tarball = resolve(destination, filename)
  return { tarball, hash: sha256(await readFile(tarball)) }
}

function packageOrder(entries: [string, string][]): [string, string][] {
  return entries.sort(([left], [right]) => codeUnitCompare(left, right))
}

function approvedRuntimePackages(lock: string): Record<string, string> {
  const snapshotsOffset = lock.indexOf('\nsnapshots:\n')
  if (snapshotsOffset < 0) fail('INVALID_RUNNER_FIXTURE')
  const packages = lock.slice(0, snapshotsOffset)
  const approved: Record<string, string> = {}
  for (const match of packages.matchAll(/^  '(@deepseek-ai\/(?:dsh[^@]*|cordis[^@]*))@([^']+)':$/gmu)) {
    const [, name, version] = match
    if (name === undefined || version === undefined || (approved[name] !== undefined && approved[name] !== version)) fail('INVALID_RUNNER_FIXTURE')
    approved[name] = version
  }
  if (Object.keys(approved).length === 0) fail('INVALID_RUNNER_FIXTURE')
  for (const [name, version] of Object.entries(APPROVED_CORDIS_RUNTIME)) {
    if (approved[name] !== version) fail('INVALID_RUNNER_FIXTURE')
  }
  return Object.fromEntries(packageOrder(Object.entries(approved)))
}

async function installedRuntimePackages(runnerRoot: string): Promise<Record<string, string>> {
  const found: Record<string, string> = {}
  const virtualStore = join(runnerRoot, 'node_modules', '.pnpm')
  for (const entry of (await readdir(virtualStore)).sort(codeUnitCompare)) {
    const scope = join(virtualStore, entry, 'node_modules', '@deepseek-ai')
    for (const name of (await readdir(scope).catch(() => [])).sort(codeUnitCompare)) {
      if (!/^(?:dsh|cordis)/u.test(name)) continue
      const manifest = JSON.parse(await readFile(join(scope, name, 'package.json'), 'utf8')) as { name?: unknown; version?: unknown }
      if (typeof manifest.name !== 'string' || typeof manifest.version !== 'string') fail('INVALID_AGENT_RUNTIME_VERSION')
      if (found[manifest.name] !== undefined && found[manifest.name] !== manifest.version) fail('INVALID_AGENT_RUNTIME_VERSION')
      found[manifest.name] = manifest.version
    }
  }
  return Object.fromEntries(packageOrder(Object.entries(found)))
}

async function seedWiki(workspace: string): Promise<{ sourceAId: string; sourceBId: string; sourceAMetadata: string }> {
  const wiki = join(workspace, '.llmwiki')
  const sourceA = await readFile(join(FIXTURE_ROOT, 'source-a.txt'))
  const sourceB = await readFile(join(FIXTURE_ROOT, 'source-b.txt'))
  const sourceAId = sha256(sourceA)
  const sourceBId = sha256(sourceB)
  const sourceAMetadata = `${JSON.stringify({
    id: sourceAId,
    name: 'Project Aurora operations bulletin (2026-01-15)',
    mediaType: 'text/plain; charset=utf-8',
    byteCount: sourceA.byteLength,
    capturedAt: '2026-01-15T00:00:00.000Z',
    origin: 'agent-smoke/source-a',
  }, null, 2)}\n`
  await mkdir(join(wiki, 'sources', sourceAId), { recursive: true })
  await mkdir(join(wiki, 'pages'), { recursive: true })
  await cp(join(FIXTURE_ROOT, 'schema.md'), join(wiki, 'schema.md'))
  await writeFile(join(wiki, 'sources', sourceAId, 'content'), sourceA)
  await writeFile(join(wiki, 'sources', sourceAId, 'metadata.json'), sourceAMetadata)
  for (const name of ['project-aurora.md', 'operations-runbook.md']) {
    const template = await readFile(join(FIXTURE_ROOT, name), 'utf8')
    await writeFile(join(wiki, 'pages', name), template.replaceAll('SOURCE_A_ID', sourceAId))
  }
  return { sourceAId, sourceBId, sourceAMetadata }
}

async function sessionDirectories(root: string): Promise<Set<string>> {
  const sessions = new Set<string>()
  const projects = await readdir(root, { withFileTypes: true }).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  })
  for (const project of projects) {
    if (!project.isDirectory() || project.isSymbolicLink()) continue
    const projectRoot = join(root, project.name)
    for (const session of await readdir(projectRoot, { withFileTypes: true })) {
      if (session.isDirectory() && !session.isSymbolicLink()) sessions.add(`${project.name}/${session.name}`)
    }
  }
  return sessions
}

function decodeToolResult(block: Record<string, unknown>): unknown {
  const rawContent: unknown = block.content
  if (!Array.isArray(rawContent)) fail('INVALID_SESSION_TRACE')
  const content: readonly unknown[] = rawContent
  const first = content[0]
  if (content.length === 1 && typeof first === 'object' && first !== null && (first as Record<string, unknown>).type === 'text') {
    const text = (first as Record<string, unknown>).text
    if (typeof text !== 'string') fail('INVALID_SESSION_TRACE')
    try { return JSON.parse(text) } catch { return text }
  }
  return content
}

function safeToolId(name: string, rawArguments: unknown): string | undefined {
  if (typeof rawArguments !== 'string') fail('INVALID_SESSION_TRACE')
  let parsed: unknown
  try { parsed = JSON.parse(rawArguments) } catch { fail('INVALID_SESSION_TRACE') }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) fail('INVALID_SESSION_TRACE')
  const id = (parsed as Record<string, unknown>).id
  if (name === 'llmwiki_read_page') {
    if (typeof id !== 'string' || !/^(?:project-aurora|operations-runbook)$/u.test(id)) fail('INVALID_SESSION_TRACE')
    return id
  }
  if (name === 'llmwiki_read_source') {
    if (typeof id !== 'string' || !/^[0-9a-f]{64}$/u.test(id)) fail('INVALID_SESSION_TRACE')
    return id
  }
  return undefined
}

export async function readNewSessionTrace(root: string, before: Set<string>, expectedRoute = { provider: PROVIDER, model: 'fixture' }): Promise<SessionTrace> {
  const after = await sessionDirectories(root)
  const created = [...after].filter(name => !before.has(name))
  if (created.length !== 1) fail('INVALID_SESSION_TRACE')
  const sessionRoot = join(root, ...created[0]!.split('/'))
  const files: string[] = []
  async function visit(path: string): Promise<void> {
    const value = await lstat(path)
    if (value.isSymbolicLink()) fail('INVALID_SESSION_TRACE')
    if (value.isDirectory()) {
      for (const entry of (await readdir(path)).sort(codeUnitCompare)) await visit(join(path, entry))
    } else if (value.isFile() && value.size <= 10 * 1024 * 1024 && /(?:jsonl|ndjson)$/u.test(path)) files.push(path)
    else if (value.isFile() && value.size > 10 * 1024 * 1024) fail('INVALID_SESSION_TRACE')
  }
  await visit(sessionRoot)
  if (files.length === 0) fail('INVALID_SESSION_TRACE')
  const events: Record<string, unknown>[] = []
  let headerSeen = false
  let expectedSeq = 0
  let previousTime = -1
  for (const file of files.sort()) {
    const lines = (await readFile(file, 'utf8')).split('\n').filter(line => line.trim() !== '')
    if (lines.length === 0) fail('INVALID_SESSION_TRACE')
    for (const [index, line] of lines.entries()) {
      let parsed: unknown
      try { parsed = JSON.parse(line) } catch { fail('INVALID_SESSION_TRACE') }
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) fail('INVALID_SESSION_TRACE')
      const event = parsed as Record<string, unknown>
      if (index === 0) {
        if (headerSeen || event.type !== 'session' || event.version !== 0 || typeof event.id !== 'string' || event.id === ''
          || !Number.isSafeInteger(event.createdAt) || Number(event.createdAt) < 0
          || (event.delegationDepth !== undefined
            && (!Number.isSafeInteger(event.delegationDepth) || Number(event.delegationDepth) < 0))) fail('INVALID_SESSION_TRACE')
        headerSeen = true
        continue
      }
      if (!Number.isSafeInteger(event.seq) || Number(event.seq) !== expectedSeq
        || !Number.isSafeInteger(event.time) || Number(event.time) < 0 || Number(event.time) < previousTime
        || typeof event.type !== 'string' || typeof event.data !== 'object' || event.data === null || Array.isArray(event.data)) fail('INVALID_SESSION_TRACE')
      expectedSeq += 1
      previousTime = Number(event.time)
      events.push(event)
    }
  }
  if (!headerSeen || events.length === 0) fail('INVALID_SESSION_TRACE')

  const calls = new Map<string, ToolEvent>()
  const completedCalls = new Set<string>()
  const completedTurns: { turn: number; tools: ToolEvent[]; finalAssistantText?: string; finalAssistantSeq?: number; userMessageSeen: boolean }[] = []
  let activeTurn: { turn: number; tools: ToolEvent[]; finalAssistantText?: string; finalAssistantSeq?: number; userMessageSeen: boolean } | undefined
  let activeStep: number | undefined
  let queuedPrompt: Record<string, unknown> | undefined
  let claimedPrompt: Record<string, unknown> | undefined
  let lastStep = 0
  let lastTurn = 0
  const surfaceMessageIds = new Set<string>()
  let verifiedRoute: { provider: string; model: string } | undefined
  const claimSurfaceMessageId = (message: Record<string, unknown>): void => {
    if (typeof message.id !== 'string' || message.id === '' || surfaceMessageIds.has(message.id)) fail('INVALID_SESSION_TRACE')
    surfaceMessageIds.add(message.id)
  }
  const phase = (data: Record<string, unknown>, withStep: boolean): { turn: number; step?: number } => {
    if (!Number.isSafeInteger(data.turn) || Number(data.turn) <= 0
      || (withStep && (!Number.isSafeInteger(data.step) || Number(data.step) <= 0))) fail('INVALID_SESSION_TRACE')
    const turn = Number(data.turn)
    return withStep ? { turn, step: Number(data.step) } : { turn }
  }
  for (const event of events) {
    const data = event.data as Record<string, unknown>
    if (event.type === 'turn/start') {
      const { turn } = phase(data, false)
      if (activeTurn !== undefined || activeStep !== undefined || queuedPrompt === undefined || claimedPrompt !== undefined
        || turn <= lastTurn) fail('INVALID_SESSION_TRACE')
      activeTurn = { turn, tools: [], userMessageSeen: false }
      lastTurn = turn
      lastStep = 0
    } else if (event.type === 'agent/inbox/spliced') {
      if (data.target !== 'next-turn' || data.start !== 0 || !Array.isArray(data.inserted)
        || (data.outcome !== undefined && data.outcome !== 'canceled')) fail('INVALID_SESSION_TRACE')
      if (data.removedCount === undefined && data.inserted.length === 1 && activeTurn === undefined && queuedPrompt === undefined) {
        queuedPrompt = pinnedUserMessage(data.inserted[0])
      } else if (data.removedCount === 1 && data.inserted.length === 0 && activeTurn !== undefined
        && activeStep === undefined && queuedPrompt !== undefined && claimedPrompt === undefined) {
        claimedPrompt = queuedPrompt
      } else {
        fail('INVALID_SESSION_TRACE')
      }
    } else if (event.type === 'user/message') {
      const message = pinnedUserMessage(data)
      if (event.surfaceOp !== 'append' || activeTurn === undefined || activeStep !== undefined
        || activeTurn.userMessageSeen || claimedPrompt === undefined || !sameMessage(message, claimedPrompt)) fail('INVALID_SESSION_TRACE')
      claimSurfaceMessageId(message)
      activeTurn.userMessageSeen = true
      queuedPrompt = undefined
      claimedPrompt = undefined
    } else if (event.type === 'step/start') {
      const { turn, step } = phase(data, true)
      if (activeTurn?.turn !== turn || !activeTurn.userMessageSeen || activeStep !== undefined || step! <= lastStep) fail('INVALID_SESSION_TRACE')
      activeStep = step
      lastStep = step!
    } else if (event.type === 'step/end') {
      const { turn, step } = phase(data, true)
      if (activeTurn?.turn !== turn || activeStep !== step) fail('INVALID_SESSION_TRACE')
      activeStep = undefined
    } else if (event.type === 'turn/end') {
      const { turn } = phase(data, false)
      const reason = data.reason
      if (activeTurn?.turn !== turn || !activeTurn.userMessageSeen || activeStep !== undefined || typeof reason !== 'object' || reason === null
        || (reason as Record<string, unknown>).kind !== 'completed') fail('INVALID_SESSION_TRACE')
      completedTurns.push(activeTurn)
      activeTurn = undefined
    } else if (event.type === 'assistant/message') {
      const { turn, step } = phase(data, true)
      const message = data.message
      if (event.surfaceOp !== 'append' || activeTurn?.turn !== turn || activeStep !== step
        || typeof message !== 'object' || message === null) fail('INVALID_SESSION_TRACE')
      const record = message as Record<string, unknown>
      const source = record.source
      const rawContent: unknown = record.content
      const sourceRecord = source as Record<string, unknown>
      const sourceEventSeqs = event.sourceEventSeqs
      if (typeof record.id !== 'string' || record.id === '' || record.role !== 'assistant' || typeof source !== 'object' || source === null
        || sourceRecord.kind !== 'model' || typeof sourceRecord.provider !== 'string' || typeof sourceRecord.model !== 'string'
        || sourceRecord.provider !== expectedRoute.provider || sourceRecord.model !== expectedRoute.model
        || !Array.isArray(rawContent) || !Array.isArray(sourceEventSeqs) || sourceEventSeqs.some(seq => !Number.isSafeInteger(seq) || Number(seq) < 0 || Number(seq) >= Number(event.seq))
        || new Set(sourceEventSeqs).size !== sourceEventSeqs.length) fail('INVALID_SESSION_TRACE')
      verifiedRoute = { provider: sourceRecord.provider, model: sourceRecord.model }
      claimSurfaceMessageId(record)
      const content: readonly unknown[] = rawContent
      if (content.length === 0) fail('INVALID_SESSION_TRACE')
      const textParts: string[] = []
      let textOnly = true
      for (const block of content) {
        if (typeof block !== 'object' || block === null) fail('INVALID_SESSION_TRACE')
        const blockRecord = block as Record<string, unknown>
        if (blockRecord.type === 'text' && typeof blockRecord.text === 'string') textParts.push(blockRecord.text)
        else textOnly = false
      }
      const text = textParts.join('')
      if (textOnly && text.trim() !== '') {
        activeTurn.finalAssistantText = text
        activeTurn.finalAssistantSeq = Number(event.seq)
      } else {
        delete activeTurn.finalAssistantText
        delete activeTurn.finalAssistantSeq
      }
      // A final response is terminal only while no later tool surface follows it.
    } else if (event.type === 'tool/call') {
      const { turn, step } = phase(data, true)
      if (activeTurn?.turn !== turn || activeStep !== step || typeof data.callId !== 'string' || data.callId === ''
        || typeof data.name !== 'string' || data.name === '' || typeof data.arguments !== 'string' || calls.has(data.callId)) fail('INVALID_SESSION_TRACE')
      const id = safeToolId(data.name, data.arguments)
      const call: ToolEvent = { name: data.name, seq: Number(event.seq), turn, step: step!, ...(id === undefined ? {} : { id }) }
      calls.set(data.callId, call)
      if (data.name.startsWith('llmwiki_')) activeTurn.tools.push(call)
      delete activeTurn.finalAssistantText
      delete activeTurn.finalAssistantSeq
    } else if (event.type === 'tool/result') {
      const { turn, step } = phase(data, true)
      if (event.surfaceOp !== 'append' || activeTurn?.turn !== turn || activeStep !== step) fail('INVALID_SESSION_TRACE')
      const message = data.message
      if (typeof message !== 'object' || message === null) fail('INVALID_SESSION_TRACE')
      const record = message as Record<string, unknown>
      const source = record.source
      const rawContent: unknown = record.content
      if (typeof record.id !== 'string' || record.id === '' || record.role !== 'user'
        || typeof source !== 'object' || source === null || (source as Record<string, unknown>).kind !== 'tool'
        || typeof (source as Record<string, unknown>).callId !== 'string' || !Array.isArray(rawContent)) fail('INVALID_SESSION_TRACE')
      const content: readonly unknown[] = rawContent
      if (content.length !== 1) fail('INVALID_SESSION_TRACE')
      const block = content[0]
      if (typeof block !== 'object' || block === null) fail('INVALID_SESSION_TRACE')
      const resultBlock = block as Record<string, unknown>
      const sourceCallId = (source as Record<string, unknown>).callId as string
      const sourceEventSeqs = event.sourceEventSeqs
      const call = calls.get(sourceCallId)
      if (call === undefined || resultBlock.type !== 'tool-result' || resultBlock.toolCallId !== sourceCallId || typeof resultBlock.isError !== 'boolean'
        || call.turn !== turn || call.step !== step || call.seq >= Number(event.seq) || completedCalls.has(sourceCallId)
        || !Array.isArray(sourceEventSeqs) || sourceEventSeqs.length !== 1 || !Number.isSafeInteger(sourceEventSeqs[0])
        || sourceEventSeqs[0] !== call.seq || data.error !== undefined || resultBlock.isError) fail('INVALID_SESSION_TRACE')
      claimSurfaceMessageId(record)
      call.result = decodeToolResult(resultBlock)
      call.resultSeq = Number(event.seq)
      completedCalls.add(sourceCallId)
      delete activeTurn.finalAssistantText
      delete activeTurn.finalAssistantSeq
    } else if (event.type === 'assistant/chunk') {
      const { turn, step } = phase(data, true)
      if (activeTurn?.turn !== turn || activeStep !== step) fail('INVALID_SESSION_TRACE')
      validateRawAssistantChunk(data)
    } else if (IGNORED_SESSION_EVENT_TYPES[event.type as string] === true) {
      const route = validateIgnoredSessionEvent(event.type as string, data, expectedRoute)
      if (route !== undefined) verifiedRoute = route
    } else if (event.ignorable === true) {
      const { turn, step } = phase(data, true)
      if (activeTurn?.turn !== turn || activeStep !== step) fail('INVALID_SESSION_TRACE')
    } else {
      fail('INVALID_SESSION_TRACE')
    }
  }
  if (activeTurn !== undefined || activeStep !== undefined || queuedPrompt !== undefined || claimedPrompt !== undefined
    || [...calls.keys()].some(callId => !completedCalls.has(callId)) || verifiedRoute === undefined) fail('INVALID_SESSION_TRACE')
  const intended = completedTurns.filter(turn => turn.tools.length > 0)
  if (intended.length !== 1) fail('INVALID_SESSION_TRACE')
  const intendedTurn = intended[0]
  if (intendedTurn === undefined) fail('INVALID_SESSION_TRACE')
  const { userMessageSeen, ...trace } = intendedTurn
  if (!userMessageSeen) fail('INVALID_SESSION_TRACE')
  return { ...trace, provider: verifiedRoute.provider, model: verifiedRoute.model }
}

function indexAfter(tools: ToolEvent[], name: string, after = -1): number {
  return tools.findIndex((tool, index) => index > after && tool.name === name)
}

export function requireMaintenanceOrder(trace: SessionTrace, required: {
  pageIds: readonly string[]
  sourceAId: string
  sourceBId: string
}): LintCounts {
  const tools = trace.tools
  const add = indexAfter(tools, 'llmwiki_add_source')
  if (add < 0) fail('ASSERT_MAINTENANCE_TRACE_ORDER')
  const addSeq = tools[add]!.seq
  const preAddReadNames: Readonly<Record<string, true>> = {
    llmwiki_status: true,
    llmwiki_list_pages: true,
    llmwiki_list_sources: true,
    llmwiki_search: true,
    llmwiki_read_page: true,
    llmwiki_read_source: true,
  }
  if (tools.slice(0, add).some(tool => preAddReadNames[tool.name] === true && (tool.resultSeq === undefined || tool.resultSeq >= addSeq))) {
    fail('ASSERT_DISCOVERY_BEFORE_MAINTENANCE')
  }
  for (const name of ['llmwiki_status', 'llmwiki_list_pages', 'llmwiki_list_sources', 'llmwiki_search']) {
    const discovery = indexAfter(tools, name)
    if (discovery < 0 || discovery >= add) fail('ASSERT_DISCOVERY_BEFORE_MAINTENANCE')
  }
  const requireReads = (slice: ToolEvent[], sourceIds: readonly string[], code: string): void => {
    const pages = new Set(slice.filter(tool => tool.name === 'llmwiki_read_page' && tool.resultSeq !== undefined).map(tool => tool.id))
    const sources = new Set(slice.filter(tool => tool.name === 'llmwiki_read_source' && tool.resultSeq !== undefined).map(tool => tool.id))
    if (required.pageIds.some(id => !pages.has(id)) || sourceIds.some(id => !sources.has(id))) fail(code)
  }
  requireReads(tools.slice(0, add), [required.sourceAId], 'ASSERT_DISCOVERY_BEFORE_MAINTENANCE')
  const addResultSeq = tools[add]!.resultSeq
  const firstUpdate = indexAfter(tools, 'llmwiki_upsert_page', add)
  const firstUpdateSeq = tools[firstUpdate]?.seq
  if (addResultSeq === undefined || firstUpdateSeq === undefined || addResultSeq >= firstUpdateSeq) fail('ASSERT_MAINTENANCE_TRACE_ORDER')
  const candidateRead = tools.findIndex((tool, index) => index > add && index < firstUpdate
    && tool.name === 'llmwiki_read_source' && tool.id === required.sourceBId
    && tool.seq > addResultSeq && tool.resultSeq !== undefined && tool.resultSeq < firstUpdateSeq)
  if (candidateRead < 0) fail('ASSERT_MAINTENANCE_TRACE_ORDER')
  const firstLint = indexAfter(tools, 'llmwiki_lint', firstUpdate)
  if (firstLint < 0) fail('ASSERT_STRUCTURAL_LINT')
  const firstLintResultSeq = tools[firstLint]!.resultSeq
  const finalLintIndex = tools.reduce((last, tool, index) => tool.name === 'llmwiki_lint' ? index : last, -1)
  const lastUpdateIndex = tools.reduce((last, tool, index) => tool.name === 'llmwiki_upsert_page' ? index : last, -1)
  if (firstLintResultSeq === undefined || finalLintIndex <= firstLint || finalLintIndex <= lastUpdateIndex) fail('ASSERT_FINAL_LINT_ORDER')
  const finalLint = tools[finalLintIndex]!
  if (finalLintIndex !== tools.length - 1 || finalLint.resultSeq === undefined) fail('ASSERT_FINAL_LINT_ORDER')
  const semantic = tools.slice(firstLint + 1, finalLintIndex)
  if (semantic.length === 0
    || semantic.some(tool => tool.seq <= firstLintResultSeq || tool.resultSeq === undefined || tool.resultSeq >= finalLint.seq)) {
    fail('ASSERT_SEMANTIC_REVIEW_TRACE')
  }
  if (!semantic.some(tool => tool.name === 'llmwiki_list_pages') || !semantic.some(tool => tool.name === 'llmwiki_list_sources')) fail('ASSERT_SEMANTIC_REVIEW_TRACE')
  requireReads(semantic, [required.sourceAId, required.sourceBId], 'ASSERT_SEMANTIC_REVIEW_TRACE')
  const mutationAndSemanticResults = [...tools.filter(tool => tool.name === 'llmwiki_add_source' || tool.name === 'llmwiki_upsert_page'), ...semantic]
  if (mutationAndSemanticResults.some(tool => tool.resultSeq === undefined || tool.resultSeq >= finalLint.resultSeq!)) fail('ASSERT_FINAL_LINT_ORDER')
  const response = trace.finalAssistantText
  const responseSeq = trace.finalAssistantSeq
  const lastSemanticResultSeq = Math.max(finalLint.resultSeq, ...semantic.map(tool => tool.resultSeq!))
  if (response === undefined || responseSeq === undefined || responseSeq <= lastSemanticResultSeq
    || !/(?:semantic review|reviewed semantically|semantic check)/iu.test(response)
    || !/(?:contradiction|contradictory|supersed(?:e|ed|es|ing))/iu.test(response)
    || required.pageIds.some(id => !response.includes(id))
    || [required.sourceAId, required.sourceBId].some(id => !response.includes(id))) fail('ASSERT_SEMANTIC_REVIEW_TRACE')
  const result = tools[finalLintIndex]?.result
  if (typeof result !== 'object' || result === null) fail('ASSERT_STRUCTURAL_LINT')
  const lint = result as Record<string, unknown>
  if (typeof lint.errorCount !== 'number' || !Number.isSafeInteger(lint.errorCount) || typeof lint.warningCount !== 'number'
    || !Number.isSafeInteger(lint.warningCount) || lint.errorCount !== 0 || lint.warningCount !== 0) fail('ASSERT_STRUCTURAL_LINT')
  return { errorCount: lint.errorCount, warningCount: lint.warningCount }
}
export function requireFreshSessionRecovery(trace: SessionTrace, expected: { endpoint: string; sourceIds: readonly string[] }): void {
  let cursor = -1
  const requiredTools: ToolEvent[] = []
  for (const name of ['llmwiki_list_pages', 'llmwiki_list_sources', 'llmwiki_search']) {
    cursor = indexAfter(trace.tools, name, cursor)
    if (cursor < 0) fail('ASSERT_FRESH_SESSION_RECOVERY_TRACE')
    requiredTools.push(trace.tools[cursor]!)
  }
  const recoveryReads = trace.tools.slice(cursor + 1)
  const requiredRead = (name: string, id: string): ToolEvent | undefined => recoveryReads.find(tool => tool.name === name && tool.id === id)
  for (const id of ['project-aurora', 'operations-runbook']) {
    const tool = requiredRead('llmwiki_read_page', id)
    if (tool === undefined) fail('ASSERT_FRESH_SESSION_RECOVERY_TRACE')
    requiredTools.push(tool)
  }
  for (const id of expected.sourceIds) {
    const tool = requiredRead('llmwiki_read_source', id)
    if (tool === undefined) fail('ASSERT_FRESH_SESSION_RECOVERY_TRACE')
    requiredTools.push(tool)
  }
  if (requiredTools.some(tool => tool.resultSeq === undefined)) fail('ASSERT_FRESH_SESSION_RECOVERY_TRACE')
  if (trace.tools.some(tool => tool.name === 'llmwiki_add_source' || tool.name === 'llmwiki_upsert_page')) fail('ASSERT_FRESH_SESSION_MUTATED')
  const response = trace.finalAssistantText
  const responseSeq = trace.finalAssistantSeq
  const lastRequiredResultSeq = requiredTools.reduce((last, tool) => Math.max(last, tool.resultSeq!), -1)
  const endpointPattern = new RegExp(`(?:current[^.\\n]{0,120}endpoint[^.\\n]{0,40}\\b${expected.endpoint}\\b|\\b${expected.endpoint}\\b[^.\\n]{0,120}current[^.\\n]{0,40}endpoint)`, 'iu')
  if (response === undefined || responseSeq === undefined || responseSeq <= lastRequiredResultSeq || !endpointPattern.test(response)
    || expected.sourceIds.some(id => !response.includes(id))) fail('ASSERT_FRESH_SESSION_RESPONSE')
}
function withoutFencedCode(markdown: string): string {
  const prose: string[] = []
  let fence: { marker: '`' | '~'; length: number } | undefined
  for (const line of markdown.split(/\r?\n/u)) {
    if (fence === undefined) {
      const opener = /^ {0,3}(`{3,}|~{3,})(.*)$/u.exec(line)
      if (opener === null || (opener[1]!.startsWith('`') && opener[2]!.includes('`'))) {
        prose.push(line)
      } else {
        fence = { marker: opener[1]![0] as '`' | '~', length: opener[1]!.length }
      }
      continue
    }
    const closer = /^ {0,3}(`+|~+)[ \t]*$/u.exec(line)
    if (closer !== null && closer[1]!.startsWith(fence.marker) && closer[1]!.length >= fence.length) fence = undefined
  }
  return prose.join('\n')
}

function withoutInlineCode(markdown: string): string {
  let prose = ''
  for (let cursor = 0; cursor < markdown.length;) {
    if (markdown[cursor] !== '`') {
      prose += markdown[cursor++]
      continue
    }
    let openerEnd = cursor + 1
    while (markdown[openerEnd] === '`') openerEnd++
    const delimiterLength = openerEnd - cursor
    let candidate = openerEnd
    let closerEnd = -1
    while (candidate < markdown.length) {
      if (markdown[candidate] !== '`') {
        candidate++
        continue
      }
      let runEnd = candidate + 1
      while (markdown[runEnd] === '`') runEnd++
      if (runEnd - candidate === delimiterLength) {
        closerEnd = runEnd
        break
      }
      candidate = runEnd
    }
    if (closerEnd < 0) {
      prose += markdown.slice(cursor, openerEnd)
      cursor = openerEnd
    } else {
      prose += ' '
      cursor = closerEnd
    }
  }
  return prose
}

function normalizedSentences(markdown: string): string[] {
  const prose = withoutInlineCode(withoutFencedCode(markdown)).replace(
    /^ {0,3}#{1,6}[ \t]+(.*?)(?:[ \t]+#+[ \t]*)?$/gmu,
    (_heading, text: string) => /[.!?]$/u.test(text) ? text : `${text}.`,
  )
  const normalized = prose.replace(/\s+/gu, ' ').trim()
  return normalized.match(/[^.!?]+(?:[.!?]+|$)/gu)?.map(sentence => sentence.trim()) ?? []
}

const CONTROLLED_FACT_PATTERN = /(?:\b(?:Harbor|Meridian|current|required|retired|superseded)\b|\b2026-01-15\b|\b2026-08-20\b|\bmust\s+not\s+(?:be\s+)?use(?:d)?\b)/iu

export function validateDurableSupersessionPages(
  pages: Readonly<Record<'project-aurora' | 'operations-runbook', string>>,
  expected: { sourceAId: string; sourceBId: string },
): void {
  for (const [id, reciprocal] of [['project-aurora', 'operations-runbook'], ['operations-runbook', 'project-aurora']] as const) {
    let parsed: ParsedPageMarkdown
    try {
      parsed = parsePageMarkdown(pages[id])
    } catch {
      fail('ASSERT_PAGE_CONCLUSION_UPDATED')
    }
    const sourceIds = parsed.metadata.sources
    if (sourceIds.length !== 2 || !sourceIds.includes(expected.sourceAId) || !sourceIds.includes(expected.sourceBId)) {
      fail('ASSERT_PAGE_EVIDENCE_MAINTAINED')
    }
    const sentences = normalizedSentences(parsed.body)
    const remainingSentences = [...sentences]
    for (const required of REQUIRED_SUPERSESSION_SENTENCES) {
      const index = remainingSentences.indexOf(required)
      if (index < 0) fail('ASSERT_PAGE_CONCLUSION_UPDATED')
      remainingSentences.splice(index, 1)
    }
    if (remainingSentences.some(sentence => CONTROLLED_FACT_PATTERN.test(sentence))) fail('ASSERT_PAGE_CONCLUSION_UPDATED')
    const prose = withoutInlineCode(withoutFencedCode(parsed.body))
    if (!new RegExp(`(?<!!)\\[[^\\]]+\\]\\(${reciprocal}\\)`, 'u').test(prose)) fail('ASSERT_RECIPROCAL_LINKS')
  }
}



async function durableTree(root: string): Promise<Record<string, string>> {
  const files: Record<string, string> = {}
  async function visit(path: string, relativePath: string): Promise<void> {
    const value = await lstat(path)
    if (value.isSymbolicLink()) fail('ASSERT_FRESH_SESSION_MUTATED')
    if (value.isDirectory()) {
      if (relativePath === '.index') return
      for (const entry of (await readdir(path)).sort(codeUnitCompare)) await visit(join(path, entry), relativePath === '' ? entry : `${relativePath}/${entry}`)
    } else if (value.isFile()) files[relativePath] = sha256(await readFile(path))
    else fail('ASSERT_FRESH_SESSION_MUTATED')
  }
  await visit(root, '')
  return files
}

async function inspectDurable(workspace: string, seeded: { sourceAId: string; sourceBId: string; sourceAMetadata: string }): Promise<{
  pageHashes: Record<string, string>
  sourceHashes: Record<string, string>
  sourceIds: string[]
}> {
  const wiki = join(workspace, '.llmwiki')
  if ((await readFile(join(wiki, 'schema.md'), 'utf8')) !== (await readFile(join(FIXTURE_ROOT, 'schema.md'), 'utf8'))) fail('ASSERT_SCHEMA_UNCHANGED')
  const sourceA = await readFile(join(FIXTURE_ROOT, 'source-a.txt'))
  const sourceB = await readFile(join(FIXTURE_ROOT, 'source-b.txt'))
  if (!(await readFile(join(wiki, 'sources', seeded.sourceAId, 'content'))).equals(sourceA)) fail('ASSERT_SOURCE_A_CHANGED')
  if ((await readFile(join(wiki, 'sources', seeded.sourceAId, 'metadata.json'), 'utf8')) !== seeded.sourceAMetadata) fail('ASSERT_SOURCE_A_CHANGED')
  if (!(await readFile(join(wiki, 'sources', seeded.sourceBId, 'content'))).equals(sourceB)) fail('ASSERT_SOURCE_B_DURABLE')
  const metadataB = JSON.parse(await readFile(join(wiki, 'sources', seeded.sourceBId, 'metadata.json'), 'utf8')) as Record<string, unknown>
  if (metadataB.id !== seeded.sourceBId || metadataB.byteCount !== sourceB.byteLength || metadataB.mediaType !== 'text/plain; charset=utf-8'
    || metadataB.name !== 'Project Aurora operations bulletin (2026-08-20)'
    || metadataB.origin !== 'agent-smoke/source-b' || typeof metadataB.capturedAt !== 'string') fail('ASSERT_SOURCE_B_METADATA')
  const project = await readFile(join(wiki, 'pages', 'project-aurora.md'), 'utf8')
  const runbook = await readFile(join(wiki, 'pages', 'operations-runbook.md'), 'utf8')
  validateDurableSupersessionPages({ 'project-aurora': project, 'operations-runbook': runbook }, seeded)
  return {
    pageHashes: { 'operations-runbook': sha256(runbook), 'project-aurora': sha256(project) },
    sourceHashes: { [seeded.sourceAId]: sha256(sourceA), [seeded.sourceBId]: sha256(sourceB) },
    sourceIds: [seeded.sourceAId, seeded.sourceBId],
  }
}

function validateEvidenceStrings(value: unknown, credential: string): void {
  if (typeof value === 'string') {
    if (/[\u0000-\u001f\u007f]/u.test(value)
      || value.includes(credential)
      || /\b(?:authorization|proxy-authorization|x-api-key|deepseek[_-]?api[_-]?key|api[_-]?key|access[_-]?token|client[_-]?secret|credential)\b(?:\s*[:=])?|\bbearer\s+/iu.test(value)
      || /(?:^|[\s"'=(])\/(?:[^/\s]+\/)*[^/\s]*/u.test(value)
      || /(?:^|[\s"'=(])(?:[A-Za-z]:[\\/]|\\\\)[^\s"']*/u.test(value)) fail('INVALID_EVIDENCE_PAYLOAD')
    return
  }
  if (Array.isArray(value)) {
    const entries: readonly unknown[] = value
    for (const entry of entries) validateEvidenceStrings(entry, credential)
    return
  }
  if (typeof value === 'object' && value !== null) {
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      validateEvidenceStrings(key, credential)
      validateEvidenceStrings(entry, credential)
    }
  }
}

async function validateEvidenceParent(path: string): Promise<void> {
  const parent = dirname(resolve(path))
  if (!isAbsolute(parent)) fail('INVALID_EVIDENCE_LOCATION')
  const canonical = await realpath(parent).catch(() => fail('INVALID_EVIDENCE_LOCATION'))
  if (canonical !== parent || relative(parent, path).split(sep).includes('..')) fail('INVALID_EVIDENCE_LOCATION')
  let cursor = parent
  while (true) {
    const value = await lstat(cursor).catch(() => fail('INVALID_EVIDENCE_LOCATION'))
    if (!value.isDirectory() || value.isSymbolicLink()) fail('INVALID_EVIDENCE_LOCATION')
    const next = dirname(cursor)
    if (next === cursor) break
    cursor = next
  }
}

interface EvidenceSnapshot { bytes: Buffer; mode: number }

async function captureEvidence(path: string): Promise<EvidenceSnapshot | undefined> {
  const metadata = await lstat(path).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  })
  if (metadata === undefined) return undefined
  if (!metadata.isFile() || metadata.isSymbolicLink()) fail('INVALID_EVIDENCE_LOCATION')
  return { bytes: await readFile(path), mode: metadata.mode & 0o777 }
}

async function restoreEvidence(path: string, previous: EvidenceSnapshot | undefined): Promise<void> {
  if (previous === undefined) {
    await rm(path, { force: true })
    return
  }
  const temporary = join(dirname(path), `.agent-smoke-restore-${randomUUID()}.tmp`)
  try {
    const handle = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, previous.mode)
    try {
      await handle.writeFile(previous.bytes)
      await handle.sync()
    } finally {
      await handle.close()
    }
    await rename(temporary, path)
    const parent = await open(dirname(path), constants.O_RDONLY)
    try { await parent.sync() } finally { await parent.close() }
  } finally {
    await rm(temporary, { force: true })
  }
}

function allowEvidencePublication(): void {
  // No termination controller was supplied, so publication may continue.
}

export interface EvidencePublicationOptions {
  throwIfTerminated?: () => void
  afterAtomicWrite?: () => void
}

export async function writeEvidence(
  path: string,
  value: unknown,
  credential: string,
  options: EvidencePublicationOptions = {},
): Promise<void> {
  const throwIfTerminated = options.throwIfTerminated ?? allowEvidencePublication
  throwIfTerminated()
  validateEvidenceStrings(value, credential)
  await validateEvidenceParent(path)
  const previous = await captureEvidence(path)
  const temporary = join(dirname(path), `.agent-smoke-${randomUUID()}.tmp`)
  let published = false
  try {
    const bytes = `${JSON.stringify(value, null, 2)}\n`
    const handle = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600)
    try {
      await handle.writeFile(bytes)
      await handle.sync()
    } finally {
      await handle.close()
    }
    await validateEvidenceParent(path)
    throwIfTerminated()
    await rename(temporary, path)
    published = true
    options.afterAtomicWrite?.()
    throwIfTerminated()
    const parent = await open(dirname(path), constants.O_RDONLY)
    try { await parent.sync() } finally { await parent.close() }
    throwIfTerminated()
  } catch (error) {
    if (published) await restoreEvidence(path, previous)
    throw error
  } finally {
    await rm(temporary, { force: true })
  }
}
export interface EvidenceFinalizationOptions {
  evidencePath: string
  evidence: unknown
  credential: string
  successMessage: string
  termination: Pick<TerminationController, 'throwIfObserved'>
  publish?: typeof writeEvidence
  afterPublication?: () => void
  output?: (message: string) => void
}

export async function publishEvidenceAndReport(options: EvidenceFinalizationOptions): Promise<void> {
  const publish = options.publish ?? writeEvidence
  const previous = await captureEvidence(options.evidencePath)
  let published = false
  options.termination.throwIfObserved()
  try {
    await publish(options.evidencePath, options.evidence, options.credential, {
      throwIfTerminated: options.termination.throwIfObserved,
    })
    published = true
    options.afterPublication?.()
    options.termination.throwIfObserved()
    ;(options.output ?? console.log)(options.successMessage)
  } catch (error) {
    if (published) await restoreEvidence(options.evidencePath, previous)
    throw error
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2).filter(argument => argument !== '--')
  validateSupportedNodeVersion(process.versions.node)
  const preflight = args.includes('--preflight')
  if (args.some(argument => argument !== '--preflight') || args.length > 1) fail('INVALID_SMOKE_CONFIGURATION')
  const { model, apiKey, evidencePath } = exactEnvironment()
  const { packageVersion } = await validateLocalContract(evidencePath)
  let temporary: string | undefined
  let pendingEvidence: unknown
  let successMessage: string | undefined
  try {
    temporary = await mkdtemp(join(tmpdir(), 'dsh-llmwiki-agent-smoke-'))
    const packRoot = join(temporary, 'pack')
    const sourceRoot = join(temporary, 'source')
    const workspace = join(temporary, 'workspace')
    const runnerRoot = join(temporary, 'runner')
    const dshHome = join(temporary, 'dsh-home')
    const env = setupEnvironment(temporary, dshHome)
    for (const path of [packRoot, sourceRoot, workspace, runnerRoot, dshHome, env.HOME!, env.XDG_CACHE_HOME!, env.XDG_CONFIG_HOME!, env.XDG_DATA_HOME!, env.XDG_STATE_HOME!, env.PNPM_HOME!, env.PNPM_STORE_DIR!]) await mkdir(path, { recursive: true })
    await writeFile(env.npm_config_userconfig!, '')
    await writeFile(join(dshHome, 'settings.yaml'), `agent-default-model:\n  provider: ${PROVIDER}\n  model: ${JSON.stringify(model)}\nllm-pi-ai:\n  providers:\n    deepseek:\n      apiKeyEnv: DEEPSEEK_API_KEY\n`)
    const packed = await packPlugin(packRoot, sourceRoot, env)
    const seeded = await seedWiki(workspace)
    await cp(RUNNER_FIXTURE_ROOT, runnerRoot, { recursive: true })
    const runnerManifestBytes = await readFile(join(runnerRoot, 'package.json'))
    const runnerManifest = JSON.parse(runnerManifestBytes.toString('utf8')) as { dependencies?: Record<string, string> }
    if (runnerManifest.dependencies === undefined) fail('INVALID_RUNNER_FIXTURE')
    const requestedPackages = Object.fromEntries(packageOrder(Object.entries(runnerManifest.dependencies)))
    const runnerLock = await readFile(join(runnerRoot, 'pnpm-lock.yaml'), 'utf8')
    if (sha256(runnerLock) !== RUNNER_LOCK_SHA256) fail('INVALID_RUNNER_FIXTURE')
    const approvedPackages = approvedRuntimePackages(runnerLock)
    await runPnpm(['install', '--frozen-lockfile', '--ignore-scripts'], { cwd: runnerRoot, env })
    const resolvedPackages = await installedRuntimePackages(runnerRoot)
    if (JSON.stringify(resolvedPackages) !== JSON.stringify(approvedPackages)) fail('INVALID_AGENT_RUNTIME_VERSION')
    const dsh = join(runnerRoot, 'node_modules', '.bin', 'dsh')
    await run(dsh, ['plugin', '--profile', 'headless', 'add', '--ignore-scripts', packed.tarball], { cwd: workspace, env, timeoutMs: SETUP_TIMEOUT_MS })
    await writeFile(join(dshHome, 'profiles', 'headless', 'cordis.patch.yml'), `- id: session-persistence-jsonl\n  config:\n    root: !!js dshHomePath('sessions')\n    compression: none\n    packChunks: false\n- id: session-title-llm\n  disabled: true\n`)
    const config = await run(dsh, ['--profile', 'headless', '--dump-config'], { cwd: workspace, env, timeoutMs: SETUP_TIMEOUT_MS })
    if (!config.includes('@evegoodevening/dsh-llmwiki') || !config.includes('root: .llmwiki')
      || !config.includes('compression: none') || !config.includes('packChunks: false')
      || !/id: session-title-llm[\s\S]*?disabled: true/u.test(config)) fail('INVALID_DISPOSABLE_PROFILE')
    if (preflight) {
      successMessage = 'PREFLIGHT_OK'
    } else {
      const modelEnv = { ...env, DEEPSEEK_API_KEY: apiKey }
      const startedAt = new Date().toISOString()
      const beforeFirst = await sessionDirectories(join(dshHome, 'sessions'))
      const sourceB = await readFile(join(FIXTURE_ROOT, 'source-b.txt'), 'utf8')
      const instructions = await readFile(join(FIXTURE_ROOT, 'instructions.txt'), 'utf8')
      await run(dsh, ['--profile', 'headless', `${instructions}\n\nNewer bulletin to ingest verbatim:\n${sourceB}`], { cwd: workspace, env: modelEnv, timeoutMs: MODEL_TIMEOUT_MS })
      const firstTrace = await readNewSessionTrace(join(dshHome, 'sessions'), beforeFirst, { provider: PROVIDER, model })
      const required = { pageIds: ['project-aurora', 'operations-runbook'], sourceAId: seeded.sourceAId, sourceBId: seeded.sourceBId }
      const lint = requireMaintenanceOrder(firstTrace, required)
      const durable = await inspectDurable(workspace, seeded)
      const durableTreeBeforeRecovery = await durableTree(join(workspace, '.llmwiki'))
      const beforeSecond = await sessionDirectories(join(dshHome, 'sessions'))
      await run(dsh, ['--profile', 'headless', 'In this fresh session, recover the existing wiki through catalogs, search, and reads. Report the current Project Aurora production synchronization endpoint and cite both durable source IDs. Do not modify the wiki.'], { cwd: workspace, env: modelEnv, timeoutMs: MODEL_TIMEOUT_MS })
      const secondTrace = await readNewSessionTrace(join(dshHome, 'sessions'), beforeSecond, { provider: PROVIDER, model })
      requireFreshSessionRecovery(secondTrace, { endpoint: 'Meridian', sourceIds: [seeded.sourceAId, seeded.sourceBId] })
      const afterRecovery = await inspectDurable(workspace, seeded)
      if (JSON.stringify(afterRecovery) !== JSON.stringify(durable)
        || JSON.stringify(await durableTree(join(workspace, '.llmwiki'))) !== JSON.stringify(durableTreeBeforeRecovery)) fail('ASSERT_FRESH_SESSION_MUTATED')
      const assertions = ['real-agent-turn', 'discovery-before-maintenance', 'candidate-read-after-add', 'source-bytes-and-metadata', 'dated-supersession-preserved', 'reciprocal-links-maintained', 'semantic-review-trace', 'final-structural-lint-clean', 'schema-unchanged', 'fresh-session-recovery'].map(id => ({ id, result: 'pass' as const }))
      const toolsObserved = [...new Set([...firstTrace.tools, ...secondTrace.tools].map(tool => tool.name))].sort()
      pendingEvidence = {
        schemaVersion: 1, provider: firstTrace.provider, model: firstTrace.model, startedAt, completedAt: new Date().toISOString(),
        package: { version: packageVersion, tarballSha256: packed.hash },
        runtime: { requested: requestedPackages, lockSha256: RUNNER_LOCK_SHA256, packages: resolvedPackages }, scenarioId: SCENARIO_ID, assertions, toolsObserved,
        traceCoverage: { discovery: { pageIds: required.pageIds, sourceIds: [required.sourceAId] }, semanticReview: { pageIds: required.pageIds, sourceIds: [required.sourceAId, required.sourceBId] } },
        durable: { sourceIds: durable.sourceIds, sourceSha256: durable.sourceHashes, pageIds: Object.keys(durable.pageHashes), pageSha256: durable.pageHashes },
        structuralLint: lint, result: 'pass',
      }
      successMessage = 'AGENT_SMOKE_OK'
    }
  } finally {
    terminateActiveChildren()
    if (temporary !== undefined) await rm(temporary, { recursive: true, force: true })
  }
  termination.throwIfObserved()
  if (pendingEvidence !== undefined && successMessage !== undefined) {
    await publishEvidenceAndReport({ evidencePath, evidence: pendingEvidence, credential: apiKey, successMessage, termination })
  } else {
    termination.throwIfObserved()
    if (successMessage !== undefined) console.log(successMessage)
  }
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) process.once(signal, () => termination.observe(signal))
  try {
    await main()
  } catch (error) {
    console.error(termination.signal !== undefined ? 'TERMINATED' : error instanceof SafeFailure ? error.code : 'AGENT_SMOKE_FAILED')
    process.exitCode = 1
  }
}

