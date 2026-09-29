import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { appendFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

interface ProbeResult {
  outcome: string
  stage: string
}

interface CompatibilityReport {
  repository: string
  runUrl: string
  sha: string
  result: string
  dsh: string
  cordis: string
  hostProbe: ProbeResult
  cordisProbe: ProbeResult
}

interface Issue {
  number: number
  state: string
  body: string | null
  user: { login: string } | null
  pull_request?: unknown
}

type Request = <T>(method: string, path: string, body?: object) => Promise<T>
const marker = '<!-- dsh-llmwiki-upstream-compatibility -->'

export async function reportCompatibility(report: CompatibilityReport, request: Request): Promise<void> {
  // Cancellation is not evidence of either incompatibility or recovery.
  if (report.result === 'cancelled' || report.result === 'skipped') return
  const passed = report.result === 'success' && Boolean(report.dsh && report.cordis) &&
    [report.hostProbe, report.cordisProbe].every(probe => probe.outcome === 'success' && probe.stage === 'complete')
  const probeFailed = [report.hostProbe, report.cordisProbe].some(probe => probe.outcome === 'failure' &&
    ['plugin-admission', 'consumer-peer-admission', 'strict-consumer-types', 'profile-lifecycle'].includes(probe.stage))
  const status = passed ? 'Compatible' : probeFailed ? 'Compatibility probe failed' : 'Verification incomplete'
  const fingerprint = createHash('sha256').update(JSON.stringify({
    status, dsh: report.dsh, cordis: report.cordis, host: report.hostProbe, cordisProbe: report.cordisProbe,
  })).digest('hex')
  const signature = `<!-- compatibility-state:${fingerprint} -->`
  const body = [
    marker, signature, `## ${status}`, '',
    `- Checkout: \`${report.sha}\` (this checks the packed checkout, not npm's plugin latest).`,
    `- npm \`@deepseek-ai/dsh@latest\`: \`${report.dsh || 'unresolved'}\`.`,
    `- npm \`@deepseek-ai/cordis@latest\`: \`${report.cordis || 'unresolved'}\`.`,
    '', '| Probe | Outcome | Last stage |', '| --- | --- | --- |',
    `| DSH native dependencies | ${report.hostProbe.outcome || 'not run'} | ${report.hostProbe.stage || 'not reached'} |`,
    `| DSH + latest Cordis override | ${report.cordisProbe.outcome || 'not run'} | ${report.cordisProbe.stage || 'not reached'} |`,
    '', `[Workflow run, exact resolved packages, and diagnostics](${report.runUrl})`, '',
    'The Cordis override is a separate forward-compatibility probe, not an upstream-supported dependency recommendation.',
    'A failed probe requires log inspection: peer rejection, type errors, and runtime failures differ from registry/network or runner failures. Incomplete checks never count as recovery.',
    'No lockfiles or peer ranges are upgraded; no model credentials or model calls are used.',
  ].join('\n')
  if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, `${body}\n`)

  const base = `/repos/${report.repository}/issues`
  let issue: Issue | undefined
  for (let page = 1; ; page++) {
    const issues = await request<Issue[]>('GET', `${base}?state=all&sort=created&direction=desc&per_page=100&page=${page}`)
    issue = issues.find(candidate => !candidate.pull_request && candidate.user?.login === 'github-actions[bot]' && candidate.body?.includes(marker))
    if (issue || issues.length < 100) break
  }
  const mention = `@${report.repository.split('/')[0]}`
  if (passed) {
    if (issue?.state === 'open') {
      await request('POST', `${base}/${issue.number}/comments`, { body: `${mention} compatibility recovered; both probes completed.\n\n${body}` })
      await request('PATCH', `${base}/${issue.number}`, { state: 'closed', state_reason: 'completed', body })
    }
    return
  }

  const title = '[compatibility] Latest DSH/Cordis check needs attention'
  if (!issue) {
    await request('POST', base, { title, body: `${body}\n\n${mention} please inspect this compatibility check.` })
    return
  }
  const changed = !issue.body?.includes(signature)
  const reopened = issue.state === 'closed'
  await request('PATCH', `${base}/${issue.number}`, { title, body, state: 'open' })
  if (changed || reopened) {
    await request('POST', `${base}/${issue.number}/comments`, { body: `${mention} ${reopened ? 'compatibility alert reopened' : 'compatibility result changed'}.\n\n${body}` })
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const { GITHUB_TOKEN: token, GITHUB_REPOSITORY: repository, GITHUB_RUN_ID: runId, GITHUB_SHA: sha } = process.env
  assert(token && repository && runId && sha, 'GitHub token, repository, run ID, and SHA are required')
  const apiUrl = process.env.GITHUB_API_URL ?? 'https://api.github.com'
  await reportCompatibility({
    repository, sha,
    runUrl: `${process.env.GITHUB_SERVER_URL ?? 'https://github.com'}/${repository}/actions/runs/${runId}`,
    result: process.env.COMPAT_CHECK_RESULT ?? '',
    dsh: process.env.COMPAT_DSH_VERSION ?? '',
    cordis: process.env.COMPAT_CORDIS_VERSION ?? '',
    hostProbe: { outcome: process.env.COMPAT_HOST_OUTCOME ?? '', stage: process.env.COMPAT_HOST_STAGE ?? '' },
    cordisProbe: { outcome: process.env.COMPAT_CORDIS_OUTCOME ?? '', stage: process.env.COMPAT_CORDIS_STAGE ?? '' },
  }, async <T>(method: string, path: string, body?: object): Promise<T> => {
    const response = await fetch(`${apiUrl}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`, accept: 'application/vnd.github+json',
        'content-type': 'application/json', 'x-github-api-version': '2022-11-28',
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(30_000),
    })
    assert(response.ok, `GitHub ${method} ${path}: HTTP ${response.status}`)
    return await response.json() as T
  })
}
