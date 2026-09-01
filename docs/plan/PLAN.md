# dsh-llmwiki implementation plan

## 1. Mission and scope

Build `dsh-llmwiki` as a **host-only, local-first, static DeepSeek Harness (dsh) Cordis plugin**. The plugin gives the model a source-linked Markdown wiki, deterministic local retrieval and structural linting, immutable raw-source preservation, and a small human command surface. It ships as one public npm package that is also a dsh profile bundle.

This plan deliberately excludes a browser UI, HTTP server, hosted sync, graph database, embeddings/vector search, SQLite, background file watching, and autonomous model calls. None is required by Karpathy's idea file or dsh's extension contract. The first release must work offline with Node's standard library and the services already supplied by dsh.

The repository already contains `.git` on an unborn branch with no commits. Implementation begins by adding the package shell and making the first planned commit; it must not run `git init` or rewrite existing Git metadata. This document and `CHECKLIST.md` are the only planning artifacts.

## 2. Sourced research and resulting decisions

### 2.1 Primary concept source

Karpathy's [`llm-wiki.md`](https://gist.githubusercontent.com/karpathy/442a6bf555914893e9891c11519de94f/raw/llm-wiki.md) is an **idea file, not a canonical application specification**. It establishes:

1. raw sources are preserved;
2. an LLM owns a navigable Markdown wiki derived from those sources;
3. a schema/instruction layer guides wiki organization;
4. ingest, query, and lint are workflows.

It does **not** prescribe directories, a database, retrieval algorithm, CLI, UI, graph, embeddings, or prompt/tool schemas. Those are implementation choices and must not be attributed to the gist.

### 2.2 Independent implementations consulted

These are examples, not normative specifications:

