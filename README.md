# dsh-llmwiki

Local-first, evidence-backed Markdown wiki plugin for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (dsh).

Inspired by [Karpathy's `llm-wiki.md`](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f) concept: raw sources are preserved immutably and an LLM owns a navigable Markdown wiki derived from those sources.

`dsh-llmwiki` gives a dsh agent durable, evidence-grounded memory: immutable source records are preserved by content hash, synthesized Markdown pages cite those source IDs, and a deterministic section index backs lexical search. Everything lives on the local filesystem under a single wiki root — no external service, no model calls for maintenance.

- **Immutable sources.** `llmwiki_add_source` stores exact UTF-8 bytes; the source ID is the SHA-256 of the content. Sources are never mutated or deleted by the plugin.
- **Evidence-backed pages.** `llmwiki_upsert_page` writes canonical Markdown whose frontmatter must list real preserved source IDs. Pages are synthesized notes; sources are the evidence.
- **Deterministic search.** `llmwiki_search` ranks page sections by a reproducible BM25-style score over a derived index (`formatVersion: 1`). A stale or missing index is rebuilt on demand; durable artifacts are never touched.
- **Read-only lint.** `llmwiki_lint` and `/wiki lint` report structural, integrity, and index diagnostics without fixing anything.
- **Safe filesystem.** The wiki root must be a real directory; symbolic links are rejected below it and all derived paths are confined to the root.

## Requirements

- Node.js `^22.19.0 || >=24`
- pnpm `11.7.0` (required for development and must be on `PATH` for `dsh plugin`)
- For profile installation: `@deepseek-ai/dsh@0.1.0-rc.6` (the tested host version)
- For direct Cordis loading: a host providing the `tools`, `commands`, and `systemPrompt` services plus the exact peer dependencies in `package.json`

## Install

### npm package name

This repository uses the controlled npm package name `@evegoodevening/dsh-llmwiki`. The unscoped npm name [`dsh-llmwiki`](https://www.npmjs.com/package/dsh-llmwiki) is owned by a different maintainer and resolves to a different implementation from [`chancelu/dsh-llmwiki`](https://github.com/chancelu/dsh-llmwiki).

Always use the scoped package specifier for registry installs, Loader rows, imports, and profile removal. Never substitute the unscoped name.

### As a dsh profile bundle (recommended)

For a registry release, install through the dsh profile manager. The commands assume `dsh` is `@deepseek-ai/dsh@0.1.0-rc.6`; replace `web` with another profile name if needed.

```sh
dsh plugin --profile web add @evegoodevening/dsh-llmwiki
dsh --profile web --dump-config
```

For local checkout validation before publishing, install the generated tarball instead:

```sh
pnpm install
PACK_DIR="$(mktemp -d)"
pnpm pack --pack-destination "$PACK_DIR"
dsh plugin --profile web add --ignore-scripts "$PACK_DIR/evegoodevening-dsh-llmwiki-0.1.0.tgz"
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
  "$PACK_DIR/evegoodevening-dsh-llmwiki-0.1.0.tgz" \
  @deepseek-ai/cordis@4.0.1 \
  @deepseek-ai/cordis-plugin-loader@1.0.2 \
  @deepseek-ai/dsh-brand@0.1.0-rc.6 \
  @deepseek-ai/dsh-commands@0.1.0-rc.6 \
  @deepseek-ai/dsh-session@0.1.0-rc.6 \
  @deepseek-ai/dsh-system-prompt@0.1.0-rc.6 \
  @deepseek-ai/dsh-tools@0.1.0-rc.6 \
  node-addon-require-builtin@0.1.4
```

Load it through the Cordis plugin Loader with `inject: ['tools', 'commands', 'systemPrompt']`. See [`examples/README.md`](examples/README.md) for a complete runnable demo that builds, packs, installs, and exercises the plugin from clean directories.

## Configuration

All keys are optional; defaults are shown.

| key | type | default | constraint | meaning |
| --- | --- | --- | --- | --- |
| `root` | string | `.llmwiki` | non-empty | Wiki root directory, resolved from the process working directory |
| `maxSourceBytes` | integer | `2097152` (2 MiB) | `>= 1` | Maximum UTF-8 byte length of a single source `content` |
| `maxPageBytes` | integer | `524288` (512 KiB) | `>= 1` | Maximum rendered byte length of a page body |
| `maxResults` | integer | `20` | `1..100` | Cap on `llmwiki_search` hits |
| `maxSnippetBytes` | integer | `1200` | `64..16384` | Cap on per-hit snippet length |
| `commandDiagnosticLimit` | integer | `20` | `1..100` | Diagnostics printed by `/wiki lint` before an omission notice |

Unknown config keys are rejected at load time.

## Storage layout

```
<root>/
  schema.md                  # human-readable wiki schema (UTF-8)
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
summary: "Concise evidence-backed summary."
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
| `llmwiki_status` | read | none | Report initialization, source/page counts, schema text, and index freshness |
| `llmwiki_add_source` | edit | `name`, `content`, `mediaType?`, `origin?` | Preserve exact UTF-8 evidence; returns source ID and dedupe state |
| `llmwiki_read_source` | read | `id`, `offset?`, `limit?` | Read immutable source content with provenance metadata |
| `llmwiki_search` | search | `query`, `limit?` | Rank page sections by lexical score; may rebuild a stale derived index |
| `llmwiki_read_page` | read | `id` | Read one synthesized page by logical page ID |
| `llmwiki_upsert_page` | edit | `id`, `title`, `summary`, `sources`, `body` | Atomically create or update a page; requires real source IDs |
| `llmwiki_lint` | read | none | Run deterministic read-only validation; reports diagnostics and counts |

## Model experience

The plugin registers a system-prompt section named `tool:llmwiki`, ordered at `116`:

```text
Use the llmwiki as durable, evidence-backed memory:
- Call llmwiki_status before relying on the wiki.
- Search first, then read only the relevant pages and immutable source records.
- Treat wiki pages as synthesized notes; source records are the preserved evidence.
- Cite real source IDs in every page write. Never invent a source ID.
- Use llmwiki_upsert_page only when new evidence changes durable knowledge.
- llmwiki_lint is read-only. Do not claim that it repaired anything.
```


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

`NOT_INITIALIZED`, `INVALID_PATH`, `SOURCE_NOT_FOUND`, `PAGE_NOT_FOUND`, `INVALID_PAGE`, `LIMIT_EXCEEDED`, `ABORTED`, `UNSAFE_FILESYSTEM`, `INDEX_CORRUPT`.

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
```

The test suite lives under `tests/`; fixtures under `tests/fixtures/`. The committed `examples/demo-wiki` corpus intentionally omits `.index` so lint first reports `INDEX_MISSING` and search rebuilds the derived index.

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
