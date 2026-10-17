import assert from 'node:assert/strict'
import { appendFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

interface AuditReport {
  repository: string
  runUrl: string
  sha: string
  result: string
  auditOutcome: string
}

interface Issue {
  number: number
  state: string
  body: string | null
  user: { login: string } | null
  pull_request?: unknown
}

type Request = <T>(method: string, path: string, body?: object) => Promise<T>
const marker = '<!-- dsh-llmwiki-dependency-audit -->'

export async function reportAudit(report: AuditReport, request: Request): Promise<void> {
  // Cancellation is not evidence of either an audit failure or recovery.
  if (report.result === 'cancelled' || report.result === 'skipped') return
  const passed = report.result === 'success' && report.auditOutcome === 'success'
  const status = passed ? 'Dependency audit passed' : report.auditOutcome === 'failure' ? 'Dependency audit failed' : 'Dependency audit incomplete'
  // Exclude the checkout and run ID so daily repeats refresh the link without pinging again.
  const signature = `<!-- dependency-audit-state:${report.result}:${report.auditOutcome} -->`
  const body = [
    marker, signature, `## ${status}`, '',
    `- Checkout: \`${report.sha}\`.`,
    `- Audit job: \`${report.result || 'unknown'}\`.`,
    `- \`pnpm audit --audit-level=high\`: \`${report.auditOutcome || 'not run'}\`.`,
    '', `[Workflow run and audit diagnostics](${report.runUrl})`, '',
    'This checks the committed root lockfile, including dev dependencies, without installing or updating packages.',
    'A failed audit can mean high/critical advisories or a registry/network error. A setup failure means the audit did not run. Inspect the workflow logs; incomplete checks never count as recovery.',
  ].join('\n')
  if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, `${body}\n`)

  const base = `/repos/${report.repository}/issues`
  let issue: Issue | undefined
  for (let page = 1; ; page++) {
    const issues = await request<Issue[]>('GET', `${base}?state=all&sort=created&direction=desc&per_page=100&page=${page}`)
    issue = issues.find(candidate => !candidate.pull_request && candidate.user?.login === 'github-actions[bot]' && candidate.body?.includes(marker))
    if (issue || issues.length < 100) break
  }
  const owner = report.repository.split('/')[0]!
  const mention = `@${owner}`
  if (passed) {
    if (issue?.state === 'open') {
      await request('POST', `${base}/${issue.number}/comments`, { body: `${mention} dependency audit recovered; the audit completed successfully.\n\n${body}` })
      await request('PATCH', `${base}/${issue.number}`, { state: 'closed', state_reason: 'completed', body })
    }
    return
  }

  const title = '[audit] Dependency audit needs attention'
  if (!issue) {
    await request('POST', base, { title, body: `${body}\n\n${mention} please inspect this dependency audit.`, assignees: [owner] })
    return
  }
  const changed = !issue.body?.includes(signature)
  const reopened = issue.state === 'closed'
  await request('PATCH', `${base}/${issue.number}`, { title, body, state: 'open' })
  if (changed || reopened) {
    await request('POST', `${base}/${issue.number}/comments`, { body: `${mention} ${reopened ? 'dependency audit alert reopened' : 'dependency audit result changed'}.\n\n${body}` })
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const { GITHUB_TOKEN: token, GITHUB_REPOSITORY: repository, GITHUB_RUN_ID: runId, GITHUB_SHA: sha } = process.env
  assert(token && repository && runId && sha, 'GitHub token, repository, run ID, and SHA are required')
  const apiUrl = process.env.GITHUB_API_URL ?? 'https://api.github.com'
  await reportAudit({
    repository, sha,
    runUrl: `${process.env.GITHUB_SERVER_URL ?? 'https://github.com'}/${repository}/actions/runs/${runId}`,
    result: process.env.AUDIT_CHECK_RESULT ?? '',
    auditOutcome: process.env.AUDIT_STEP_OUTCOME ?? '',
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
