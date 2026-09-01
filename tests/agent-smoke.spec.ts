import { spawnSync, type SpawnSyncReturns } from 'node:child_process'
import { cp, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createTerminationController, CURRENT_MERIDIAN_SENTENCE, HISTORICAL_HARBOR_SENTENCE, publishEvidenceAndReport, readNewSessionTrace, requireFreshSessionRecovery, requireMaintenanceOrder, RETIRED_HARBOR_SENTENCE, validateDurableSupersessionPages, validateModelIdentifier, validateSupportedNodeVersion, writeEvidence, type SessionTrace } from '../scripts/agent-smoke.ts'

const repositoryRoot = resolve(import.meta.dirname, '..')
const evidencePath = resolve(repositoryRoot, 'tests/fixtures/agent-smoke/latest.json')

async function optionalEvidence(): Promise<Buffer | undefined> {
  return await readFile(evidencePath).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  })
}

function ignoreTerminationEffect(): void {
  // These tests exercise evidence handling without external process side effects.
}

function invokePreflight(env: NodeJS.ProcessEnv): SpawnSyncReturns<string> {
  return spawnSync(process.execPath, ['--import', 'tsx', 'scripts/agent-smoke.ts', '--preflight'], {
    cwd: repositoryRoot,
    env: { PATH: process.env.PATH, ...env },
    encoding: 'utf8',
    timeout: 10_000,
  })
}

const sourceAId = 'a'.repeat(64)
const sourceBId = 'b'.repeat(64)
const requiredReads = { pageIds: ['project-aurora', 'operations-runbook'], sourceAId, sourceBId }

async function pinnedTrace(): Promise<{ root: string; trace: SessionTrace }> {
  const root = await mkdtemp(join(tmpdir(), 'agent-smoke-trace-'))
  await cp(resolve(repositoryRoot, 'tests/fixtures/agent-smoke/session-pinned'), join(root, 'session'), { recursive: true })
  return { root, trace: await readNewSessionTrace(root, new Set()) }
}
async function pinnedRecoveryTrace(name: string): Promise<{ root: string; trace: SessionTrace }> {
  const root = await mkdtemp(join(tmpdir(), 'agent-smoke-recovery-trace-'))
  await cp(resolve(repositoryRoot, `tests/fixtures/agent-smoke/${name}`), join(root, 'session'), { recursive: true })
  return { root, trace: await readNewSessionTrace(root, new Set()) }
}

function supersessionPage(title: string, reciprocal: string, body: string): string {
  return `---\ntitle: ${JSON.stringify(title)}\nsummary: "Project Aurora endpoint transition."\nsources:\n  - "${sourceAId}"\n  - "${sourceBId}"\n---\n\n# ${title}\n\n${body}\n\nSee [related page](${reciprocal}).\n`
}

function validSupersessionPages(): Record<'project-aurora' | 'operations-runbook', string> {
  const transition = `${HISTORICAL_HARBOR_SENTENCE}\n\n${CURRENT_MERIDIAN_SENTENCE}\n\n${RETIRED_HARBOR_SENTENCE}`
  return {
    'project-aurora': supersessionPage('Project Aurora', 'operations-runbook', transition),
    'operations-runbook': supersessionPage('Operations Runbook', 'project-aurora', transition),
  }
}


