import { execFile, type ExecFileOptionsWithStringEncoding } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { access, cp, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative, sep } from 'node:path'
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
  paths: Record<string, string>
}
interface TreeManifestEntry {
  path: string
  sha256: string
}



interface ReleaseProbeOutput {
  enabled: boolean
  sourceId?: string
  pluginPath?: string
  promptCount: number
  toolNames: string[]
  commandNames: string[]
  lintResult?: string
}

function exec(file: string, args: readonly string[], options: ExecFileOptionsWithStringEncoding): Promise<ChildOutput> {
  const { promise, resolve, reject } = Promise.withResolvers<ChildOutput>()
  execFile(file, args, options, (error, stdout, stderr) => {
    if (error !== null) {
      reject(Object.assign(error, { stdout, stderr }))
      return
    }
    resolve({ stdout, stderr })
  })
  return promise
}

const temporaryDirectories: string[] = []

afterEach(async () => Promise.all(temporaryDirectories.splice(0).map(path => rm(path, { recursive: true, force: true }))))

async function temporaryDirectory(prefix: string): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), prefix))
  temporaryDirectories.push(path)
  return path
}
async function withRepositorySourcesUnavailable<T>(operation: () => Promise<T>): Promise<T> {
  const repository = process.cwd()
  const paths = ['src', 'node_modules'].map(name => ({
    original: join(repository, name),
    hidden: join(repository, `.${name}.packed-probe-hidden-${randomUUID()}`),
  }))
  const moved: typeof paths = []
  let outcome: { value: T } | undefined
  let operationError: unknown
  try {
    for (const path of paths) {
      await rename(path.original, path.hidden)
      moved.push(path)
    }
    outcome = { value: await operation() }
  } catch (error) {
    operationError = error
  }

  const restorationErrors: unknown[] = []
  for (const path of moved.toReversed()) {
    try {
      await rename(path.hidden, path.original)
    } catch (error) {
      restorationErrors.push(error)
    }
  }
  if (restorationErrors.length > 0) {
    throw new AggregateError(
      restorationErrors,
      'failed to restore repository directories after packed probe',
      operationError === undefined ? undefined : { cause: operationError },
    )
  }
  if (operationError !== undefined) {
    throw new Error('packed probe operation failed before repository restoration', { cause: operationError })
  }
  if (outcome === undefined) throw new Error('packed probe completed without an outcome')
  return outcome.value
}

async function createTreeManifest(root: string): Promise<TreeManifestEntry[]> {
  const files: string[] = []
  const visit = async (directory: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true })
    for (const entry of entries.toSorted((left, right) => left.name.localeCompare(right.name, 'en'))) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) {
        await visit(path)
      } else if (entry.isFile()) {
        files.push(path)
      } else {
        throw new Error(`unexpected non-file entry in durable wiki tree: ${path}`)
      }
    }
  }
  await visit(root)
  return Promise.all(files.map(async path => ({
    path: relative(root, path).split(sep).join('/'),
    sha256: await hashFile(path),
  })))
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
    throw new Error(`npm pack returned invalid JSON: ${output}`, { cause: error })
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
    throw new Error(`npm pack returned invalid metadata: ${output}`)
  }

  const packedFiles: unknown = packed.files
  if (!Array.isArray(packedFiles)) {
    throw new Error(`npm pack returned invalid metadata: ${output}`)
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
      throw new Error(`npm pack returned invalid file metadata: ${output}`)
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
    || !('paths' in parsed)
    || typeof parsed.paths !== 'object'
    || parsed.paths === null
    || Array.isArray(parsed.paths)
  ) {
    throw new Error(`packed consumer returned invalid output: ${output}`)
  }

  const paths: Record<string, string> = {}
  for (const [name, path] of Object.entries(parsed.paths)) {
    if (typeof path !== 'string') {
      throw new Error(`packed consumer returned invalid path for ${name}: ${output}`)
    }
    paths[name] = path
  }
  return { paths }
}


