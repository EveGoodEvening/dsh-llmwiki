# dsh-llmwiki

Local-first, source-linked Markdown wiki storage and retrieval plugin for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (dsh).

Inspired by [Karpathy's `llm-wiki.md`](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f) concept, this package provides the deterministic storage, retrieval, and structural-integrity substrate for a navigable Markdown wiki. The calling dsh agent, under system/user instructions and ordinary tool approval, owns evidence maintenance and semantic review.

Immutable source records are preserved by content hash, synthesized Markdown pages cite those source IDs, and a deterministic section index backs lexical search. Everything lives on the local filesystem under a single wiki root. The service, tools, commands, catalogs, search, and lint make no model or network calls.

- **Immutable sources.** `llmwiki_add_source` stores exact UTF-8 bytes; the source ID is the SHA-256 of the content. Sources are never mutated or deleted by the plugin.
- **Source-linked pages.** `llmwiki_upsert_page` writes canonical Markdown whose frontmatter must list existing preserved source IDs. This enforces source-record existence, not claim-level entailment, quotation alignment, or paragraph-to-source attribution.
- **Deterministic search.** `llmwiki_search` ranks page sections by a reproducible BM25-style score over a derived index (`formatVersion: 1`). A stale or missing index is rebuilt on demand; durable artifacts are never touched.
- **Structural lint.** `llmwiki_lint` and `/wiki lint` deterministically report filesystem, integrity, link, canonical-format, and index diagnostics without fixing anything or making semantic judgments.
- **Safe filesystem.** The wiki root must be a real directory; symbolic links are rejected below it and all derived paths are confined to the root.

## Requirements

- Node.js `^22.19.0 || >=24`
- pnpm `11.7.0` (required for development and must be on `PATH` for `dsh plugin`)
- For profile installation: `@deepseek-ai/dsh@0.1.0-rc.6` or `0.1.1-rc.2` (both tested; `0.1.1-rc.2` recommended)
- For direct Cordis loading: a host providing the `tools`, `commands`, and `systemPrompt` services plus one complete, matching DSH service family allowed by `peerDependencies`

## Install

### npm package name

This repository uses the controlled npm package name `@evegoodevening/dsh-llmwiki`. The unscoped npm name [`dsh-llmwiki`](https://www.npmjs.com/package/dsh-llmwiki) is owned by a different maintainer and resolves to a different implementation from [`chancelu/dsh-llmwiki`](https://github.com/chancelu/dsh-llmwiki).

Always use the scoped package specifier for registry installs, Loader rows, imports, and profile removal. Never substitute the unscoped name.

### As a dsh profile bundle (recommended)

For a registry release, install through the dsh profile manager. The commands assume the recommended host `@deepseek-ai/dsh@0.1.1-rc.2`; `0.1.0-rc.6` remains covered by the release E2E matrix. Replace `web` with another profile name if needed.

```sh
dsh plugin --profile web add @evegoodevening/dsh-llmwiki
dsh --profile web --dump-config
```

For local checkout validation before publishing, install the generated tarball instead:

```sh
pnpm install
PACK_DIR="$(mktemp -d)"
pnpm pack --pack-destination "$PACK_DIR"
dsh plugin --profile web add --ignore-scripts "$PACK_DIR/evegoodevening-dsh-llmwiki-0.1.1.tgz"
dsh --profile web --dump-config
```

`dsh plugin` is the required profile-management path. It runs pnpm inside `$DSH_HOME/profiles/web`, detects this package's `dsh.bundle.patch`, and adds the installed package to the profile's ordered bundle list. No separate manual “apply bundle” step is needed. The config dump should contain an `@evegoodevening/dsh-llmwiki` layer and the `llmwiki` row.

Restart a running profile after installation, then use `/wiki status` or `/wiki lint`. To uninstall the bundle without deleting the wiki data:

```sh
dsh plugin --profile web remove @evegoodevening/dsh-llmwiki
```

### As a direct Cordis plugin

After creating the tarball above, install it into the Cordis consumer together with the exact runtime Loader dependencies:

```sh
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
```

The example uses the current `0.1.1-rc.2` service family. Direct Cordis consumers may instead use a complete `0.1.0-rc.6` or `0.1.0-rc.8` family, but all DSH service packages must come from the same family; do not mix release candidates. A fresh install of the legacy top-level host `@deepseek-ai/dsh@0.1.0-rc.6` currently resolves its DSH service packages to `0.1.0-rc.8`, and the release E2E asserts that resolved runtime explicitly.

Successful opt-in agent-smoke evidence records the runner's exact direct dependency requests, the complete resolved DeepSeek/Cordis package set, and the pinned runner lock hash as `runtime.requested`, `runtime.packages`, and `runtime.lockSha256`. This distinguishes requested host specs from the transitive versions actually executed.

The committed agent-smoke runner also pins and overrides Cordis to `4.0.1` and Loader to `1.0.2`; its frozen integrity-bearing lock must contain no resolved Cordis `4.0.2` or Loader `1.0.3` package.

Load it through the Cordis plugin Loader with `inject: ['tools', 'commands', 'systemPrompt']`. See [`examples/README.md`](examples/README.md) for a complete runnable demo that builds, packs, installs, and exercises the plugin from clean directories.

## Configuration

All keys are optional; defaults are shown.

| key | type | default | constraint | meaning |
| --- | --- | --- | --- | --- |
| `root` | string | `.llmwiki` | non-empty | Wiki root directory, resolved from the process working directory |
| `maxSourceBytes` | integer | `2097152` (2 MiB) | `>= 1` | Maximum UTF-8 byte length of a single source `content` |
| `maxPageBytes` | integer | `524288` (512 KiB) | `>= 1` | Maximum rendered byte length of a page body |
| `maxResults` | integer | `20` | `1..100` | Cap on `llmwiki_search` hits and default/maximum page size for both catalog listing tools |
| `maxSnippetBytes` | integer | `1200` | `64..16384` | Cap on per-hit snippet length |
| `commandDiagnosticLimit` | integer | `20` | `1..100` | Diagnostics printed by `/wiki lint` before an omission notice |

Unknown config keys are rejected at load time.

## Storage layout

```
<root>/
  schema.md                  # human-owned, create-only wiki guidance (UTF-8)
  sources/
    <sha256>/                # source ID = lowercase hex SHA-256 of content
      content                # exact immutable UTF-8 bytes
      metadata.json          # { id, name, mediaType, byteCount, capturedAt, origin? }
  pages/
    <page-id>.md             # canonical Markdown (see Page format)
  .index/
    search.json              # derived section search index, formatVersion 1
    state.json               # index fingerprint/state, formatVersion 1
```

`<page-id>` is a normalized POSIX relative path with no leading slash and no `.md` suffix (e.g. `getting-started`, `guides/install`). Empty, `.`, `..`, backslash, percent, and control-character segments are rejected.

### Page format

Pages are canonical Markdown with a required frontmatter block:

```markdown
---
title: "Getting Started"
summary: "Concise source-linked summary."
sources:
  - "e74435c7a03ec6b7e8ce437e27975f4a7c5c83e4d26bbc529412807f054fb0a6"
---

# Getting Started

Body Markdown organized under ATX headings. Every cited source ID must exist under sources/.
```

`title` and `summary` are double-quoted single-line strings. `sources` is a sorted, unique list of 64-character lowercase hex source IDs. The body is rendered canonically before storage and bounded by `maxPageBytes`.

## Tools

Registered with the dsh `tools` service. Read-only tools are concurrency-safe.

| tool | kind | parameters | purpose |
| --- | --- | --- | --- |
| `llmwiki_status` | read | none | Report initialization, source/page counts, schema text, and index freshness without creating or repairing wiki storage |
| `llmwiki_add_source` | edit | `name`, `content`, `mediaType?`, `origin?` | Preserve exact UTF-8 evidence; returns source ID and dedupe state |
| `llmwiki_list_sources` | read | `limit?`, `cursor?` | List safe immutable source metadata in deterministic ID order for recovery |
| `llmwiki_read_source` | read | `id`, `offset?`, `limit?` | Read immutable source content with provenance metadata |
| `llmwiki_search` | search | `query`, `limit?` | Rank page sections by lexical score; may rebuild a stale derived index |
| `llmwiki_list_pages` | read | `limit?`, `cursor?` | List page metadata and exact byte hashes in deterministic ID order for recovery |
| `llmwiki_read_page` | read | `id` | Read one synthesized page by logical page ID |
| `llmwiki_upsert_page` | edit | `id`, `title`, `summary`, `sources`, `body` | Atomically create or update a page when maintenance is authorized; requires existing source IDs but does not verify claim support |
| `llmwiki_lint` | read | none | Run deterministic model-free structural validation; reports diagnostics and counts, never semantic findings |

Catalog pages use deterministic UTF-16 code-unit ID order. Omitted `limit` uses `maxResults`; explicit limits must be safe integers from `1` through that configured cap. `nextCursor` is an opaque, tool-specific live-seek cursor and is `null` at the end. Listings validate the complete durable catalog before returning any page, never create or repair storage, omit absent source `origin`, and may reflect records inserted, updated, or deleted between calls. For a point-in-time inventory, quiesce writers and restart without a cursor.

## Model experience

The plugin registers a system-prompt section named `tool:llmwiki`, ordered at `116`. It defines two agent-layer workflows that are executable through the nine public tools above.

```text
Use llmwiki as local source-linked wiki storage and retrieval. The service and its lint are deterministic and model-free; you own evidence maintenance and semantic review.
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
4. Only when the user request authorizes maintenance, update affected pages while preserving both sides of a disagreement or recording a clearly dated supersession, then maintain links and rerun structural lint.
```

### Evidence maintenance

1. Call `llmwiki_status` before maintenance. If `schemaText` is non-null, read the returned human-owned schema.
2. On a fresh root, the non-creating status call may return `schemaText: null`. Supplying material alone does not authorize preservation. Only with explicit user authorization, preserve the source with `llmwiki_add_source` to initialize storage, then call `llmwiki_status` again and read the schema before classification or page maintenance.
3. Recover durable records with `llmwiki_list_sources` and `llmwiki_list_pages`; search and read relevant pages and immutable sources before writing.
4. Only with explicit authorization to preserve candidate material, add it with `llmwiki_add_source` if it was not already preserved by the fresh-root branch, then classify it as `new`, `update`, `contradiction`, or `no material change`.
5. Only when the user request authorizes maintenance, update every materially affected page, cite only existing immutable source IDs, preserve material disagreements, and maintain page links.
6. Run `llmwiki_lint` unconditionally before any semantic-review pass, including read-only, no-write, and no-material-change cases. Its durable observable result is a bounded structural report with diagnostics and counts; it never makes semantic judgments. After any authorized durable updates, rerun structural lint.

### Semantic review

Only after the unconditional structural lint, the agent starts a separately named semantic review. This ordering applies even when the request is read-only, no writes occurred, or classification found no material change. The agent lists pages and sources, states a selected review scope, reads every page in that scope, reads every source cited by those pages plus newly supplied candidate sources, and compares dated and qualified claims. Each material finding is classified as `contradiction`, `superseded`, `unsupported`, or `missing-link`, with affected page IDs and source IDs reported visibly.

Those findings are model judgments, never `llmwiki_lint` diagnostics. Only when the user request authorizes maintenance may the agent update affected pages, preserving both sides of a disagreement or recording a clearly dated supersession and maintaining links. After any such durable updates, it reruns structural lint. Prompt and documentation contract tests freeze this workflow; behavioral closure requires the separately planned credentialed agent evidence and is not claimed here.

### Schema ownership

`schema.md` is human-owned guidance subordinate to system and user instructions. The plugin creates the default only when the file is absent and preserves every existing custom schema byte-for-byte. There is no schema mutation tool or automatic rewrite. Schema evolution remains intentionally unresolved because authorization and confirmation, visible audit evidence, and optimistic-concurrency/lost-update behavior require a separate product decision.

The registered runtime prompt, implemented in `src/prompt.ts`, mirrors the documented block above and states these same service-layer, agent-layer, authorization, source-link, structural-lint, semantic-review, and schema boundaries.


## Command

`/wiki [status|lint|reindex]` — local, no model invocation.

- `status` (default): prints initialization, source/page counts, and index state.
- `lint`: prints error/warning counts and up to `commandDiagnosticLimit` diagnostics.
- `reindex`: rebuilds the derived search index and reports page/section counts and format version.

## Lint diagnostics

`llmwiki_lint` and `/wiki lint` report these codes. Severity is `error` unless noted.

| code | severity | meaning |
| --- | --- | --- |
| `ROOT_MISSING` | error | Wiki root directory is missing |
| `ROOT_NOT_DIRECTORY` | error | Wiki root is not a directory |
| `UNSAFE_SYMLINK` | error | Symbolic link found in or below the wiki root |
| `REQUIRED_DIRECTORY_MISSING` | error | A required wiki directory is missing |
| `REQUIRED_PATH_NOT_DIRECTORY` | error | A required path that should be a directory is not |
| `SCHEMA_MISSING` | error | `schema.md` is missing |
| `INVALID_UTF8` | error | A required file is not valid UTF-8 |
| `SOURCE_INVALID_ID` | error | A source directory name is not a lowercase SHA-256 ID |
| `SOURCE_CONTENT_MISSING` | error | Source `content` file is missing |
| `SOURCE_CONTENT_NOT_FILE` | error | Source `content` is not a regular file |
| `SOURCE_HASH_MISMATCH` | error | Source ID does not match the SHA-256 of its content |
| `SOURCE_METADATA_MISSING` | error | Source `metadata.json` is missing |
| `SOURCE_METADATA_NOT_FILE` | error | Source `metadata.json` is not a regular file |
| `SOURCE_METADATA_MALFORMED` | error | Source metadata is not valid UTF-8 JSON |
| `SOURCE_METADATA_INVALID` | error | Source metadata does not match the required schema |
| `SOURCE_METADATA_UNKNOWN_KEY` | error | Source metadata contains an unknown key |
| `SOURCE_METADATA_ID_MISMATCH` | error | Source metadata `id` does not match its directory name |
| `SOURCE_METADATA_BYTE_COUNT_MISMATCH` | error | Source metadata `byteCount` does not match content bytes |
| `SOURCE_UNREFERENCED` | warning | Valid source is not referenced by any valid page (`Source is not referenced by any valid page.`) |
| `PAGE_INVALID_PATH` | error | Page path is not a normalized relative `.md` path |
| `PAGE_INVALID_MARKDOWN` | error | Page is not valid canonical wiki Markdown |
| `PAGE_MISSING_SOURCE` | error | A page cites a missing or invalid source ID |
| `DUPLICATE_TITLE` | warning | Page title duplicates another after Unicode normalization |
| `ORPHAN_PAGE` | warning | Page has no incoming links from another page |
| `LINK_ESCAPES_PAGES` | error | A relative page link escapes the pages directory |
| `BROKEN_PAGE_LINK` | error | A page link targets a non-existent page |
| `INDEX_MISSING` | warning | Derived search index is missing (search will rebuild it) |
| `INDEX_MALFORMED` | error | Index file is not valid canonical JSON for format version 1 |
| `INDEX_INCOMPATIBLE` | error | Index uses an unsupported format version |
| `INDEX_STALE` | warning | Index fingerprints do not match current pages |
| `TEMP_FILE_ABANDONED` | warning | An abandoned atomic-write temporary file was found |

## Error codes

Tool and command failures surface `LlmWikiError` with one of these codes:

`NOT_INITIALIZED`, `INVALID_PATH`, `SOURCE_NOT_FOUND`, `PAGE_NOT_FOUND`, `INVALID_PAGE`, `LIMIT_EXCEEDED`, `INVALID_CURSOR`, `CATALOG_CORRUPT`, `ABORTED`, `UNSAFE_FILESYSTEM`, `INDEX_CORRUPT`.

## Development

```sh
pnpm install
pnpm run build          # tsc + tsdown -> lib/
pnpm run typecheck      # tsc --noEmit
pnpm run lint           # eslint . --max-warnings 0
pnpm test               # vitest run
pnpm run test:coverage  # vitest run --coverage
pnpm run test:e2e       # end-to-end specs (vitest.e2e.config.ts)
pnpm run check:determinism  # scripts/check-determinism.ts
pnpm run smoke          # scripts/smoke.ts
LLMWIKI_AGENT_SMOKE_NETWORK=allow pnpm run smoke:agent -- --preflight  # setup/network check; no model request
LLMWIKI_AGENT_SMOKE_NETWORK=allow pnpm run smoke:agent    # credentialed real-agent smoke; never an offline gate
```

The test suite lives under `tests/`; fixtures under `tests/fixtures/`. The committed `examples/demo-wiki` corpus intentionally omits `.index` so lint first reports `INDEX_MISSING` and search rebuilds the derived index.

### Opt-in real-agent smoke

The agent smoke is deliberately separate from build, test, coverage, determinism, ordinary smoke, prepack, and release gates. It uses the packed plugin in a disposable DeepSeek Harness `0.1.1-rc.2` headless profile and drives a real `@deepseek-ai/dsh-agent@0.1.1-rc.2` turn through provider `deepseek`.

Set `DEEPSEEK_API_KEY`, a non-empty `LLMWIKI_AGENT_SMOKE_MODEL`, and the exact explicit network opt-in `LLMWIKI_AGENT_SMOKE_NETWORK=allow`; there is no default model or fallback provider. Without the opt-in, the harness exits `BLOCKED_NETWORK_NOT_OPTED_IN` before disposable setup. `pnpm run smoke:agent -- --preflight` clean-builds and packs a temporary copy of the current source, installs exact pinned DSH specifications into an isolated HOME/XDG/pnpm environment, validates the disposable profile and evidence location, and records no model request. A missing key exits `BLOCKED_MISSING_CREDENTIAL`. The optional `LLMWIKI_AGENT_SMOKE_EVIDENCE` changes the success-only evidence destination from `tests/fixtures/agent-smoke/latest.json`.

Only a successful credentialed run writes canonical sanitized evidence atomically. It retains assertion results, safe tool names, requested and resolved runtime versions, durable source/page IDs and hashes, and final structural-lint error/warning counts, but never prompts, completions, credentials, headers, raw wiki content, child diagnostics, transcripts, or absolute paths. Preflight never creates or overwrites evidence, the credential reaches only the model-running child, bounded children are terminated on timeout, and the harness deletes its disposable profile, stores, and wiki.

## Exports

```ts
export { Config } from '@evegoodevening/dsh-llmwiki'
export type { Config as LlmWikiConfig, ResolvedConfig } from '@evegoodevening/dsh-llmwiki'
export { LLMWIKI_ERROR_CODES, LlmWikiError, isLlmWikiError } from '@evegoodevening/dsh-llmwiki'
export type { LlmWikiErrorCode, SerializedLlmWikiError } from '@evegoodevening/dsh-llmwiki'
export { isPageId, isSourceId, pageId, sourceId } from '@evegoodevening/dsh-llmwiki'
export type { PageId, SourceId } from '@evegoodevening/dsh-llmwiki'
export { LlmWikiService } from '@evegoodevening/dsh-llmwiki'
export type * from '@evegoodevening/dsh-llmwiki'   // all public types from types.ts
```

## License

MIT (c) EveGoodEvening. See [LICENSE](LICENSE).