describe('agent smoke runtime safety', () => {
  it('accepts only the full supported Node version ranges', () => {
    for (const version of ['22.19.0', '22.19.7', '22.99.0', '24.0.0', '25.3.1', '26.0.0-nightly']) {
      expect(() => validateSupportedNodeVersion(version)).not.toThrow()
    }
    for (const version of ['22.18.9', '22.0.0', '23.0.0', '21.99.0', 'v22.19.0', '24', 'not-a-version']) {
      expect(() => validateSupportedNodeVersion(version)).toThrow('INVALID_LOCAL_ENVIRONMENT')
    }
  })

  it('records nonzero exit intent and terminates children immediately when termination is observed', () => {
    const effects: string[] = []
    const controller = createTerminationController(
      () => effects.push('children-killed'),
      () => effects.push('exit-nonzero'),
    )
    controller.observe('SIGTERM')
    expect(controller.signal).toBe('SIGTERM')
    expect(effects).toEqual(['exit-nonzero', 'children-killed'])
    expect(() => controller.throwIfObserved()).toThrow('TERMINATED')
  })

  it('preserves prior evidence when termination is observed before publication', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agent-smoke-pre-publication-'))
    const path = join(root, 'latest.json')
    const original = '{"result":"previous"}\n'
    await writeFile(path, original)
    const controller = createTerminationController(ignoreTerminationEffect, ignoreTerminationEffect)
    controller.observe('SIGINT')
    try {
      await expect(publishEvidenceAndReport({
        evidencePath: path,
        evidence: { result: 'pass' },
        credential: 'secret',
        successMessage: 'AGENT_SMOKE_OK',
        termination: controller,
        output: () => { throw new Error('success output must not run') },
      })).rejects.toThrow('TERMINATED')
      expect(await readFile(path, 'utf8')).toBe(original)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('removes newly published evidence and suppresses success when termination follows atomic publication', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agent-smoke-post-publication-'))
    const path = join(root, 'latest.json')
    const output: string[] = []
    const controller = createTerminationController(ignoreTerminationEffect, ignoreTerminationEffect)
    try {
      await expect(publishEvidenceAndReport({
        evidencePath: path,
        evidence: { result: 'pass' },
        credential: 'secret',
        successMessage: 'AGENT_SMOKE_OK',
        termination: controller,
        afterPublication: () => controller.observe('SIGHUP'),
        output: message => output.push(message),
      })).rejects.toThrow('TERMINATED')
      await expect(stat(path)).rejects.toMatchObject({ code: 'ENOENT' })
      expect(output).toEqual([])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('removes evidence when termination lands immediately after the atomic rename', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agent-smoke-atomic-boundary-'))
    const path = join(root, 'latest.json')
    const controller = createTerminationController(ignoreTerminationEffect, ignoreTerminationEffect)
    try {
      await expect(writeEvidence(path, { result: 'pass' }, 'secret', {
        throwIfTerminated: () => controller.throwIfObserved(),
        afterAtomicWrite: () => controller.observe('SIGTERM'),
      })).rejects.toThrow('TERMINATED')
      await expect(stat(path)).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
  it('restores prior evidence when termination follows replacement publication', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agent-smoke-restore-publication-'))
    const path = join(root, 'latest.json')
    const original = '{"result":"previous"}\n'
    await writeFile(path, original, { mode: 0o640 })
    const controller = createTerminationController(ignoreTerminationEffect, ignoreTerminationEffect)
    try {
      await expect(publishEvidenceAndReport({
        evidencePath: path,
        evidence: { result: 'pass' },
        credential: 'secret',
        successMessage: 'AGENT_SMOKE_OK',
        termination: controller,
        afterPublication: () => controller.observe('SIGTERM'),
      })).rejects.toThrow('TERMINATED')
      expect(await readFile(path, 'utf8')).toBe(original)
      expect((await stat(path)).mode & 0o777).toBe(0o640)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

})

describe('opt-in real-agent smoke routing', () => {
  it('classifies a missing credential before package, profile, network, or evidence effects', async () => {
    const before = await optionalEvidence()
    const result = invokePreflight({
      LLMWIKI_AGENT_SMOKE_MODEL: 'contract-test-model',
      LLMWIKI_AGENT_SMOKE_EVIDENCE: evidencePath,
    })
    expect(result.status).not.toBe(0)
    expect(result.signal).toBeNull()
    expect(result.stderr.trim()).toBe('BLOCKED_MISSING_CREDENTIAL')
    expect(result.stdout).toBe('')
    expect(await optionalEvidence()).toEqual(before)
  })

  it('requires explicit network opt-in before creating disposable state', async () => {
    const before = await optionalEvidence()
    const result = invokePreflight({
      DEEPSEEK_API_KEY: 'not-forwarded-to-setup',
      LLMWIKI_AGENT_SMOKE_MODEL: 'contract-test-model',
      LLMWIKI_AGENT_SMOKE_EVIDENCE: evidencePath,
    })
    expect(result.status).not.toBe(0)
    expect(result.stderr.trim()).toBe('BLOCKED_NETWORK_NOT_OPTED_IN')
    expect(result.stdout).toBe('')
    expect(await optionalEvidence()).toEqual(before)
  })

  it('rejects an empty model distinctly and retains no default or provider fallback', () => {
    const result = invokePreflight({
      DEEPSEEK_API_KEY: 'not-used-because-model-is-invalid',
      LLMWIKI_AGENT_SMOKE_NETWORK: 'allow',
      LLMWIKI_AGENT_SMOKE_MODEL: '   ',
    })
    expect(result.status).not.toBe(0)
    expect(result.stderr.trim()).toBe('INVALID_SMOKE_CONFIGURATION')
  })

  it('keeps every ordinary gate independent from smoke:agent', async () => {
    const manifest = JSON.parse(await readFile(resolve(repositoryRoot, 'package.json'), 'utf8')) as {
      scripts: Record<string, string>
      devDependencies: Record<string, string>
    }
    expect(manifest.scripts['smoke:agent']).toBe('tsx scripts/agent-smoke.ts')
    expect(manifest.scripts['test:agent-smoke-preflight']).toBe('vitest run --config vitest.agent-smoke.config.ts')
    expect(manifest.devDependencies['@deepseek-ai/dsh-agent']).toBe('0.1.1-rc.2')
    for (const name of ['build', 'clean', 'prepack', 'typecheck', 'lint', 'test', 'test:coverage', 'test:e2e', 'check:determinism', 'smoke']) {
      expect(manifest.scripts[name]).not.toContain('smoke:agent')
      expect(manifest.scripts[name]).not.toContain('agent-smoke')
    }
    const ordinaryConfig = await readFile(resolve(repositoryRoot, 'vitest.config.ts'), 'utf8')
    expect(ordinaryConfig).toContain("'tests/agent-smoke.spec.ts'")
    expect((await stat(resolve(repositoryRoot, 'scripts/agent-smoke.ts'))).isFile()).toBe(true)
  })

  it('parses one completed pinned turn, safe phase IDs, and final lint counts', async () => {
    const { root, trace } = await pinnedTrace()
    try {
      expect(trace.turn).toBe(1)
      expect(requireMaintenanceOrder(trace, requiredReads)).toEqual({ errorCount: 0, warningCount: 0 })
      expect(trace.tools.every(tool => tool.turn === 1 && tool.step === 1)).toBe(true)
      expect(trace.tools.filter(tool => tool.name === 'llmwiki_read_page').map(tool => tool.id)).toContain('operations-runbook')
      expect(trace.tools.filter(tool => tool.name === 'llmwiki_read_source').map(tool => tool.id)).toContain(sourceBId)
      expect(trace.tools.at(-1)?.result).toEqual({ errorCount: 0, warningCount: 0 })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('rejects wrong persisted assistant and request-header routes offline', async () => {
    const fixture = await readFile(resolve(repositoryRoot, 'tests/fixtures/agent-smoke/session-pinned/pinned-project/pinned-session/session.jsonl'), 'utf8')
    for (const mutate of [
      (value: string) => value.replace('"provider":"deepseek","model":"fixture"', '"provider":"other","model":"fixture"'),
      (value: string) => value.replace('"provider":"deepseek","model":"fixture"', '"provider":"deepseek","model":"wrong"'),
      (value: string) => value.replace(/("type":"assistant\/message"[^\n]+"provider":)"deepseek"/u, '$1"other"'),
      (value: string) => value.replace(/("type":"assistant\/message"[^\n]+"model":)"fixture"/u, '$1"wrong"'),
    ]) {
      const root = await mkdtemp(join(tmpdir(), 'agent-smoke-wrong-route-'))
      try {
        await mkdirSession(root, mutate(fixture))
        await expect(readNewSessionTrace(root, new Set(), { provider: 'deepseek', model: 'fixture' })).rejects.toThrow('INVALID_SESSION_TRACE')
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    }
  })

  it('requires rc.2 assistant source-event provenance shape', async () => {
    const fixture = await readFile(resolve(repositoryRoot, 'tests/fixtures/agent-smoke/session-pinned/pinned-project/pinned-session/session.jsonl'), 'utf8')
    for (const mutate of [
      (value: string) => value.split('\n').map(line => {
        if (!line.includes('"type":"assistant/message"')) return line
        const event = JSON.parse(line) as Record<string, unknown>
        delete event.sourceEventSeqs
        return JSON.stringify(event)
      }).join('\n'),
      (value: string) => value.replace('"sourceEventSeqs":[]', '"sourceEventSeqs":[999]'),
    ]) {
      const root = await mkdtemp(join(tmpdir(), 'agent-smoke-assistant-provenance-'))
      try {
        await mkdirSession(root, mutate(fixture))
        await expect(readNewSessionTrace(root, new Set())).rejects.toThrow('INVALID_SESSION_TRACE')
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    }
  })

  it('accepts validated rc.2 raw assistant chunks and explicit ignorable envelopes without retaining them', async () => {
    const fixture = await readFile(resolve(repositoryRoot, 'tests/fixtures/agent-smoke/session-pinned/pinned-project/pinned-session/session.jsonl'), 'utf8')
    const records = fixture.trimEnd().split('\n').map(line => JSON.parse(line) as Record<string, unknown>)
    const insertAt = records.findIndex(record => record.type === 'assistant/message')
    records.splice(insertAt, 0,
      { seq: 0, time: 0, type: 'assistant/chunk', data: { turn: 1, step: 1, chunk: { type: 'text-delta', index: 0, text: 'secret raw content' } } },
      { seq: 0, time: 0, type: 'provider/telemetry', data: { turn: 1, step: 1 }, ignorable: true },
    )
    for (const [index, record] of records.slice(1).entries()) {
      record.seq = index
      record.time = 1788220800000 + index
    }
    const root = await mkdtemp(join(tmpdir(), 'agent-smoke-raw-events-'))
    try {
      await mkdirSession(root, `${records.map(record => JSON.stringify(record)).join('\n')}\n`)
      const trace = await readNewSessionTrace(root, new Set())
      expect(trace.finalAssistantText).not.toContain('secret raw content')
      records[insertAt] = { ...records[insertAt], data: { turn: 1, step: 1, chunk: { type: 'unknown' } } }
      const invalidRoot = await mkdtemp(join(tmpdir(), 'agent-smoke-invalid-raw-event-'))
      try {
        await mkdirSession(invalidRoot, `${records.map(record => JSON.stringify(record)).join('\n')}\n`)
        await expect(readNewSessionTrace(invalidRoot, new Set())).rejects.toThrow('INVALID_SESSION_TRACE')
      } finally {
        await rm(invalidRoot, { recursive: true, force: true })
      }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('requires positive monotonic turn and step identifiers', async () => {
    const fixture = await readFile(resolve(repositoryRoot, 'tests/fixtures/agent-smoke/session-pinned/pinned-project/pinned-session/session.jsonl'), 'utf8')
    for (const mutated of [
      fixture.replaceAll('"turn":1', '"turn":0'),
      fixture.replaceAll('"step":1', '"step":0'),
    ]) {
      const root = await mkdtemp(join(tmpdir(), 'agent-smoke-nonpositive-phase-'))
      try {
        await mkdirSession(root, mutated)
        await expect(readNewSessionTrace(root, new Set())).rejects.toThrow('INVALID_SESSION_TRACE')
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    }
  })

  it('rejects cross-correlation, cross-phase, failed, and incomplete traces', async () => {
    const fixture = await readFile(resolve(repositoryRoot, 'tests/fixtures/agent-smoke/session-pinned/pinned-project/pinned-session/session.jsonl'), 'utf8')
    for (const mutate of [
      (value: string) => value.replace('"version":0', '"version":1'),
      (value: string) => value.replace('"toolCallId":"call-1"', '"toolCallId":"wrong"'),
      (value: string) => `${value}${value.split('\n')[3]}\n`,
      (value: string) => value.replace('"isError":false', '"isError":true'),
      (value: string) => value.replace('"type":"tool/result","data":{"turn":1,"step":1', '"type":"tool/result","data":{"turn":2,"step":1'),
      (value: string) => value.replace('"type":"tool/result","data":{"turn":1,"step":1', '"type":"tool/result","data":{"turn":1,"step":2'),
      (value: string) => value.replace('"reason":{"kind":"completed"}', '"reason":{"kind":"aborted","reason":{"kind":"user"}}'),
      (value: string) => value.replace('"callId":"call-1"', '"callId":""'),
      (value: string) => value.replace('"name":"llmwiki_status"', '"name":""'),
      (value: string) => value.replace('"type":"tool/call"', '"type":"tool/unexpected"'),
      (value: string) => value.replace('"type":"step/start"', '"type":"step/unexpected"'),
      (value: string) => value.replace('"type":"session/title"', '"type":"session/unknown"'),
      (value: string) => value.replace('"type":"session/title"', '"type":"error"'),
      (value: string) => value.replace(`${value.split('\n').find(line => line.includes('"type":"turn/end"'))}\n`, ''),
      (value: string) => value.replace(`${value.split('\n').find(line => line.includes('"type":"step/end"'))}\n`, ''),
    ]) {
      const root = await mkdtemp(join(tmpdir(), 'agent-smoke-invalid-trace-'))
      try {
        await mkdirSession(root, mutate(fixture))
        await expect(readNewSessionTrace(root, new Set())).rejects.toThrow('INVALID_SESSION_TRACE')
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    }
  })

  it('rejects invalid tool result surface IDs and source event correlations offline', async () => {
    const fixture = await readFile(resolve(repositoryRoot, 'tests/fixtures/agent-smoke/session-pinned/pinned-project/pinned-session/session.jsonl'), 'utf8')
    const mutateFirstResult = (
      value: string,
      mutate: (event: Record<string, unknown>, message: Record<string, unknown>) => void,
    ): string => {
      const records = value.trimEnd().split('\n').map(line => JSON.parse(line) as Record<string, unknown>)
      const event = records.find(record => record.type === 'tool/result')
      if (event === undefined) throw new Error('missing fixture tool result')
      const data = event.data as Record<string, unknown>
      const message = data.message as Record<string, unknown>
      mutate(event, message)
      return `${records.map(record => JSON.stringify(record)).join('\n')}\n`
    }
    const mutations = [
      (value: string) => mutateFirstResult(value, (_event, message) => { delete message.id }),
      (value: string) => mutateFirstResult(value, (_event, message) => { message.id = '' }),
      (value: string) => mutateFirstResult(value, (_event, message) => { message.id = 1 }),
      (value: string) => mutateFirstResult(value, (_event, message) => { message.id = 'prompt-1' }),
      (value: string) => mutateFirstResult(value, event => { delete event.sourceEventSeqs }),
      (value: string) => mutateFirstResult(value, event => { event.sourceEventSeqs = [11] }),
      (value: string) => mutateFirstResult(value, event => { event.sourceEventSeqs = [10, 10] }),
    ]
    for (const mutate of mutations) {
      const root = await mkdtemp(join(tmpdir(), 'agent-smoke-invalid-result-surface-'))
      try {
        await mkdirSession(root, mutate(fixture))
        await expect(readNewSessionTrace(root, new Set())).rejects.toThrow('INVALID_SESSION_TRACE')
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    }
  })

  it('accepts only the exact deterministic headless events and their pinned payloads', async () => {
    const fixture = await readFile(resolve(repositoryRoot, 'tests/fixtures/agent-smoke/session-pinned/pinned-project/pinned-session/session.jsonl'), 'utf8')
    const events = fixture.trim().split('\n').slice(1).map(line => JSON.parse(line) as {
      seq: number
      time: number
      type: string
      data: Record<string, unknown>
    })
    expect(events.map(event => event.seq)).toEqual(events.map((_, index) => index))
    expect(events.every((event, index) => Number.isSafeInteger(event.time) && event.time >= (events[index - 1]?.time ?? 0))).toBe(true)
    expect(events.filter(event => ['permission/preset', 'sandbox/mode', 'approval/policy', 'agent/inbox/spliced', 'session/title'].includes(event.type)))
      .toEqual([
        expect.objectContaining({ type: 'permission/preset', data: { preset: 'workspace-write' } }),
        expect.objectContaining({ type: 'sandbox/mode', data: { mode: 'workspace-write' } }),
        expect.objectContaining({ type: 'approval/policy', data: { policy: 'ask' } }),
        expect.objectContaining({ type: 'agent/inbox/spliced', data: { target: 'next-turn', start: 0, inserted: [expect.objectContaining({ id: 'prompt-1', role: 'user', source: { kind: 'user' } })] } }),
        expect.objectContaining({ type: 'session/title', data: { title: 'Project Aurora maintenance', messageSeqs: [], source: { kind: 'user' } } }),
        expect.objectContaining({ type: 'agent/inbox/spliced', data: { target: 'next-turn', start: 0, removedCount: 1, inserted: [] } }),
      ])
    const root = await mkdtemp(join(tmpdir(), 'agent-smoke-known-event-trace-'))
    try {
      await mkdirSession(root, fixture)
      await expect(readNewSessionTrace(root, new Set())).resolves.toMatchObject({ turn: 1 })
      await mkdirSession(root, fixture.replace(',"delegationDepth":0', ''))
      await expect(readNewSessionTrace(root, new Set())).resolves.toMatchObject({ turn: 1 })
      const swapPhysicalLines = (value: string): string => {
        const lines = value.trimEnd().split('\n')
        ;[lines[2], lines[3]] = [lines[3]!, lines[2]!]
        return `${lines.join('\n')}\n`
      }
      const removeEvent = (value: string, type: string, occurrence = 0): string => {
        const records = value.trimEnd().split('\n').map(line => JSON.parse(line) as Record<string, unknown>)
        let seen = 0
        const kept = records.filter((record, index) => index === 0 || record.type !== type || seen++ !== occurrence)
        for (const [index, record] of kept.slice(1).entries()) {
          record.seq = index
          record.time = 1788220800000 + index
        }
        return `${kept.map(record => JSON.stringify(record)).join('\n')}\n`
      }
      for (const [index, mutate] of [
        (value: string) => removeEvent(value, 'agent/inbox/spliced'),
        (value: string) => removeEvent(value, 'agent/inbox/spliced', 1),
        (value: string) => value.replace('"inserted":[{"id":"prompt-1"', '"removedCount":0,"inserted":[{"id":"prompt-1"'),
        (value: string) => value.replace('"inserted":[{"id":"prompt-1","role":"user"', '"inserted":[{"id":"prompt-1","role":"assistant"'),
        (value: string) => value.replace('"source":{"kind":"user"},"content"', '"source":{"kind":"plugin"},"content"'),
        (value: string) => value.replace('"removedCount":1', '"removedCount":2'),
        (value: string) => removeEvent(value, 'user/message'),
        (value: string) => value.replace(',"surfaceOp":"append"}\n{"seq":8', '}\n{"seq":8'),
        (value: string) => value.split('\n').map(line => {
          if (!line.includes('"type":"user/message"')) return line
          const event = JSON.parse(line) as { data: unknown }
          event.data = { message: event.data }
          return JSON.stringify(event)
        }).join('\n'),
        (value: string) => value.replace('"target":"next-turn"', '"target":"next"'),
        (value: string) => value.replace('"preset":"workspace-write"', '"preset":""'),
        (value: string) => value.replace('"policy":"ask"', '"policy":"allow"'),
        (value: string) => value.replace('"mode":"workspace-write"', '"mode":"unconfined"'),
        (value: string) => value.replace('"seq":1,', '"seq":2,'),
        swapPhysicalLines,
        (value: string) => value.replace('"time":1788220800002', '"time":1788220800000'),
        (value: string) => value.replace('"messageSeqs":[],"source":{"kind":"user"}', '"messageSeqs":[],"source":{"kind":"automatic"}'),
        (value: string) => value.replace(/"time":\d+/u, '"time":-1'),
        (value: string) => value.replace(/"time":\d+/u, '"time":1.5'),
        (value: string) => value.replace('"delegationDepth":0', '"delegationDepth":-1'),
        (value: string) => value.replace('"delegationDepth":0', '"delegationDepth":1.5'),
        (value: string) => value.replace('"delegationDepth":0', '"delegationDepth":"0"'),
      ].entries()) {
        await mkdirSession(root, mutate(fixture))
        const accepted = await readNewSessionTrace(root, new Set()).then(() => true, () => false)
        expect(accepted, `mutation ${index}`).toBe(false)
      }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
  it('pins plaintext unpacked persistence and disables the auxiliary title model', async () => {
    const source = await readFile(resolve(repositoryRoot, 'scripts/agent-smoke.ts'), 'utf8')
    expect(source).toContain('compression: none')
    expect(source).toContain('packChunks: false')
    expect(source).toContain('- id: session-title-llm\\n  disabled: true')
  })
  it('accepts the exact normalized durable supersession contract', () => {
    const pages = validSupersessionPages()
    pages['project-aurora'] = pages['project-aurora'].replace('On 2026-08-20, Meridian', 'On\n  2026-08-20,   Meridian')
    expect(() => validateDurableSupersessionPages(pages, { sourceAId, sourceBId })).not.toThrow()
  })

  it('rejects reversed supersession dates', () => {
    const pages = validSupersessionPages()
    pages['project-aurora'] = pages['project-aurora']
      .replaceAll('2026-01-15', 'DATE_A')
      .replaceAll('2026-08-20', '2026-01-15')
      .replaceAll('DATE_A', '2026-08-20')
    expect(() => validateDurableSupersessionPages(pages, { sourceAId, sourceBId })).toThrow('ASSERT_PAGE_CONCLUSION_UPDATED')
  })

  it('rejects negations of required supersession facts', () => {
    for (const [fact, negation] of [
      [HISTORICAL_HARBOR_SENTENCE, 'On 2026-01-15, Harbor was not the current production synchronization endpoint for Project Aurora.'],
      [CURRENT_MERIDIAN_SENTENCE, 'On 2026-08-20, Meridian is not the required current production synchronization endpoint for Project Aurora.'],
      [RETIRED_HARBOR_SENTENCE, 'On 2026-08-20, Harbor is not retired and may be used for Project Aurora production synchronization.'],
    ] as const) {
      const pages = validSupersessionPages()
      pages['project-aurora'] = pages['project-aurora'].replace(fact, negation)
      expect(() => validateDurableSupersessionPages(pages, { sourceAId, sourceBId })).toThrow('ASSERT_PAGE_CONCLUSION_UPDATED')
    }
  })

  it('rejects a current-Harbor and retired-Harbor contradiction', () => {
    const pages = validSupersessionPages()
    pages['project-aurora'] = pages['project-aurora'].replace(RETIRED_HARBOR_SENTENCE,
      `${RETIRED_HARBOR_SENTENCE} On 2026-08-20, Harbor is the required current production synchronization endpoint for Project Aurora.`)
    expect(() => validateDurableSupersessionPages(pages, { sourceAId, sourceBId })).toThrow('ASSERT_PAGE_CONCLUSION_UPDATED')
  })

  it('rejects alternate wording that still describes Harbor as current', () => {
    const pages = validSupersessionPages()
    pages['project-aurora'] = pages['project-aurora'].replace(RETIRED_HARBOR_SENTENCE,
      `${RETIRED_HARBOR_SENTENCE} Harbor remains the production synchronization endpoint in current use.`)
    expect(() => validateDurableSupersessionPages(pages, { sourceAId, sourceBId })).toThrow('ASSERT_PAGE_CONCLUSION_UPDATED')
  })

  it('rejects controlled trailing fragments at true EOF without punctuation', () => {
    const pages = validSupersessionPages()
    pages['project-aurora'] = `${pages['project-aurora'].trimEnd()}\n\nHarbor remains current`
    expect(() => validateDurableSupersessionPages(pages, { sourceAId, sourceBId })).toThrow('ASSERT_PAGE_CONCLUSION_UPDATED')
  })

  it('allows harmless trailing prose at true EOF without punctuation', () => {
    const pages = validSupersessionPages()
    pages['project-aurora'] = `${pages['project-aurora'].trimEnd()}\n\nAdditional context appears elsewhere`
    expect(() => validateDurableSupersessionPages(pages, { sourceAId, sourceBId })).not.toThrow()
  })

  it('rejects a duplicate required supersession sentence', () => {
    const pages = validSupersessionPages()
    pages['project-aurora'] = `${pages['project-aurora'].trimEnd()}\n\n${CURRENT_MERIDIAN_SENTENCE}\n`
    expect(() => validateDurableSupersessionPages(pages, { sourceAId, sourceBId })).toThrow('ASSERT_PAGE_CONCLUSION_UPDATED')
  })

  it('rejects controlled contradictions in ATX headings', () => {
    const pages = validSupersessionPages()
    pages['project-aurora'] = `${pages['project-aurora'].trimEnd()}\n\n## Harbor remains current\n`
    expect(() => validateDurableSupersessionPages(pages, { sourceAId, sourceBId })).toThrow('ASSERT_PAGE_CONCLUSION_UPDATED')
  })

  it('allows benign endpoint prose but rejects contradictory extra endpoint sentences', () => {
    const benign = validSupersessionPages()
    benign['project-aurora'] = benign['project-aurora'].replace(RETIRED_HARBOR_SENTENCE,
      `${RETIRED_HARBOR_SENTENCE} The endpoint inventory is documented elsewhere.`)
    expect(() => validateDurableSupersessionPages(benign, { sourceAId, sourceBId })).not.toThrow()

    const contradictory = validSupersessionPages()
    contradictory['project-aurora'] = contradictory['project-aurora'].replace(RETIRED_HARBOR_SENTENCE,
      `${RETIRED_HARBOR_SENTENCE} The production synchronization endpoint is Harbor.`)
    expect(() => validateDurableSupersessionPages(contradictory, { sourceAId, sourceBId })).toThrow('ASSERT_PAGE_CONCLUSION_UPDATED')
  })

  it('rejects reciprocal links that exist only inside fenced code', () => {
    const pages = validSupersessionPages()
    pages['operations-runbook'] = pages['operations-runbook'].replace('See [related page](project-aurora).', '```markdown\nSee [related page](project-aurora).\n```')
    expect(() => validateDurableSupersessionPages(pages, { sourceAId, sourceBId })).toThrow('ASSERT_RECIPROCAL_LINKS')
  })

  it('recognizes longer matching closing fences', () => {
    const pages = validSupersessionPages()
    pages['operations-runbook'] = pages['operations-runbook'].replace('See [related page](project-aurora).',
      '```markdown\n[fenced](project-aurora)\n````\nSee [related page](project-aurora).')
    expect(() => validateDurableSupersessionPages(pages, { sourceAId, sourceBId })).not.toThrow()
  })

  it.each(['```', '~~~'])('treats an unclosed %s fence as fenced through EOF', fence => {
    const pages = validSupersessionPages()
    pages['operations-runbook'] = pages['operations-runbook'].replace('See [related page](project-aurora).',
      `${fence}\nSee [related page](project-aurora).`)
    expect(() => validateDurableSupersessionPages(pages, { sourceAId, sourceBId })).toThrow('ASSERT_RECIPROCAL_LINKS')
  })

  it('does not count an image-only destination as a reciprocal link', () => {
    const pages = validSupersessionPages()
    pages['operations-runbook'] = pages['operations-runbook'].replace('See [related page](project-aurora).',
      'See ![related diagram](project-aurora).')
    expect(() => validateDurableSupersessionPages(pages, { sourceAId, sourceBId })).toThrow('ASSERT_RECIPROCAL_LINKS')
  })

  it('does not count a link-like inline code span as a reciprocal link', () => {
    const pages = validSupersessionPages()
    pages['operations-runbook'] = pages['operations-runbook'].replace('See [related page](project-aurora).',
      'Example: `[related page](project-aurora)`.')
    expect(() => validateDurableSupersessionPages(pages, { sourceAId, sourceBId })).toThrow('ASSERT_RECIPROCAL_LINKS')
  })

  it('pins the exact factual sentences in the scenario instructions', async () => {
    const instructions = await readFile(resolve(repositoryRoot, 'tests/fixtures/agent-smoke/instructions.txt'), 'utf8')
    for (const sentence of [HISTORICAL_HARBOR_SENTENCE, CURRENT_MERIDIAN_SENTENCE, RETIRED_HARBOR_SENTENCE]) {
      expect(instructions.split(sentence)).toHaveLength(2)
    }
  })

  it('requires both exact source IDs and an unfenced reciprocal link', () => {
    const missingSource = validSupersessionPages()
    missingSource['project-aurora'] = missingSource['project-aurora'].replace(`  - "${sourceBId}"\n`, '')
    expect(() => validateDurableSupersessionPages(missingSource, { sourceAId, sourceBId })).toThrow('ASSERT_PAGE_EVIDENCE_MAINTAINED')
    const extraSource = validSupersessionPages()
    extraSource['project-aurora'] = extraSource['project-aurora'].replace(`  - "${sourceBId}"\n`, `  - "${sourceBId}"\n  - "${'c'.repeat(64)}"\n`)
    expect(() => validateDurableSupersessionPages(extraSource, { sourceAId, sourceBId })).toThrow('ASSERT_PAGE_EVIDENCE_MAINTAINED')


    const missingLink = validSupersessionPages()
    missingLink['operations-runbook'] = missingLink['operations-runbook'].replace('](project-aurora)', '](other-page)')
    expect(() => validateDurableSupersessionPages(missingLink, { sourceAId, sourceBId })).toThrow('ASSERT_RECIPROCAL_LINKS')
  })


  it('requires both exact pages, source A in discovery, and both sources in semantic review', async () => {
    const { root, trace } = await pinnedTrace()
    try {
      expect(() => requireMaintenanceOrder(trace, { ...requiredReads, pageIds: ['project-aurora', 'missing-page'] })).toThrow('ASSERT_DISCOVERY_BEFORE_MAINTENANCE')
      const preAddSource = trace.tools.findIndex(tool => tool.name === 'llmwiki_read_source')
      trace.tools[preAddSource]!.id = sourceBId
      expect(() => requireMaintenanceOrder(trace, requiredReads)).toThrow('ASSERT_DISCOVERY_BEFORE_MAINTENANCE')
      trace.tools[preAddSource]!.id = sourceAId
      const semanticSourceB = trace.tools.findLastIndex(tool => tool.name === 'llmwiki_read_source' && tool.id === sourceBId)
      trace.tools[semanticSourceB]!.id = sourceAId
      expect(() => requireMaintenanceOrder(trace, requiredReads)).toThrow('ASSERT_SEMANTIC_REVIEW_TRACE')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('requires the visible semantic-review classification, exact pages and sources, after semantic reads', async () => {
    const mutations: ((trace: SessionTrace) => void)[] = [
      trace => { trace.finalAssistantText = trace.finalAssistantText!.replace('contradicted and superseded', 'changed') },
      trace => { trace.finalAssistantText = trace.finalAssistantText!.replace('project-aurora', 'missing-page') },
      trace => { trace.finalAssistantText = trace.finalAssistantText!.replace(sourceAId, 'c'.repeat(64)) },
      trace => { trace.finalAssistantText = trace.finalAssistantText!.replace('Selected semantic review', 'Maintenance complete') },
      trace => { trace.finalAssistantSeq = trace.tools.findLast(tool => tool.name === 'llmwiki_read_source')!.seq - 1 },
    ]
    for (const mutate of mutations) {
      const { root, trace } = await pinnedTrace()
      try {
        mutate(trace)
        expect(() => requireMaintenanceOrder(trace, requiredReads)).toThrow('ASSERT_SEMANTIC_REVIEW_TRACE')
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    }
  })

  it('requires the exact source-B candidate read before the first upsert', async () => {
    const { root, trace } = await pinnedTrace()
    try {
      const candidateRead = trace.tools.findIndex((tool, index) => index > trace.tools.findIndex(entry => entry.name === 'llmwiki_add_source')
        && tool.name === 'llmwiki_read_source')
      trace.tools[candidateRead]!.id = sourceAId
      expect(() => requireMaintenanceOrder(trace, requiredReads)).toThrow('ASSERT_MAINTENANCE_TRACE_ORDER')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
  it('rejects delayed discovery and candidate results across mutation call boundaries', async () => {
    for (const mutate of [
      (trace: SessionTrace): void => {
        const add = trace.tools.find(tool => tool.name === 'llmwiki_add_source')!
        trace.tools.find(tool => tool.name === 'llmwiki_search')!.resultSeq = add.seq + 1
      },
      (trace: SessionTrace): void => {
        const update = trace.tools.find(tool => tool.name === 'llmwiki_upsert_page')!
        trace.tools.find((tool, index) => index > trace.tools.findIndex(entry => entry.name === 'llmwiki_add_source')
          && tool.name === 'llmwiki_read_source' && tool.id === sourceBId)!.resultSeq = update.seq + 1
      },
    ]) {
      const { root, trace } = await pinnedTrace()
      try {
        mutate(trace)
        expect(() => requireMaintenanceOrder(trace, requiredReads)).toThrow()
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    }
  })

  it('rejects a first structural-lint result delayed beyond a semantic-review call', async () => {
    const { root, trace } = await pinnedTrace()
    try {
      const firstLint = trace.tools.find(tool => tool.name === 'llmwiki_lint')!
      const semantic = trace.tools.find((tool, index) => index > trace.tools.indexOf(firstLint) && tool.name === 'llmwiki_list_pages')!
      firstLint.resultSeq = semantic.seq + 1
      expect(() => requireMaintenanceOrder(trace, requiredReads)).toThrow('ASSERT_SEMANTIC_REVIEW_TRACE')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('rejects a semantic-review result delayed beyond the final-lint call', async () => {
    const { root, trace } = await pinnedTrace()
    try {
      const firstLint = trace.tools.find(tool => tool.name === 'llmwiki_lint')!
      const finalLint = trace.tools.findLast(tool => tool.name === 'llmwiki_lint')!
      trace.tools.find((tool, index) => index > trace.tools.indexOf(firstLint) && tool.name === 'llmwiki_read_source')!.resultSeq = finalLint.seq + 1
      expect(() => requireMaintenanceOrder(trace, requiredReads)).toThrow('ASSERT_SEMANTIC_REVIEW_TRACE')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('requires completed mutation results before the final lint result and the final lint as the final wiki tool', async () => {
    for (const mutate of [
      (trace: SessionTrace): void => {
        const add = trace.tools.find(tool => tool.name === 'llmwiki_add_source')!
        const candidate = trace.tools.find((tool, index) => index > trace.tools.indexOf(add) && tool.name === 'llmwiki_read_source')!
        add.resultSeq = candidate.seq
      },
      (trace: SessionTrace): void => {
        const finalLint = trace.tools.findLast(tool => tool.name === 'llmwiki_lint')!
        trace.tools.findLast(tool => tool.name === 'llmwiki_upsert_page')!.resultSeq = finalLint.resultSeq! + 1
      },
      (trace: SessionTrace): void => {
        const finalLintIndex = trace.tools.findLastIndex(tool => tool.name === 'llmwiki_lint')
        trace.tools.splice(finalLintIndex + 1, 0, { name: 'llmwiki_status', seq: trace.tools[finalLintIndex]!.seq + 1, resultSeq: trace.tools[finalLintIndex]!.resultSeq! + 1, turn: 1, step: 1 })
      },
    ]) {
      const { root, trace } = await pinnedTrace()
      try {
        mutate(trace)
        expect(() => requireMaintenanceOrder(trace, requiredReads)).toThrow()
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    }
  })
  it('validates the externally persisted final recovery response and exact citations', async () => {
    const fixture = await readFile(resolve(repositoryRoot, 'tests/fixtures/agent-smoke/recovery-valid/pinned-project/recovery-session/session.jsonl'), 'utf8')
    expect(fixture).toContain('"version":0')
    expect(fixture).toContain('"type":"agent/inbox/spliced"')
    const { root, trace } = await pinnedRecoveryTrace('recovery-valid')
    try {
      const validate = (): void => requireFreshSessionRecovery(trace, { endpoint: 'Meridian', sourceIds: [sourceAId, sourceBId] })
      expect(validate).not.toThrow()
      trace.finalAssistantText = trace.finalAssistantText!.replace('Meridian', 'Harbor')
      expect(validate).toThrow('ASSERT_FRESH_SESSION_RESPONSE')
      trace.finalAssistantText = `The current production synchronization endpoint is Meridian. Sources: ${sourceAId}.`
      expect(validate).toThrow('ASSERT_FRESH_SESSION_RESPONSE')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('requires successful reads of both exact pages and both exact sources after recovery discovery', async () => {
    for (const mutate of [
      (trace: SessionTrace): void => {
        trace.tools = trace.tools.filter(tool => !(tool.name === 'llmwiki_read_page' && tool.id === 'operations-runbook'))
      },
      (trace: SessionTrace): void => {
        trace.tools = trace.tools.filter(tool => !(tool.name === 'llmwiki_read_source' && tool.id === sourceBId))
      },
      (trace: SessionTrace): void => {
        const sourceBRead = trace.tools.find(tool => tool.name === 'llmwiki_read_source' && tool.id === sourceBId)!
        sourceBRead.id = 'c'.repeat(64)
      },
    ]) {
      const { root, trace } = await pinnedRecoveryTrace('recovery-valid')
      try {
        mutate(trace)
        expect(() => requireFreshSessionRecovery(trace, { endpoint: 'Meridian', sourceIds: [sourceAId, sourceBId] }))
          .toThrow('ASSERT_FRESH_SESSION_RECOVERY_TRACE')
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    }
  })
  it('rejects delayed recovery results and a nonterminal recovery assistant offline', async () => {
    for (const delay of [
      (trace: SessionTrace): void => { trace.tools.find(tool => tool.name === 'llmwiki_list_sources')!.resultSeq = trace.finalAssistantSeq! + 1 },
      (trace: SessionTrace): void => { trace.tools.find(tool => tool.name === 'llmwiki_read_source' && tool.id === sourceBId)!.resultSeq = trace.finalAssistantSeq! + 1 },
    ]) {
      const { root, trace } = await pinnedRecoveryTrace('recovery-valid')
      try {
        delay(trace)
        expect(() => requireFreshSessionRecovery(trace, { endpoint: 'Meridian', sourceIds: [sourceAId, sourceBId] }))
          .toThrow('ASSERT_FRESH_SESSION_RESPONSE')
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    }

    const fixture = await readFile(resolve(repositoryRoot, 'tests/fixtures/agent-smoke/recovery-valid/pinned-project/recovery-session/session.jsonl'), 'utf8')
    const records = fixture.trimEnd().split('\n').map(line => JSON.parse(line) as Record<string, unknown>)
    const stepEnd = records.findIndex(record => record.type === 'step/end')
    records.splice(stepEnd, 0,
      {
        seq: 25,
        time: 1788220800025,
        type: 'tool/call',
        data: { turn: 1, step: 1, callId: 'call-after-assistant', name: 'host_read', arguments: '{}' },
      },
      {
        seq: 26,
        time: 1788220800026,
        type: 'tool/result',
        data: {
          turn: 1,
          step: 1,
          message: {
            id: 'tool-result-after-assistant',
            role: 'user',
            source: { kind: 'tool', callId: 'call-after-assistant' },
            content: [{
              type: 'tool-result',
              toolCallId: 'call-after-assistant',
              content: [{ type: 'text', text: '{}' }],
              isError: false,
            }],
          },
        },
        surfaceOp: 'append',
        sourceEventSeqs: [25],
      },
    )
    for (const [index, record] of records.slice(stepEnd + 2).entries()) {
      record.seq = 27 + index
      record.time = 1788220800027 + index
    }
    const nonterminalRoot = await mkdtemp(join(tmpdir(), 'agent-smoke-nonterminal-assistant-'))
    try {
      await mkdirSession(nonterminalRoot, `${records.map(record => JSON.stringify(record)).join('\n')}\n`)
      const nonterminal = await readNewSessionTrace(nonterminalRoot, new Set())
      expect(nonterminal.finalAssistantText).toBeUndefined()
      expect(() => requireFreshSessionRecovery(nonterminal, { endpoint: 'Meridian', sourceIds: [sourceAId, sourceBId] }))
        .toThrow('ASSERT_FRESH_SESSION_RESPONSE')
    } finally {
      await rm(nonterminalRoot, { recursive: true, force: true })
    }
  })

  it('rejects unsafe model identifiers and recursively blocks credentials and absolute paths without overwriting evidence', async () => {
    expect(validateModelIdentifier('deepseek-chat')).toBe('deepseek-chat')
    for (const model of ['key/value', '/home/user/model', 'C:\\secret\\model', 'bad\nmodel']) {
      expect(() => validateModelIdentifier(model)).toThrow('INVALID_SMOKE_CONFIGURATION')
    }
    const root = await mkdtemp(join(tmpdir(), 'agent-smoke-evidence-'))
    const path = join(root, 'latest.json')
    const original = '{"result":"previous"}\n'
    await writeFile(path, original)
    try {
      for (const value of [
        { model: 'sentinel-secret' },
        { nested: { model: 'prefix-sentinel-secret-suffix' } },
        { model: '/home/user/secret' },
        { model: 'C:\\Users\\secret\\model' },
        { model: 'Authorization: token' },
        { model: 'safe\u0007value' },
      ]) {
        await expect(writeEvidence(path, value, 'sentinel-secret')).rejects.toThrow('INVALID_EVIDENCE_PAYLOAD')
        expect(await readFile(path, 'utf8')).toBe(original)
      }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('rejects evidence paths with symlink ancestors before atomic replacement', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agent-smoke-evidence-symlink-'))
    const durable = join(root, 'durable')
    const alias = join(root, 'alias')
    await mkdir(durable)
    await symlink(durable, alias, 'dir')
    try {
      await expect(writeEvidence(join(alias, 'latest.json'), { result: 'pass' }, 'sentinel-secret'))
        .rejects.toThrow('INVALID_EVIDENCE_LOCATION')
      await expect(readFile(join(durable, 'latest.json'))).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('documents and records requested exact specs, resolved packages, and lock identity', async () => {
    const source = await readFile(resolve(repositoryRoot, 'scripts/agent-smoke.ts'), 'utf8')
    const readme = await readFile(resolve(repositoryRoot, 'README.md'), 'utf8')
    expect(source).toContain('runtime: { requested: requestedPackages, lockSha256: RUNNER_LOCK_SHA256, packages: resolvedPackages }')
    expect(readme).toContain('`runtime.requested`, `runtime.packages`, and `runtime.lockSha256`')
  })

  it('commits an exact integrity-bearing runner lock fixture', async () => {
    const manifest = JSON.parse(await readFile(resolve(repositoryRoot, 'tests/fixtures/agent-smoke/runner/package.json'), 'utf8')) as {
      dependencies: Record<string, string>
      pnpm: { overrides: Record<string, string> }
    }
    const lock = await readFile(resolve(repositoryRoot, 'tests/fixtures/agent-smoke/runner/pnpm-lock.yaml'), 'utf8')
    const workspace = await readFile(resolve(repositoryRoot, 'tests/fixtures/agent-smoke/runner/pnpm-workspace.yaml'), 'utf8')
    const exactCordis = {
      '@deepseek-ai/cordis': '4.0.1',
      '@deepseek-ai/cordis-plugin-loader': '1.0.2',
    }
    expect(manifest.dependencies).toMatchObject(exactCordis)
    expect(manifest.pnpm.overrides).toEqual(exactCordis)
    expect(workspace).toContain("'@deepseek-ai/cordis': 4.0.1")
    expect(workspace).toContain("'@deepseek-ai/cordis-plugin-loader': 1.0.2")
    expect(lock).toContain("'@deepseek-ai/cordis@4.0.1':")
    expect(lock).toContain("'@deepseek-ai/cordis-plugin-loader@1.0.2':")
    expect(lock).toContain("'@deepseek-ai/dsh@0.1.1-rc.2':")
    expect(lock).toContain('integrity: sha512-')
    expect(lock).not.toContain("'@deepseek-ai/cordis@4.0.2':")
    expect(lock).not.toContain("'@deepseek-ai/cordis-plugin-loader@1.0.3':")
    expect(lock).not.toContain('specifier: ^')
  })
})

async function mkdirSession(root: string, events: string): Promise<void> {
  const session = join(root, 'pinned-project', 'pinned-session')
  await mkdir(session, { recursive: true })
  await writeFile(join(session, 'session.jsonl'), events)
}
