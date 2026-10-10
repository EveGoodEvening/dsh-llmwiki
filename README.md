# dsh-llmwiki

English | [简体中文](README.zh.md)

Third-party, local-first, source-linked Markdown wiki storage and retrieval plugin for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH), inspired by [Karpathy's LLM Wiki](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f).

Maintained by EveGoodEvening, this is not an official DeepSeek or DeepSeek Harness project. References to DeepSeek Harness and Andrej Karpathy describe compatibility and inspiration only; they do not imply affiliation, sponsorship, or endorsement.

- Preserve immutable sources by SHA-256 and write Markdown pages that cite them.
- Search page sections with a deterministic lexical index; rebuild it when stale.
- Check structure, links, and integrity with model-free lint.

The plugin makes no model or network calls. The calling agent handles synthesis and semantic review; a source citation proves record existence, not claim support.

## Requirements

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

The plugin's version in [package.json](package.json) is independent of the DSH and dependency versions above.

## Install

Use **`@evegoodevening/dsh-llmwiki`**. The unscoped `dsh-llmwiki` package belongs to a different project.

From this checkout, pack and install `0.0.1` with a supported DSH host on `PATH` (`web` is the example profile):

```sh
pnpm install --frozen-lockfile
pnpm pack
dsh plugin --profile web add ./evegoodevening-dsh-llmwiki-0.0.1.tgz
```

When the package is available on npm, the equivalent registry command is `dsh plugin --profile web add @evegoodevening/dsh-llmwiki@latest`.

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

Keep the patch on every start; restart a running profile after changes. Use `/wiki status` to inspect the repository. Before changing the installed package, stop all writers and back up the root. Retain the same explicit root to reuse existing wiki data, and check the filesystem requirements below before enabling it.

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
| `llmwiki_read_page` | Read exact page Markdown and its SHA-256 by logical ID |
| `llmwiki_upsert_page` | Create or conditionally update a page citing existing source IDs |
| `llmwiki_lint` | Check structure, integrity, links, and index freshness |

Start with status and the schema. Preserve sources and maintain affected pages only with user authorization. Run structural lint **before semantic review**, even without writes, and again after any updates. Semantic findings are agent judgments, not lint results. Full workflow: [runtime prompt](src/prompt.ts); parameters: [tool schemas](src/tools.ts).

Search uses deterministic NFKC/lowercase tokens and BM25 field weighting; ties sort by page ID and section start line. Snippets show contiguous normalized body context around the earliest fitting scored query token (whole letter/number run or existing CJK two-code-point gram), with same-position ties resolved by UTF-16 lexical token order. They stay within `maxSnippetBytes` without splitting UTF-8 code points; no omission markers are added. Dispersed query terms need not all appear. Title/heading-only matches and body tokens too large for the cap use a bounded body prefix instead.

### Page-write preconditions

Every page write requires `expectedSha256`: use `null` to create an absent page, or the exact raw-Markdown `sha256` returned by a page read or catalog to update an existing page. On `PAGE_CONFLICT`, reread and reconcile the page before retrying; do not overwrite with a stale hash or blindly retry.

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
- **Filesystem backend.** Descriptor-contained storage requires Linux, numeric nofollow/directory-open flags, and a mounted, usable `/proc/self/fd`. Unsupported or unavailable capabilities fail closed with `UNSAFE_FILESYSTEM`; there is no pathname fallback. Non-Linux descriptor backends are not supported or claimed proven. Root and child directories are pinned per operation, final files are opened without following symlinks, and an initialized root's device/inode identity must remain unchanged.
- **Adversary limits.** Pinned traversal prevents symlink substitution from redirecting filesystem operations into an outside symlink target. It is not a whole-tree transaction or a compare-and-rename guarantee. An already-authorized directory can remain accessible after being renamed outside its former lexical root. Ordinary file/hardlink injection, privileged mount or process access, and hostile replacement of procfs are outside this guarantee; OS isolation and the no-untrusted-writers requirement still apply.
- **Some reads can write.** Status, catalog listings, and lint never write. Source/page reads and search may initialize storage; search may also rebuild the index. Read-only deployments need an initialized repository and a fresh index.
- Sources are never edited or deleted by the plugin. Existing `schema.md` is preserved; there is no schema-editing API.

### Interrupted source writes

Retry `llmwiki_add_source` (or `ctx.llmwiki.addSource`) with identical content after an interrupted source write. Recovery is limited to the final source directory with **no committed `metadata.json`**, containing only an empty state, matching durable `content`, and/or recognized regular writer temporary files. Matching durable content is preserved; metadata commits last using the retry's provenance. The recovered receipt has `deduplicated: false`; the next identical-content retry deduplicates.

A valid complete record always deduplicates without changing its first committed metadata/provenance bytes. Corrupt content or metadata, unknown children, and symlink/nonregular children are refused without changing the rejected record. Reads, catalogs, and lint do not repair partial records or treat them as valid; source/page reads can still initialize the storage layout as described above. This is narrow crash retry, not a generic repair/quarantine facility or a multi-page transaction.

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

## References / Acknowledgements

The design and integration work consulted these sources:

- [Andrej Karpathy's LLM Wiki idea file](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f) — the primary conceptual inspiration: immutable raw sources, a persistent LLM-maintained Markdown wiki, schema guidance, and ingest/query/lint workflows. It describes a pattern, not a required implementation or API.
- [Astro-Han/karpathy-llm-wiki](https://github.com/Astro-Han/karpathy-llm-wiki) — the raw/wiki/schema separation, evidence requirements, and explicit ingest/query/lint workflows in its agent skill. The specific triage and cascade-update guidance is covered by the scoped attribution and retained MIT license in [Third-party notices](THIRD_PARTY_NOTICES.md).
- [ddsyasas/llm-wiki](https://github.com/ddsyasas/llm-wiki) — persisted source/page records, index-first navigation, and the separation of deterministic lint from model judgment. Its Next.js/SQLite/FTS application architecture is not adopted here.
- [Praney Behl's llm-wiki-plugin](https://github.com/praneybehl/llm-wiki-plugin) — section-level lexical retrieval and stable evidence output in its search tooling, plus surgical page updates, citations, and user-review boundaries in its ingest workflow. Its Python/uv/FastEmbed/sqlite-vec runtime is not adopted here.
- [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness/tree/fa7e9f5a) — Cordis plugin and service conventions, lifecycle ownership, tool/command/system-prompt registration, and profile bundle integration. The initial integration research used revision `fa7e9f5a`; supported runtime versions are listed above.

These acknowledgements identify design influences and integration references; they do not imply endorsement by the referenced authors or projects. This package's MIT license does not relicense the referenced works, which remain subject to their own copyright and licensing terms.

## License

[MIT](LICENSE) © EveGoodEvening.

See [Third-party notices](THIRD_PARTY_NOTICES.md) for the scope and complete upstream license retained for workflow guidance. The project's MIT license does not replace that notice.
