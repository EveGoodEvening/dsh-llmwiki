# Runnable packed demo / 可运行打包示例

This committed corpus contains one immutable source and one canonical source-linked page. The page cites an existing source record; the plugin does not deterministically verify claim-level support. The corpus intentionally contains no `.index`: structural lint first reports `INDEX_MISSING`, search rebuilds the derived index, and structural lint then reports zero errors and zero warnings.

The runnable demo exercises the deterministic, model-free storage/retrieval and structural-integrity substrate directly; it is not a real-agent or semantic-review proof. In agent use, begin with `llmwiki_status`; on a fresh root, expect `initialized: false` and `schemaText: null`. Obtain explicit user authorization before preserving supplied material with `llmwiki_add_source`, then call `llmwiki_status` again and reread its now-present human-owned schema before maintenance. Inventory both catalogs, search and read relevant pages and sources, and classify the material as `new`, `update`, `contradiction`, or `no material change`. When the user request authorizes maintenance, update every materially affected page while preserving disagreements and links. Structural lint runs unconditionally before semantic review, including read-only, no-write, and no-material-change workflows. When semantic review makes authorized durable updates, structural lint reruns afterward. Semantic review selects and states its scope, then reads every scoped page, every source cited by those pages, and every relevant new candidate source before comparing dated and qualified claims and reporting classified `contradiction`, `superseded`, `unsupported`, or `missing-link` findings with page/source IDs. Semantic findings are agent judgments, never `llmwiki_lint` diagnostics.

`schema.md` is create-only through this plugin: an absent file receives the default, while an existing human-owned schema is preserved byte-for-byte. There is no schema mutation API; schema evolution remains intentionally unresolved pending authorization/confirmation, visible audit evidence, and optimistic-concurrency/lost-update product decisions.

## 1. Build, pack, and install from clean directories

Run this block from the repository checkout. It records that checkout as `REPO`, creates clean pack/consumer directories, installs only the packed artifact and exact runtime/Loader dependencies, and copies the example data.

```sh
cd /path/to/dsh-llmwiki
REPO=$PWD
PACK_DIR=/tmp/dsh-llmwiki-demo-pack
DEMO_DIR=/tmp/dsh-llmwiki-demo
rm -rf "$PACK_DIR" "$DEMO_DIR"
mkdir -p "$PACK_DIR" "$DEMO_DIR"
pnpm run build
pnpm pack --pack-destination "$PACK_DIR"

cd "$DEMO_DIR"
printf '%s\n' '{"private":true,"type":"module"}' > package.json
pnpm add --ignore-scripts \
  "$PACK_DIR/evegoodevening-dsh-llmwiki-0.1.1.tgz" \
  @deepseek-ai/cordis@4.0.1 \
  @deepseek-ai/cordis-plugin-loader@1.0.2 \
  @deepseek-ai/dsh-brand@0.1.1-rc.2 \
  @deepseek-ai/dsh-commands@0.1.1-rc.2 \
  @deepseek-ai/dsh-session@0.1.1-rc.2 \
  @deepseek-ai/dsh-system-prompt@0.1.1-rc.2 \
  @deepseek-ai/dsh-tools@0.1.1-rc.2 \
  node-addon-require-builtin@0.1.4
cp -R "$REPO/examples/demo-wiki" ./demo-wiki
cp "$REPO/examples/cordis.yml" ./cordis.yml
```

`cordis.yml` is the complete direct Loader row composition. Its `root: ./demo-wiki` is resolved from the process working directory, so the commands below deliberately run from `$DEMO_DIR`.

This Loader row is an explicit operator opt-in to host-managed, policy-exempt storage. The root is captured once at activation: relative roots resolve from the host process cwd, absolute roots are fixed directly, and later session/tool/command cwd values do not change it. All callers in the activation share that root. Use distinct explicit roots to isolate trusted projects; do not share an activation or root between mutually untrusted tenants, and do not run concurrent writers from separate activations or processes.

The plugin uses direct Node I/O outside `ctx.fs`, `DSH_PERMISSION_MODE`, fs-sandbox, filesystem intent/observation/read-before-edit, remote/workspace providers, and `ctx.approval`. Source/page mutation, first-use initialization, and reindex write. `readSource`, `readPage`, and search may initialize repository paths/schema; search may also publish a missing or stale index. Do not opt in where DSH-enforced read-only, approval/provider semantics, or tenant isolation are required.

## 2. Create the runner exactly

