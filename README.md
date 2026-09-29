# dsh-llmwiki

Local-first, source-linked Markdown wiki storage and retrieval plugin for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (dsh).

Inspired by [Karpathy's `llm-wiki.md`](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f) concept, this package provides the deterministic storage, retrieval, and structural-integrity substrate for a navigable Markdown wiki. The calling dsh agent, under system/user instructions, owns evidence maintenance and semantic review; that workflow guidance is not a technical DSH filesystem approval gate.

Immutable source records are preserved by content hash, synthesized Markdown pages cite those source IDs, and a deterministic section index backs lexical search. Everything lives on the local filesystem under a single wiki root. The service, tools, commands, catalogs, search, and lint make no model or network calls.

- **Immutable sources.** `llmwiki_add_source` stores exact UTF-8 bytes; the source ID is the SHA-256 of the content. Sources are never mutated or deleted by the plugin.
- **Source-linked pages.** `llmwiki_upsert_page` writes canonical Markdown whose frontmatter must list existing preserved source IDs. This enforces source-record existence, not claim-level entailment, quotation alignment, or paragraph-to-source attribution.
- **Deterministic search.** `llmwiki_search` ranks page sections by a reproducible BM25-style score over a derived index (`formatVersion: 1`). A stale or missing index is rebuilt on demand; durable artifacts are never touched.
- **Structural lint.** `llmwiki_lint` and `/wiki lint` deterministically report filesystem, integrity, link, canonical-format, and index diagnostics without fixing anything or making semantic judgments.
- **Safe filesystem.** The wiki root must be a real directory; symbolic links are rejected below it and all derived paths are confined to the root.

## Requirements

- Node.js `^22.19.0 || >=24` (the current-host packed proof ran on Node `24.21.0`)
- pnpm `11.7.0` (required for development and must be on `PATH` for `dsh plugin`)

**Verified packed-profile matrix (2026-09-29).** Versions below are actual coherent host resolutions, not independent `latest` tags. Use `@deepseek-ai/dsh@0.1.7-rc.2` for a new deployment with a compatible plugin artifact; keep legacy hosts on their corresponding complete families.

| Top-level `@deepseek-ai/dsh` | Five resolved `@deepseek-ai/dsh-{brand,commands,session,system-prompt,tools}` packages | Cordis | Loader | Include | Timer | HMR | Group |
| --- | --- | --- | --- | --- | --- | --- | --- |
| **`0.1.7-rc.2` (recommended latest)** | `0.1.7-rc.2` each | `4.0.4` | `1.0.5` | `1.0.9` | `1.1.6` | `@deepseek-ai/dsh-hmr@0.1.7-rc.2` | Not part of the asserted current-host closure |
| `0.1.1-rc.2` (retained) | `0.1.1-rc.2` each | `4.0.1` | `1.0.2` | `1.0.7` | `1.1.4` | `@deepseek-ai/cordis-plugin-hmr@1.0.17` | `1.0.2` |
| `0.1.0-rc.6` (retained) | `0.1.0-rc.8` each | `4.0.1` | `1.0.2` | `1.0.7` | `1.1.4` | `@deepseek-ai/cordis-plugin-hmr@1.0.17` | `1.0.2` |

These are packed-artifact/profile lifecycle proofs (default disabled, explicit opt-in, tools/command/prompt, persistence, removal and remount), **not** a real-model invocation. DSH `next` (`0.2.0-rc.2`) is unproven and unsupported by this matrix. The checkout's pinned Cordis `4.0.1`/Loader `1.0.2` development dependencies and separately frozen `0.1.1-rc.2` real-agent runner are legacy test closures; neither proves latest-host or credentialed model behavior. The currently published plugin `0.1.6` still excludes the latest family in its peer metadata; the current-host proof used the **updated checkout's packed artifact**, not the published `0.1.6` tarball. Do not bypass peer checks to install the old release on latest.

For direct Cordis loading, provide `tools`, `commands`, and `systemPrompt` from **one** matching DSH service family. Schemastery is a host-supplied peer (`@deepseek-ai/schemastery@^3.18.1`): resolve one shared host-compatible installation, rather than installing a second copy beside the host's declarations (current strict consumer typing passed with shared `3.18.4`).

## Install

### npm package name

This repository uses the controlled npm package name `@evegoodevening/dsh-llmwiki`. The unscoped npm name [`dsh-llmwiki`](https://www.npmjs.com/package/dsh-llmwiki) is owned by a different maintainer and resolves to a different implementation from [`chancelu/dsh-llmwiki`](https://github.com/chancelu/dsh-llmwiki).

Always use the scoped package specifier for registry installs, Loader rows, imports, and profile removal. Never substitute the unscoped name.

### As an explicitly enabled dsh profile bundle

Installing the package adds its bundle layer to the profile, but the bundled patch intentionally activates no `llmwiki` Loader row. This secure default prevents a read-only-capable profile from silently acquiring policy-exempt host-write capability. Operators must explicitly opt in with a Loader patch and an explicit root.

For a registry release whose peer metadata includes the chosen host family, install through the dsh profile manager. The commands below target the recommended host `@deepseek-ai/dsh@0.1.7-rc.2`; the already-published plugin `0.1.6` is **not** compatible with that host, so until a compatible release is published use the updated checkout's packed artifact instead. Replace `web` and the host-state path as appropriate.

```sh
dsh plugin --profile web add @evegoodevening/dsh-llmwiki
cat > /etc/dsh/llmwiki-web.patch.yml <<'YAML'
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
dsh --profile web --patch /etc/dsh/llmwiki-web.patch.yml --dump-config
```

For local checkout validation before publishing, install the generated tarball instead:

```sh
pnpm install
PACK_DIR="$(mktemp -d)"
pnpm pack --pack-destination "$PACK_DIR"
dsh plugin --profile web add --ignore-scripts "$PACK_DIR/evegoodevening-dsh-llmwiki-0.1.6.tgz"
dsh --profile web --patch /etc/dsh/llmwiki-web.patch.yml --dump-config
```

`dsh plugin` installs the package inside `$DSH_HOME/profiles/web`, detects its intentionally empty `dsh.bundle.patch`, and adds the package to the profile's ordered bundle list. The package alone exposes no llmwiki service, tools, command, prompt, or host writes. The explicit operator patch supplies the `llmwiki` row; keep that patch in the profile's deployment configuration and use it on every start. The config dump should contain the row only when that opt-in patch is present.

Restart a running profile after enabling or changing the patch, then use `/wiki status` or `/wiki lint`. To uninstall the package without deleting wiki data:

```sh
dsh plugin --profile web remove @evegoodevening/dsh-llmwiki
```

Upgrading to the secure-default bundle performs no data migration: existing roots, IDs, canonical bytes, and indexes remain compatible. Retain the existing configured root in the explicit patch to keep sharing that repository. Prefer an absolute host-state path so ownership is not confused with a DSH workspace. Never automatically discover, copy, split, reassign, or delete a historically shared root; the plugin cannot infer which project owns its records.

### As a direct Cordis plugin

The following standalone Loader recipe uses the **legacy `0.1.0-rc.6` DSH service family** exercised by the packed direct-Loader E2E, not a separately verified latest standalone boot. After creating the updated-checkout tarball above, install it into a Cordis consumer together with these exact runtime Loader dependencies:

```sh
pnpm add --ignore-scripts \
  "$PACK_DIR/evegoodevening-dsh-llmwiki-0.1.6.tgz" \
  @deepseek-ai/cordis@4.0.1 \
  @deepseek-ai/cordis-plugin-loader@1.0.2 \
  @deepseek-ai/dsh-brand@0.1.0-rc.6 \
  @deepseek-ai/dsh-commands@0.1.0-rc.6 \
  @deepseek-ai/dsh-session@0.1.0-rc.6 \
  @deepseek-ai/dsh-system-prompt@0.1.0-rc.6 \
  @deepseek-ai/dsh-tools@0.1.0-rc.6 \
  node-addon-require-builtin@0.1.4
```

This direct example installs a complete `0.1.0-rc.6` DSH service family with Cordis `4.0.1` and Loader `1.0.2`. This **standalone** service selection differs from the top-level profile host `@deepseek-ai/dsh@0.1.0-rc.6`, which resolves services to `0.1.0-rc.8`. The profile matrix above separately proves the latest and retained hosts with their actual plugin resolutions; do not mix service release candidates or transplant this standalone recipe's old Cordis/Loader into a latest host.

The opt-in agent-smoke runner records requested dependencies, actual resolved DeepSeek/Cordis packages, and its pinned lock hash as `runtime.requested`, `runtime.packages`, and `runtime.lockSha256`. That runner remains frozen at DSH `0.1.1-rc.2`, Cordis `4.0.1`, Loader `1.0.2`, Include `1.0.7`, Timer `1.1.4`, Group `1.0.2`, and Cordis HMR `1.0.17`; it is not latest-host or model-success evidence.

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

## Storage scope and DSH policy boundary

The durable repository identity is the plugin activation's **fixed resolved host root**. A relative `root`, including the default `.llmwiki`, is resolved once against the host process working directory when the plugin activates and captured as an absolute path. An absolute `root` is captured directly. Later `process.cwd()` changes, tool-agent or command-agent identity, `SessionHeader.cwd`, session/workspace identity, and optional `WorkspaceId` do not select or move storage. Tools, commands, and direct service callers in one activation all use that same captured root.

Activation identity owns only in-memory initialization/cache state and one activation-local same-process mutation queue. Two sequential activations using the same resolved root therefore share the same durable records, including after disposal and remount. Their queues are separate: concurrent writers in separate activations or processes are unsupported, and the queue is not a cross-process lock. Isolation requires separate contexts or processes configured with distinct resolved roots. Mutually untrusted tenants must share neither an activation nor a root.

This is host-managed plugin application storage implemented with direct Node filesystem I/O. It is outside `ctx.fs`, DSH filesystem sandbox/provider routing, `DSH_PERMISSION_MODE`, filesystem read-before-edit and approval policy, `fs/write-intent`, `fs/edit-intent`, `fs/observed`, remote/workspace filesystem providers, and `ctx.approval`. Explicit user authorization in the agent workflow governs what the agent should preserve; it does not technically authorize or deny the underlying filesystem operation. A custom `tools/pre-execute` guard gates only selected tool calls and does not cover direct service calls, commands, initialization, or derived-index writes.

Persistence surfaces have different host-write requirements:

- `llmwiki_status`, source/page listing, `llmwiki_lint`, `/wiki status`, and `/wiki lint` are strictly non-mutating.
- `llmwiki_add_source`, `llmwiki_upsert_page`, first-use repository/schema initialization, and `/wiki reindex` write the host root.
- `llmwiki_read_source`, `llmwiki_read_page`, and `llmwiki_search` are initialization-capable: their service paths may create the root, `sources/`, `pages/`, `.index/`, or missing `schema.md`. They are usable on an OS-read-only root only after the repository is fully initialized.
- Search is additionally conditionally index-publishing. It stays read-only only with a prebuilt fresh index; an absent or incomplete repository, or a missing/stale index, requires initialization or index publication and fails when host OS permissions deny those writes.

Operators requiring hard DSH-enforced read-only behavior, DSH approval/observation/read-before-edit semantics, remote/workspace providers, or tenant isolation must not opt in to llmwiki in that execution boundary. Use host filesystem permissions or deployment-level process isolation for the current product. To isolate trusted projects, mount distinct explicit roots; changing only session cwd is insufficient. No partial cwd-only or `ctx.fs`-only migration is implied or supported.

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
pnpm run test:e2e       # clean build + serialized E2E (vitest.e2e.config.ts)
pnpm run check:determinism  # scripts/check-determinism.ts
pnpm run smoke          # scripts/smoke.ts
LLMWIKI_AGENT_SMOKE_NETWORK=allow pnpm run smoke:agent -- --preflight  # setup/network check; no model request
LLMWIKI_AGENT_SMOKE_NETWORK=allow pnpm run smoke:agent    # credentialed real-agent smoke; never an offline gate
```

The test suite lives under `tests/`; fixtures under `tests/fixtures/`. The committed `examples/demo-wiki` corpus intentionally omits `.index` so lint first reports `INDEX_MISSING` and search rebuilds the derived index.

`test:e2e` builds the package before running either E2E file, so it works without a pre-existing `lib/`. E2E files run sequentially: the packed-package probes rebuild `lib/` and temporarily hide shared checkout paths, while Loader tests import the public built entry.

The E2E configuration gives tests and cleanup hooks 180 seconds by default because they build real packages and remove full disposable DSH installations. Individual profile-lifecycle cases retain their explicit 300-second limits; unit-test timeouts are unchanged. To reproduce a clean release environment locally, run `pnpm run clean && CI=true GITHUB_ACTIONS=true pnpm run test:e2e`.

Ordinary `pnpm run smoke` exercises the pinned development closure, not the latest host. For the packed current-host profile path on Node 24/pnpm 11.7.0, use `pnpm exec vitest run --config vitest.e2e.config.ts tests/built-package.e2e.spec.ts -t '0.1.7-rc.2'` (the complete serialized matrix is `pnpm run test:e2e`). Neither command requests a model.

### Opt-in real-agent smoke

The agent smoke is deliberately separate from build, test, coverage, determinism, ordinary smoke, prepack, and release gates. It uses the packed plugin in a disposable DeepSeek Harness `0.1.1-rc.2` headless profile and drives a real `@deepseek-ai/dsh-agent@0.1.1-rc.2` turn through provider `deepseek`.

Set `DEEPSEEK_API_KEY`, a non-empty `LLMWIKI_AGENT_SMOKE_MODEL`, and the exact explicit network opt-in `LLMWIKI_AGENT_SMOKE_NETWORK=allow`; there is no default model or fallback provider. Without the opt-in, the harness exits `BLOCKED_NETWORK_NOT_OPTED_IN` before disposable setup. `pnpm run smoke:agent -- --preflight` clean-builds and packs a temporary copy of the current source, installs exact pinned DSH specifications into an isolated HOME/XDG/pnpm environment, validates the disposable profile and evidence location, and records no model request. A missing key exits `BLOCKED_MISSING_CREDENTIAL`. The optional `LLMWIKI_AGENT_SMOKE_EVIDENCE` changes the success-only evidence destination from `tests/fixtures/agent-smoke/latest.json`.

Only a successful credentialed run writes canonical sanitized evidence atomically. It retains assertion results, safe tool names, requested and resolved runtime versions, durable source/page IDs and hashes, and final structural-lint error/warning counts, but never prompts, completions, credentials, headers, raw wiki content, child diagnostics, transcripts, or absolute paths. Preflight never creates or overwrites evidence, the credential reaches only the model-running child, bounded children are terminated on timeout, and the harness deletes its disposable profile, stores, and wiki.

### Publishing to npm

[`.github/workflows/publish.yml`](.github/workflows/publish.yml) publishes `@evegoodevening/dsh-llmwiki` when a `v*` tag is pushed. The tag must exactly match `v` plus the version in `package.json`. It uses a GitHub-hosted runner, Node.js 24, npm 11.20.0, and the pnpm version declared in `packageManager`, with dependency caches disabled and Actions pinned to commit SHAs.

Before the first CI release, configure the package's **Settings → Trusted Publisher → GitHub Actions** on npmjs.com:

| Field | Value |
| --- | --- |
| Organization or user | `EveGoodEvening` |
| Repository | `dsh-llmwiki` |
| Workflow filename | `publish.yml` (not the full path) |
| Environment name | Leave empty; the workflow does not declare an environment |
| Allowed actions | Allow `npm publish` for direct releases |

Authentication uses OIDC via `id-token: write`; do not add an `NPM_TOKEN` or `NODE_AUTH_TOKEN` publish secret. New trusted publishers default to staged publishing, so explicitly allowing `npm publish` is required. Public-repository/public-package releases receive provenance automatically. See [npm's trusted publishing documentation](https://docs.npmjs.com/trusted-publishers/).

The release gate runs a frozen-lockfile install, typecheck, lint, unit tests, a clean build followed by serialized packed-package E2E, determinism checks, and the ordinary smoke before `npm publish --access public`. The credentialed real-agent smoke is not a release gate. Publishing also runs the existing `prepack` build.

The Linux unit suite includes a private read-only tmpfs mount proof that requires root. The workflow uses the GitHub-hosted VM's passwordless `sudo` for that suite, preserves `PATH` and `HOME` so pnpm uses the installed toolchain and store, and restores `node_modules` ownership on exit. Missing mount capabilities fail the gate rather than skipping the proof; later checks and publishing run as the normal runner user.

To release from `master`, commit an unpublished stable package version and update versioned tarball examples. Push the branch containing the workflow first and confirm that **Publish to npm** appears in GitHub Actions, then push the annotated release tag in a separate operation. In the initial `0.1.4` rollout, a combined first-workflow/branch/tag push registered the workflow without starting a run; a later isolated tag push against the same commit did start it.

```sh
git push origin HEAD:master
version="$(node --print 'require("./package.json").version')"
git tag -a "v$version" -m "Release v$version"
git push origin "refs/tags/v$version"
```

The workflow does not bump versions or overwrite published versions. After the first successful OIDC release, npm recommends enabling **Require two-factor authentication and disallow tokens** and revoking unused publish tokens.

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
