# dsh-llmwiki

Local-first, source-linked Markdown wiki storage and retrieval for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH), inspired by [Karpathy's LLM Wiki](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f).

- Preserve immutable sources by SHA-256 and write Markdown pages that cite them.
- Search page sections with a deterministic lexical index; rebuild it when stale.
- Check structure, links, and integrity with model-free lint.

The plugin makes no model or network calls. The calling agent handles synthesis and semantic review; a source citation proves record existence, not claim support.

## Requirements

Supported combinations for plugin **0.1.7**, verified with packed-profile lifecycle checks on **2026-09-29**:

| DSH (`@deepseek-ai/dsh`) | Cordis (`@deepseek-ai/cordis`) | Status |
| --- | --- | --- |
| **`0.2.0-rc.2`** | **`4.0.4`** | **Recommended** |
| `0.1.7-rc.2` | `4.0.4` | Supported |
| `0.1.1-rc.2` | `4.0.1` | Supported legacy |
| `0.1.0-rc.6` | `4.0.1` | Supported legacy |

- **Node.js:** `^22.19.0 || >=24`.
- **pnpm:** `11.7.0`, on `PATH` for `dsh plugin` and development.
- Use a coherent DSH service family, not mixed release candidates. The `0.1.0-rc.6` host resolves its five DSH service peers to `0.1.0-rc.8`; the other rows use same-version services.
- Direct Cordis loading also needs DSH `tools`, `commands`, and `systemPrompt` services and one shared `@deepseek-ai/schemastery@^3.18.1` installation. See [exact peer ranges](package.json) and the [standalone example](examples/README.md).

Pin a listed combination; future versions and arbitrary DSH/Cordis pairings are not implied. Plugin `0.1.6` does **not** support the modern DSH rows—use `0.1.7`, without bypassing peer checks.

## Install

Use **`@evegoodevening/dsh-llmwiki`**. The unscoped `dsh-llmwiki` package belongs to a different project.

With a supported DSH host on `PATH` (`web` is the example profile):

```sh
dsh plugin --profile web add @evegoodevening/dsh-llmwiki@0.1.7
```

Installation leaves the plugin **disabled**. Enable it with an operator-owned patch and an explicit, writable wiki root:

```sh
mkdir -p "$HOME/.config/dsh"
cat > "$HOME/.config/dsh/llmwiki-web.patch.yml" <<YAML
- insert:
    - id: llmwiki
      name: '@evegoodevening/dsh-llmwiki'
      config:
        root: '$HOME/.local/share/dsh/llmwiki/web'
YAML
dsh --profile web --patch "$HOME/.config/dsh/llmwiki-web.patch.yml" --dump-config
dsh --profile web --patch "$HOME/.config/dsh/llmwiki-web.patch.yml"
```

Keep the patch on every start; restart a running profile after changes. Use `/wiki status` to inspect the repository. When upgrading, retain the same root—there is no data migration.

To uninstall without deleting wiki data:

```sh
dsh plugin --profile web remove @evegoodevening/dsh-llmwiki
```

For local-tarball installation or standalone Cordis loading, use the [runnable example](examples/README.md).

## Usage

### Commands

| Command | Purpose |
| --- | --- |
| `/wiki status` | Report initialization, source/page counts, and index state; also the default `/wiki` action |
| `/wiki lint` | Report structural errors and warnings without repairing anything |
| `/wiki reindex` | Rebuild the derived search index |

### Agent tools

| Tool | Purpose |
| --- | --- |
| `llmwiki_status` | Inspect storage and read the human-owned schema |
| `llmwiki_add_source` | Preserve exact UTF-8 content; return its source ID |
| `llmwiki_list_sources` | Browse source metadata with pagination |
| `llmwiki_read_source` | Read preserved content and provenance |
| `llmwiki_search` | Find ranked page-section matches |
| `llmwiki_list_pages` | Browse page metadata and hashes with pagination |
| `llmwiki_read_page` | Read a page by logical ID |
| `llmwiki_upsert_page` | Create or update a page citing existing source IDs |
| `llmwiki_lint` | Check structure, integrity, links, and index freshness |

Start with status and the schema. Preserve sources and maintain affected pages only with user authorization. Run structural lint **before semantic review**, even without writes, and again after any updates. Semantic findings are agent judgments, not lint results. Full workflow: [runtime prompt](src/prompt.ts); parameters: [tool schemas](src/tools.ts).

## Configuration

All keys are optional. Numeric values are integers; unknown keys are rejected.

| Key | Default | Meaning / limits |
| --- | --- | --- |
| `root` | `.llmwiki` | Non-empty path, resolved once from the host process cwd |
| `maxSourceBytes` | `2097152` | Source content limit: 2 MiB; minimum 1 byte |
| `maxPageBytes` | `524288` | Rendered page body limit: 512 KiB; minimum 1 byte |
| `maxResults` | `20` | Search and catalog page-size cap; `1..100` |
| `maxSnippetBytes` | `1200` | Search snippet limit; `64..16384` bytes |
| `commandDiagnosticLimit` | `20` | Diagnostics printed by `/wiki lint`; `1..100` |

## Storage and safety

```text
<root>/
  schema.md                  # human-owned guidance; created only if absent
  sources/<sha256>/
    content                  # immutable UTF-8 source
    metadata.json            # provenance and capture metadata
  pages/<page-id>.md          # Markdown with title, summary, and source IDs
  .index/{search,state}.json  # derived, rebuildable search data
```

- **Host storage, not a DSH sandbox.** Direct Node filesystem I/O bypasses `ctx.fs`, DSH permission modes, approval, read-before-edit, and remote/workspace providers. Do not enable this plugin where those controls are required; enforce boundaries with OS permissions and process isolation.
- **One fixed root per activation.** Session/workspace cwd changes do not switch storage. Use distinct roots for isolation; mutually untrusted tenants must not share a root or activation. Concurrent writers across activations/processes are unsupported. Do not let untrusted processes modify the root.
- **Some reads can write.** Status, catalog listings, and lint never write. Source/page reads and search may initialize storage; search may also rebuild the index. Read-only deployments need an initialized repository and a fresh index.
- Sources are never edited or deleted by the plugin. Existing `schema.md` is preserved; there is no schema-editing API.

## Development

```sh
pnpm install --frozen-lockfile
pnpm run build
pnpm run typecheck
pnpm run lint
pnpm test
pnpm run test:e2e
pnpm run check:determinism
pnpm run smoke
```

The Linux unit suite's read-only tmpfs test requires root and mount-namespace capability. E2E builds first and exercises packed packages across the supported host matrix; run it separately from other builds because it temporarily hides shared checkout paths. Ordinary smoke uses the pinned legacy development dependencies, not the recommended host.

- **Upstream compatibility:** `pnpm run check:compatibility` probes latest DSH with native dependencies and, separately, forced latest Cordis. Networked, model-free; probes do not automatically extend the support table. See the [scheduled workflow](.github/workflows/compatibility.yml).
- **Real-agent smoke:** set `DEEPSEEK_API_KEY`, `LLMWIKI_AGENT_SMOKE_MODEL`, and `LLMWIKI_AGENT_SMOKE_NETWORK=allow`, then run `pnpm run smoke:agent`. This separate, credentialed check uses a pinned DSH `0.1.1-rc.2` runner; offline checks do not prove model behavior.
- **Publishing:** the [release workflow](.github/workflows/publish.yml) uses npm Trusted Publishing for a `v*` tag matching `package.json`.

## License

[MIT](LICENSE) © EveGoodEvening.
