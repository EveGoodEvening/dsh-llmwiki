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
  runtimeVersions?: Record<string, string>
}

const LEGACY_DSH_RUNTIME_VERSION = '0.1.0-rc.6'
const CURRENT_DSH_VERSION = '0.1.1-rc.2'
const TESTED_DSH_VERSIONS = ['0.1.0-rc.6', CURRENT_DSH_VERSION] as const
const EXPECTED_DSH_RUNTIME_VERSIONS: Record<(typeof TESTED_DSH_VERSIONS)[number], string> = {
  '0.1.0-rc.6': '0.1.0-rc.8',
  [CURRENT_DSH_VERSION]: CURRENT_DSH_VERSION,
}
const DSH_RUNTIME_PACKAGE_NAMES = [
  '@deepseek-ai/dsh-brand',
  '@deepseek-ai/dsh-commands',
  '@deepseek-ai/dsh-session',
  '@deepseek-ai/dsh-system-prompt',
  '@deepseek-ai/dsh-tools',
] as const
const LEGACY_DSH_RUNTIME_PACKAGE_SPECS = DSH_RUNTIME_PACKAGE_NAMES.map(name => `${name}@${LEGACY_DSH_RUNTIME_VERSION}`)

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
  const rawRuntimeVersions: unknown = 'runtimeVersions' in parsed ? parsed.runtimeVersions : undefined
  let runtimeVersions: Record<string, string> | undefined
  if (rawRuntimeVersions !== undefined) {
    if (typeof rawRuntimeVersions !== 'object' || rawRuntimeVersions === null || Array.isArray(rawRuntimeVersions)) {
      throw new Error(`release probe returned invalid output: ${output}`)
    }
    runtimeVersions = {}
    for (const [name, version] of Object.entries(rawRuntimeVersions)) {
      if (typeof version !== 'string') throw new Error(`release probe returned invalid output: ${output}`)
      runtimeVersions[name] = version
    }
  }
  if (promptCount === undefined || (enabled && (lintResult === undefined || runtimeVersions === undefined))) {
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
    ...(runtimeVersions === undefined ? {} : { runtimeVersions }),
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
      const packageDirectory = join(probeRoot, 'node_modules', '@evegoodevening', 'dsh-llmwiki')
      await mkdir(packageDirectory, { recursive: true })
      await cp(join(process.cwd(), 'lib'), join(packageDirectory, 'lib'), { recursive: true })
      await cp(join(process.cwd(), 'package.json'), join(packageDirectory, 'package.json'))
      await cp(join(process.cwd(), 'cordis.patch.yml'), join(packageDirectory, 'cordis.patch.yml'))
      await symlink(join(process.cwd(), 'node_modules'), join(packageDirectory, 'node_modules'), 'dir')
      await writeFile(join(probeRoot, 'package.json'), JSON.stringify({ private: true, type: 'module' }))

      const output = await runNode(probeRoot, `
        // Dynamic import intentionally verifies the isolated installed-package boundary.
        const module = await import('@evegoodevening/dsh-llmwiki')
        const resolved = import.meta.resolve('@evegoodevening/dsh-llmwiki')
        if (!resolved.endsWith('/lib/index.js')) throw new Error('public entry did not resolve to lib/index.js: ' + resolved)
        if ('default' in module) throw new Error('@evegoodevening/dsh-llmwiki must not expose a default export')
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

  it('loads the packed tarball through the real Loader using the scoped package name', async () => {
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
    await execWithDiagnostics('pnpm', [
      'add',
      '--ignore-scripts',
      '--ignore-workspace',
      '--lockfile-dir=.',
      '--virtual-store-dir=node_modules/.pnpm',
      tarball,
      '@deepseek-ai/cordis@4.0.1',
      '@deepseek-ai/cordis-plugin-loader@1.0.2',
      'node-addon-require-builtin@0.1.4',
      ...LEGACY_DSH_RUNTIME_PACKAGE_SPECS,
      'js-yaml@4.1.0',
      'typescript@6.0.3',
    ], { cwd: consumer, env: cleanEnvironment() })
    await writeFile(join(consumer, 'consumer.ts'), `
      import { apply, Config, LlmWikiService, type CatalogRequest, type LlmWikiConfig, type PageCatalogPage, type SourceCatalogPage, type WikiStatus } from '@evegoodevening/dsh-llmwiki'
      const config: LlmWikiConfig = Config({ root: '.llmwiki' })
      const status: WikiStatus | undefined = undefined
      const request: CatalogRequest = { limit: 1 }
      const sourceCatalog: SourceCatalogPage | undefined = undefined
      const pageCatalog: PageCatalogPage | undefined = undefined
      const probeCatalogDeclarations = (service: InstanceType<typeof LlmWikiService>) => {
        const sourceCatalogCall: Promise<SourceCatalogPage> = service.listSources(request, new AbortController().signal)
        const pageCatalogCall: Promise<PageCatalogPage> = service.listPages({ cursor: 'opaque' })
        return { sourceCatalogCall, pageCatalogCall }
      }
      void apply
      void LlmWikiService
      console.log(config.root === '.llmwiki' && status === undefined && request.limit === 1 && sourceCatalog === undefined && pageCatalog === undefined && typeof probeCatalogDeclarations === 'function')
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
    const declarations = await readFile(join(consumer, 'node_modules', '@evegoodevening', 'dsh-llmwiki', 'lib', 'types', 'index.d.ts'), 'utf8')
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
        entry: '@evegoodevening/dsh-llmwiki',
        patch: '@evegoodevening/dsh-llmwiki/cordis.patch.yml',
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

      // Dynamic import intentionally verifies the disposable consumer's package boundary.
      const imported = await import('@evegoodevening/dsh-llmwiki')
      if ('default' in imported) throw new Error('default export regression')
      const parsedPatch = load(await readFile(paths.patch, 'utf8'))
      if (!Array.isArray(parsedPatch) || parsedPatch.length !== 0) throw new Error('canonical patch must parse as exactly an empty array')
      const wikiRoot = consumerRoot + '/packed-loader-wiki'
      const ctx = new Context()
      const loader = ctx.plugin(Loader, { baseUrl: import.meta.url })
      await loader.await()
      await ctx.loader.create({ name: '@deepseek-ai/dsh-tools', config: { mode: 'native' } })
      await ctx.loader.create({ name: '@deepseek-ai/dsh-commands' })
      await ctx.loader.create({ name: '@deepseek-ai/dsh-system-prompt' })
      await ctx.loader.create({
        name: '@evegoodevening/dsh-llmwiki',
        inject: ['tools', 'commands', 'systemPrompt'],
        config: { root: wikiRoot },
      })
      await ctx.loader.await()
      const result = await ctx.tools.execute({ callId: 'packed-status', name: 'llmwiki_status', arguments: {}, signal: new AbortController().signal })
      if (result.isError) throw new Error('packed status failed')
      const status = result.value
      if (status.initialized || status.sourceCount !== 0 || status.pageCount !== 0 || status.schemaText !== null
        || status.index.present || status.index.fresh || status.index.formatVersion !== null || status.index.sectionCount !== 0) {
        throw new Error('packed status did not report an absent wiki')
      }
      console.log(JSON.stringify({ paths }))
      await loader.dispose()
    `))
    const parsed = parseConsumerOutput(output)
    expect(Object.keys(parsed.paths).sort()).toEqual(['brand', 'commands', 'cordis', 'entry', 'helper', 'loader', 'patch', 'session', 'systemPrompt', 'tools', 'typescript'])
    expect(parsed.paths.typescript).toContain('/node_modules/.pnpm/typescript@6.0.3/')
    expect(parsed.paths.entry).toContain('/node_modules/.pnpm/')
    expect(parsed.paths.entry).toMatch(/\/node_modules\/\.pnpm\/[^/]+\/node_modules\/@evegoodevening\/dsh-llmwiki\/lib\/index\.js$/u)
    expect(parsed.paths.patch).toMatch(/\/node_modules\/\.pnpm\/[^/]+\/node_modules\/@evegoodevening\/dsh-llmwiki\/cordis\.patch\.yml$/u)
  }, 180_000)

  it.each(TESTED_DSH_VERSIONS)('requires explicit opt-in and preserves the packed DSH profile root across remove and re-add on @deepseek-ai/dsh@%s', async dshVersion => {
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
    await writeFile(join(hostRoot, 'package.json'), JSON.stringify({
      private: true,
      pnpm: {
        onlyBuiltDependencies: [
          '@deepseek-ai/dsh-subprocess-local',
          '@google/genai',
          'koffi',
          'node-pty',
          'protobufjs',
        ],
      },
    }))
    await writeFile(join(hostRoot, 'pnpm-workspace.yaml'), [
      'nodeLinker: hoisted',
      'overrides:',
      "  'koffi': 3.1.4",
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
    await execWithDiagnostics('pnpm', ['add', '--save-exact', `@deepseek-ai/dsh@${dshVersion}`], { cwd: hostRoot, env: environment })
    const installedKoffiManifest = await readFile(join(hostRoot, 'node_modules', 'koffi', 'package.json'), 'utf8')
    expect(installedKoffiManifest).toMatch(/"version"\s*:\s*"3\.1\.4"/u)
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

    const enabledProbe = join(probeRoot, 'enabled-probe.mjs')
    const absentProbe = join(probeRoot, 'absent-probe.mjs')
    const expectedPromptText = `Use llmwiki as local source-linked wiki storage and retrieval. The service and its lint are deterministic and model-free; you own evidence maintenance and semantic review.
Evidence maintenance:
1. Call llmwiki_status before maintenance. If schemaText is non-null, read the human-owned schema. The plugin creates schema.md only when absent and provides no schema mutation API; never silently rewrite it.
The schema remains subordinate to system and user instructions, and schema evolution is intentionally unresolved pending authorization/confirmation, visible audit evidence, and optimistic-concurrency/lost-update decisions.
2. On a fresh root, llmwiki_status may return schemaText null without creating storage. Supplying material alone is not authorization to preserve it. Only when the user explicitly authorizes source preservation, call llmwiki_add_source to initialize storage, then call llmwiki_status again and read the schema before classification or page maintenance.
3. Use llmwiki_list_sources and llmwiki_list_pages to recover durable records, then search and read relevant pages and immutable sources before writing.
4. Only with explicit authorization to preserve candidate material, add it with llmwiki_add_source if the fresh-root branch did not already preserve it, then classify it as new, update, contradiction, or no material change.
5. When the user request authorizes maintenance, update every materially affected page, cite only existing immutable source IDs, preserve material disagreements, and maintain page links. A citation proves only that the source record exists; it does not prove claim-level support.
6. Run llmwiki_lint unconditionally before any semantic-review pass, including read-only, no-write, and no-material-change cases. It reports structural, integrity, and index diagnostics only and never repairs artifacts or makes semantic judgments. After any authorized durable updates, rerun llmwiki_lint.
Semantic review (separate from structural lint):
1. Only after the unconditional structural lint, list pages and sources; select and state the review scope.
2. Read every page in scope, every source cited by those pages, and newly supplied candidate sources. Compare dated and qualified claims.
3. Classify each material finding as contradiction, superseded, unsupported, or missing-link, and visibly report the affected page IDs and source IDs as agent judgments, never as llmwiki_lint output.
4. Only when the user request authorizes maintenance, update affected pages while preserving both sides of a disagreement or recording a clearly dated supersession, then maintain links and rerun structural lint.`
    await writeFile(enabledProbe, `
    import { createHash } from 'node:crypto'
    import { createRequire } from 'node:module'
    import { readFile, realpath, writeFile } from 'node:fs/promises'
    import { join } from 'node:path'
  
    export const name = 'llmwiki-release-enabled-probe'
    export const inject = ['tools', 'commands', 'systemPrompt', 'llmwiki']
    const normalize = value => {
      if (Array.isArray(value)) return value.map(normalize)
      if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right, 'en')).map(([key, entry]) => [key, normalize(entry)]))
      return value
    }
    export async function apply(ctx, config) {
      const execute = (name, args, signal = new AbortController().signal) => ctx.tools.execute({ callId: 'release-' + name, name, arguments: args, signal })
      const invoke = async (name, args, signal) => {
        const result = await execute(name, args, signal)
        if (result.isError) throw result.error ?? new Error('tool failed: ' + name)
        return result.value
      }
      const status = await invoke('llmwiki_status', {})

      let sourceId
      if (config.mode === 'initial') {
        if (status.initialized || status.sourceCount !== 0 || status.pageCount !== 0 || status.schemaText !== null || status.index.present) {
          throw new Error('initial status did not report an absent wiki')
        }
        const source = await invoke('llmwiki_add_source', { name: 'Release evidence', content: 'Packed profile durable evidence.', origin: 'release-e2e' })
        sourceId = source.id
        const initializedStatus = await invoke('llmwiki_status', {})
        if (!initializedStatus.initialized || initializedStatus.sourceCount !== 1 || initializedStatus.pageCount !== 0 || typeof initializedStatus.schemaText !== 'string') {
          throw new Error('status after authorized source preservation did not expose the initialized schema')
        }
        await invoke('llmwiki_upsert_page', { id: 'release-page', title: 'Release page', summary: 'Packed release lifecycle.', sources: [sourceId], body: '# Release page\\n\\nPacked profile durable evidence.' })
      } else if (config.mode === 'restored') {
        if (!status.initialized || status.sourceCount !== 1 || status.pageCount !== 1) throw new Error('restored status did not report the durable wiki')
        sourceId = config.expectedSourceId
        if (typeof sourceId !== 'string') throw new Error('restored probe omitted expected source ID')
      } else {
        throw new Error('unknown enabled probe mode: ' + config.mode)
      }
  
      const readSource = await invoke('llmwiki_read_source', { id: sourceId })
      if (readSource.id !== sourceId || readSource.content !== 'Packed profile durable evidence.') throw new Error('source round trip failed')
      const sourceCatalog = await invoke('llmwiki_list_sources', { limit: 1, unknown: '/etc/passwd' })
      const expectedSourceCatalogKeys = ['byteCount', 'capturedAt', 'id', 'mediaType', 'name', 'origin']
      if (sourceCatalog.items.length !== 1 || sourceCatalog.items[0]?.id !== sourceId || sourceCatalog.items[0]?.name !== 'Release evidence' || sourceCatalog.items[0]?.mediaType !== 'text/plain; charset=utf-8' || sourceCatalog.items[0]?.byteCount !== 32 || sourceCatalog.items[0]?.origin !== 'release-e2e' || typeof sourceCatalog.items[0]?.capturedAt !== 'string' || sourceCatalog.nextCursor !== null || JSON.stringify(Object.keys(sourceCatalog.items[0]).sort()) !== JSON.stringify(expectedSourceCatalogKeys)) throw new Error('source catalog failed')
      if (!Object.isFrozen(sourceCatalog.items[0])) throw new Error('source catalog item is mutable')
      if ((await invoke('llmwiki_list_sources', {})).items[0]?.name !== 'Release evidence') throw new Error('source catalog result was not detached')
      const page = await invoke('llmwiki_read_page', { id: 'release-page' })
      const expectedPage = '---\\ntitle: "Release page"\\nsummary: "Packed release lifecycle."\\nsources:\\n  - "' + sourceId + '"\\n---\\n\\n# Release page\\n\\nPacked profile durable evidence.\\n'
      if (page.id !== 'release-page' || page.markdown !== expectedPage) throw new Error('page round trip failed')
      const pageCatalog = await invoke('llmwiki_list_pages', { limit: 1, ignored: true })
      const expectedPageHash = createHash('sha256').update(expectedPage).digest('hex')
      const expectedPageCatalogKeys = ['byteCount', 'id', 'sha256', 'sources', 'summary', 'title']
      if (pageCatalog.items.length !== 1 || pageCatalog.items[0]?.id !== 'release-page' || pageCatalog.items[0]?.title !== 'Release page' || pageCatalog.items[0]?.summary !== 'Packed release lifecycle.' || JSON.stringify(pageCatalog.items[0]?.sources) !== JSON.stringify([sourceId]) || pageCatalog.items[0]?.byteCount !== Buffer.byteLength(expectedPage) || pageCatalog.items[0]?.sha256 !== expectedPageHash || pageCatalog.nextCursor !== null || JSON.stringify(Object.keys(pageCatalog.items[0]).sort()) !== JSON.stringify(expectedPageCatalogKeys)) throw new Error('page catalog failed')
      if (!Object.isFrozen(pageCatalog.items[0]?.sources)) throw new Error('page catalog sources are mutable')
      if (JSON.stringify((await invoke('llmwiki_list_pages', {})).items[0]?.sources) !== JSON.stringify([sourceId])) throw new Error('page catalog result was not detached')
      for (const name of ['llmwiki_list_sources', 'llmwiki_list_pages']) {
        const invalid = await execute(name, { limit: 0 })
        if (!invalid.isError) throw new Error(name + ' accepted an invalid limit')
        const controller = new AbortController()
        controller.abort()
        const aborted = await execute(name, {}, controller.signal)
        if (!aborted.isError) throw new Error(name + ' ignored an aborted signal')
      }
      const search = await invoke('llmwiki_search', { query: 'durable evidence' })
      if (!Array.isArray(search) || search[0]?.pageId !== 'release-page') throw new Error('search failed')
      const lint = await invoke('llmwiki_lint', {})
      if (lint.errorCount !== 0) throw new Error('lint tool reported errors')
      const lintResult = JSON.stringify(normalize(lint))
  
      const require = createRequire(join(config.profileRoot, 'package.json'))
      const pluginPath = await realpath(require.resolve('@evegoodevening/dsh-llmwiki'))
      const profileModules = await realpath(join(config.profileRoot, 'node_modules'))
      if (!pluginPath.startsWith(profileModules + '/')) throw new Error('plugin escaped profile node_modules: ' + pluginPath)
      if (config.forbiddenRoots.some(root => pluginPath === root || pluginPath.startsWith(root + '/'))) throw new Error('plugin resolved through repository: ' + pluginPath)
      if (!pluginPath.endsWith('/lib/index.js') || pluginPath.includes('/src/') || pluginPath.includes('/file:')) throw new Error('plugin did not resolve to packed lib entry: ' + pluginPath)
  
      const pluginRequire = createRequire(pluginPath)
      const runtimeVersions = {}
      for (const name of ${JSON.stringify(DSH_RUNTIME_PACKAGE_NAMES)}) {
        const manifest = JSON.parse(await readFile(pluginRequire.resolve(name + '/package.json'), 'utf8'))
        runtimeVersions[name] = manifest.version
      }
      const agent = new Proxy({ session: { append: () => ({ seq: 0 }) } }, { get: (target, property) => property === 'session' ? target.session : () => undefined })
      const commandLines = config.mode === 'initial' ? ['/wiki status', '/wiki lint', '/wiki reindex'] : ['/wiki status', '/wiki lint']
      for (const line of commandLines) {
        const signal = new AbortController().signal
        const command = runtimeVersions['@deepseek-ai/dsh-commands'] === '0.1.0-rc.6'
          ? await ctx.commands.execute(agent, line, signal)
          : await ctx.commands.execute(agent, line, [], signal)
        if (!command || command.result.kind !== 'success') throw new Error('command failed: ' + line)
      }
  
      const toolNames = ctx.tools.schemas().map(schema => schema.name).filter(name => name.startsWith('llmwiki_'))
      const expectedToolNames = ['llmwiki_status', 'llmwiki_add_source', 'llmwiki_list_sources', 'llmwiki_read_source', 'llmwiki_search', 'llmwiki_list_pages', 'llmwiki_read_page', 'llmwiki_upsert_page', 'llmwiki_lint']
      const commandNames = ctx.commands.list(agent).map(command => command.name).filter(name => name === 'wiki').sort()
      if (JSON.stringify(toolNames) !== JSON.stringify(expectedToolNames) || new Set(toolNames).size !== 9 || commandNames.length !== 1) throw new Error('duplicate, missing, or reordered registrations')
      const catalogSchemas = Object.fromEntries(ctx.tools.schemas().filter(schema => schema.name === 'llmwiki_list_sources' || schema.name === 'llmwiki_list_pages').map(schema => [schema.name, schema]))
      for (const name of ['llmwiki_list_sources', 'llmwiki_list_pages']) {
        const parameters = catalogSchemas[name]?.parameters
        const parameterProperties = parameters?.properties
        if (!parameters || parameters.type !== 'object' || !parameterProperties || JSON.stringify(Object.keys(parameterProperties).sort()) !== JSON.stringify(['cursor', 'limit']) || Object.hasOwn(parameters, 'additionalProperties') || Object.hasOwn(parameters, 'required')) throw new Error(name + ' parameter schema is not closed and complete')
        const output = ctx.tools.get(name)?.output?.schema
        if (!output || output.additionalProperties !== false || output.properties?.items?.items?.additionalProperties !== false) throw new Error(name + ' output schema is not closed')
      }
      if (ctx.get('llmwiki') === undefined) throw new Error('llmwiki profile service is absent')
      const promptSections = (await ctx.systemPrompt.assemble()).sections.filter(section => section.name === 'tool:llmwiki')
      if (promptSections.length !== 1 || promptSections[0].text !== ${JSON.stringify(expectedPromptText)}) throw new Error('llmwiki prompt section mismatch')
  
  
      await writeFile(config.marker, JSON.stringify({ enabled: true, sourceId, pluginPath, promptCount: promptSections.length, toolNames, commandNames, lintResult, runtimeVersions }))
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
      `        hostVersion: ${JSON.stringify(dshVersion)}`,
      ...(mode === undefined ? [] : [`        mode: ${JSON.stringify(mode)}`]),
      ...(expectedSourceId === undefined ? [] : [`        expectedSourceId: ${JSON.stringify(expectedSourceId)}`]),
      '        forbiddenRoots:',
      `          - ${JSON.stringify(repositoryRealPath)}`,
      `          - ${JSON.stringify(repositoryNodeModulesRealPath)}`,
      '',
    ].join('\n'))
    const wikiRoot = join(probeRoot, 'explicit-host-wiki')
    const profilePatch = join(profileRoot, 'cordis.patch.yml')
    const writeProfileMount = async (disabled = false) => writeFile(profilePatch, [
      '- insert:',
      '    - id: llmwiki',
      "      name: '@evegoodevening/dsh-llmwiki'",
      '      config:',
      `        root: ${JSON.stringify(wikiRoot)}`,
      '        maxSourceBytes: 2097152',
      '        maxPageBytes: 524288',
      '        maxResults: 20',
      '        maxSnippetBytes: 1200',
      '        commandDiagnosticLimit: 20',
      ...(disabled ? ['- id: llmwiki', '  disabled: true'] : []),
      '',
    ].join('\n'))

    const bootProfile = async (state: 'initial' | 'restored' | 'absent', expectedSourceId?: string): Promise<ReleaseProbeOutput> => {
      const marker = join(probeRoot, `${state}-${randomUUID()}.json`)
      const probePatch = join(probeRoot, `${state}-${randomUUID()}.patch.yml`)
      await writeProbePatch(probePatch, state === 'absent' ? absentProbe : enabledProbe, marker, state === 'absent' ? undefined : state, expectedSourceId)
      await withRepositorySourcesUnavailable(() => runDsh(['--profile', profileName, '--patch', probePatch]))
      return parseReleaseProbeOutput(await readFile(marker, 'utf8'))
    }

    const defaultDisabled = await bootProfile('absent')
    expect(defaultDisabled).toMatchObject({ enabled: false, promptCount: 0, toolNames: [], commandNames: [] })
    await expect(access(wikiRoot)).rejects.toMatchObject({ code: 'ENOENT' })

    await writeProfileMount()
    const first = await bootProfile('initial')
    expect(first.toolNames).toEqual(['llmwiki_status', 'llmwiki_add_source', 'llmwiki_list_sources', 'llmwiki_read_source', 'llmwiki_search', 'llmwiki_list_pages', 'llmwiki_read_page', 'llmwiki_upsert_page', 'llmwiki_lint'])
    expect(first.commandNames).toEqual(['wiki'])
    expect(first.promptCount).toBe(1)
    expect(first.runtimeVersions).toEqual(Object.fromEntries(DSH_RUNTIME_PACKAGE_NAMES.map(name => [name, EXPECTED_DSH_RUNTIME_VERSIONS[dshVersion]])))
    const profileNodeModulesRealPath = await realpath(join(profileRoot, 'node_modules'))
    expect(first.pluginPath.startsWith(`${profileNodeModulesRealPath}/`)).toBe(true)
    expect(first.pluginPath.endsWith('/@evegoodevening/dsh-llmwiki/lib/index.js')).toBe(true)
    expect([repositoryRealPath, repositoryNodeModulesRealPath].some(root => first.pluginPath === root || first.pluginPath.startsWith(`${root}/`))).toBe(false)
    expect(first.pluginPath).not.toContain('/src/')
    if (first.sourceId === undefined) throw new Error('enabled release probe omitted sourceId')
    const sourcePath = join(wikiRoot, 'sources', first.sourceId, 'content')
    const pagePath = join(wikiRoot, 'pages', 'release-page.md')
    expect(await readFile(sourcePath, 'utf8')).toBe('Packed profile durable evidence.')
    expect(await readFile(pagePath, 'utf8')).toContain('Packed profile durable evidence.')
    const durableManifest = await createTreeManifest(wikiRoot)
    expect(durableManifest.some(entry => entry.path.startsWith('.index/'))).toBe(true)

    await writeProfileMount(true)
    const explicitlyDisabled = await bootProfile('absent')
    expect(explicitlyDisabled).toMatchObject({ enabled: false, promptCount: 0, toolNames: [], commandNames: [] })
    expect(await createTreeManifest(wikiRoot)).toEqual(durableManifest)

    await runDsh(['plugin', '--profile', profileName, 'remove', '@evegoodevening/dsh-llmwiki'])
    const removed = await bootProfile('absent')
    expect(removed).toMatchObject({ enabled: false, promptCount: 0, toolNames: [], commandNames: [] })
    expect(await createTreeManifest(wikiRoot)).toEqual(durableManifest)

    await runDsh(['plugin', '--profile', profileName, 'add', '--offline', '--ignore-scripts', tarball])
    expect(await createTreeManifest(wikiRoot)).toEqual(durableManifest)
    const readdedStillDisabled = await bootProfile('absent')
    expect(readdedStillDisabled).toMatchObject({ enabled: false, promptCount: 0, toolNames: [], commandNames: [] })
    await writeProfileMount()
    const restored = await bootProfile('restored', first.sourceId)
    expect(restored.sourceId).toBe(first.sourceId)
    expect(restored.toolNames).toEqual(first.toolNames)
    expect(restored.commandNames).toEqual(['wiki'])
    expect(restored.promptCount).toBe(1)
    expect(restored.runtimeVersions).toEqual(first.runtimeVersions)
    expect(restored.lintResult).toBe(first.lintResult)
    expect(await readFile(sourcePath, 'utf8')).toBe('Packed profile durable evidence.')
    expect(await readFile(pagePath, 'utf8')).toContain('Packed profile durable evidence.')
    expect(await createTreeManifest(wikiRoot)).toEqual(durableManifest)
  }, 300_000)

  it('composed read-only policy keeps llmwiki host-store writes outside the pinned filesystem policy', async () => {
    const packDirectory = await temporaryDirectory('dsh-llmwiki-c21-policy-pack-')
    const runnerRoot = await temporaryDirectory('dsh-llmwiki-c21-policy-runner-')
    const dshHome = await temporaryDirectory('dsh-llmwiki-c21-policy-home-')
    const projectRoot = await temporaryDirectory('dsh-llmwiki-c21-policy-project-')
    const wikiRoot = join(projectRoot, 'wiki')
    const probeRoot = await temporaryDirectory('dsh-llmwiki-c21-policy-probe-')
    const profileName = 'c21-policy'
    const profileRoot = join(dshHome, 'profiles', profileName)
    const fixtureRoot = join(process.cwd(), 'tests', 'fixtures', 'agent-smoke', 'runner')
    const expectedLockHash = 'af12c2caeed081804f6d57fcac547a0686d456696d15c4a4d1b60602bd9797b7'

    await Promise.all(['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml'].map(name => cp(join(fixtureRoot, name), join(runnerRoot, name))))
    const lockPath = join(runnerRoot, 'pnpm-lock.yaml')
    expect(await hashFile(lockPath)).toBe(expectedLockHash)
    const environment = {
      ...cleanEnvironment(),
      DSH_HOME: dshHome,
      DSH_PERMISSION_MODE: 'read-only',
      DSH_TOOLS_MODE: 'native',
      DSH_TELEMETRY_DISABLED: '1',
      DEEPSEEK_API_KEY: '',
    }
    await execWithDiagnostics('pnpm', ['install', '--frozen-lockfile', '--ignore-scripts'], { cwd: runnerRoot, env: environment })
    expect(await hashFile(lockPath)).toBe(expectedLockHash)
    const dshManifest: unknown = JSON.parse(await readFile(join(runnerRoot, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'), 'utf8'))
    expect(dshManifest).toMatchObject({ name: '@deepseek-ai/dsh', version: CURRENT_DSH_VERSION })
    const dshBinary = await realpath(join(runnerRoot, 'node_modules', '.bin', 'dsh'))

    await execWithDiagnostics('npm', ['run', 'prepack'], { cwd: process.cwd(), env: cleanEnvironment() })
    const pack = parsePackMetadata((await execWithDiagnostics('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', packDirectory], { cwd: process.cwd(), env: cleanEnvironment() })).stdout)
    const tarball = isAbsolute(pack.filename) ? pack.filename : join(packDirectory, pack.filename)
    const runDsh = (args: readonly string[]) => execWithDiagnostics(dshBinary, args, { cwd: projectRoot, env: environment })
    await runDsh(['plugin', '--profile', profileName, 'add', '--ignore-scripts', tarball])

    await writeFile(join(profileRoot, 'cordis.patch.yml'), [
      '- id: sandbox-policy',
      '  config:',
      '    mode: read-only',
      `    workspaceRoot: ${JSON.stringify(projectRoot)}`,
      '- insert:',
      '    - id: llmwiki',
      "      name: '@evegoodevening/dsh-llmwiki'",
      '      config:',
      `        root: ${JSON.stringify(wikiRoot)}`,
      '        maxSourceBytes: 2097152',
      '        maxPageBytes: 524288',
      '        maxResults: 20',
      '        maxSnippetBytes: 1200',
      '        commandDiagnosticLimit: 20',
      '',
    ].join('\n'))

    const marker = join(probeRoot, 'result.json')
    const probe = join(probeRoot, 'probe.mjs')
    const probePatch = join(probeRoot, 'probe.patch.yml')
    const stockSentinel = join(projectRoot, 'stock-denied.txt')
    await writeFile(probe, `
      import { access, readFile, writeFile } from 'node:fs/promises'
      import { join } from 'node:path'

      export const name = 'c21-composed-policy-probe'
      export const inject = ['tools', 'commands', 'systemPrompt', 'llmwiki', 'sandboxPolicy', 'fs', 'sandbox']
      export async function apply(ctx, config) {
        if (ctx.sandboxPolicy?.defaultMode !== 'read-only') throw new Error('sandbox-policy is not mounted read-only')
        if (ctx.fs?.sandboxMode !== 'read-only') throw new Error('fs-sandbox is not mounted read-only')
        if (!ctx.get('sandbox')) throw new Error('sandbox runtime capability is absent')
        if (!ctx.get('fs')) throw new Error('filesystem runtime capability is absent')
        const stockWrite = ctx.tools.get('write')
        if (!stockWrite) throw new Error('stock write tool is absent')
        const denial = await ctx.tools.execute({
          callId: 'c21-policy-write',
          name: 'write',
          arguments: { file_path: config.stockSentinel, content: 'stock' },
          signal: new AbortController().signal,
        })
        if (!denial.isError || denial.error?.info?.code !== 'FS_SANDBOX_DENIED') throw new Error('stock write did not return FS_SANDBOX_DENIED: ' + JSON.stringify(denial))
        if (!String(denial.error?.message).includes('[sandbox: file access denied under read-only mode]')) throw new Error('stock denial omitted the read-only marker')
        try { await access(config.stockSentinel); throw new Error('stock write sentinel exists') }
        catch (error) { if (error?.code !== 'ENOENT') throw error }

        const receipt = await ctx.llmwiki.addSource({ name: 'C21 policy probe', content: 'direct Node host-store write', origin: 'C21 policy probe' })
        if (receipt.deduplicated) throw new Error('llmwiki direct write unexpectedly deduplicated')
        const content = await readFile(join(config.wikiRoot, 'sources', receipt.id, 'content'), 'utf8')
        if (content !== 'direct Node host-store write') throw new Error('llmwiki direct host-store write did not persist')
        await writeFile(config.marker, JSON.stringify({
          sandboxPolicyMode: ctx.sandboxPolicy.defaultMode,
          fsSandboxMode: ctx.fs.sandboxMode,
          sandboxMounted: true,
          fsMounted: true,
          writeToolMounted: true,
          denialCode: denial.error.info.code,
          sentinelAbsent: true,
          sourceId: receipt.id,
          sourceContent: content,
        }))
        setTimeout(() => process.kill(process.pid, 'SIGTERM'), 0)
      }
    `)
    await writeFile(probePatch, [
      '- insert:',
      '    - id: c21-composed-policy-probe',
      `      name: ${JSON.stringify(probe)}`,
      '      config:',
      `        marker: ${JSON.stringify(marker)}`,
      `        stockSentinel: ${JSON.stringify(stockSentinel)}`,
      `        wikiRoot: ${JSON.stringify(wikiRoot)}`,
      '',
    ].join('\n'))

    await withRepositorySourcesUnavailable(() => runDsh(['--profile', profileName, '--patch', probePatch]))
    const result: unknown = JSON.parse(await readFile(marker, 'utf8'))
    expect(result).toMatchObject({
      sandboxPolicyMode: 'read-only',
      fsSandboxMode: 'read-only',
      sandboxMounted: true,
      fsMounted: true,
      writeToolMounted: true,
      denialCode: 'FS_SANDBOX_DENIED',
      sentinelAbsent: true,
      sourceContent: 'direct Node host-store write',
    })
    await expect(access(stockSentinel)).rejects.toMatchObject({ code: 'ENOENT' })
    if (typeof result !== 'object' || result === null || Array.isArray(result) || !('sourceId' in result) || typeof result.sourceId !== 'string') {
      throw new Error('C21 composed-policy probe omitted a valid sourceId')
    }
    expect(await readFile(join(wikiRoot, 'sources', result.sourceId, 'content'), 'utf8')).toBe('direct Node host-store write')
  }, 300_000)
})
