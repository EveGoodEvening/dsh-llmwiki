import { execFile, type ExecFileOptionsWithStringEncoding } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'

type ExecOptions = Omit<ExecFileOptionsWithStringEncoding, 'encoding'>
interface ChildOutput {
  stdout: string
  stderr: string
}

interface PackMetadata {
  filename: string
  files: { path: string }[]
}

interface ConsumerOutput {
  resolved: string
  patch: string
}

const exec = promisify(execFile) as (file: string, args: readonly string[], options: ExecFileOptionsWithStringEncoding) => Promise<ChildOutput>
const temporaryDirectories: string[] = []

afterEach(async () => Promise.all(temporaryDirectories.splice(0).map(path => rm(path, { recursive: true, force: true }))))

async function temporaryDirectory(prefix: string): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), prefix))
  temporaryDirectories.push(path)
  return path
}

function cleanEnvironment(): NodeJS.ProcessEnv {
  const environment = { ...process.env, NO_COLOR: '1' }
  delete environment.NODE_OPTIONS
  delete environment.NODE_PATH
  delete environment.TSX_TSCONFIG_PATH
  delete environment.npm_config_node_options
  return environment
}

function normalizeChildOutput(output: unknown): string {
  if (typeof output === 'string') return output
  if (Buffer.isBuffer(output)) return output.toString('utf8')
  return ''
}

function parsePackMetadata(output: string): PackMetadata {
  let parsed: unknown
  try {
    parsed = JSON.parse(output)
  } catch (error) {
    throw new Error(`pnpm pack returned invalid JSON: ${output}`, { cause: error })
  }

  const packed: unknown = Array.isArray(parsed) ? parsed[0] : parsed
  if (
    typeof packed !== 'object'
    || packed === null
    || Array.isArray(packed)
    || !('filename' in packed)
    || typeof packed.filename !== 'string'
    || !('files' in packed)
  ) {
    throw new Error(`pnpm pack returned invalid metadata: ${output}`)
  }

  const packedFiles: unknown = packed.files
  if (!Array.isArray(packedFiles)) {
    throw new Error(`pnpm pack returned invalid metadata: ${output}`)
  }
  const rawFiles: readonly unknown[] = packedFiles

  const files: { path: string }[] = []
  for (const file of rawFiles) {
    if (
      typeof file !== 'object'
      || file === null
      || Array.isArray(file)
      || !('path' in file)
      || typeof file.path !== 'string'
    ) {
      throw new Error(`pnpm pack returned invalid file metadata: ${output}`)
    }
    files.push({ path: file.path })
  }

  return { filename: packed.filename, files }
}

function parseConsumerOutput(output: string): ConsumerOutput {
  const parsed: unknown = JSON.parse(output)
  if (
    typeof parsed !== 'object'
    || parsed === null
    || Array.isArray(parsed)
    || !('resolved' in parsed)
    || typeof parsed.resolved !== 'string'
    || !('patch' in parsed)
    || typeof parsed.patch !== 'string'
  ) {
    throw new Error(`packed consumer returned invalid output: ${output}`)
  }
  return { resolved: parsed.resolved, patch: parsed.patch }
}

async function execWithDiagnostics(file: string, args: readonly string[], options: ExecOptions = {}): Promise<ChildOutput> {
  try {
    const result = await exec(file, args, { ...options, encoding: 'utf8' })
    return {
      stdout: normalizeChildOutput(result.stdout),
      stderr: normalizeChildOutput(result.stderr),
    }
  } catch (error) {
    const failure = error as { stdout?: unknown; stderr?: unknown }
    const message = error instanceof Error ? error.message : 'Child process failed'
    const diagnostics = [message, normalizeChildOutput(failure.stdout).trim(), normalizeChildOutput(failure.stderr).trim()].filter(Boolean).join('\n')
    throw new Error(diagnostics, { cause: error })
  }
}

async function runNode(cwd: string, source: string): Promise<string> {
  const script = join(cwd, `.dsh-llmwiki-probe-${randomUUID()}.mjs`)
  try {
    await writeFile(script, source)
    return (await execWithDiagnostics(process.execPath, [script], { cwd, env: cleanEnvironment() })).stdout.trim()
  } finally {
    await rm(script, { force: true })
  }
}

