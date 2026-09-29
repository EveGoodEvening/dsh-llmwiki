import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { appendFile } from 'node:fs/promises'

const mode = process.argv[2] ?? 'all'
assert(['resolve', 'all', 'host', 'cordis'].includes(mode), 'Use resolve, all, host, or cordis')

async function latest(name: string): Promise<string> {
  const response = await fetch(`https://registry.npmjs.org/${name}/latest`, { signal: AbortSignal.timeout(30_000) })
  assert(response.ok, `Registry lookup for ${name}: HTTP ${response.status}`)
  const manifest = await response.json() as { name: string; version: string }
  assert.equal(manifest.name, name)
  return manifest.version
}

// Resolve once for both lanes; CI passes this snapshot into separate steps.
const dsh = process.env.LLMWIKI_COMPAT_DSH_VERSION ?? await latest('@deepseek-ai/dsh')
const cordis = process.env.LLMWIKI_COMPAT_CORDIS_VERSION ?? await latest('@deepseek-ai/cordis')
for (const version of [dsh, cordis]) {
  assert(/^\d+\.\d+\.\d+(?:-[\w.-]+)?(?:\+[\w.-]+)?$/u.test(version), `Expected an exact registry version: ${version}`)
}
console.log(JSON.stringify({ dsh, cordis }))
if (process.env.GITHUB_OUTPUT) {
  await appendFile(process.env.GITHUB_OUTPUT, `dsh=${dsh}\ncordis=${cordis}\n`)
}

if (mode !== 'resolve') {
  for (const lane of mode === 'all' ? ['host', 'cordis'] : [mode]) {
    console.log(`Checking ${lane}: DSH ${dsh}, Cordis ${lane === 'cordis' ? cordis : 'host-selected'}`)
    const result = spawnSync('pnpm', [
      'exec', 'vitest', 'run', '--config', 'vitest.e2e.config.ts',
      'tests/built-package.e2e.spec.ts', '-t', 'requires explicit opt-in',
    ], {
      stdio: 'inherit',
      env: {
        ...process.env,
        LLMWIKI_COMPAT_DSH_VERSION: dsh,
        LLMWIKI_COMPAT_CORDIS_VERSION: lane === 'cordis' ? cordis : '',
      },
    })
    if (result.error) throw result.error
    if (result.status !== 0) process.exitCode = 1
  }
}