function parseReleaseProbeOutput(output: string): ReleaseProbeOutput {
  const parsed: unknown = JSON.parse(output)
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`release probe returned invalid output: ${output}`)
  }
  const enabled = 'enabled' in parsed && typeof parsed.enabled === 'boolean' ? parsed.enabled : undefined
  const rawToolNames: unknown = 'toolNames' in parsed ? parsed.toolNames : undefined
  const rawCommandNames: unknown = 'commandNames' in parsed ? parsed.commandNames : undefined
  if (enabled === undefined || !Array.isArray(rawToolNames) || !Array.isArray(rawCommandNames)) {
    throw new Error(`release probe returned invalid output: ${output}`)
  }
  const toolValues: readonly unknown[] = rawToolNames
  const commandValues: readonly unknown[] = rawCommandNames
  if (!toolValues.every(name => typeof name === 'string') || !commandValues.every(name => typeof name === 'string')) {
    throw new Error(`release probe returned invalid output: ${output}`)
  }
  const sourceId = 'sourceId' in parsed && typeof parsed.sourceId === 'string' ? parsed.sourceId : undefined
  const pluginPath = 'pluginPath' in parsed && typeof parsed.pluginPath === 'string' ? parsed.pluginPath : undefined
  const promptCount = 'promptCount' in parsed && typeof parsed.promptCount === 'number' ? parsed.promptCount : undefined
  const lintResult = 'lintResult' in parsed && typeof parsed.lintResult === 'string' ? parsed.lintResult : undefined
  if (promptCount === undefined || (enabled && lintResult === undefined)) {
    throw new Error(`release probe returned invalid output: ${output}`)
  }
  return {
    enabled,
    ...(sourceId === undefined ? {} : { sourceId }),
    ...(pluginPath === undefined ? {} : { pluginPath }),
    promptCount,
    toolNames: toolValues.map(name => String(name)),
    commandNames: commandValues.map(name => String(name)),
    ...(lintResult === undefined ? {} : { lintResult }),
  }
}