describe('built package contract', () => {
  it('loads only the public built entry, preserves named exports, and has no default export', async () => {
    const probeRoot = await mkdtemp(join(tmpdir(), 'dsh-llmwiki-built-entry-probe-'))
    try {
      const packageDirectory = join(probeRoot, 'node_modules', 'dsh-llmwiki')
      await mkdir(join(probeRoot, 'node_modules'), { recursive: true })
      await symlink(process.cwd(), packageDirectory, 'dir')
      await writeFile(join(probeRoot, 'package.json'), JSON.stringify({ private: true, type: 'module' }))

      const output = await runNode(probeRoot, `
        const module = await import('dsh-llmwiki')
        const resolved = import.meta.resolve('dsh-llmwiki')
        if (!resolved.endsWith('/lib/index.js')) throw new Error('public entry did not resolve to lib/index.js: ' + resolved)
        if ('default' in module) throw new Error('dsh-llmwiki must not expose a default export')
        if (module.name !== 'llmwiki') throw new Error('wrong plugin name')
        if (JSON.stringify(module.inject) !== JSON.stringify(['tools', 'commands', 'systemPrompt'])) throw new Error('wrong inject contract')
        if (!module.apply || !module.Config || !module.LlmWikiService) throw new Error('missing named exports')
        if (Error().stack.includes('/src/')) throw new Error('source/private import regression')
        console.log(Object.keys(module).sort().join(','))
      `)
      expect(output).toContain('apply')
      expect(output).not.toContain('default')
    } finally {
      await rm(probeRoot, { recursive: true, force: true })
    }
  })

  it('loads the packed tarball through the real Loader using the bare package name', async () => {
    const consumer = await temporaryDirectory('dsh-llmwiki-packed-consumer-')
    const packDirectory = await temporaryDirectory('dsh-llmwiki-pack-output-')
    const pack = await execWithDiagnostics('pnpm', ['pack', '--json', '--pack-destination', packDirectory], { cwd: process.cwd(), env: cleanEnvironment() })
    const packed = parsePackMetadata(pack.stdout)
    const tarball = isAbsolute(packed.filename) ? packed.filename : join(packDirectory, packed.filename)
    expect(packed.files.map(file => file.path)).not.toContainEqual(expect.stringMatching(/(^|\/)src\//u))
    const archive = await execWithDiagnostics('tar', ['-tzf', tarball], { env: cleanEnvironment() })
    expect(archive.stdout.split('\n')).not.toContainEqual(expect.stringMatching(/^package\/src\//u))

    await writeFile(join(consumer, 'package.json'), JSON.stringify({ private: true, type: 'module' }))
    await execWithDiagnostics('pnpm', ['add', '--ignore-scripts', tarball, '@deepseek-ai/cordis@4.0.1', '@deepseek-ai/cordis-plugin-loader@1.0.2', 'node-addon-require-builtin@0.1.4', '@deepseek-ai/dsh-commands@0.1.0-rc.6', '@deepseek-ai/dsh-system-prompt@0.1.0-rc.6', '@deepseek-ai/dsh-tools@0.1.0-rc.6', 'js-yaml@4.1.0'], { cwd: consumer, env: cleanEnvironment() })
    await writeFile(join(consumer, 'consumer.ts'), `
      import { apply, Config, LlmWikiService, type LlmWikiConfig, type WikiStatus } from 'dsh-llmwiki'
      const config: LlmWikiConfig = Config({ root: '.llmwiki' })
      const status: WikiStatus | undefined = undefined
      void apply
      void LlmWikiService
      console.log(config.root === '.llmwiki' && status === undefined)
    `)
    await writeFile(join(consumer, 'tsconfig.json'), JSON.stringify({ compilerOptions: { module: 'NodeNext', moduleResolution: 'NodeNext', strict: true, outDir: 'dist' }, files: ['consumer.ts'] }))
    const typescript = join(process.cwd(), 'node_modules', 'typescript', 'bin', 'tsc')
    await execWithDiagnostics(process.execPath, [typescript, '-p', 'tsconfig.json'], { cwd: consumer, env: cleanEnvironment() })
    expect(await runNode(consumer, `import './dist/consumer.js'`)).toBe('true')
    const declarations = await readFile(join(consumer, 'node_modules', 'dsh-llmwiki', 'lib', 'types', 'index.d.ts'), 'utf8')
    expect(declarations).not.toMatch(/export\s+default/u)
    const output = await runNode(consumer, `
      import { readFile } from 'node:fs/promises'
      import { Context } from '@deepseek-ai/cordis'
      import Loader from '@deepseek-ai/cordis-plugin-loader'
      import { load } from 'js-yaml'
      import 'node-addon-require-builtin'
      const resolved = import.meta.resolve('dsh-llmwiki')
      const patch = import.meta.resolve('dsh-llmwiki/cordis.patch.yml')
      if (!resolved.includes('/node_modules/dsh-llmwiki/lib/index.js')) throw new Error('packed probe bypassed temp node_modules/lib entry: ' + resolved)
      const imported = await import('dsh-llmwiki')
      if ('default' in imported) throw new Error('default export regression')
      const parsedPatch = load(await readFile(new URL(patch), 'utf8'))
      if (!Array.isArray(parsedPatch) || parsedPatch[0]?.insert?.[0]?.name !== 'dsh-llmwiki') throw new Error('canonical patch did not parse')
      const ctx = new Context()
      const loader = ctx.plugin(Loader, { baseUrl: import.meta.url })
      await loader.await()
      await ctx.loader.create({ name: '@deepseek-ai/dsh-tools', config: { mode: 'native' } })
      await ctx.loader.create({ name: '@deepseek-ai/dsh-commands' })
      await ctx.loader.create({ name: '@deepseek-ai/dsh-system-prompt' })
      await ctx.loader.create({
        name: 'dsh-llmwiki',
        inject: ['tools', 'commands', 'systemPrompt'],
        config: parsedPatch[0].insert[0].config,
      })
      await ctx.loader.await()
      const result = await ctx.tools.execute({ callId: 'packed-status', name: 'llmwiki_status', arguments: {}, signal: new AbortController().signal })
      if (result.isError || !result.value.initialized) throw new Error('packed status failed')
      console.log(JSON.stringify({ resolved, patch }))
      await loader.dispose()
    `)
    const parsed = parseConsumerOutput(output)
    expect(parsed.resolved).toContain('/node_modules/dsh-llmwiki/lib/index.js')
    expect(parsed.patch).toContain('/node_modules/dsh-llmwiki/cordis.patch.yml')
  }, 180_000)
})
