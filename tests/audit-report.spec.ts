import { execFile } from 'node:child_process'
import { createServer, type Server } from 'node:http'
import { promisify } from 'node:util'
import { afterEach, beforeEach, expect, it } from 'vitest'

interface Issue {
  number: number
  state: string
  state_reason?: string
  body: string
  title: string
  assignees: string[]
  user: { login: string }
  pull_request?: object
}

let server: Server
let apiUrl: string
let issues: Issue[]
let comments: string[]
let requests: number
let apiFailure: { method: string; status: number } | undefined
const execute = promisify(execFile)

beforeEach(async () => {
  issues = []
  comments = []
  requests = 0
  apiFailure = undefined
  server = createServer((request, response) => {
    void (async () => {
      requests++
      response.setHeader('content-type', 'application/json')
      if (apiFailure && apiFailure.method === request.method) {
        response.writeHead(apiFailure.status).end('{}')
        return
      }
      const url = new URL(request.url ?? '/', 'http://localhost')
      if (request.method === 'GET' && url.pathname === '/repos/example/wiki/issues') {
        const offset = (Number(url.searchParams.get('page')) - 1) * 100
        response.end(JSON.stringify(issues.slice(offset, offset + 100)))
        return
      }
      const chunks: Buffer[] = []
      for await (const chunk of request) chunks.push(Buffer.from(chunk as Uint8Array))
      const body = JSON.parse(Buffer.concat(chunks).toString()) as {
        body: string; title: string; assignees: string[]; state?: string; state_reason?: string
      }
      if (request.method === 'POST' && url.pathname.endsWith('/comments')) {
        comments.push(body.body)
        response.end('{}')
      } else if (request.method === 'POST' && url.pathname === '/repos/example/wiki/issues') {
        const issue = { ...body, number: issues.length + 1, state: 'open', user: { login: 'github-actions[bot]' } }
        issues.unshift(issue)
        response.end(JSON.stringify(issue))
      } else if (request.method === 'PATCH') {
        const issue = issues.find(entry => entry.number === Number(url.pathname.split('/').at(-1)))
        if (!issue) throw new Error('Unknown issue')
        Object.assign(issue, body)
        response.end(JSON.stringify(issue))
      } else {
        response.writeHead(404).end('{}')
      }
    })().catch((error: unknown) => {
      response.writeHead(500).end(JSON.stringify({ message: String(error) }))
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('Missing HTTP port')
  apiUrl = `http://127.0.0.1:${address.port}`
})

afterEach(async () => {
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
})

async function run(overrides: NodeJS.ProcessEnv = {}): Promise<void> {
  await execute(process.execPath, ['scripts/report-audit.ts'], {
    env: {
      ...process.env,
      GITHUB_API_URL: apiUrl,
      GITHUB_SERVER_URL: 'https://github.com',
      GITHUB_TOKEN: 'local-test-token',
      GITHUB_REPOSITORY: 'example/wiki',
      GITHUB_RUN_ID: '10',
      GITHUB_SHA: '0123456789abcdef',
      GITHUB_STEP_SUMMARY: '',
      AUDIT_CHECK_RESULT: 'failure',
      AUDIT_STEP_OUTCOME: 'failure',
      ...overrides,
    },
    timeout: 10_000,
  })
}

const recovered = { AUDIT_CHECK_RESULT: 'success', AUDIT_STEP_OUTCOME: 'success' }

it('assigns and mentions the owner once, deduplicating daily failures while refreshing diagnostics', async () => {
  await run()
  expect(issues).toHaveLength(1)
  expect(issues[0]?.assignees).toEqual(['example'])
  expect(issues[0]?.body).toContain('@example')
  expect(issues[0]?.body).toContain('0123456789abcdef')
  await run({ GITHUB_RUN_ID: '11', GITHUB_SHA: 'abcdef0123456789' })
  expect(issues).toHaveLength(1)
  expect(issues[0]?.state).toBe('open')
  expect(issues[0]?.body).toContain('/actions/runs/11')
  expect(issues[0]?.body).toContain('abcdef0123456789')
  expect(comments).toEqual([])
})

it('closes after a completed audit and reopens the same alert on regression', async () => {
  await run()
  const number = issues[0]?.number
  await run(recovered)
  expect(issues[0]?.state).toBe('closed')
  expect(issues[0]?.state_reason).toBe('completed')
  expect(comments).toHaveLength(1)
  expect(comments[0]).toContain('@example')
  await run(recovered)
  expect(comments).toHaveLength(1)
  await run({ GITHUB_RUN_ID: '12' })
  expect(issues).toHaveLength(1)
  expect(issues[0]?.number).toBe(number)
  expect(issues[0]?.state).toBe('open')
  expect(comments).toHaveLength(2)
  expect(comments[1]).toContain('@example')
  expect(comments[1]).toContain('/actions/runs/12')
})

it('reports setup failure without treating a missing or skipped audit as recovery', async () => {
  await run({ AUDIT_STEP_OUTCOME: 'skipped' })
  expect(issues).toHaveLength(1)
  expect(issues[0]?.state).toBe('open')
  expect(issues[0]?.body).toContain('@example')
  await run({ ...recovered, AUDIT_STEP_OUTCOME: '' })
  expect(issues[0]?.state).toBe('open')
  await run({ ...recovered, AUDIT_STEP_OUTCOME: 'skipped' })
  expect(issues[0]?.state).toBe('open')
  await run()
  expect(comments.at(-1)).toContain('@example')
})

it.each(['cancelled', 'skipped'])('leaves alerts untouched when the audit job is %s', async result => {
  await run()
  const before = JSON.stringify({ issues, comments, requests })
  await run({ AUDIT_CHECK_RESULT: result })
  expect(JSON.stringify({ issues, comments, requests })).toBe(before)
})

it('does not create an issue for a healthy first run', async () => {
  await run(recovered)
  expect(issues).toEqual([])
  expect(comments).toEqual([])
})

it('reopens a manually closed unresolved alert even when the failure is unchanged', async () => {
  await run()
  const alert = issues[0]
  if (!alert) throw new Error('Missing initial alert')
  alert.state = 'closed'
  await run()
  expect(issues).toHaveLength(1)
  expect(alert.state).toBe('open')
  expect(comments).toHaveLength(1)
  expect(comments[0]).toContain('@example')
})

it('paginates past human issues, pull requests, and unrelated bot alerts without modifying them', async () => {
  await run()
  const alert = issues[0]
  if (!alert) throw new Error('Missing initial alert')
  issues.unshift(...Array.from({ length: 100 }, (_, index) => ({
    ...alert, number: index + 2,
    user: { login: index % 2 === 0 ? 'user' : 'github-actions[bot]' },
    ...(index % 2 === 0 ? {} : { pull_request: {} }),
  })), { ...alert, number: 102, body: '<!-- dsh-llmwiki-upstream-compatibility -->' })
  const unrelated = JSON.stringify(issues.slice(0, 101))
  await run(recovered)
  expect(issues).toHaveLength(102)
  expect(alert.state).toBe('closed')
  expect(JSON.stringify(issues.slice(0, 101))).toBe(unrelated)
})

it.each([
  { method: 'GET', status: 500 },
  { method: 'POST', status: 403 },
])('fails visibly on GitHub $method HTTP $status instead of swallowing notification errors', async failure => {
  apiFailure = failure
  await expect(run()).rejects.toThrow(`HTTP ${failure.status}`)
  expect(issues).toEqual([])
  expect(comments).toEqual([])
})