async function hashFile(path: string): Promise<string> {
  return createHash('sha256').update(await readFile(path)).digest('hex')
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
      await execWithDiagnostics('npm', ['run', 'prepack'], { cwd: process.cwd(), env: cleanEnvironment() })
      const packageDirectory = join(probeRoot, 'node_modules', 'dsh-llmwiki')
      await mkdir(packageDirectory, { recursive: true })
      await cp(join(process.cwd(), 'lib'), join(packageDirectory, 'lib'), { recursive: true })
      await cp(join(process.cwd(), 'package.json'), join(packageDirectory, 'package.json'))
      await cp(join(process.cwd(), 'cordis.patch.yml'), join(packageDirectory, 'cordis.patch.yml'))
      await symlink(join(process.cwd(), 'node_modules'), join(packageDirectory, 'node_modules'), 'dir')
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
    const consumer = await temporaryDirectory('dwc-')
    const packDirectory = await temporaryDirectory('dwp-')
    const staleMarker = join(process.cwd(), 'lib', '.stale-prepack-marker')
    await mkdir(join(process.cwd(), 'lib'), { recursive: true })
    await writeFile(staleMarker, 'stale')
    await execWithDiagnostics('npm', ['run', 'prepack'], { cwd: process.cwd(), env: cleanEnvironment() })
    await expect(access(staleMarker)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(access(join(process.cwd(), 'lib', 'index.js'))).resolves.toBeUndefined()

    const pack = await execWithDiagnostics('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', packDirectory], { cwd: process.cwd(), env: cleanEnvironment() })
    const packed = parsePackMetadata(pack.stdout)
    const tarball = isAbsolute(packed.filename) ? packed.filename : join(packDirectory, packed.filename)
    expect(packed.files.map(file => file.path)).not.toContainEqual(expect.stringMatching(/(^|\/)src\//u))
    const archive = await execWithDiagnostics('tar', ['-tzf', tarball], { env: cleanEnvironment() })
    expect(archive.stdout.split('\n')).not.toContainEqual(expect.stringMatching(/^package\/src\//u))

    await writeFile(join(consumer, 'package.json'), JSON.stringify({ private: true, type: 'module' }))
    await execWithDiagnostics('pnpm', ['add', '--ignore-scripts', '--ignore-workspace', '--lockfile-dir=.', '--virtual-store-dir=node_modules/.pnpm', tarball, '@deepseek-ai/cordis@4.0.1', '@deepseek-ai/cordis-plugin-loader@1.0.2', 'node-addon-require-builtin@0.1.4', '@deepseek-ai/dsh-brand@0.1.0-rc.6', '@deepseek-ai/dsh-commands@0.1.0-rc.6', '@deepseek-ai/dsh-session@0.1.0-rc.6', '@deepseek-ai/dsh-system-prompt@0.1.0-rc.6', '@deepseek-ai/dsh-tools@0.1.0-rc.6', 'js-yaml@4.1.0', 'typescript@6.0.3'], { cwd: consumer, env: cleanEnvironment() })
    await writeFile(join(consumer, 'consumer.ts'), `
      import { apply, Config, LlmWikiService, type LlmWikiConfig, type WikiStatus } from 'dsh-llmwiki'
      const config: LlmWikiConfig = Config({ root: '.llmwiki' })
      const status: WikiStatus | undefined = undefined
      void apply
      void LlmWikiService
      console.log(config.root === '.llmwiki' && status === undefined)
    `)
    await writeFile(join(consumer, 'tsconfig.json'), JSON.stringify({ compilerOptions: { module: 'NodeNext', moduleResolution: 'NodeNext', strict: true, outDir: 'dist' }, files: ['consumer.ts'] }))
    const consumerRealPath = await realpath(consumer)
    const repositoryRealPath = await realpath(process.cwd())
    const repositoryNodeModulesRealPath = await realpath(join(process.cwd(), 'node_modules'))
    const typescript = await realpath(join(consumer, 'node_modules', 'typescript', 'bin', 'tsc'))
    expect(typescript.startsWith(`${consumerRealPath}/node_modules/`)).toBe(true)
    const typescriptManifest: unknown = JSON.parse(await readFile(join(consumer, 'node_modules', 'typescript', 'package.json'), 'utf8'))
    expect(typescriptManifest).toMatchObject({ name: 'typescript', version: '6.0.3' })
    expect([repositoryRealPath, repositoryNodeModulesRealPath].some(root => typescript === root || typescript.startsWith(`${root}/`))).toBe(false)
    await withRepositorySourcesUnavailable(async () => {
      await execWithDiagnostics(process.execPath, [typescript, '-p', 'tsconfig.json'], { cwd: consumer, env: cleanEnvironment() })
      expect(await runNode(consumer, `import './dist/consumer.js'`)).toBe('true')
    })
    const declarations = await readFile(join(consumer, 'node_modules', 'dsh-llmwiki', 'lib', 'types', 'index.d.ts'), 'utf8')
    expect(declarations).not.toMatch(/export\s+default/u)
    const output = await withRepositorySourcesUnavailable(() => runNode(consumer, `
      import { readFile, realpath } from 'node:fs/promises'
      import { fileURLToPath } from 'node:url'
      import { Context } from '@deepseek-ai/cordis'
      import Loader from '@deepseek-ai/cordis-plugin-loader'
      import { load } from 'js-yaml'
      import 'node-addon-require-builtin'

      const consumerRoot = ${JSON.stringify(consumerRealPath)}
      const forbiddenRoots = [${JSON.stringify(repositoryRealPath)}, ${JSON.stringify(repositoryNodeModulesRealPath)}]
      const specifiers = {
        entry: 'dsh-llmwiki',
        patch: 'dsh-llmwiki/cordis.patch.yml',
        loader: '@deepseek-ai/cordis-plugin-loader',
        helper: 'node-addon-require-builtin',
        cordis: '@deepseek-ai/cordis',
        brand: '@deepseek-ai/dsh-brand',
        commands: '@deepseek-ai/dsh-commands',
        session: '@deepseek-ai/dsh-session',
        systemPrompt: '@deepseek-ai/dsh-system-prompt',
        tools: '@deepseek-ai/dsh-tools',
        typescript: 'typescript',
      }
      const paths = {}
      for (const [name, specifier] of Object.entries(specifiers)) {
        const resolved = import.meta.resolve(specifier)
        if (!resolved.startsWith('file:')) throw new Error(name + ' did not resolve to a file URL: ' + resolved)
        const canonical = await realpath(fileURLToPath(resolved))
        const consumerModules = consumerRoot + '/node_modules/'
        if (!canonical.startsWith(consumerModules)) throw new Error(name + ' escaped disposable consumer node_modules: ' + canonical)
        if (forbiddenRoots.some(root => canonical === root || canonical.startsWith(root + '/'))) throw new Error(name + ' resolved through repository: ' + canonical)
        if (canonical.includes('/workspace/') || canonical.includes('/file:') || canonical.includes('/src/')) throw new Error(name + ' resolved through workspace/file/source path: ' + canonical)
        paths[name] = canonical
      }
      if (!paths.entry.endsWith('/lib/index.js')) throw new Error('packed entry did not resolve to lib/index.js: ' + paths.entry)
      if (!paths.patch.endsWith('/cordis.patch.yml')) throw new Error('packed patch did not resolve canonically: ' + paths.patch)

      const imported = await import('dsh-llmwiki')
      if ('default' in imported) throw new Error('default export regression')
      const parsedPatch = load(await readFile(paths.patch, 'utf8'))
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
      console.log(JSON.stringify({ paths }))
      await loader.dispose()
    `))
    const parsed = parseConsumerOutput(output)
    expect(Object.keys(parsed.paths).sort()).toEqual(['brand', 'commands', 'cordis', 'entry', 'helper', 'loader', 'patch', 'session', 'systemPrompt', 'tools', 'typescript'])
    expect(parsed.paths.typescript).toContain('/node_modules/.pnpm/typescript@6.0.3/')
    expect(parsed.paths.entry).toContain('/node_modules/.pnpm/')
    expect(parsed.paths.entry).toMatch(/\/node_modules\/\.pnpm\/[^/]+\/node_modules\/dsh-llmwiki\/lib\/index\.js$/u)
    expect(parsed.paths.patch).toMatch(/\/node_modules\/\.pnpm\/[^/]+\/node_modules\/dsh-llmwiki\/cordis\.patch\.yml$/u)
  }, 180_000)

  it('survives the packed DSH profile add, disable, remove, and re-add lifecycle', async () => {
    const packDirectory = await temporaryDirectory('dsh-llmwiki-release-pack-')
    const hostRoot = await temporaryDirectory('dsh-llmwiki-release-host-')
    const dshHome = await temporaryDirectory('dsh-llmwiki-release-home-')
    const projectRoot = await temporaryDirectory('dsh-llmwiki-release-project-')
    const storeRoot = await temporaryDirectory('dsh-llmwiki-release-store-')
    const probeRoot = await temporaryDirectory('dsh-llmwiki-release-probes-')
    const profileName = 'llmwiki-release'
    const profileRoot = join(dshHome, 'profiles', profileName)

    await execWithDiagnostics('npm', ['run', 'prepack'], { cwd: process.cwd(), env: cleanEnvironment() })
    const pack = parsePackMetadata((await execWithDiagnostics('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', packDirectory], { cwd: process.cwd(), env: cleanEnvironment() })).stdout)
    const tarball = isAbsolute(pack.filename) ? pack.filename : join(packDirectory, pack.filename)
    await writeFile(join(hostRoot, 'package.json'), JSON.stringify({ private: true }))
    await writeFile(join(hostRoot, 'pnpm-workspace.yaml'), [
      'nodeLinker: hoisted',
      'allowBuilds:',
      "  '@deepseek-ai/dsh-subprocess-local@0.1.0-rc.6': true",
      "  '@google/genai@1.52.0': true",
      "  'koffi@3.1.4': true",
      "  'node-pty@1.1.0': true",
      "  'protobufjs@7.6.5': true",
      '',
    ].join('\n'))
    const environment = {
      ...cleanEnvironment(),
      DSH_HOME: dshHome,
      DSH_TELEMETRY_DISABLED: '1',
      DEEPSEEK_API_KEY: '',
      npm_config_store_dir: storeRoot,
      PNPM_STORE_DIR: storeRoot,
    }
    await execWithDiagnostics('pnpm', ['add', '--save-exact', '@deepseek-ai/dsh@0.1.0-rc.6'], { cwd: hostRoot, env: environment })
    const ignoredBuilds = await execWithDiagnostics('pnpm', ['ignored-builds'], { cwd: hostRoot, env: environment })
    expect(ignoredBuilds.stdout).toMatch(/(?:^|\n)\s*None\s*(?:\n|$)/u)
    const dshBinary = await realpath(join(hostRoot, 'node_modules', '.bin', 'dsh'))
    const hostRealPath = await realpath(hostRoot)
    const repositoryRealPath = await realpath(process.cwd())
    const repositoryNodeModulesRealPath = await realpath(join(process.cwd(), 'node_modules'))
    expect(dshBinary.startsWith(`${hostRealPath}/node_modules/`)).toBe(true)
    expect([repositoryRealPath, repositoryNodeModulesRealPath].some(root => dshBinary === root || dshBinary.startsWith(`${root}/`))).toBe(false)

    const runDsh = async (args: readonly string[]) => execWithDiagnostics(process.execPath, [dshBinary, ...args], { cwd: projectRoot, env: environment })
    await runDsh(['plugin', '--profile', profileName, 'add', '--ignore-scripts', tarball])
    const dump = await runDsh(['--profile', profileName, '--dump-config'])
    expect(dump.stdout).toContain('dsh-llmwiki')

    const enabledProbe = join(probeRoot, 'enabled-probe.mjs')
    const absentProbe = join(probeRoot, 'absent-probe.mjs')
    const expectedPromptText = `Use the llmwiki as durable, evidence-backed memory:
- Call llmwiki_status before relying on the wiki.
- Search first, then read only the relevant pages and immutable source records.
- Treat wiki pages as synthesized notes; source records are the preserved evidence.
- Cite real source IDs in every page write. Never invent a source ID.
- Use llmwiki_upsert_page only when new evidence changes durable knowledge.
- llmwiki_lint is read-only. Do not claim that it repaired anything.`
    await writeFile(enabledProbe, `
      import { createRequire } from 'node:module'
      import { realpath, writeFile } from 'node:fs/promises'
      import { join } from 'node:path'

      export const name = 'llmwiki-release-enabled-probe'
      export const inject = ['tools', 'commands', 'systemPrompt', 'llmwiki']
      const normalize = value => {
        if (Array.isArray(value)) return value.map(normalize)
        if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right, 'en')).map(([key, entry]) => [key, normalize(entry)]))
        return value
      }
      export async function apply(ctx, config) {
        const invoke = async (name, args) => {
          const result = await ctx.tools.execute({ callId: 'release-' + name, name, arguments: args, signal: new AbortController().signal })
          if (result.isError) throw result.error ?? new Error('tool failed: ' + name)
          return result.value
        }
        const status = await invoke('llmwiki_status', {})
        if (!status.initialized) throw new Error('status tool reported an uninitialized wiki')

        let sourceId
        if (config.mode === 'initial') {
          const source = await invoke('llmwiki_add_source', { name: 'Release evidence', content: 'Packed profile durable evidence.', origin: 'release-e2e' })
          sourceId = source.id
          await invoke('llmwiki_upsert_page', { id: 'release-page', title: 'Release page', summary: 'Packed release lifecycle.', sources: [sourceId], body: '# Release page\\n\\nPacked profile durable evidence.' })
        } else if (config.mode === 'restored') {
          sourceId = config.expectedSourceId
          if (typeof sourceId !== 'string') throw new Error('restored probe omitted expected source ID')
        } else {
          throw new Error('unknown enabled probe mode: ' + config.mode)
        }

        const readSource = await invoke('llmwiki_read_source', { id: sourceId })
        if (readSource.id !== sourceId || readSource.content !== 'Packed profile durable evidence.') throw new Error('source round trip failed')
        const page = await invoke('llmwiki_read_page', { id: 'release-page' })
        const expectedPage = '---\\ntitle: "Release page"\\nsummary: "Packed release lifecycle."\\nsources:\\n  - "' + sourceId + '"\\n---\\n\\n# Release page\\n\\nPacked profile durable evidence.\\n'
        if (page.id !== 'release-page' || page.markdown !== expectedPage) throw new Error('page round trip failed')
        const search = await invoke('llmwiki_search', { query: 'durable evidence' })
        if (!Array.isArray(search) || search[0]?.pageId !== 'release-page') throw new Error('search failed')
        const lint = await invoke('llmwiki_lint', {})
        if (lint.errorCount !== 0) throw new Error('lint tool reported errors')
        const lintResult = JSON.stringify(normalize(lint))

        const agent = new Proxy({ session: { append: () => ({ seq: 0 }) } }, { get: (target, property) => property === 'session' ? target.session : () => undefined })
        const commandLines = config.mode === 'initial' ? ['/wiki status', '/wiki lint', '/wiki reindex'] : ['/wiki status', '/wiki lint']
        for (const line of commandLines) {
          const command = await ctx.commands.execute(agent, line, new AbortController().signal)
          if (!command || command.result.kind !== 'success') throw new Error('command failed: ' + line)
        }

        const toolNames = ctx.tools.schemas().map(schema => schema.name).filter(name => name.startsWith('llmwiki_')).sort()
        const commandNames = ctx.commands.list(agent).map(command => command.name).filter(name => name === 'wiki').sort()
        if (toolNames.length !== 7 || new Set(toolNames).size !== 7 || commandNames.length !== 1) throw new Error('duplicate or missing registrations')
        if (ctx.get('llmwiki') === undefined) throw new Error('llmwiki profile service is absent')
        const promptSections = (await ctx.systemPrompt.assemble()).sections.filter(section => section.name === 'tool:llmwiki')
        if (promptSections.length !== 1 || promptSections[0].text !== ${JSON.stringify(expectedPromptText)}) throw new Error('llmwiki prompt section mismatch')

        const require = createRequire(join(config.profileRoot, 'package.json'))
        const pluginPath = await realpath(require.resolve('dsh-llmwiki'))
        const profileModules = await realpath(join(config.profileRoot, 'node_modules'))
        if (!pluginPath.startsWith(profileModules + '/')) throw new Error('plugin escaped profile node_modules: ' + pluginPath)
        if (config.forbiddenRoots.some(root => pluginPath === root || pluginPath.startsWith(root + '/'))) throw new Error('plugin resolved through repository: ' + pluginPath)
        if (!pluginPath.endsWith('/lib/index.js') || pluginPath.includes('/src/') || pluginPath.includes('/file:')) throw new Error('plugin did not resolve to packed lib entry: ' + pluginPath)

        await writeFile(config.marker, JSON.stringify({ enabled: true, sourceId, pluginPath, promptCount: promptSections.length, toolNames, commandNames, lintResult }))
        setTimeout(() => process.kill(process.pid, 'SIGTERM'), 0)
      }
    `)
    await writeFile(absentProbe, `
      import { writeFile } from 'node:fs/promises'

      export const name = 'llmwiki-release-absent-probe'
      export const inject = ['tools', 'commands', 'systemPrompt']
      export async function apply(ctx, config) {
        const agent = { session: { append: () => ({ seq: 0 }) } }
        const toolNames = ctx.tools.schemas().map(schema => schema.name).filter(name => name.startsWith('llmwiki_')).sort()
        const commandNames = ctx.commands.list(agent).map(command => command.name).filter(name => name === 'wiki').sort()
        const promptCount = (await ctx.systemPrompt.assemble()).sections.filter(section => section.name === 'tool:llmwiki').length
        if (ctx.get('llmwiki') !== undefined || toolNames.length !== 0 || commandNames.length !== 0 || promptCount !== 0) throw new Error('llmwiki survived disabled or removed profile state')
        await writeFile(config.marker, JSON.stringify({ enabled: false, promptCount, toolNames, commandNames }))
        setTimeout(() => process.kill(process.pid, 'SIGTERM'), 0)
      }
    `)

    const writeProbePatch = async (path: string, modulePath: string, marker: string, mode?: 'initial' | 'restored', expectedSourceId?: string) => writeFile(path, [
      '- insert:',
      '    - id: llmwiki-release-probe',
      `      name: ${JSON.stringify(modulePath)}`,
      '      config:',
      `        marker: ${JSON.stringify(marker)}`,
      `        profileRoot: ${JSON.stringify(profileRoot)}`,
      ...(mode === undefined ? [] : [`        mode: ${JSON.stringify(mode)}`]),
      ...(expectedSourceId === undefined ? [] : [`        expectedSourceId: ${JSON.stringify(expectedSourceId)}`]),
      '        forbiddenRoots:',
      `          - ${JSON.stringify(repositoryRealPath)}`,
      `          - ${JSON.stringify(repositoryNodeModulesRealPath)}`,
      '',
    ].join('\n'))
    const disabledPatch = join(probeRoot, 'disable-llmwiki.patch.yml')
    await writeFile(disabledPatch, '- id: llmwiki\n  disabled: true\n')

    const bootProfile = async (state: 'initial' | 'restored' | 'absent', layers: readonly string[] = [], expectedSourceId?: string): Promise<ReleaseProbeOutput> => {
      const marker = join(probeRoot, `${state}-${randomUUID()}.json`)
      const probePatch = join(probeRoot, `${state}-${randomUUID()}.patch.yml`)
      await writeProbePatch(probePatch, state === 'absent' ? absentProbe : enabledProbe, marker, state === 'absent' ? undefined : state, expectedSourceId)
      await withRepositorySourcesUnavailable(() => runDsh(['--profile', profileName, ...layers.flatMap(path => ['--patch', path]), '--patch', probePatch]))
      return parseReleaseProbeOutput(await readFile(marker, 'utf8'))
    }

    const first = await bootProfile('initial')
    expect(first.toolNames).toEqual(['llmwiki_add_source', 'llmwiki_lint', 'llmwiki_read_page', 'llmwiki_read_source', 'llmwiki_search', 'llmwiki_status', 'llmwiki_upsert_page'])
    expect(first.commandNames).toEqual(['wiki'])
    expect(first.promptCount).toBe(1)
    const profileNodeModulesRealPath = await realpath(join(profileRoot, 'node_modules'))
    expect(first.pluginPath.startsWith(`${profileNodeModulesRealPath}/`)).toBe(true)
    expect(first.pluginPath.endsWith('/dsh-llmwiki/lib/index.js')).toBe(true)
    expect([repositoryRealPath, repositoryNodeModulesRealPath].some(root => first.pluginPath === root || first.pluginPath.startsWith(`${root}/`))).toBe(false)
    expect(first.pluginPath).not.toContain('/src/')
    if (first.sourceId === undefined) throw new Error('enabled release probe omitted sourceId')
    const wikiRoot = join(projectRoot, '.llmwiki')
    const sourcePath = join(wikiRoot, 'sources', first.sourceId, 'content')
    const pagePath = join(wikiRoot, 'pages', 'release-page.md')
    expect(await readFile(sourcePath, 'utf8')).toBe('Packed profile durable evidence.')
    expect(await readFile(pagePath, 'utf8')).toContain('Packed profile durable evidence.')
    const durableManifest = await createTreeManifest(wikiRoot)
    expect(durableManifest.some(entry => entry.path.startsWith('.index/'))).toBe(true)

    const disabled = await bootProfile('absent', [disabledPatch])
    expect(disabled).toMatchObject({ enabled: false, promptCount: 0, toolNames: [], commandNames: [] })
    expect(await createTreeManifest(wikiRoot)).toEqual(durableManifest)

    await runDsh(['plugin', '--profile', profileName, 'remove', 'dsh-llmwiki'])
    const removed = await bootProfile('absent')
    expect(removed).toMatchObject({ enabled: false, promptCount: 0, toolNames: [], commandNames: [] })
    expect(await createTreeManifest(wikiRoot)).toEqual(durableManifest)

    await runDsh(['plugin', '--profile', profileName, 'add', '--offline', '--ignore-scripts', tarball])
    expect(await createTreeManifest(wikiRoot)).toEqual(durableManifest)
    const restored = await bootProfile('restored', [], first.sourceId)
    expect(restored.sourceId).toBe(first.sourceId)
    expect(restored.toolNames).toEqual(first.toolNames)
    expect(restored.commandNames).toEqual(['wiki'])
    expect(restored.promptCount).toBe(1)
    expect(restored.lintResult).toBe(first.lintResult)
    expect(await readFile(sourcePath, 'utf8')).toBe('Packed profile durable evidence.')
    expect(await readFile(pagePath, 'utf8')).toContain('Packed profile durable evidence.')
    expect(await createTreeManifest(wikiRoot)).toEqual(durableManifest)
  }, 300_000)
})