- [Astro-Han Agent Skill](https://raw.githubusercontent.com/Astro-Han/karpathy-llm-wiki/main/SKILL.md): reinforces the raw/wiki/schema split, evidence requirements, and explicit ingest/query/lint workflows.
- [ddsyasas ingest](https://raw.githubusercontent.com/ddsyasas/llm-wiki/main/packages/core/src/ingest.ts), [query](https://raw.githubusercontent.com/ddsyasas/llm-wiki/main/packages/core/src/query.ts), and [lint](https://raw.githubusercontent.com/ddsyasas/llm-wiki/main/packages/core/src/lint.ts): demonstrates persisted source/page records, index-first query, and the value of separating deterministic lint from LLM judgment. Its Next.js/SQLite/FTS application topology is not adopted.
- [Praney Behl search](https://raw.githubusercontent.com/praneybehl/llm-wiki-plugin/main/skills/llm-wiki/scripts/wiki_search.py): demonstrates section-level lexical retrieval, stable evidence output, and optional semantic enhancement. This plan adopts section-level lexical retrieval but not its Python/uv/FastEmbed/sqlite-vec runtime.
- [Praney Behl ingest workflow](https://raw.githubusercontent.com/praneybehl/llm-wiki-plugin/main/skills/llm-wiki/references/ingest-workflow.md): supports surgical page updates, citations, and user-review boundaries. Graph extraction remains deferred.

### 2.3 Exact dsh extension sources consulted

The architecture follows [`deepseek-ai/deepseek-harness`](https://github.com/deepseek-ai/deepseek-harness) at revision [`fa7e9f5a`](https://github.com/deepseek-ai/deepseek-harness/tree/fa7e9f5a):

- `docs/cordis-tutorial/01-first-plugin.md:23-77`: static Cordis rows and accepted plugin entry shapes.
- `docs/cordis-tutorial/02-lifecycle-and-effects.md:62-94`: registrations/resources are fiber-owned effects and async disposal must quiesce.
- `docs/cordis-tutorial/03-services.md:44-78`: `inject` is service-key based; activation is order-independent and follows dependency availability.
- `docs/cookbook/adding-a-package.md:9-49`: package/manifest conventions and capability topology.
- `docs/testing.md:7-49`: HMR cleanup, real Loader composition, built-artifact, coverage, and keyless snapshot expectations.
- `packages/extensions/cordis-host-runner/src/index.ts:80-143`: `Context` declaration merging, `Service` subclass, static `inject`, Schemastery `Config`, and `super(ctx, key)`.
- `packages/extensions/tool-cordis/src/index.ts:26-58`: named plugin exports, exact `ctx.systemPrompt.section(...)`, `ctx.tools.register(defineTool(...))`, JSON output declaration, and pure rendering.
- `packages/goal/command-goal/src/index.ts:162-169`: exact `ctx.commands.register({ name, description, input, handler })` shape.
- `packages/interaction/commands/src/index.ts:25-55`: lowercase command names, abortable `CommandInvocation`, and `CommandResult` contract.
- `packages/core/tools/src/index.ts:65-135,211-223`: `defineTool`, JSON output schema/render contract, and replayable presentation types.
- `packages/core/system-prompt/README.md:20-23`: prompt sections are scoped, fiber-owned registrations.
- `packages/bundle/base/package.json:13-40` and `packages/bundle/base/cordis.patch.yml:1-17`: exact `dsh.bundle.patch` manifest shape and patch-row insertion semantics.

### 2.4 Newly verified release/tooling contract

The compatibility baseline is now fixed rather than inferred: `packageManager` is `pnpm@11.7.0`; `engines.node` is `^22.19.0 || >=24`; peer dependencies are exact versions `@deepseek-ai/cordis@4.0.1`, `@deepseek-ai/dsh-brand@0.1.0-rc.6`, and `@deepseek-ai/dsh-commands`, `@deepseek-ai/dsh-session`, `@deepseek-ai/dsh-system-prompt`, and `@deepseek-ai/dsh-tools` at `0.1.0-rc.6`, mirrored exactly in development dependencies; runtime `@deepseek-ai/schemastery` is exactly `3.18.1`; and development tooling is TypeScript `6.0.3`, ESLint `9.39.2`, `@typescript-eslint/parser` `8.67.0`, `@typescript-eslint/eslint-plugin` `8.67.0`, tsdown `0.22.2`, tsx `4.22.4`, Vitest/`@vitest/coverage-v8` `4.1.8`, and `@types/node` `22.20.0`. The exact `0.1.0-rc.5` dsh packages inspected locally are not published. Primary npm registry version records prove the selected rc.6 packages are installable, and comparison of the published rc.6 declarations/runtime with the inspected rc.5 source found the planned APIs byte-identical. Exact pins prevent accidental resolution to the older rc.1 `latest` dist-tag. dsh domain convention requires `Branded<B>` to be imported directly from `@deepseek-ai/dsh-brand`; C02 therefore receives sequential ownership of `package.json` and `pnpm-lock.yaml` from C01, adds the exact rc.6 package as both peer and development dependency, regenerates the lockfile through pnpm rather than hand-editing it, then transfers `package.json` to C09 and `pnpm-lock.yaml` to C10.

C10's discovered test-only direct dependency contract is exact development dependencies `@deepseek-ai/cordis-plugin-loader@1.0.2` and `node-addon-require-builtin@0.1.4`. Its patch-parsing paths do not import `@deepseek-ai/cordis-plugin-include`; `@deepseek-ai/cordis-plugin-include@1.0.6` remained transitive and unused by C10, so the provisional direct development pin was removed under the conditional contract. C10 may update `package.json` and `pnpm-lock.yaml` solely for the required Loader/helper entries and pnpm-generated resolutions, then transfers `package.json` to C11 and `pnpm-lock.yaml` to C12.

Chunk staging must reflect files that actually exist. C01 defines only script commands whose targets exist in the repository shell/current configuration, but it does not execute TypeScript compilation: with no `src/**/*.ts` input yet, `tsc --showConfig` exits with TS18003 before producing usable configuration output. C01 therefore validates the raw `tsconfig.json` compiler options with a Node assertion; C02, after creating the first source files, is the first chunk to execute `pnpm run typecheck` (and any real `tsc --showConfig` inspection if needed). C02's focused import scan covers only the C02 modules that exist at that boundary; the final integration review scans every later filesystem callsite after C03–C10 exist. C11 creates `scripts/check-determinism.ts` and `scripts/smoke.ts` and then adds the corresponding `check:determinism` and `smoke` package scripts under its sequential package-manifest ownership. Likewise, C01 must not require bundle fields that point at a file which does not exist yet: C09 creates `cordis.patch.yml`, then adds `dsh.bundle.patch`, the patch export, and the patch `files` entry.

Workers do not hand-author `pnpm-lock.yaml`. The orchestrator's C01 install verification runs pnpm `11.7.0`, which generates the lockfile from the reviewed manifest; the generated lockfile is committed as C01 output. pnpm `11.7.0` ignores build-policy settings placed under `package.json#pnpm`; project build policy belongs in the committed `pnpm-workspace.yaml`. C01 creates exactly:

```yaml
allowBuilds:
  esbuild@0.28.2: true
```

Omitting `packages` keeps this a root-only single-package project, omitted dependencies remain denied under the default `strictDepBuilds: true`, and the allowlist pins the only approved build script to exactly `esbuild@0.28.2`. `minimumReleaseAgeExclude` is unrelated to dependency build-script approval and must not be used or interpreted as that policy. A dependency-clean pnpm `11.7.0` install has already exited zero under this workspace policy; frozen-lockfile verification remains a release gate, not an unresolved C01 defect.

Vitest 4.1.8 coverage uses `coverage.include: ['src/**/*.ts']` to include unimported source files and `coverage.thresholds.perFile: true` for per-file enforcement. The obsolete `coverage.all` option and top-level `coverage.perFile` spelling are prohibited.

## 3. Chosen architecture

### 3.1 Package topology

Use a **single package** named `dsh-llmwiki` with named Cordis plugin exports:

```ts
export interface Config {
  root?: string
  maxSourceBytes?: number
  maxPageBytes?: number
  maxResults?: number
  maxSnippetBytes?: number
  commandDiagnosticLimit?: number
}
export const Config: z<Config> = z.object(/* matching §3.9 exactly */)
export const name = 'llmwiki'
export const inject = ['tools', 'commands', 'systemPrompt']
export function apply(ctx: Context, config: Config): void
```

Do not default-export the plugin: dsh documents a regression class in which default-export wrapping can lose named `inject`. A Loader test must guard this.

A separate interface/provider/consumer package family is unnecessary now. The service, filesystem implementation, model tools, command, and prompt form one cohesive local capability with one release cadence. Internal modules keep boundaries explicit so a future provider split remains possible without exposing speculative public seams.

The same npm package becomes a bundle in C09, when `cordis.patch.yml` exists, by adding:

```json
{
  "dsh": { "bundle": { "patch": "./cordis.patch.yml" } }
}
```

C01 deliberately omits the patch export, `files` entry, and `dsh.bundle.patch` field. C09 creates `cordis.patch.yml`, adds those package fields, and inserts one row with `id: llmwiki`, `name: dsh-llmwiki`, and conservative defaults. Users override the **entire** config in profile `cordis.patch.yml`; documentation must warn that dsh patch config is replacement, not deep merge.

### 3.2 Host service

`LlmWikiService extends Service` is registered as `ctx.llmwiki` through Cordis `Context` augmentation. It owns:

- root resolution and containment;
- repository initialization/status;
- immutable source preservation and reading;
- validated page writes and reading/listing;
- deterministic section indexing/search;
- deterministic lint;
- serialization of mutations and atomic file replacement.

`apply()` instantiates the service and registers tools, prompt, and command against it. All registrations are fiber-owned. The service has no watcher or long-lived handle; if a later implementation opens handles, they must be acquired through `ctx.effect()` with an async disposer.

### 3.3 Filesystem model

Configured `root` defaults to `.llmwiki`, resolved against `process.cwd()` once at activation. All public paths are POSIX-style logical paths. OS paths are private implementation details.

```text
.llmwiki/
├── schema.md
├── sources/
│   └── <sha256>/
│       ├── content
│       └── metadata.json
├── pages/
│   └── **/*.md
└── .index/
    ├── search.json
    └── state.json
```

Rules:

- `schema.md` is user-owned wiki guidance. Initialization creates a concise default only when absent; later operations never overwrite it.
- Source ID is lowercase SHA-256 of the exact source bytes. `content` is immutable and byte-identical. `metadata.json` is immutable canonical JSON recording `id`, display `name`, media type, byte count, capture time, and optional origin. Capture time records the actual ingest event and is intentionally nondeterministic across fresh roots, so source metadata is excluded from derived-output determinism guarantees. Re-ingesting identical bytes within one root returns the existing record without rewriting either its capture time or any other metadata. The first immutable provenance wins; later aliases are returned to the caller but are not silently persisted.
- Pages are UTF-8 Markdown below `pages/`; logical page IDs are normalized relative paths without `.md`. No absolute paths, `..`, empty segments, backslashes, NUL, or symlink traversal are accepted.
- Every page begins with strict YAML frontmatter containing `title`, `summary`, and a non-empty unique sorted `sources` array of known source IDs. The body must be non-empty Markdown. The implementation supports only its documented scalar/list subset; it does not depend on a general YAML library for domain parsing.
- `.index/*` is derived and disposable. Search/lint may rebuild it synchronously when missing/stale. Deleting `.index` is always safe.
- Atomic writes use a sibling temporary file opened exclusively, `fsync` where supported, rename, then cleanup. Page writes and index rebuilds are serialized by one in-process mutation queue. No claim of cross-process write safety is made; concurrent writers in separate dsh processes are unsupported and lint reports abandoned temporary files.
- The configured wiki root must be a real directory, never a symlink. If absent, initialization creates it safely; if it exists as a symlink or any non-directory filesystem object, configuration is rejected. Symlinks are also rejected anywhere below the accepted real root for source/page/index operations. Root creation and traversal use `lstat`/`realpath` checks to prevent configured-root escape.

### 3.4 Deterministic index and search

Search is dependency-free and section based:

1. Discover page files recursively; reject symlinks; sort by UTF-8 code-unit logical path.
2. Parse frontmatter and split Markdown at ATX headings. Each record contains page ID, title, heading trail, one-based start line, source IDs, and normalized text.
3. Tokenize with Unicode property escapes: lowercase, normalize NFKC, collect letter/number runs; preserve CJK runs and also emit overlapping 2-character grams for runs longer than one character. Drop no language-specific stop words.
4. Build document frequency over sections and store canonical `search.json` with a format version, page fingerprints, sorted records, lengths, term frequencies, and document frequencies.
5. Score query tokens using BM25 with fixed constants `k1 = 1.2`, `b = 0.75`. Add deterministic field boosts: title `2.0`, heading trail `1.5`, body `1.0`. Repeated query tokens do not multiply weight.
6. Sort by descending finite score, then page ID, then start line. Return at most configured `maxResults`; snippets are deterministic line-bounded extracts capped by `maxSnippetBytes` without splitting a UTF-8 code point.
7. Empty/tokenless queries are rejected. Search never invokes a model, network, external process, locale-dependent collation, clock, or random source.

`state.json` records index format version and a sorted mapping of page ID to SHA-256 of exact page bytes. Freshness is decided by comparing the current mapping; mtimes are never authoritative. An incompatible or malformed derived index is rebuilt, not migrated in place.

The parallel C04/C05 contract is normative and closed. Both files use `formatVersion: 1`; JSON objects reject unknown keys, arrays preserve the specified order, `averageSectionLength` is the sole numeric field permitted to be a finite non-negative floating-point value, every integer-count field remains a non-negative safe integer, hashes are 64-character lowercase hexadecimal SHA-256 values, and canonical serialization uses the field order shown below, two-space indentation, and one trailing newline:

```ts
interface IndexStateV1 {
  formatVersion: 1
  pages: Array<{ pageId: string; sha256: string }> // sorted by pageId
  searchSha256: string // hash of the exact canonical search.json bytes
}

interface SearchIndexV1 {
  formatVersion: 1
  pageFingerprints: Array<{ pageId: string; sha256: string }> // same sorted mapping as state.pages
  documentCount: number
  averageSectionLength: number
  documentFrequencies: Array<{ term: string; count: number }> // sorted by term
  sections: Array<{
    pageId: string
    title: string
    headingTrail: string[]
    startLine: number
    sourceIds: string[] // sorted
    normalizedText: string
    length: number
    titleTermFrequencies: Array<{ term: string; count: number }>
    headingTermFrequencies: Array<{ term: string; count: number }>
    bodyTermFrequencies: Array<{ term: string; count: number }>
  }> // sorted by pageId, then startLine
}
```

Each term-frequency array is sorted by term and contains only positive safe-integer counts. `averageSectionLength` is the sole floating-point numeric field: it is the finite non-negative arithmetic mean of safe-integer `length` values, or `0` for an empty corpus. All other integer-count fields, including `documentCount`, `startLine`, `length`, and document/term-frequency `count` values, remain non-negative safe integers, with the stricter positive-count rule where stated. The writer commits canonical `search.json` first and `state.json` second; freshness requires a valid pair where `state.searchSha256` hashes the exact current `search.json` bytes and both fingerprint arrays equal the freshly computed page mapping. Any missing, extra, malformed, non-finite, negative, non-safe-integer where an integer is required, unsorted, version-incompatible, hash-mismatched, or mapping-mismatched field makes the pair non-fresh; search rebuilds it, while lint reports the specified index diagnostic without writing.

### 3.5 Lint

Lint is read-only and deterministic. It returns sorted diagnostics with `{ code, severity, path, line?, message }`; ordering is path, line (missing last), code, message. It checks:

- required directories/schema presence and UTF-8 validity;
- symlinks and root escapes;
- source directory name/content hash agreement;
- source metadata schema and byte count;
- page path normalization and `.md` extension;
- frontmatter shape, unknown keys, duplicate/unsorted source IDs, missing sources, empty body;
- duplicate normalized titles;
- broken relative Markdown links between pages and links escaping `pages/`;
- stale/malformed/incompatible index;
- temporary files left by interrupted atomic writes.

Lint never edits. `fix` is intentionally absent in v1.

### 3.6 Model-facing tools

After C16, register exactly these nine tools through `ctx.tools.register(defineTool(...))` in the displayed stable order:

| Tool | Mutation | Contract |
|---|---:|---|
| `llmwiki_status` | no | Return initialization state, counts, schema text, and index freshness. This is the discovery entry point. |
| `llmwiki_add_source` | yes | Accept `name`, exact UTF-8 `content`, optional `mediaType` and `origin`; preserve bytes, return source ID and dedupe state. Content input avoids granting arbitrary host-file reads. |
| `llmwiki_list_sources` | no | Accept optional bounded `limit`/opaque source cursor and return the closed source catalog page defined in §14.3. |
| `llmwiki_read_source` | no | Accept exact source ID plus optional byte-bounded offset/limit; return byte range and metadata. |
| `llmwiki_search` | derived-index rebuild only | Accept query and optional limit; return ranked matching sections with page, heading, line, score, snippet, and source IDs. |
| `llmwiki_list_pages` | no | Accept optional bounded `limit`/opaque page cursor and return the closed page catalog page defined in §14.3. |
| `llmwiki_read_page` | no | Accept normalized page ID; return exact Markdown plus parsed metadata. |
| `llmwiki_upsert_page` | yes | Accept page ID, title, summary, source IDs, and body; validate known source linkage and atomically write canonical Markdown. Return created/updated plus content hash. |
| `llmwiki_lint` | no | Return deterministic structural/integrity diagnostics and summary counts; it never performs semantic review. |

`defineTool` must remain the registration API. Its compiled parameter schema is an open top-level object, so the plugin cannot claim or test a closed top-level parameter-object invariant. Every supported parameter is nevertheless declared explicitly with required flags, descriptions, and bounds; handlers validate/reject invalid values of declared fields, ignore no declared validation failure, do not read or derive behavior from unknown keys, and produce the same behavior when irrelevant unknown keys are present. Structured output/value objects use closed JSON schemas wherever the dsh schema surface supports closure. `execute` observes `exec.signal` before and between I/O phases and never turns cancellation into success. Result renderers and `presentCall`/`presentResult` are pure; search uses the generic search/read presentation vocabulary where compatible, with raw text fallback. Mutating calls make their effect explicit in title and model-facing result.

No delete tool ships in v1: deleting knowledge or raw evidence is a trust-sensitive operation better performed explicitly by a human in the filesystem. Source bytes are immutable by contract.

### 3.7 Prompt integration

Register one stable section:

```ts
ctx.systemPrompt.section({
  name: 'tool:llmwiki',
  order: 116,
  text: LLMWIKI_SYSTEM_PROMPT,
})
```

The prompt defines a status-first maintenance workflow:

- call `llmwiki_status` before relying on or mutating the wiki; a fresh root reports `initialized: false` and `schemaText: null`;
- read the human-owned schema when present while treating it as subordinate to system/user instructions; schema evolution remains intentionally unresolved pending authorization/confirmation, visible audit evidence, and optimistic-concurrency/lost-update decisions;
- obtain explicit user authorization before preserving supplied material with `llmwiki_add_source`;
- after adding a source, call status again and reread the now-present human-owned schema before maintenance;
- inventory both source and page catalogs, then search and read relevant pages and immutable sources;
- classify supplied material as `new`, `update`, `contradiction`, or `no material change` before deciding whether any page should change;
- when maintenance is authorized, update every materially affected page, use only existing source IDs, preserve disagreements, and maintain links;
- run structural `llmwiki_lint` unconditionally before the separately named semantic review, including read-only, no-write, and no-material-change paths;
- for semantic review, separately name and state the selected scope, read every scoped page plus every source it cites and relevant new candidate sources, classify material findings as `contradiction`, `superseded`, `unsupported`, or `missing-link`, visibly report affected page and source IDs as agent judgments, and update pages only when the user request authorizes maintenance;
- after any authorized durable updates, rerun structural lint; lint is read-only and never claims semantic judgment or repairs.

The stable prompt text lives in `src/prompt.ts`, is snapshot-tested verbatim, and is documented in README Model Experience. Tool schemas are the remainder of the direct model-context cost.

### 3.8 Human command

Register one lowercase command:

```text
/wiki [status|lint|reindex]
```

- no argument / `status`: concise initialized/count/index status;
- `lint`: deterministic summary and first configured diagnostic cap;
- `reindex`: force rebuild derived index and report record count.

The command does not trigger a model turn and does not ingest/write pages. Its handler respects `invocation.signal`, returns stable `CommandResult` error text for invalid syntax/domain errors, and lets unexpected programmer/I/O errors reject for dsh's normal handling.

### 3.9 Configuration

Schemastery validates:

```ts
interface Config {
  root?: string                 // default '.llmwiki'; non-empty
  maxSourceBytes?: number       // default 2 MiB, >= 1
  maxPageBytes?: number         // default 512 KiB, >= 1
  maxResults?: number           // default 20, 1..100
  maxSnippetBytes?: number      // default 1200, 64..16384
  commandDiagnosticLimit?: number // default 20, 1..100
}
```

Limits are deployment config, never scattered constants. Tools may request lower per-call limits but cannot exceed configured caps. `root` is not exposed as a tool argument. Bundle patch states the complete default config because dsh patch overrides replace whole configs.

The public DTOs have these field-level contracts:

```ts
interface WikiStatus {
  initialized: boolean
  sourceCount: number
  pageCount: number
  schemaText: string | null
  index: { present: boolean; fresh: boolean; formatVersion: number | null; sectionCount: number }
}

interface ReindexReceipt {
  pageCount: number
  sectionCount: number
  formatVersion: number
}

interface ByteRange {
  offset: number // zero-based UTF-8 byte offset; default 0
  limit: number  // maximum returned bytes, integer >= 1 and capped by maxSourceBytes
}
```

`readSource` returns the largest code-point-aligned byte slice beginning at or after `offset` and ending no later than `offset + limit`; if either boundary falls inside a UTF-8 sequence it advances the start and retreats the end. `offset === byteCount` returns an empty slice; `offset > byteCount` is `LIMIT_EXCEEDED`. Returned metadata includes the effective byte start/end and total byte count so truncation is explicit.

## 4. Public contracts and invariants

### 4.1 Public TypeScript surface

`src/index.ts` exports plugin metadata and public domain types. `ctx.llmwiki` exposes:

```ts
status(signal?: AbortSignal): Promise<WikiStatus>
addSource(input: AddSourceInput, signal?: AbortSignal): Promise<SourceReceipt>
readSource(id: SourceId, range?: ByteRange, signal?: AbortSignal): Promise<SourceRead>
search(query: string, limit?: number, signal?: AbortSignal): Promise<SearchHit[]>
readPage(id: PageId, signal?: AbortSignal): Promise<PageRead>
upsertPage(input: UpsertPageInput, signal?: AbortSignal): Promise<PageReceipt>
lint(signal?: AbortSignal): Promise<LintReport>
reindex(signal?: AbortSignal): Promise<ReindexReceipt>
```

Brand constructors validate `SourceId` and `PageId`; callers never cast arbitrary strings. Domain errors carry stable codes (`NOT_INITIALIZED`, `INVALID_PATH`, `SOURCE_NOT_FOUND`, `PAGE_NOT_FOUND`, `INVALID_PAGE`, `LIMIT_EXCEEDED`, `ABORTED`, `UNSAFE_FILESYSTEM`, `INDEX_CORRUPT`) and safe messages. Tool/command adapters translate expected domain errors; internal causes are not serialized into model-visible JSON.

### 4.2 Non-negotiable invariants

1. Captured source content is byte-identical and never overwritten.
2. A page cannot be committed without at least one existing source ID.
3. Every path remains within the resolved root; symlinks are rejected.
4. The same durable page/source content bytes and query produce byte-equivalent index JSON, diagnostics, ordering, and search results. Capture-time source metadata intentionally differs across independent fresh-root ingests and is outside this derived-output determinism guarantee; dedupe within one root preserves the first metadata unchanged.
5. Derived index loss/corruption cannot destroy source or page data.
6. Mutation success is reported only after atomic rename completes.
7. Cancellation never reports success after the abort is observed.
8. Cordis disposal removes service/tool/command/prompt registrations; remounting has no duplicate residue.
9. Plugin activation does not depend on patch row order.
10. No operation performs network access, subprocess execution, or hidden model calls.

## 5. Complete target file tree

```text
.
├── .gitignore
├── LICENSE
├── README.md
├── PLAN.md
├── CHECKLIST.md
├── package.json
├── pnpm-lock.yaml
├── pnpm-workspace.yaml
├── tsconfig.json
├── tsdown.config.ts
├── vitest.config.ts
├── vitest.e2e.config.ts
├── tsconfig.eslint.json
├── eslint.config.js
├── cordis.patch.yml
├── src/
│   ├── index.ts
│   ├── config.ts
│   ├── types.ts
│   ├── errors.ts
│   ├── ids.ts
│   ├── paths.ts
│   ├── atomic.ts
│   ├── markdown.ts
│   ├── tokenizer.ts
│   ├── indexer.ts
│   ├── lint.ts
│   ├── service.ts
│   ├── prompt.ts
│   ├── presentation.ts
│   ├── tools.ts
│   └── command.ts
├── tests/
│   ├── harness.ts
│   ├── ids-paths.spec.ts
│   ├── markdown.spec.ts
│   ├── indexer.spec.ts
│   ├── service.spec.ts
│   ├── lint.spec.ts
│   ├── plugin.spec.ts
│   ├── loader.e2e.spec.ts
│   ├── built-package.e2e.spec.ts
│   └── fixtures/
│       ├── corpus/
│       │   ├── source-a.txt
│       │   ├── source-b.txt
│       │   ├── alpha.md
│       │   └── beta.md
│       └── expected/
│           ├── search.json
│           └── lint.json
├── examples/
│   ├── README.md
│   ├── cordis.yml
│   └── demo-wiki/
│       ├── schema.md
│       ├── sources/
│       │   └── <fixture-sha256>/
│       │       ├── content
│       │       └── metadata.json
│       └── pages/
│           └── getting-started.md
└── scripts/
    ├── check-determinism.ts
    └── smoke.ts
```

`lib/`, coverage, temporary wiki roots, and `.index/` output generated during tests are ignored and never committed. C01 creates the protective `.gitignore` before any install/build command; C12 may tighten it during final cleanup. The example intentionally omits `.index` to prove rebuildability. No `AGENTS.md` is planned: there are no repository lessons yet, and fabricating them would violate the assignment context.

Current-state reconciliation: durable repository-specific smoke lessons later justified `AGENTS.md`, added separately by commit `99addd9` (`docs(agents): record real-agent smoke constraints`). This does not rewrite the historical target-tree decision above and is outside C19A's exact-19 accounting.

`.npmignore` is intentionally absent from the authoritative target tree. `package.json#files` is the single publication allowlist, and the structured-pack plus `pnpm pack --dry-run` gates verify its exact emitted set; a second exclusion mechanism would add drift risk without constraining publication further.

## 6. Component design and ownership

| Component | Paths | Responsibility | Depends on |
|---|---|---|---|
| Repository/package shell | `package.json`, `pnpm-lock.yaml`, `pnpm-workspace.yaml`, configs (including `eslint.config.js`), `.gitignore`, license | ESM public package, fail-closed dependency build policy, build/test/lint scripts, published files, exact dsh peers | none |
| Domain primitives | `types.ts`, `errors.ts`, `ids.ts`, `paths.ts` | `Branded<B>`-based IDs using direct `@deepseek-ai/dsh-brand`, stable DTOs/errors, real-directory root acceptance and containment | Node stdlib, `@deepseek-ai/dsh-brand` |
| Persistence codecs | `atomic.ts`, `markdown.ts` | atomic writes; strict canonical page/frontmatter parse/render | primitives |
| Retrieval | `tokenizer.ts`, `indexer.ts` | deterministic section records, fingerprints, BM25 search/index | codecs/primitives |
| Lint | `lint.ts` | stable read-only diagnostics across source/page/index trees | retrieval/codecs |
| Service | `service.ts`, `config.ts` | lifecycle-facing orchestration, mutation queue, limits, all public methods | all core modules, Cordis, Schemastery |
| dsh adapters | `prompt.ts`, `presentation.ts`, `tools.ts`, `command.ts`, `index.ts` | exact prompt/tool/command registration and `ctx.llmwiki` publication | service + dsh APIs |
| Bundle | `cordis.patch.yml` + manifest fields | profile installation/composition | published package |
| Tests | `tests/**` | observable contracts, cleanup, Loader/built artifact | shipping entry path |
| Example/docs | `examples/**`, `README.md`, scripts | install/use/migrate/operate and runnable proof | built package |

## 7. End-to-end data flows

### 7.1 Source preservation and page maintenance

1. Model calls `llmwiki_status`; service inspects storage without creating or repairing it. A fresh root reports `initialized: false` and `schemaText: null`.
2. Model obtains source text through the conversation or another separately authorized tool and obtains explicit user authorization to preserve it.
3. `llmwiki_add_source` validates the UTF-8 byte cap, hashes exact bytes, and atomically creates immutable source files or returns dedupe.
4. Model calls `llmwiki_status` again and rereads the now-present human-owned schema before maintenance.
5. Model inventories `llmwiki_list_sources` and `llmwiki_list_pages`, searches, and reads relevant pages and immutable sources.
6. Model classifies the material as `new`, `update`, `contradiction`, or `no material change`, identifies every materially affected page, and preserves disagreements and links.
7. Model runs structural `llmwiki_lint` unconditionally before a separately named semantic review, even when no page write is proposed.
8. Only with explicit authorization, model calls `llmwiki_upsert_page` using known source IDs; service validates and atomically writes canonical Markdown.
9. After writes, model reruns status, catalogs as needed, relevant reads, and structural lint before semantic review. Search rebuilds the derived index when stale and returns ranked matching sections; semantic review remains an agent-layer judgment, not lint output.

### 7.2 Query

1. `llmwiki_search` validates query/limit and abort state.
2. Service fingerprints sorted page bytes.
3. Fresh valid index is loaded, otherwise rebuilt atomically.
4. Query tokens are scored deterministically.
5. A structured result whose output/value object schema is closed where supported is rendered to model text and replayable UI metadata.
6. Model may call `llmwiki_read_page` and `llmwiki_read_source` for complete context and provenance.

### 7.3 Human maintenance

1. dsh dispatches `/wiki` directly to the command registry.
2. Handler selects `status`, `lint`, or `reindex` without a model turn.
3. Service performs the operation under the same validation/abort contracts.
4. Handler returns concise stable text; detailed diagnostics remain available through tool or filesystem.

## 8. Testing and verification gates

### 8.1 Unit/contract tests

- ID/path traversal, absolute/backslash/NUL/symlink rejection.
- Strict frontmatter round-trip and malformed/unknown/duplicate fields.
- Unicode tokenization, CJK grams, section boundaries, stable hashes.
- BM25 ranking, ties, limits, snippets, zero-token query, exact golden index bytes.
- Immutable source dedupe and attempted corruption detection.
- Atomic page create/update, known-source enforcement, size caps, cancellation, index invalidation.
- Every lint diagnostic and stable ordering; lint leaves all files byte-identical.
- Tool schemas, validated outputs, pure presentation, domain-error mapping.
- Command parsing/results and abort behavior.
- HMR disposal removes `ctx.llmwiki`, seven tools, prompt section, and command; remount succeeds once.

### 8.2 Composition and package gates

- Real Cordis Loader boots `cordis.patch.yml` with required dsh services; invoke status/search/lint through registries rather than direct helpers.
- The source-side Loader harness uses these installed root development dependencies directly. It must not create a test-local package, invoke a package manager, or perform any per-test network installation.
- Explicitly assert no default export and test dsh export unwrapping.
- Built package smoke and determinism scripts import the public named exports from `lib/index.js` under plain Node semantics after `pnpm run build`; neither script imports `src/index.ts` or a private module. The smoke also resolves bundled `cordis.patch.yml` from package exports.
- `package.json#files`, not `.npmignore`, is the authoritative publication boundary: it permits only `lib/**/*.js`, `lib/**/*.js.map`, `lib/types/**/*.d.ts`, `lib/types/**/*.d.ts.map`, `cordis.patch.yml`, `README.md`, and `LICENSE`, plus npm-required `package.json`. `pnpm pack --dry-run` remains a separate exact manifest inspection and must exclude source, fixtures, plans, tests, examples, and local wiki data.
- The structured tarball gate first runs `npm run prepack` explicitly and proves that the clean production build removed a stale `lib/` marker and recreated the public entry. It then runs `npm pack --ignore-scripts --json --pack-destination <temp>`, parses the complete JSON payload, and validates exactly one emitted `.tgz` beneath the disposable destination. `--ignore-scripts` prevents a second lifecycle run from contaminating the structured JSON channel; the stale `pnpm pack --json` flow, mixed-output scraping, and last-token guessing are prohibited.
- The packed consumer is provisioned only inside a disposable root and explicitly installs the tarball, `@deepseek-ai/cordis-plugin-loader@1.0.2`, every exact runtime peer from §2.4, `node-addon-require-builtin@0.1.4`, and exact `typescript@6.0.3` for declaration consumption; because its patch-parsing path does not import `@deepseek-ai/cordis-plugin-include`, it does not install that package directly and any transitive Include resolution remains unused by C10. Plain-Node children remove `NODE_PATH`, `NODE_OPTIONS`, and source/workspace alias variables or configuration. The declaration compiler, package entry, patch, Loader, helper, and runtime peers are resolved and canonicalized from the disposable consumer, every real path must remain contained beneath that consumer's `node_modules`, and declaration compilation/probes run only while repository `src/` and repository `node_modules/` are genuinely absent at the filesystem level. The shared quarantine helper moves both paths to unique hidden siblings, records every completed move, starts the child only after both moves succeed, and reverse-restores every moved path before returning or propagating a setup/child failure; restoration failures are surfaced explicitly. Environment sanitization, post-hoc realpath guards, loose substring checks, source-text scans, a repository compiler, and repository package or `node_modules` symlinks are insufficient. Probe scripts/files live only under the disposable root, never in the repository.
- The permanent packed-profile E2E installs the produced tarball through the supported dsh rc.6 plugin/profile registry flow and boots the actual registry-installed dsh rc.6 runtime with the selected disposable profile through CLI `--patch` probes in enabled, disabled, removed, and re-added states. It never constructs a direct `Context`, manually mounts `ToolRuntime`/`CommandRuntime`/`SystemPrompt`, imports `dsh-llmwiki`, or mounts the plugin itself. Every packed-profile child boot runs while repository `src/` and repository `node_modules/` are genuinely absent under the same move/confirm/`finally`-restore contract. After the initial enabled exercise of status, source add/read, page upsert/read, search, lint, `/wiki status`, `/wiki lint`, and `/wiki reindex`, the gate records (a) a sorted full recursive `.llmwiki` file-tree manifest containing every normalized relative POSIX path and SHA-256 file hash, including derived `.index/*`, and (b) the complete lint DTO normalized recursively by sorted object keys while retaining array order. Disabled and removed boots prove the service, seven tools, `/wiki`, and the assembled `tool:llmwiki` prompt section are absent and the complete manifest is exactly unchanged. Immediately after re-add and before boot, then after a restore-only boot that reads the exact pre-existing source/page without source add, page upsert, or reindex, the complete manifest remains exactly equal to the initial baseline; the restored full normalized lint value equals the initial value, not merely its error count or selected fields. The gate cleans every disposable profile, project, tarball, dependency, probe, quarantined repository path, and dsh state artifact.
- Runnable smoke creates a temporary wiki, ingests evidence, writes a page, searches it, lints cleanly, disposes Cordis, and externally re-reads byte-identical source/page files.
- Determinism script builds the same corpus in two fresh roots and byte-compares canonical index/search/lint output.

`pnpm run lint` is ESLint `9.39.2` flat-config linting via `eslint.config.js`, using exact `@typescript-eslint/parser` `8.67.0` and `@typescript-eslint/eslint-plugin` `8.67.0`; it owns and lint-checks `src/**/*.ts`, `tests/**/*.ts`, `scripts/**/*.ts`, and `*.{ts,js}` while ignoring `lib/`, `coverage/`, `node_modules/`, example wiki data, and generated temporary roots. Typed linting uses the dedicated C01-owned `tsconfig.eslint.json`, which extends the production compiler options, sets `noEmit`, and explicitly includes future `src/**/*.ts`, `tests/**/*.ts`, `scripts/**/*.ts`, and root TypeScript configuration files so those paths receive type-aware rules as they are created without broadening the production build. The parser/plugin `8.67.0` peer ranges include exact TypeScript `6.0.3` and ESLint `9.39.2`; incompatible `8.56.0` is prohibited. `pnpm run test` uses `vitest.config.ts`, which excludes `tests/**/*.e2e.spec.ts`; `pnpm run test:e2e` uses dedicated `vitest.e2e.config.ts`, whose `include` is exactly `tests/**/*.e2e.spec.ts`, so each suite is selected by executable Vitest configuration rather than an unexpanded shell glob.

### 8.3 Planned commands

Use pnpm `11.7.0` for project gates selected by `packageManager` and locked in `pnpm-lock.yaml`; use npm only for the verified structured-pack sequence because `npm pack --ignore-scripts --json` preserves a clean machine-readable channel after the explicit lifecycle run:

```sh
pnpm install --frozen-lockfile
pnpm peers check
pnpm ignored-builds
pnpm run typecheck
pnpm run lint
pnpm run test
pnpm run test:coverage
pnpm run build
pnpm run test:e2e
pnpm run check:determinism
pnpm run smoke
PACK_DESTINATION="$(mktemp -d)"
trap 'rm -rf "$PACK_DESTINATION"' EXIT
npm run prepack
npm pack --ignore-scripts --json --pack-destination "$PACK_DESTINATION"
pnpm pack --dry-run
```

Before release, run the smoke against the supported dsh version in a clean temporary profile with the packed tarball installed. If dsh's own checkout is used for compatibility validation, run its focused Loader/composition test only; this repository must not require modification of dsh core.

## 9. Dependency order and parallel safety

### 9.1 Required ordering

1. Repository/package shell and orchestrator-generated lockfile.
2. Domain primitives and filesystem safety.
3. Markdown/persistence codecs.
4. Retrieval and lint (can proceed in parallel after codecs).
5. Service orchestration after retrieval/lint contracts stabilize.
6. Tools/presentation/prompt and command (parallel after service API).
7. Plugin entry and bundle composition.
8. Tests/goldens and example/docs (fixtures can begin after contracts; final assertions wait for integration).
9. Cleanup, all gates, split final review, release readiness.

### 9.2 Parallel-safe chunks

- Retrieval (`tokenizer.ts`, `indexer.ts`, retrieval tests) and lint (`lint.ts`, lint tests) may run concurrently once shared DTOs, Markdown parser signatures, and the immutable §3.4 index JSON contract are fixed.
- Model adapter source files (`prompt.ts`, `presentation.ts`, `tools.ts`) and human command source (`command.ts`) may run concurrently once `LlmWikiService` is fixed. `tests/plugin.spec.ts` is sequential: C07 creates the tool/prompt sections, C08 adds only its command section after C07 commits, then C10 receives the complete file.
- README/example work may run alongside late tests after public names/config/tool schemas are frozen.

Parallel agents must not edit shared files outside their owned path list. Sequential integration ownership transfers are authoritative in `CHECKLIST.md`: C06→C10 for `tests/harness.ts`, C07→C08→C10 for `tests/plugin.spec.ts`, C01→C02→C09→C10→C11→C12 for `package.json`, C01→C02→C10→C12 for `pnpm-lock.yaml`, and C01→C12 for `pnpm-workspace.yaml`, package/build/lint/test configs, `.gitignore`, and `LICENSE`. C02 adds only exact `@deepseek-ai/dsh-brand@0.1.0-rc.6` peer/development entries and the pnpm-generated lock update. C09 adds bundle patch manifest fields only after creating `cordis.patch.yml`. C10 adds only exact `@deepseek-ai/cordis-plugin-loader@1.0.2`, exact `node-addon-require-builtin@0.1.4`, and pnpm-generated lock resolutions; its patch parser does not import `@deepseek-ai/cordis-plugin-include`, so the provisional direct `1.0.6` pin was removed and only a transitive, unused resolution may remain. C11 adds only the determinism/smoke script entries after creating their targets. `src/index.ts`, `src/types.ts`, `src/service.ts`, and `README.md` otherwise remain integration-owner files. Any needed cross-chunk contract change is proposed to the current owner rather than duplicated. Golden fixture rewrites are allowed only by the owning chunk and only after an intentional reviewed contract change; normal verification never updates goldens.

## 10. Risks, mitigations, and rollback

| Risk | Mitigation | Rollback |
|---|---|---|
| dsh prerelease API drift or unavailable local version | Pin the installable exact rc.6 peers/dev dependencies whose published declarations/runtime are byte-identical to the inspected local rc.5 APIs; Loader and packed-artifact smokes exercise named exports and registries. | Revert compatibility commit or pin the last verified installable exact versions; persisted wiki format remains independent. |
| Path traversal/symlink escape | Centralize all path resolution; reject symlinks; adversarial tests. | Disable plugin row/remove bundle while preserving `.llmwiki`; repair affected release before remount. |
| Partial writes/process crash | Exclusive temp + sync + rename; lint abandoned temps; immutable raw content. | Delete abandoned temps and `.index`; rebuild. Never rewrite source content as recovery. |
| Index nondeterminism/corruption | Canonical sorting/JSON, content hashes, fixed scoring constants, byte-comparison script. | Delete `.index`; next operation rebuilds. |
| Model writes unsupported claims | Require existing source IDs, explicit authorization before source preservation or page writes, catalog/search/read/classify guidance, and unconditional structural lint followed by separate semantic review. Structural lint checks integrity only and never claims semantic support. | Revert/delete the page manually; immutable source records remain intact. No automated destructive fix. |
| Tool context bloat | Nine narrow schemas, bounded catalogs/snippets/results, concise prompt. | Profile can disable the one plugin row; no persisted-data migration required. |
| Concurrent dsh processes | Document single-writer contract; in-process queue; detect temp remnants. | Stop extra writer, lint, remove abandoned temp/index, rebuild. |
| Future format changes | Version only derived index initially; keep source/page format simple and documented. | New code can rebuild index; page/source migrations must be explicit copy-first commands in a later release. |

Operational rollback is composition-level: remove/disable the `llmwiki` row or bundle from the profile. This leaves `.llmwiki` untouched. Reinstalling the previous compatible package resumes against the same source/page format. Never make rollback depend on the derived index.

## 11. Conventional commit sequence

Each commit is reviewable and green for its available gates; do not combine unrelated chunks.

1. `chore: initialize dsh-llmwiki package`
2. `feat: add safe wiki filesystem primitives`
3. `feat: add canonical wiki markdown persistence`
4. `feat: add deterministic wiki search index`
5. `feat: add deterministic wiki linting`
6. `feat: add llmwiki service orchestration`
7. `feat: expose llmwiki model tools and prompt`
8. `feat: add wiki maintenance command`
9. `feat: ship dsh bundle composition`
10. `test: cover llmwiki contracts and loader lifecycle`
11. `docs: add llmwiki usage and runnable example`
12. `chore: finalize package and release gates` — `ef39d90`
13. `fix(index): recreate deleted derived index` — `094fbc0`
14. `test(package): pin native profile dependency` — `92daa29`
15. `docs: close implementation tracker` — final tracker-only `PLAN.md`/`CHECKLIST.md` closure commit; no hash is recorded before the commit exists.

If review fixes are non-trivial, amend the owning unshared commit or add `fix(<scope>): ...` immediately after it. Do not hide behavior changes in cleanup/docs commits.

## 12. Final split review

Perform two independent reviews after all gates pass:

### Review A — domain, safety, determinism

Review `src/{types,errors,ids,paths,atomic,markdown,tokenizer,indexer,lint,service}.ts`, fixtures, and unit tests. Reproduce traversal/symlink/cancellation/corruption cases; byte-compare deterministic outputs; verify lint is non-mutating and sources immutable.

**Resolved finding C13-A-01 (major):** The original reproduction deleted the complete derived `.index/` directory after service initialization, then observed `ENOENT` from `src/indexer.ts#writeIndex` on the next search. The behavior fix is implemented in `src/indexer.ts`, where `writeIndex` safely recreates `paths.index` through the C02-owned `ensureWikiDirectory` primitive from `src/paths.ts` before either atomic index write; the observable regression is in `tests/service.spec.ts`, which proves the next search restores the same results and byte-identical `search.json`/`state.json` without changing source or page bytes. The focused reproduction/regression run passed all 4 selected service cases, typecheck and lint passed, and an independent targeted re-review returned **CLEAN**. The complete Review A rerun then covered every planned audit, C03–C10 import scan, adversarial reproduction, lint non-mutation proof, derived-index recovery proof, and finding-accounting item and returned **CLEAN** with zero unresolved findings. Commit accounting: `fix(index): recreate deleted derived index` is `094fbc0`, after C12 `ef39d90` and before C13-B `92daa29` in the focused conventional order. The full C12 rerun and packed-profile scenario are complete; the independent final closure audit and physical generated-artifact re-audit also returned **CLEAN**, so C13 and the tracker are closed with zero unresolved findings.

### Review B — dsh integration, packaging, experience

Review `src/{config,prompt,presentation,tools,command,index}.ts`, manifest/config/build files, `cordis.patch.yml`, Loader/built smokes, README, and example. Verify exact dsh APIs, named exports/inject, fiber cleanup, prompt/tool output contracts, package contents, profile rollback, and no accidental UI/server/vector scope.
**Resolved finding C13-B-01 (major):** The final built-package gate exposed registry-transitive `koffi` drift to `3.1.5`, which defeated the fail-closed exact build allowlist and broke the deterministic packed-consumer install contract. The disposable packed-profile workspace now uses the exact `koffi: 3.1.4` override, matches it with exact `koffi@3.1.4: true` under `allowBuilds`, asserts the installed `node_modules/koffi/package.json` version is exactly `3.1.4`, and requires `pnpm ignored-builds` to report `None`; native-build trust was not broadened beyond the exact profile dependencies. The focused profile lifecycle regression, typecheck, and lint passed, and an independent targeted re-review returned **CLEAN**. Commit accounting: `test(package): pin native profile dependency` is `92daa29`, following C13-A `094fbc0` in the focused conventional order.

**Aggregate Review B status: CLEAN (zero unresolved findings).** C13-B-01's override, installed-version assertion, exact build-policy match, ignored-build proof, focused gates, and targeted re-review are complete. The full §8.3 rerun and actual packed-profile add/disable/remove/re-add scenario are also green. The independent final closure audit and physical generated-artifact re-audit are **CLEAN**; C13 and the release tracker are complete.


After fixes, rerun the smallest affected test first, then every gate in §8.3. The release tracker closes only when both reviews have no unresolved findings, the packed-tarball clean-profile smoke passes, documentation matches actual defaults/tool names, and the working tree contains no generated wiki/index/build artifacts.

**Final closure status: COMPLETE.** C01–C13 have zero unchecked tasks and zero unresolved findings. Both independent reviews are **CLEAN**, the packed-tarball clean-profile lifecycle and every final gate remain green with their exact environment and evidence preserved in `CHECKLIST.md`, and the post-accounting physical audit found no generated wiki, index, build, dependency, probe, quarantine, or disposable profile/project/store artifacts. The final tracker-only conventional commit is `docs: close implementation tracker`; because this statement is part of that atomic `PLAN.md`/`CHECKLIST.md` commit, no hash is pre-recorded.

## 13. Plan-review disposition

Accepted and incorporated:

- Corrected the Schemastery example to pair `interface Config` with `const Config: z<Config>`.
- Defined sequential ownership transfers for shared integration tests/configuration and removed ambiguous parallel ownership.
- Selected ESLint 9 flat config, named `eslint.config.js`, its dependencies, and exact linted/ignored paths.
- Set objective per-file Vitest V8 coverage thresholds: 90% lines/statements/functions and 85% branches.
- Defined the closed C04/C05 `search.json`/`state.json` schema, canonical ordering, validation, hash pairing, and commit/freshness rules.
- Required smoke and determinism scripts to import the built public `lib/index.js` entry only.
- Assigned C12 explicit sequential cleanup ownership for package/config files.
- Moved protective `.gitignore` and `LICENSE` creation to C01 so install/pack acceptance is executable.
- Defined `WikiStatus` and `ByteRange` fields and byte-boundary/EOF behavior.
- Replaced subjective acceptance checks with commands and observable assertions in `CHECKLIST.md`.
- Clarified the remaining P3 precision points: `averageSectionLength` is the only finite non-negative floating-point numeric field while integer-count fields remain safe integers; capture-time metadata is intentionally nondeterministic across fresh roots, excluded from derived-output determinism, and never rewritten by same-root dedupe.
- Replaced unpublished dsh `0.1.0-rc.5` pins with installable exact `0.1.0-rc.6` peer/development pins; recorded primary npm registry evidence, byte-identical published rc.6 declaration/runtime comparison to the locally inspected rc.5 APIs, and exact-pin protection from the older rc.1 `latest` dist-tag.
- Corrected the impossible closed top-level tool-parameter invariant: dsh `defineTool` compiles an open top-level parameter object, while declared parameters remain explicit and validated, unknown keys cannot influence behavior, and structured output/value objects remain closed where supported.
- Fixed the verified release contract to pnpm `11.7.0`, Node `^22.19.0 || >=24`, exact dsh/Cordis peers, Schemastery `3.18.1`, TypeScript `6.0.3`, ESLint `9.39.2`, `@typescript-eslint/parser` and `@typescript-eslint/eslint-plugin` `8.67.0`, and the verified tsdown/tsx/Vitest/coverage/Node-types versions.
- Corrected chunk staging: C01 exposes only scripts with current targets; C11 creates and then wires determinism/smoke scripts; C09 creates and then publishes the bundle patch.
- Assigned `pnpm-lock.yaml` generation to the orchestrator's install verification rather than worker-authored content.
- Corrected the pnpm `11.7.0` build-policy location: `package.json#pnpm` settings are ignored, so C01 owns and commits the exact minimal root-only `pnpm-workspace.yaml` policy shown in §2.4; omitted dependencies remain fail-closed under default `strictDepBuilds: true`, `minimumReleaseAgeExclude` is unrelated, and verification requires `pnpm ignored-builds` to print `None`.
- Updated Vitest 4 coverage semantics to `coverage.include` plus `coverage.thresholds.perFile`, removing obsolete `coverage.all`/top-level `perFile` requirements.
- Corrected C01 verification sequencing after observing TS18003 from `pnpm exec tsc --showConfig` with no `src` inputs: C01 now validates raw `tsconfig.json` compiler options using a Node assertion, while C02 performs the first real typecheck after creating source files.
- Corrected pnpm `11.7.0` script argument forwarding after observing that `pnpm run lint -- --no-warn-ignored` passes a literal separator to ESLint: the executable zero-warning gate is `pnpm run lint --no-warn-ignored`.
- Corrected C01's executable test split: `test:e2e` now uses a dedicated `vitest.e2e.config.ts` with an explicit Vitest `include` instead of passing an unexpanded glob, while the unit config excludes E2E files.
- Added the C01-owned `tsconfig.eslint.json` project strategy so type-aware ESLint covers future source, test, script, and root TypeScript configuration files.
- Pinned the pnpm build allowlist key to exact `esbuild@0.28.2` rather than approving every version of the package.
- Replaced incompatible `@typescript-eslint` `8.56.0`, whose primary registry peer range excludes TypeScript 6, with exact stable parser/plugin `8.67.0`; primary registry manifests confirm compatibility with TypeScript `6.0.3` and ESLint `9.39.2`. Reopened the affected C01 dependency, install, lint, and review checks until the corrected pins are installed and lint is reverified.
- Added the direct exact `@deepseek-ai/dsh-brand@0.1.0-rc.6` peer/development dependency required by dsh's `Branded<B>` convention, with explicit C01→C02 package/lock ownership transfer and pnpm-generated lock update.
- Narrowed C02's import scan to modules present at the C02 boundary and assigned the complete later-filesystem-callsite scan to final integration review.
- Made the root policy consistent and fail-closed: the configured root is accepted only as a real directory, never as a symlink; an absent root may be safely created, while an existing symlink or non-directory is rejected.
- Deferred a clean-build `prepack` lifecycle to C12, after sources and the complete package surface exist; its absence does not make the source-less C01 shell incomplete.
- Recorded C10's exact Loader/helper test dependencies and resolved conditional Include outcome: `@deepseek-ai/cordis-plugin-include@1.0.6` remained transitive and unused, so its provisional direct pin was removed. Both scope-preserving review fixes were completed and reverified: the generated lockfile reflects that dependency cleanup, and the first built-entry probe runs only from a disposable consumer root. The root-installed source harness, hermetic packed-consumer requirements, robust JSON pack parsing, resolution guards, and cleanup contract remain unchanged. All 17 plugin tests and all 6 E2E tests passed with build, typecheck, and lint green; C10 is complete, verified, review-clean, and committed as `c343e67` (`test: cover llmwiki contracts and loader lifecycle`).
- Corrected the stale public service signature: `reindex` returns the atomic `ReindexReceipt` (`pageCount`, `sectionCount`, and `formatVersion`), not `IndexStatus`. C11's scope-preserving review corrections were completed and reverified: documentation and example claims match runtime behavior, determinism/smoke/packed-demo evidence was tightened, the accidental absolute-tarball self-dependency was removed with a dependency-clean frozen install succeeding, and the automated README audit now compares documented config defaults, tool names, and command tokens with exported runtime definitions. The clean packed demo, build, determinism, smoke, typecheck, and lint gates passed; C11 is complete, verified, review-clean, and committed as `cb67064` (`docs: add llmwiki usage and runnable example`).
- C12's three scope-preserving proof corrections are complete without changing product behavior, release scope, owned paths, or gate selection. Packed declaration/runtime/profile child phases ran only while repository `src/` and repository `node_modules/` were moved to unique hidden siblings and physically unavailable, with every completed move reverse-restored before child/setup errors could propagate and restoration failures surfaced explicitly. The permanent packed-profile lifecycle compared the sorted recursive normalized-POSIX-path/SHA-256 manifest of every `.llmwiki` regular file, including `.index/*`, at the initial, disabled, removed, re-added-before-boot, and restored checkpoints; all manifests were identical. The initial and restored complete lint DTOs were recursively normalized with locale-sorted object keys and retained array order, canonically serialized, and equal byte-for-byte. The authoritative structured-pack sequence remained explicit `npm run prepack` followed by `npm pack --ignore-scripts --json --pack-destination <temp>`, with `pnpm pack --dry-run` as a separate exact allowlist inspection. The final rerun on Node `v24.18.0`, pnpm `11.7.0`, dsh `0.1.0-rc.6`, and Ubuntu `24.04.4 LTS` / Linux `6.8.0-71-generic` `x86_64` passed the dependency-clean frozen install, clean peer check, `ignored-builds: None`, typecheck, lint, 185 unit tests, aggregate coverage `94.89%` statements / `89.64%` branches / `97.92%` functions / `97.51%` lines with every per-file threshold green, warning-free build, all 7 E2E tests through the actual registry profile add/disable/remove/re-add lifecycle, determinism hash `f4b636ac0401093955bf3938ec8616014da149dc30b5707a9980cac82781fd12`, smoke, structured pack, and dry-run pack. C12 is complete, verified, review-clean, and committed as `ef39d90` (`chore: finalize package and release gates`).
- `.npmignore` was intentionally omitted from the target tree and C12 output because the `package.json#files` allowlist plus structured-pack and dry-run pack gates exactly constrain publication; retaining one authoritative allowlist avoids contradictory inclusion/exclusion policy.

Discarded:

- `git init` was not added: the worktree already contains `.git` and is on an unborn branch. Reinitializing is redundant and risks altering user-owned repository metadata; C01 starts with tracked package files and the first commit instead.
- The prior requirement to prohibit `pnpm-workspace.yaml` and use `pnpm.onlyBuiltDependencies` was discarded as factually incorrect for pnpm `11.7.0`: project build policy must be committed in `pnpm-workspace.yaml`, while package-level `pnpm` settings are ignored.
- The Node `>=24` engine complaint was discarded: `engines.node` declares plugin runtime/production compatibility with the exact dsh host range `^22.19.0 || >=24`; a dev-only Babel parser dependency's narrower engine metadata does not constrain plugin consumers.
- The claim that frozen installation still fails was discarded as stale: after the workspace build-policy correction, an observed dependency-clean pnpm `11.7.0` install exited zero. Frozen-lockfile installation remains a later reproducibility gate.

## 14. Post-closure handoff adjudication (2026-08-31)

### 14.1 Authority and scope

This section resumes the completed C01–C13 plan for the exact follow-up goal raised by `handoff-2026-0830.md`. It does not reopen or rewrite the historical completion evidence above. For future resumes, this section and the corresponding C14–C19B tracker in `CHECKLIST.md` are authoritative for the follow-up; the original handoff remains preserved unchanged as review evidence, not as an implementation checklist. Current `AGENTS.md` guidance was added later in separate commit `99addd9` and is accounted outside C19A.

The adjudication covers exactly these 13 IDs: `GAP-INGEST`, `GAP-CATALOG`, `GAP-SCHEMA`, `GAP-SEMANTIC-LINT`, `GAP-EVIDENCE`, `GAP-MODEL-E2E`, `CLAIM-COMPLETE`, `DEF-INDEX-TRUST`, `DEF-UPSERT-POSTCOMMIT`, `DEF-CANONICAL-LINT`, `DEF-UTF8-PROGRESS`, `DEF-EMPTY-SOURCE`, and `DEF-STALE-TARBALL`. One independent verdict contained a duplicate `DEF-STALE-TARBALL` placeholder and incorrectly described the list as 14 identifiers; it is discarded. There are 13 distinct IDs.

Architecture boundary:

- `LlmWikiService`, deterministic tools, `/wiki`, indexing, catalogs, and structural lint remain model-free, offline, and deterministic.
- Deterministic catalog/listing and unreferenced-source diagnostics are required current-product capabilities because they restore discovery of already-persisted data.
- The calling DSH agent owns two explicit workflows: evidence maintenance and a separate semantic review. Semantic review reads cataloged pages and immutable sources, identifies contradictions/superseded conclusions, and proposes or performs source-linked page updates under the ordinary tool/user-approval boundary; it is never reported as `llmwiki_lint` output.
- `schema.md` remains user-owned and create-only through the plugin. Model/user schema mutation is intentionally unresolved: no authorization, confirmation/audit, or lost-update contract has been approved. C17 must document this limitation and the follow-up must not claim full schema co-evolution or full handoff closure.
- A real-model result must never be fabricated. The opt-in smoke implementation is committed independently from credentialed execution; only the latter can close agent-behavior and semantic-review evidence.

### 14.2 Exhaustive decision ledger

#### GAP-INGEST

- **Exists:** yes.
- **Decision:** fix the current-scope guidance/positioning gap; do not add service-side orchestration.
- **Rationale:** the primitive tools do not themselves define investigation, classification (`new`, `update`, `contradiction`, `no material change`), affected-page maintenance, cross-linking, conflict preservation, structural lint, or semantic review. The calling agent can own that explicit workflow without violating the model-free service boundary.
- **Approved change surface:** `src/prompt.ts`, README, examples, prompt/tool contract assertions, and the real-agent scenario. Guidance must direct the agent to read schema, recover/catalog existing records, search/read before writing, classify evidence, update every materially affected page, preserve disagreements, maintain links, run structural lint, then perform the separately named semantic review defined below. No hidden model call, background agent, or autonomous service method is approved.
- **Verification:** C17 exact prompt snapshot/registration assertions and documentation audit freeze and implement the workflow contract; mandatory C19B durable artifact assertions for the controlled contradiction scenario alone supply behavioral closure.
- **Dependencies:** GAP-CATALOG; C17 follows C16 and records GAP-SCHEMA as unresolved rather than depending on its closure; C19B supplies the required credentialed behavior.
- **Status:** contract implementation and C17 gates are complete; the clean three-lens static product review and final commit `10eccf7` are recorded. The ID remains open pending C19B behavioral evidence.

#### GAP-CATALOG

- **Exists:** yes.
- **Decision:** fix under the frozen catalog contract in §14.3.
- **Rationale:** status exposes counts, search covers pages, and reads require a known ID. A source committed before a page update can therefore become undiscoverable in a later session. This is a deterministic recoverability defect in the declared storage/retrieval substrate, not optional autonomous behavior.
- **Approved change surface:** exactly the service methods, tools, DTOs, errors, configuration reuse, tests, scripts, prompt, and documentation enumerated in §14.3 and C16. Unreferenced-source detection remains deterministic and read-only.
- **Verification:** interrupted-ingest recovery across a fresh service/session; stable live-seek pagination and ordering; empty/large catalogs; malformed-record and cursor failures; no mutation during listing/lint; unreferenced source reported then cleared when cited; all nine-tool Loader/packed/profile/presentation/schema/determinism/documentation surfaces migrated.
- **Dependencies:** none conceptually; implementation is C16 after the foundational defect chunks.
- **Status:** complete in C16. Independent static closure review CLEAN. Final commit `e8a8c2b` has actual subject `fix(catalog): preserve safe path semantics` and exactly four product/test paths: `src/lint.ts`, `src/service.ts`, `tests/lint.spec.ts`, and `tests/service.spec.ts`.

#### GAP-SCHEMA

- **Exists:** yes.
- **Decision:** intentionally unresolved; C17 fixes only truthful governance wording and does not close the capability gap.
- **Rationale:** `schema.md` exists and status returns it, but the handoff also asks for user/model schema evolution. Adding mutation requires a product decision covering explicit user authorization, visible confirmation/audit evidence, UTF-8/size validation, atomic persistence, and optimistic concurrency (for example an expected SHA-256) so a stale agent cannot overwrite a human edit. No such authorization UX or audit surface is approved in this follow-up, and inventing one in planning would expand the trust boundary without user approval.
- **Approved change surface:** C17 may strengthen the create-only default text and state that schema is human-owned, read before maintenance, subordinate to system/user instructions, and never silently rewritten. It must not add or imply `llmwiki_update_schema`, automatic mutation, or completed schema co-evolution.
- **Verification:** initialization creates the strengthened default only when absent; existing custom schema remains byte-identical; status/prompt/docs agree on ownership and explicitly identify schema mutation as unresolved. A later product decision must separately specify authorization/confirmation, audit location, expected-hash conflict behavior, validation, cancellation, tests, and prompt rules before implementation can be planned.
- **Dependencies:** none for truthful wording; any future schema-mutation milestone is outside C14–C19B.
- **Status:** unresolved by explicit scope/dependency/product-decision reason; the follow-up cannot claim the full handoff goal while this remains open.

#### GAP-SEMANTIC-LINT

- **Exists:** yes.
- **Decision:** implement and verify an explicit agent-layer semantic-review workflow while preserving deterministic structural lint.
- **Rationale:** `llmwiki_lint` can verify filesystem and structural integrity but cannot judge contradictions, unsupported claims, missing concepts, or stale conclusions. The missing capability belongs in the calling-agent workflow, not in `LlmWikiService`.
- **Agent-layer contract:** after structural lint, the agent starts a distinct “semantic review”; calls `llmwiki_list_pages` and `llmwiki_list_sources`; reads every page in the selected review scope and every source cited by those pages plus newly supplied candidate sources; compares dated/qualified claims; classifies each material finding as `contradiction`, `superseded`, `unsupported`, or `missing-link`; reports affected page IDs and source IDs in its visible response; and, only when the user request authorizes maintenance, updates affected pages with both sides preserved or a clearly dated supersession. It must not attribute these judgments to `llmwiki_lint`, silently rewrite schema, or claim entailment was deterministically proved.
- **Approved change surface:** C17 freezes and implements this workflow in prompt/default-schema/docs and exact contract assertions without closing the ID. C19B uses a controlled prior page plus a materially contradictory newer source and requires the real agent to identify the stale conclusion, preserve disagreement or update the conclusion with both source IDs, and maintain affected links.
- **Verification:** C17 text/snapshot assertions prove contract invocation and separation from structural lint but are not behavioral closure; C19B alone closes the behavior by independently inspecting tool trace and durable page bytes/source links rather than accepting model self-report. `LlmWikiService` remains model/network-free.
- **Dependencies:** C16 catalogs; C17 freezes/implements the workflow contract; C19B supplies credentialed behavioral proof and closure.
- **Status:** contract implementation guidance and C17 gates are complete; the clean three-lens static product review and final commit `10eccf7` are recorded. The ID remains open and behavioral closure is externally blocked until C19B.

#### GAP-EVIDENCE

- **Exists:** yes.
- **Decision:** fix positioning.
- **Rationale:** upsert verifies that listed immutable source IDs exist; it does not prove claim-level entailment, quotation alignment, or paragraph-to-source attribution. Unqualified `evidence-backed` or `evidence-grounded` wording overstates the enforced invariant.
- **Approved change surface:** package description if affected, `README.md`, `examples/README.md`, `src/prompt.ts`, public tool descriptions/presentation text, and exact documentation assertions. Use `source-linked`, `source-referenced`, or an explicit definition of the actual invariant. No deterministic entailment checker is approved.
- **Verification:** text audit for unqualified overclaims; tests confirm source existence remains the enforced write invariant and no new semantic guarantee is asserted.
- **Dependencies:** grouped with CLAIM-COMPLETE and GAP-SEMANTIC-LINT in C17.
- **Status:** complete in C17 after clean three-lens static product review and final commit `10eccf7`.

#### GAP-MODEL-E2E

- **Exists:** yes.
- **Decision:** add a committable opt-in smoke implementation in C19A and a separately blocked credentialed execution milestone C19B; neither is an offline release gate.
- **Rationale:** current E2E directly calls tools and proves package/Loader/profile plumbing without a real model. Agent discipline and semantic review require a real supported turn, but an external credential must not strand reviewed code uncommitted.
- **Supported execution contract:** C19A adds `pnpm run smoke:agent`, implemented with the already-pinned `@deepseek-ai/dsh-agent@0.1.1-rc.2` family and a disposable DSH profile containing the packed plugin. The committed runner directly pins and overrides `@deepseek-ai/cordis@4.0.1` and `@deepseek-ai/cordis-plugin-loader@1.0.2`, matching package peer/development coverage; its integrity-bearing frozen lock and approved runtime set reject resolved Cordis `4.0.2` and Loader `1.0.3`. The provider is exactly DeepSeek. Explicit invocation requires non-secret `LLMWIKI_AGENT_SMOKE_MODEL` and secret `DEEPSEEK_API_KEY`; there is no default model and no fallback provider. Optional `LLMWIKI_AGENT_SMOKE_EVIDENCE` may override the default sanitized evidence path `tests/fixtures/agent-smoke/latest.json`.
- **Preflight/invocation:** `pnpm run smoke:agent -- --preflight` validates Node/package versions, built tarball/profile creation, the exact provider/model variable, credential presence, writable disposable/evidence locations, and network opt-in without sending a model request. `pnpm run smoke:agent` is the sole credentialed invocation. `pnpm run test:agent-smoke-preflight` uses only `vitest.agent-smoke.config.ts`; ordinary `test`, coverage, E2E, build, lint, determinism, and smoke gates remain offline, exclude the focused agent-smoke test where applicable, and do not invoke either agent-smoke command. A keyless preflight is expected to exit nonzero with the blocker classification.
- **Durable evidence:** after a real run, write sanitized canonical JSON at `tests/fixtures/agent-smoke/latest.json` with schema version, provider (`deepseek`), model identifier, UTC started/completed timestamps, package version/tarball SHA-256, scenario ID, ordered assertion IDs/results, tool names observed (no arguments containing source text or secrets), phase-specific durable source/page IDs and hashes, structural-lint counts, and overall result. Discovery requires both seeded pages and source A only; the post-add/pre-update boundary requires exact source B; semantic review requires both pages and both sources. Fresh-session recovery must validate the externally persisted strict completed-turn final assistant event for the Meridian endpoint and both exact durable source IDs. Evidence retains only the passing recovery assertion, never response text, prompts, completions, credentials, headers, absolute paths, or raw source/page content.
- **Unblock condition:** C19B becomes actionable only when `DEEPSEEK_API_KEY` is non-empty, `LLMWIKI_AGENT_SMOKE_MODEL` names a model the credential can successfully invoke through the pinned DSH agent family, outbound access to the configured DeepSeek endpoint is permitted, and preflight passes. Completion requires the credentialed command to exit zero and the committed sanitized evidence to satisfy every C19B assertion; script existence, mocks, direct tool calls, or keyless preflight do not close it.
- **Dependencies:** C16 catalogs, C17 workflow/positioning, C18 documentation stabilization, and externally supplied access for C19B.
- **Status:** C19A is complete in commit `89fce38`, actual subject `test(agent): add opt-in real-model smoke harness`, with exactly its 19 owned paths. Separate commit `99addd9`, actual subject `docs(agents): record real-agent smoke constraints`, contains only `AGENTS.md` and is outside exact-19 accounting. C19B is externally blocked until all precise prerequisites coexist: an authorized non-empty `DEEPSEEK_API_KEY`; a safe explicit `LLMWIKI_AGENT_SMOKE_MODEL` successfully invokable through pinned DSH agent `0.1.1-rc.2`; `LLMWIKI_AGENT_SMOKE_NETWORK=allow` plus permitted outbound access to the configured DeepSeek endpoint; and zero-exit `pnpm run smoke:agent -- --preflight`. `tests/fixtures/agent-smoke/latest.json` is absent; no credentialed model/network run occurred. `GAP-MODEL-E2E`, `GAP-INGEST`, and `GAP-SEMANTIC-LINT` remain open solely pending C19B.

#### CLAIM-COMPLETE

- **Exists:** yes as an implied positioning problem, not as a literal sentence claiming “complete implementation.”
- **Decision:** fix as the umbrella positioning cutover; do not treat it as a separate product feature.
- **Rationale:** public language that an LLM owns durable evidence-grounded memory is broader than the behavior proven by primitive tools, structural lint, and model-free E2E. The completed C01–C13 tracker refers to its narrower implementation plan and remains historically valid.
- **Approved change surface:** coherent wording across `package.json` description, `README.md`, `examples/README.md`, prompt/tool descriptions, and future release text: “Local-first, source-linked Markdown wiki storage and retrieval plugin for DeepSeek Harness,” plus an explicit service-layer versus agent-layer scope statement.
- **Verification:** documentation/package metadata audit; no “complete/full realization” implication; C01–C13 completion wording remains scoped to the historical plan.
- **Dependencies:** implemented and gate-verified in C17 alongside `GAP-EVIDENCE` positioning and the contract implementation for `GAP-INGEST`/`GAP-SEMANTIC-LINT`; the two workflow IDs remain open until C19B behavioral closure.
- **Status:** complete in C17 after clean three-lens static product review and final commit `10eccf7`, with no duplicate implementation chunk.

#### DEF-INDEX-TRUST

- **Exists:** yes.
- **Decision:** fix at P0 priority.
- **Rationale:** current freshness accepts mutually consistent editable derived files and current page fingerprints without proving that sections, normalized text, frequencies, or snippets came from those pages. Forged content can be reported fresh and returned by search.
- **Approved change surface:** one shared page-derived trust predicate across `src/indexer.ts`, all service search/status/index-freshness consumers in `src/service.ts`, and `src/lint.ts`; focused regressions in `tests/indexer.spec.ts`, `tests/service.spec.ts`, and `tests/lint.spec.ts`. Rebuild expected canonical index bytes (or an exactly equivalent page-derived semantic invariant) before reuse/fresh reporting. Do not add signatures, secrets, or trust between the two editable cache files.
- **Verification:** forge canonical `search.json` and matching `state.json` with current fingerprints; search must not return forged text, status must not report it fresh, lint must diagnose it, and rebuild must restore page-derived canonical bytes. Preserve deterministic byte output and disposable-index recovery.
- **Dependencies:** none.
- **Status:** complete in C14. Draft implementation committed as `1b7754d` (`fix(index): verify derived index semantics`) with the full eight-path accounting: six product/test paths (`src/indexer.ts`, `src/service.ts`, `src/lint.ts`, `tests/indexer.spec.ts`, `tests/service.spec.ts`, `tests/lint.spec.ts`) plus the two tracker bookkeeping paths (`docs/plan/PLAN.md`, `docs/plan/CHECKLIST.md`). The first review fixes are committed as `11ba0a0` (`fix(index): harden page snapshot trust`) with exactly six paths: `docs/plan/CHECKLIST.md`, `docs/plan/PLAN.md`, `src/indexer.ts`, `src/service.ts`, `tests/indexer.spec.ts`, and `tests/service.spec.ts`. Stable-page-snapshot fixes are committed as `54321a8` (`fix(index): trust stable page snapshots`) with exactly the same six paths. Corpus-snapshot fixes are committed as `03db8b8` (`fix(index): validate corpus snapshots`) with exactly five paths: `docs/plan/CHECKLIST.md`, `docs/plan/PLAN.md`, `src/indexer.ts`, `src/service.ts`, and `tests/indexer.spec.ts`. Independent three-lens final review found the implementation clean across the shared trust rule and final lint/corpus invalid-path behavior; its only finding was stale tracker accounting, corrected here. Final commit `6ba64b3` has actual subject `fix(index): align lint snapshot trust` and exactly five paths: `src/indexer.ts`, `src/lint.ts`, `src/service.ts`, `tests/lint.spec.ts`, and `tests/service.spec.ts`. `DEF-INDEX-TRUST`, C14, and the follow-up C14 ledger are complete. C15 is the active-next dependency pointer, but its work remains not started.

#### DEF-UPSERT-POSTCOMMIT

- **Exists:** yes.
- **Decision:** fix at P1 priority.
- **Rationale:** page rename commits durable state before index unlinking; a later unlink failure turns a successful mutation into a failure receipt and invites unsafe retry. Fingerprints already make the old index stale.
- **Approved change surface:** `src/service.ts` and focused service/tool tests. Remove post-commit index deletion and rely on corrected fingerprint/semantic freshness. No fallible operation after the commit point may convert the write into reported failure.
- **Verification:** inject derived-index unlink denial or retain stale index files, upsert a page, assert a success receipt and committed bytes, then assert status/search treats the old index as stale and rebuilds correctly; cancellation boundaries must not report failure after commit.
- **Dependencies:** DEF-INDEX-TRUST so stale detection is trustworthy.
- **Status:** complete in C15. Independent three-lens final review found no product or test issue; only stale tracker accounting remained. Commit `f2411ae` has actual subject `fix(service): make writes and ranges truthful` and exactly nine paths: `docs/plan/CHECKLIST.md`, `docs/plan/PLAN.md`, `src/lint.ts`, `src/service.ts`, `src/tools.ts`, `tests/lint.spec.ts`, `tests/plugin.spec.ts`, `tests/service-postcommit.spec.ts`, and `tests/service.spec.ts`.

#### DEF-CANONICAL-LINT

- **Exists:** yes.
- **Decision:** fix at P1 priority.
- **Rationale:** parsing proves supported syntax, not canonical byte representation. Reordered frontmatter and other parseable noncanonical layouts currently pass despite the canonical contract.
- **Approved change surface:** `src/lint.ts`, reuse of `src/markdown.ts` renderer, and `tests/lint.spec.ts`/golden updates. Parse, rerender through the one canonical renderer, compare exact UTF-8 bytes, and emit `PAGE_INVALID_MARKDOWN` without rewriting.
- **Verification:** reordered keys, alternate supported quoting/spacing, CRLF, blank-line differences, and missing final newline are diagnosed; canonical files remain clean; lint leaves every byte unchanged.
- **Dependencies:** none conceptually; grouped with catalog lint work in C16 to avoid conflicting edits to `src/lint.ts` and lint goldens.
- **Status:** complete in C16. Independent static closure review CLEAN. Final commit `e8a8c2b` has actual subject `fix(catalog): preserve safe path semantics` and exactly four product/test paths: `src/lint.ts`, `src/service.ts`, `tests/lint.spec.ts`, and `tests/service.spec.ts`.

#### DEF-UTF8-PROGRESS

- **Exists:** yes.
- **Decision:** fix at P2 priority while preserving the documented maximum-byte contract.
- **Rationale:** a limit smaller than the next multibyte code point can return `byteEnd === offset` before EOF, causing pagination loops. Silently exceeding the configured/requested maximum would contradict the existing byte-bound contract.
- **Approved change surface:** range logic in `src/service.ts`, stable domain error/DTO wording in `src/errors.ts` or `src/types.ts` only if required, tool descriptions in `src/tools.ts`, documentation, and focused service/plugin tests. For a valid non-EOF offset where no complete code point fits, return a stable explicit invalid-range error instructing the caller to increase the limit; successful reads must always advance and remain within the requested cap.
- **Verification:** `漢` at offset `0`, limit `1` returns the stable error; limit `3` advances to EOF; mixed ASCII/multibyte pagination never splits UTF-8, never exceeds limit, and every successful non-EOF step advances.
- **Dependencies:** none conceptually; implemented in C15 after C14.
- **Status:** complete in C15. Independent three-lens final review found no product or test issue; only stale tracker accounting remained. Commit `f2411ae` records the verified range behavior.

#### DEF-EMPTY-SOURCE

- **Exists:** yes.
- **Decision:** fix at P2 priority.
- **Rationale:** the public tool says source content and optional origin are non-empty, but zero-byte content and trim-empty origin are accepted. Source text consisting only of whitespace may be meaningful evidence, so the enforced content invariant is zero UTF-8 bytes, not trimmed emptiness.
- **Approved change surface:** `src/service.ts`, metadata parsing/validation at its current owner, tool schema/description only if clarification is needed, and focused service/plugin/lint tests. Reject exact zero-byte content before filesystem mutation; reject present origin when `trim().length === 0`; preserve meaningful origin value according to the existing metadata normalization contract; lint malformed persisted metadata with the same invariant.
- **Verification:** empty content creates no directory and returns the stable input error; whitespace-only content remains accepted unless the public contract is deliberately changed in the same chunk; absent origin is accepted; empty/whitespace origin is rejected; persisted malformed whitespace origin is diagnosed; non-empty/deduped sources are unchanged.
- **Dependencies:** none conceptually; implemented in C15.
- **Status:** complete in C15. Independent three-lens final review found no product or test issue; only stale tracker accounting remained. Commit `f2411ae` records the verified source validation behavior.

#### DEF-STALE-TARBALL

- **Exists:** yes.
- **Decision:** fix at P2 priority.
- **Rationale:** package version `0.1.1` packs as `evegoodevening-dsh-llmwiki-0.1.1.tgz`; exactly four executable documentation references previously named `0.1.0.tgz` and now name the current artifact.
- **Approved change surface:** `README.md` and `examples/README.md`; exactly four documentation references changed to `evegoodevening-dsh-llmwiki-0.1.1.tgz`. No documentation-audit assertion required a change.
- **Verification:** README/examples contain zero stale `0.1.0.tgz` matches and exactly four current `evegoodevening-dsh-llmwiki-0.1.1.tgz` matches. `pnpm pack` produced `/tmp/dsh-llmwiki-c18-pack/evegoodevening-dsh-llmwiki-0.1.1.tgz`, supporting the documented local/profile install commands.
- **Dependencies:** none; isolated documentation chunk C18 follows stabilized C17 public documentation.
- **Status:** complete. Independent static documentation review verdict: CLEAN. Commit `ff4b213` has actual subject `docs: use current packed artifact name` and exactly four paths: `README.md`, `docs/plan/CHECKLIST.md`, `docs/plan/PLAN.md`, and `examples/README.md`. `DEF-STALE-TARBALL`, C18, its review, commit, and ledger are complete. C19A is complete in `89fce38`; C19B remains externally blocked.

### 14.3 Frozen C16 catalog contract

C16 adds exactly two service methods and two model tools. Public service names are `listSources(request?, signal?)` and `listPages(request?, signal?)`; tool names are `llmwiki_list_sources` and `llmwiki_list_pages`. The complete tool registry becomes exactly nine tools in this stable order: `llmwiki_status`, `llmwiki_add_source`, `llmwiki_list_sources`, `llmwiki_read_source`, `llmwiki_search`, `llmwiki_list_pages`, `llmwiki_read_page`, `llmwiki_upsert_page`, `llmwiki_lint`. Registration, assembled schemas, prompt enumeration, presentations, direct-service callers, exact-count assertions, Loader lifecycle, built-package/profile probes, smoke/determinism scripts, README, and examples must all migrate atomically in C16; no seven-tool compatibility alias remains.

Both methods accept `CatalogRequest { limit?: number; cursor?: string }`. `limit` defaults to the resolved configured `maxResults`, must be a safe integer in `1..maxResults`, and therefore has the existing deployment hard maximum `100`; no new config key or manifest/bundle field is added. `cursor` is an opaque, unpadded base64url encoding of canonical UTF-8 JSON with no whitespace and exact field order: source cursor `{"v":1,"kind":"sources","after":"<source-id>"}`; page cursor `{"v":1,"kind":"pages","after":"<page-id>"}`. Decoded objects are closed; malformed base64url/UTF-8/JSON, unknown fields/version/kind, invalid ID, noncanonical encoding, or use with the other catalog throws new stable `INVALID_CURSOR` without exposing paths. `nextCursor` is `null` exactly at end of list; an empty catalog returns `{ items: [], nextCursor: null }`.

`listSources` returns closed `SourceCatalogPage { items: SourceCatalogEntry[]; nextCursor: string | null }`; each entry has exact field order `{ id, name, mediaType, byteCount, capturedAt, origin? }` and reuses validated immutable `SourceMetadata` without content or host paths. Entries sort by source ID using locale-independent UTF-16 code-unit comparison. `listPages` returns closed `PageCatalogPage { items: PageCatalogEntry[]; nextCursor: string | null }`; each entry has exact field order `{ id, title, summary, sources, byteCount, sha256 }`, with `sources` already sorted, `byteCount` the exact Markdown byte length, and `sha256` the lowercase hash of exact bytes. Entries sort by page ID using the same comparator. Output object schemas are closed wherever dsh supports closure; top-level tool parameter objects retain `defineTool`'s documented openness but handlers use only declared `limit`/`cursor`.

Pagination is deterministic live seek, not a snapshot: a page begins at the first key strictly greater than `after`. After mutation, unchanged keys are never duplicated; deleted keys are harmless; newly inserted keys `<= after` are not seen in that traversal, while newly inserted keys `> after` may appear. Cursor stability therefore depends only on the ordering key, not mtimes, capture time, index state, or a hidden generation. Callers needing a point-in-time inventory must restart from no cursor after quiescing writers. Discovery validates the complete selected catalog before returning any page: malformed source/page records, unsafe symlinks, invalid UTF-8, hash/metadata mismatch, or parse-invalid pages fail the whole call with existing `UNSAFE_FILESYSTEM` where safety is violated and new stable `CATALOG_CORRUPT` for invalid persisted records; entries are never silently skipped. Missing/non-initialized roots return an empty page without creating files. Cancellation before or between traversal/validation phases throws `ABORTED`; listing performs no writes, index rebuild, clock read, network, model call, or subprocess.

C16 also adds deterministic warning `SOURCE_UNREFERENCED` at logical path `sources/<id>/metadata.json`, no line, with exact message `Source is not referenced by any valid page.`; order remains the global lint order. It is computed from every valid source minus source IDs referenced by valid parsed pages and never mutates data. Canonical-page byte lint remains the separate `PAGE_INVALID_MARKDOWN` contract.

### 14.4 Sequential implementation chunks

All chunks are sequential to keep shared service, lint, prompt, documentation, and integration-test ownership unambiguous. Each implementation chunk is independently reviewable, verifiable, committable, and leaves a durable resume point. C15 transferred `src/lint.ts` to C16 after commit `f2411ae`.

1. **C14 — Restore page-derived index trust** (`DEF-INDEX-TRUST`).
2. **C15 — Make mutation and source reads truthful** (`DEF-UPSERT-POSTCOMMIT`, `DEF-UTF8-PROGRESS`, `DEF-EMPTY-SOURCE`), complete in `f2411ae`, including the persisted-metadata lint invariant in `src/lint.ts`; ownership of `src/lint.ts` is transferred to C16.
3. **C16 — Add deterministic recovery catalogs and complete structural lint** (`GAP-CATALOG`, `DEF-CANONICAL-LINT`) under §14.3, receiving `src/lint.ts` from C15; complete after draft commit `6516d17`, review-fix commit `e50f45b`, traversal-fix commit `99ab707`, independent static closure review CLEAN, and final commit `e8a8c2b` (`fix(catalog): preserve safe path semantics`) containing exactly `src/lint.ts`, `src/service.ts`, `tests/lint.spec.ts`, and `tests/service.spec.ts`.
4. **C17 — Freeze and implement workflow guidance and honest positioning** (`GAP-INGEST` and `GAP-SEMANTIC-LINT` contracts, plus `GAP-EVIDENCE` and `CLAIM-COMPLETE`), complete after clean three-lens static product review and final commit `10eccf7` (`docs: synchronize wiki maintenance guidance`) containing exactly `README.md`, `examples/README.md`, `scripts/check-determinism.ts`, `src/prompt.ts`, `src/service.ts`, `tests/built-package.e2e.spec.ts`, `tests/plugin.spec.ts`, and `tests/service.spec.ts`. Both workflow IDs remain open pending C19B and `GAP-SCHEMA` remains unresolved.
5. **C18 — Repair packed-artifact instructions** (`DEF-STALE-TARBALL`), complete after independent static documentation review verdict CLEAN and commit `ff4b213` (`docs: use current packed artifact name`) containing exactly `README.md`, `docs/plan/CHECKLIST.md`, `docs/plan/PLAN.md`, and `examples/README.md`.
6. **C19A — Implement the opt-in real-agent smoke** (`GAP-MODEL-E2E` implementation), complete in commit `89fce38` with actual subject `test(agent): add opt-in real-model smoke harness`. Its exact 19 paths are `README.md`, `docs/plan/CHECKLIST.md`, `docs/plan/PLAN.md`, `package.json`, `scripts/agent-smoke.ts`, `tests/agent-smoke.spec.ts`, `tests/fixtures/agent-smoke/instructions.txt`, `tests/fixtures/agent-smoke/operations-runbook.md`, `tests/fixtures/agent-smoke/project-aurora.md`, `tests/fixtures/agent-smoke/recovery-valid/pinned-project/recovery-session/session.jsonl`, `tests/fixtures/agent-smoke/runner/package.json`, `tests/fixtures/agent-smoke/runner/pnpm-lock.yaml`, `tests/fixtures/agent-smoke/runner/pnpm-workspace.yaml`, `tests/fixtures/agent-smoke/schema.md`, `tests/fixtures/agent-smoke/session-pinned/pinned-project/pinned-session/session.jsonl`, `tests/fixtures/agent-smoke/source-a.txt`, `tests/fixtures/agent-smoke/source-b.txt`, `vitest.agent-smoke.config.ts`, and `vitest.config.ts`. Separate guidance commit `99addd9` has actual subject `docs(agents): record real-agent smoke constraints` and exactly one path, `AGENTS.md`; it is outside C19A's exact-19 accounting.
7. **C19B — Execute credentialed agent and semantic-review acceptance**; its passing durable evidence alone behaviorally closes `GAP-INGEST`, `GAP-SEMANTIC-LINT`, and `GAP-MODEL-E2E`. It is externally blocked pending an authorized non-empty `DEEPSEEK_API_KEY`, a safe explicit `LLMWIKI_AGENT_SMOKE_MODEL` successfully invokable through pinned DSH agent `0.1.1-rc.2`, `LLMWIKI_AGENT_SMOKE_NETWORK=allow` with permitted outbound access to the configured DeepSeek endpoint, and zero-exit `pnpm run smoke:agent -- --preflight`. `tests/fixtures/agent-smoke/latest.json` is absent; no credentialed model/network run occurred.

C14 is complete. Draft implementation is committed as `1b7754d` (`fix(index): verify derived index semantics`) with all six product/test paths and both tracker bookkeeping paths accounted for. First review fixes are committed as `11ba0a0` (`fix(index): harden page snapshot trust`) with exactly six paths: `docs/plan/CHECKLIST.md`, `docs/plan/PLAN.md`, `src/indexer.ts`, `src/service.ts`, `tests/indexer.spec.ts`, and `tests/service.spec.ts`. Stable-page-snapshot fixes are committed as `54321a8` (`fix(index): trust stable page snapshots`) with exactly the same six paths. Corpus-snapshot fixes are committed as `03db8b8` (`fix(index): validate corpus snapshots`) with exactly five paths: `docs/plan/CHECKLIST.md`, `docs/plan/PLAN.md`, `src/indexer.ts`, `src/service.ts`, and `tests/indexer.spec.ts`. Independent three-lens final review was clean across the shared index trust rule and final lint/corpus invalid-path behavior; only stale tracker accounting remained, and this update corrects it. Final commit `6ba64b3` (`fix(index): align lint snapshot trust`) contains exactly `src/indexer.ts`, `src/lint.ts`, `src/service.ts`, `tests/lint.spec.ts`, and `tests/service.spec.ts`. `DEF-INDEX-TRUST`, C14, and its follow-up ledger are complete.

C15 is complete. Focused service/service-postcommit/plugin/lint verification passed 95/95, `pnpm run typecheck` passed, and `pnpm run lint` passed. Independent three-lens final review found no product or test issue; only stale tracker accounting remained, corrected here. Commit `f2411ae` has actual subject `fix(service): make writes and ranges truthful` and exactly nine paths: `docs/plan/CHECKLIST.md`, `docs/plan/PLAN.md`, `src/lint.ts`, `src/service.ts`, `src/tools.ts`, `tests/lint.spec.ts`, `tests/plugin.spec.ts`, `tests/service-postcommit.spec.ts`, and `tests/service.spec.ts`. `DEF-UPSERT-POSTCOMMIT`, `DEF-UTF8-PROGRESS`, `DEF-EMPTY-SOURCE`, C15, and its review/commit ledger are complete; ownership of `src/lint.ts` was transferred to C16.

C16 is complete. Implementation, review fixes, and all recorded verification gates are complete. Draft commit `6516d17` has actual subject `feat(catalog): add deterministic wiki listings` and exactly 18 paths: `README.md`, `docs/plan/CHECKLIST.md`, `docs/plan/PLAN.md`, `examples/README.md`, `scripts/check-determinism.ts`, `scripts/smoke.ts`, `src/errors.ts`, `src/lint.ts`, `src/presentation.ts`, `src/prompt.ts`, `src/service.ts`, `src/tools.ts`, `src/types.ts`, `tests/built-package.e2e.spec.ts`, `tests/lint.spec.ts`, `tests/loader.e2e.spec.ts`, `tests/plugin.spec.ts`, and `tests/service.spec.ts`. Review-fix commit `e50f45b` has actual subject `fix(catalog): validate complete listings` and exactly eight paths: `README.md`, `docs/plan/CHECKLIST.md`, `docs/plan/PLAN.md`, `src/service.ts`, `tests/built-package.e2e.spec.ts`, `tests/loader.e2e.spec.ts`, `tests/plugin.spec.ts`, and `tests/service.spec.ts`. Traversal-fix commit `99ab707` has actual subject `fix(catalog): bound directory traversal` and exactly four paths: `docs/plan/CHECKLIST.md`, `docs/plan/PLAN.md`, `src/service.ts`, and `tests/service.spec.ts`. Independent static closure review verdict: CLEAN. Final commit `e8a8c2b` has actual subject `fix(catalog): preserve safe path semantics` and exactly four product/test paths: `src/lint.ts`, `src/service.ts`, `tests/lint.spec.ts`, and `tests/service.spec.ts`. `GAP-CATALOG`, `DEF-CANONICAL-LINT`, C16, and the C16 follow-up ledger are complete. C17 is complete after clean three-lens static product review and final commit `10eccf7`; `GAP-SCHEMA` remains explicitly unresolved, and C19B remains externally blocked.

C17 is complete. Draft commit `565514f` has actual subject `docs: clarify llmwiki workflow and guarantees` and exactly 13 paths: `README.md`, `docs/plan/CHECKLIST.md`, `docs/plan/PLAN.md`, `examples/README.md`, `examples/demo-wiki/schema.md`, `package.json`, `scripts/check-determinism.ts`, `src/prompt.ts`, `src/service.ts`, `src/tools.ts`, `tests/built-package.e2e.spec.ts`, `tests/plugin.spec.ts`, and `tests/service.spec.ts`. Review-fix commit `587f375` has actual subject `docs: enforce authorized wiki maintenance` and exactly seven paths: `README.md`, `scripts/check-determinism.ts`, `src/prompt.ts`, `src/service.ts`, `tests/built-package.e2e.spec.ts`, `tests/plugin.spec.ts`, and `tests/service.spec.ts`. The focused plugin/service run passed 83/83, followed by passing typecheck, lint, build, determinism, and built-package E2E 8/8 gates. The final three-lens static product review was clean. Final commit `10eccf7` has actual subject `docs: synchronize wiki maintenance guidance` and exactly eight paths: `README.md`, `examples/README.md`, `scripts/check-determinism.ts`, `src/prompt.ts`, `src/service.ts`, `tests/built-package.e2e.spec.ts`, `tests/plugin.spec.ts`, and `tests/service.spec.ts`. C17 review, commit, and ledger are complete; `GAP-EVIDENCE` and `CLAIM-COMPLETE` are complete. `GAP-INGEST` and `GAP-SEMANTIC-LINT` remain open pending C19B, and `GAP-SCHEMA` remains unresolved.

C18 is complete. Independent static documentation review verdict: CLEAN. Commit `ff4b213` has actual subject `docs: use current packed artifact name` and exactly four paths: `README.md`, `docs/plan/CHECKLIST.md`, `docs/plan/PLAN.md`, and `examples/README.md`. `DEF-STALE-TARBALL`, C18, its review, commit, and ledger are complete. C19A implementation/review/commit/ledger are complete in `89fce38`; separate `AGENTS.md` guidance commit `99addd9` is outside exact-19 accounting. C19B remains externally blocked under the exact credential/model/network/preflight conditions above, so `GAP-MODEL-E2E`, `GAP-INGEST`, and `GAP-SEMANTIC-LINT` remain open solely pending C19B. `GAP-SCHEMA` remains intentionally unresolved pending a separate product decision defining authorization/confirmation, audit evidence, validation, cancellation, and optimistic-concurrency/lost-update behavior.