```sh
cd /tmp/dsh-llmwiki-demo
cat > run.mjs <<'EOF'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import 'node-addon-require-builtin'

const disabled = process.env.LLMWIKI_DISABLED === '1'
const ctx = new Context()
const loader = ctx.plugin(Loader, { baseUrl: import.meta.url })
await loader.await()
try {
  await ctx.loader.create({ id: 'tools', name: '@deepseek-ai/dsh-tools', config: { mode: 'native' } })
  await ctx.loader.create({ id: 'commands', name: '@deepseek-ai/dsh-commands' })
  await ctx.loader.create({ id: 'system-prompt', name: '@deepseek-ai/dsh-system-prompt' })

  if (disabled) {
    await ctx.loader.await()
    console.log('llmwiki row disabled; durable demo-wiki left untouched')
  } else {
    await ctx.loader.create({
      id: 'llmwiki',
      name: '@evegoodevening/dsh-llmwiki',
      inject: ['tools', 'commands', 'systemPrompt'],
      config: {
        root: './demo-wiki',
        maxSourceBytes: 2097152,
        maxPageBytes: 524288,
        maxResults: 20,
        maxSnippetBytes: 1200,
        commandDiagnosticLimit: 20,
      },
    })
    await ctx.loader.await()

    const signal = new AbortController().signal
    let sequence = 0
    const call = async (name, args) => {
      sequence += 1
      const result = await ctx.tools.execute({ callId: `demo-${sequence}-${name}`, name, arguments: args, signal })
      if (result.isError) throw new Error(`${name}: ${result.error.message}`)
      return result.value
    }

    const statusBefore = await call('llmwiki_status', {})
    const sources = await call('llmwiki_list_sources', {})
    const pages = await call('llmwiki_list_pages', {})
    const lintBefore = await call('llmwiki_lint', {})
    if (statusBefore.sourceCount !== 1 || statusBefore.pageCount !== 1) throw new Error('unexpected corpus counts')
    if (sources.items[0]?.id !== 'e74435c7a03ec6b7e8ce437e27975f4a7c5c83e4d26bbc529412807f054fb0a6' || sources.nextCursor !== null) throw new Error('unexpected source catalog')
    if (pages.items[0]?.id !== 'getting-started' || pages.nextCursor !== null) throw new Error('unexpected page catalog')
    if (lintBefore.errorCount !== 0) throw new Error('pre-search lint reported errors')
    if (!statusBefore.index.present && !lintBefore.diagnostics.some(item => item.code === 'INDEX_MISSING' && item.severity === 'warning')) {
      throw new Error('missing index was not reported by pre-search lint')
    }
    if (statusBefore.index.present && (!statusBefore.index.fresh || lintBefore.warningCount !== 0)) {
      throw new Error('existing pre-search index was not fresh and clean')
    }

    const search = await call('llmwiki_search', { query: 'deterministic section', limit: 5 })
    const statusAfter = await call('llmwiki_status', {})
    const lintAfter = await call('llmwiki_lint', {})
    if (search[0]?.pageId !== 'getting-started' || search[0]?.startLine !== 12) {
      throw new Error('unexpected first search hit')
    }
    if (!statusAfter.index.present || !statusAfter.index.fresh) throw new Error('search did not create a fresh index')
    if (lintAfter.errorCount !== 0 || lintAfter.warningCount !== 0) throw new Error('post-search lint was not clean')

    console.log(JSON.stringify({ statusBefore, sources, pages, lintBefore, firstHit: search[0], statusAfter, lintAfter }, null, 2))
  }
} finally {
  await loader.dispose()
}
EOF
```

## 3. Exercise status, lint, search, disable, and cleanup

The enabled run calls status, inventories the source and page catalogs, runs pre-search structural lint, searches, then reruns status and structural lint. The second enabled run reads the same durable corpus and already-fresh index. The disabled run boots the same host services while omitting the `llmwiki` row; it does not delete `demo-wiki`.

```sh
cd /tmp/dsh-llmwiki-demo
node run.mjs
node run.mjs
LLMWIKI_DISABLED=1 node run.mjs
rm -rf /tmp/dsh-llmwiki-demo /tmp/dsh-llmwiki-demo-pack
```

Expected facts from the first enabled run (timestamps and scores are not prescribed):

- pre-search status: `sourceCount: 1`, `pageCount: 1`, `index.present: false`;
- source/page catalogs: one item each, IDs `e74435c7a03ec6b7e8ce437e27975f4a7c5c83e4d26bbc529412807f054fb0a6` and `getting-started`, both with `nextCursor: null`;
- pre-search lint: `errorCount: 0` and an `INDEX_MISSING` warning;
- first search hit: `pageId: "getting-started"`, `startLine: 12`;
- post-search status: index present and fresh;
- post-search lint: `errorCount: 0`, `warningCount: 0`.

## dsh profile flow: explicit activation required

The packed package is installed as a profile bundle through `dsh.bundle.patch`, but that bundled patch is intentionally empty: installation alone does not mount llmwiki or expose its host-write capability. Install through the dsh profile manager, then supply an explicit operator-owned Loader patch with an explicit root:

```sh
dsh plugin --profile web add --ignore-scripts /tmp/dsh-llmwiki-demo-pack/evegoodevening-dsh-llmwiki-0.1.1.tgz
cat > /tmp/dsh-llmwiki-demo/enable-llmwiki.patch.yml <<'YAML'
- insert:
    - id: llmwiki
      name: '@evegoodevening/dsh-llmwiki'
      config:
        root: /var/lib/dsh/llmwiki/web
        maxSourceBytes: 2097152
        maxPageBytes: 524288
        maxResults: 20
        maxSnippetBytes: 1200
        commandDiagnosticLimit: 20
YAML
dsh --profile web --patch /tmp/dsh-llmwiki-demo/enable-llmwiki.patch.yml --dump-config
```

Without the second patch, the dump has the installed package layer but no `llmwiki` row, service, tools, command, or prompt. Keep the operator patch in deployment configuration and use it whenever starting the profile; restart a running profile before invoking `/wiki status`, `/wiki lint`, or `/wiki reindex`.

For a registry release, use `dsh plugin --profile web add @evegoodevening/dsh-llmwiki`; never substitute the unscoped `dsh-llmwiki` package owned by the other project. A profile override replaces the entire `llmwiki.config`, so retain all six keys. Upgrading to this explicit-activation bundle does not copy, split, discover, delete, or otherwise migrate an existing root: point the opt-in patch at the same root to retain sharing, preferably with an absolute host-state path. Remove the package with `dsh plugin --profile web remove @evegoodevening/dsh-llmwiki`; the configured wiki root remains available for later re-enabling.

## Fixture identity

- source ID / SHA-256: `e74435c7a03ec6b7e8ce437e27975f4a7c5c83e4d26bbc529412807f054fb0a6`
- exact content length: `116` UTF-8 bytes
- page: `pages/getting-started.md`, citing that exact source ID
- first query hit: `getting-started`, section start line `12`
- generated `.index`: intentionally omitted from the repository
