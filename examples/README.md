# Runnable packed demo / 可运行打包示例

This committed corpus contains one immutable source and one canonical evidence-backed page. It intentionally contains no `.index`: lint first reports `INDEX_MISSING`, search rebuilds the derived index, and lint then reports zero errors and zero warnings.

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
  "$PACK_DIR/evegoodevening-dsh-llmwiki-0.1.0.tgz" \
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

The enabled run inventories sources and pages, then calls status, pre-search lint, search, post-search status, and post-search lint. The second enabled run reads the same durable corpus and already-fresh index. The disabled run boots the same host services while omitting the `llmwiki` row; it does not delete `demo-wiki`.

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

## dsh profile flow

The packed package is a profile bundle through `dsh.bundle.patch`. Install it through the dsh profile manager, not by running pnpm directly in an arbitrary project:

```sh
dsh plugin --profile web add --ignore-scripts /tmp/dsh-llmwiki-demo-pack/evegoodevening-dsh-llmwiki-0.1.0.tgz
dsh --profile web --dump-config
```

The first command installs the tarball into `$DSH_HOME/profiles/web` and automatically adds its real package name to `dsh.profile.bundles`. The dump should contain an `@evegoodevening/dsh-llmwiki` layer and the `llmwiki` row; restart a running profile before invoking `/wiki status`, `/wiki lint`, or `/wiki reindex`.

For a registry release, use `dsh plugin --profile web add @evegoodevening/dsh-llmwiki`; never substitute the unscoped `dsh-llmwiki` package owned by the other project. A profile override replaces the entire `llmwiki.config`, so retain all six keys shown in `cordis.yml`. Remove the bundle with `dsh plugin --profile web remove @evegoodevening/dsh-llmwiki`; the configured wiki root remains available for re-enabling.

## Fixture identity

- source ID / SHA-256: `e74435c7a03ec6b7e8ce437e27975f4a7c5c83e4d26bbc529412807f054fb0a6`
- exact content length: `116` UTF-8 bytes
- page: `pages/getting-started.md`, citing that exact source ID
- first query hit: `getting-started`, section start line `12`
- generated `.index`: intentionally omitted from the repository
