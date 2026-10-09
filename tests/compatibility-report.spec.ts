import { execFile } from 'node:child_process'
import { createServer, type Server } from 'node:http'
import { promisify } from 'node:util'
import { afterEach, beforeEach, expect, it } from 'vitest'

interface Issue {
  number: number
  state: string
  body: string
  title: string
  user: { login: string }
  pull_request?: object
}

let server: Server
let apiUrl: string
let issues: Issue[]
let comments: string[]
let mutations: number
let apiStatus: number
const execute = promisify(execFile)

beforeEach(async () => {
  issues = []
  comments = []
  mutations = 0
  apiStatus = 200
  server = createServer((request, response) => {
    void (async () => {
      response.setHeader('content-type', 'application/json')
      if (apiStatus !== 200) {
        response.writeHead(apiStatus).end('{}')
        return
      }
      const url = new URL(request.url ?? '/', 'http://localhost')
      if (request.method === 'GET') {
        const offset = (Number(url.searchParams.get('page')) - 1) * 100
        response.end(JSON.stringify(issues.slice(offset, offset + 100)))
        return
      }
      const chunks: Buffer[] = []
      for await (const chunk of request) chunks.push(Buffer.from(chunk as Uint8Array))
      const body = JSON.parse(Buffer.concat(chunks).toString()) as { body: string; title: string; state?: string }
      mutations++
      if (url.pathname.endsWith('/comments')) {
        comments.push(body.body)
        response.end('{}')
      } else if (request.method === 'POST') {
        const issue = { ...body, number: issues.length + 1, state: 'open', user: { login: 'github-actions[bot]' } }
        issues.unshift(issue)
        response.end(JSON.stringify(issue))
      } else {
        const issue = issues.find(entry => entry.number === Number(url.pathname.split('/').at(-1)))
        if (!issue) throw new Error('Unknown issue')
        Object.assign(issue, body)
        response.end(JSON.stringify(issue))
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
  await execute(process.execPath, ['scripts/report-compatibility.ts'], {
    env: {
      ...process.env,
      GITHUB_API_URL: apiUrl,
      GITHUB_SERVER_URL: 'https://github.com',
      GITHUB_TOKEN: 'local-test-token',
      GITHUB_REPOSITORY: 'example/wiki',
      GITHUB_RUN_ID: '10',
      GITHUB_SHA: '0123456789abcdef',
      GITHUB_STEP_SUMMARY: '',
      COMPAT_CHECK_RESULT: 'failure',
      COMPAT_DSH_VERSION: '0.2.0-rc.2',
      COMPAT_CORDIS_VERSION: '4.0.4',
      COMPAT_HOST_OUTCOME: 'success',
      COMPAT_HOST_STAGE: 'complete',
      COMPAT_CORDIS_OUTCOME: 'failure',
      COMPAT_CORDIS_STAGE: 'plugin-admission',
      ...overrides,
    },
    timeout: 10_000,
  })
}

const recovered = { COMPAT_CHECK_RESULT: 'success', COMPAT_CORDIS_OUTCOME: 'success', COMPAT_CORDIS_STAGE: 'complete' }

it('deduplicates repeated failures, refreshes the run link, and notifies changed targets', async () => {
  await run()
  expect(issues).toHaveLength(1)
  expect(issues[0]?.body).toContain('@example')
  await run({ GITHUB_RUN_ID: '11' })
  expect(issues).toHaveLength(1)
  expect(issues[0]?.body).toContain('/actions/runs/11')
  expect(comments).toEqual([])
  await run({ COMPAT_CORDIS_VERSION: '4.0.5', COMPAT_CORDIS_STAGE: 'consumer-peer-admission' })
  expect(issues).toHaveLength(1)
  expect(comments).toHaveLength(1)
  expect(comments[0]).toContain('@example')
  expect(comments[0]).toContain('4.0.5')
})

it('closes only a completed recovery and reopens the same issue on regression', async () => {
  await run()
  await run(recovered)
  expect(issues[0]?.state).toBe('closed')
  expect(comments).toHaveLength(1)
  expect(comments[0]).toContain('@example')
  await run(recovered)
  expect(comments).toHaveLength(1)
  await run()
  expect(issues).toHaveLength(1)
  expect(issues[0]?.state).toBe('open')
  expect(comments).toHaveLength(2)
  expect(comments[1]).toContain('@example')
})

it('never closes an alert on a partial probe, unresolved tag, or cancelled run', async () => {
  await run()
  await run({ ...recovered, COMPAT_CORDIS_STAGE: 'strict-consumer-types' })
  expect(issues[0]?.state).toBe('open')
  await run({ ...recovered, COMPAT_DSH_VERSION: '' })
  expect(issues[0]?.state).toBe('open')
  const before = JSON.stringify({ issues, comments, mutations })
  await run({ COMPAT_CHECK_RESULT: 'cancelled' })
  expect(JSON.stringify({ issues, comments, mutations })).toBe(before)
})

it('does not create an issue for a healthy first run', async () => {
  await run(recovered)
  expect(issues).toEqual([])
  expect(mutations).toBe(0)
})

it('finds older bot alerts across pages without modifying user issues or pull requests', async () => {
  await run()
  const alert = issues[0]
  if (!alert) throw new Error('Missing initial alert')
  issues.unshift(...Array.from({ length: 100 }, (_, index) => ({
    ...alert, number: index + 2,
    user: { login: index % 2 === 0 ? 'user' : 'github-actions[bot]' },
    ...(index % 2 === 0 ? {} : { pull_request: {} }),
  })))
  const unrelated = JSON.stringify(issues.slice(0, 100))
  await run(recovered)
  expect(issues).toHaveLength(101)
  expect(alert.state).toBe('closed')
  expect(JSON.stringify(issues.slice(0, 100))).toBe(unrelated)
})

it('fails visibly when GitHub refuses the reporting token', async () => {
  apiStatus = 403
  await expect(run()).rejects.toThrow('HTTP 403')
  expect(mutations).toBe(0)
})
