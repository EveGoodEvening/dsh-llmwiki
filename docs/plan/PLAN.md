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

### 14.5 Final-gate verification and accounting

Coverage-regression commit `5a38926` has actual subject `test(service): cover catalog error boundaries`. It is a separate final-gate test commit outside the C14–C19A chunk product commits and does not change C19A's exact-19 path accounting. Final evidence is: ordinary unit tests 245/245; C19A-focused tests 51/51; typecheck, lint, build, smoke, and determinism passed; E2E passed 8/8; aggregate coverage is 93.22% statements, 88.55% branches, 97.59% functions, and 95.75% lines; `src/service.ts` coverage is 90.89% statements, 85.33% branches, 95.18% functions, and 94.56% lines; and the dependency audit reported no vulnerabilities.

This final-gate accounting does not alter follow-up closure boundaries: C19B remains externally blocked and unchecked, `GAP-INGEST`, `GAP-SEMANTIC-LINT`, and `GAP-MODEL-E2E` remain open solely pending C19B, and `GAP-SCHEMA` remains intentionally unresolved pending its separate product decision.

## 15. GitHub issues #2 and #3 adjudication (2026-09-02)

### 15.1 Authority, scope, and relationship to the existing follow-up

This section is the architecture authority for GitHub issues #2 and #3. It adds exactly two decision IDs, `ISSUE-2-WORKSPACE-SCOPE` and `ISSUE-3-FILESYSTEM-POLICY`, without reopening, renumbering, or weakening any decision or completed evidence in §§1–14. The corresponding executable tracker is `CHECKLIST.md` C20–C22.

This lane is independent of C19B. C19B remains externally blocked under its existing credential/model/network/preflight conditions and remains the only behavioral closure gate for `GAP-INGEST`, `GAP-SEMANTIC-LINT`, and `GAP-MODEL-E2E`. Neither issue #2 nor issue #3 requires a credentialed model run, and resolving them must not create, modify, or claim `tests/fixtures/agent-smoke/latest.json`. `GAP-SCHEMA` also remains intentionally unresolved.

### 15.2 Conservative product boundary

The current product remains a host-only, local-first Cordis plugin whose durable repository is selected solely by one fixed resolved host root. Service state is activation-local, but repository identity is not:

- one `LlmWikiService` is registered on each plugin context and owns activation-local initialization state and one same-process mutation queue for its fixed resolved root;
- a relative configured `root`, including the default `.llmwiki`, is resolved once against the host process working directory at activation and then converted to a fixed absolute host path;
- an absolute configured `root` denotes that fixed host path directly;
- tool `exec.agent`, command `invocation.agent`, `SessionHeader.cwd`, agent identity, session identity, and optional `WorkspaceId` do not participate in repository identity;
- therefore every agent, session, tool call, command call, and direct service caller using an activation shares its fixed root; separate workspace metadata does not isolate data;
- two activations configured with the same resolved root address the same durable repository even though their caches and queues are separate. Concurrent writers in separate activations or processes remain unsupported; the same-process queue is not a cross-process lock;
- isolation requires separate plugin contexts/processes configured with distinct resolved roots. A shared root or shared activation is unsupported for mutually untrusted tenants or projects requiring storage isolation.

Durable repository identity is consequently the fixed resolved host root. Activation identity selects only in-memory service state and serialization; canonical workspace aliases and per-session cwd changes are irrelevant because no caller workspace is consulted after activation.

### 15.3 `ISSUE-2-WORKSPACE-SCOPE` — no runtime fix required

- **Issue claim:** the wiki is process/plugin-context shared rather than workspace/agent scoped.
- **Exists:** yes; focused source, built-artifact, test, and two-agent reproduction evidence confirms it.
- **Decision:** repository-resolved as designed; no runtime repository-selection fix is required. C21 made the fixed-root contract explicit, regression-protected it, and removed silent bundled activation of policy-exempt host storage in favor of explicit operator opt-in. The GitHub issue is not closed; its approved comment and `not_planned`/by-design closure remain C22 external work.
- **Why no product-code fix is required:** process-wide sharing matches the existing host-only architecture, single-service topology, configured-root contract, and durable PLAN decisions. DSH exposes caller workspace coordinates, but merely making an ordinary Cordis service reachable from an agent context does not scope its state. Adopting workspace identity would require a breaking redesign of service APIs, root state, queues, initialization, direct callers, commands, tools, migration, and policy—not a corrective patch to the declared product.
- **Required work:** clarify public documentation and configuration guidance; retain or strengthen a focused contract test proving constructor-time root capture; exercise tool calls across distinct agents/session cwd values, command calls across distinct command agents where applicable, and direct service callers; prove all use the captured root; add a sequential two-activation same-root regression that writes through one activation, reads/lists through the other, then disposes/remounts and confirms the durable record remains shared; and retain a separately mounted distinct-root isolation case as the negative control. Writers in the same-root regression remain sequential, and the test must not be presented as support for concurrent separate-activation/process writers.
- **Repository disposition:** resolved with no runtime fix required after unanimous CLEAN C21 re-review. GitHub closure remains separately authorization-gated and unchecked in C22. The future closure comment must cite fixed-root adapter, sequential same-root durable-sharing, and distinct-root isolation evidence; distinguish fixed-root identity from activation-local state; and warn against shared-root concurrent writers and multi-tenant use.

### 15.4 `ISSUE-3-FILESYSTEM-POLICY` — no `ctx.fs` migration required

- **Issue claim:** wiki filesystem operations bypass DSH's filesystem-policy seam.
- **Exists:** yes; production persistence uses direct Node filesystem APIs and the plugin does not inject `fs`, dispatch `fs/*` observation/write intents, request `ctx.approval`, or pass through the DSH sandbox provider.
- **Decision:** repository-resolved with host storage remaining outside `ctx.fs`; no runtime I/O migration is required. C21 removed unconditional bundled activation and now requires explicit operator opt-in/configuration for this policy-exempt store. The GitHub issue is not closed; its approved comment and `not_planned`/by-design closure remain C22 external work.
- **Ownership:** `.llmwiki` is host-managed plugin application storage. The plugin, its configured host root, and host OS permissions own its persistence and safety. It is not DSH workspace-provider storage even when a relative root happens to resolve beneath a process working directory.
- **Permission semantics:** `DSH_PERMISSION_MODE`, `dsh-fs-sandbox`, filesystem observation/read-before-edit policy, `fs/write-intent`, `fs/edit-intent`, `fs/observed`, remote/workspace filesystem providers, and `ctx.approval` do not govern llmwiki reads or writes. Prompt guidance requiring explicit user authorization for knowledge maintenance is an instruction-level workflow rule, not a technical DSH approval gate. External `tools/pre-execute` guards may gate selected tool calls but do not cover direct service calls, commands, initialization, or derived-index writes and therefore must not be represented as complete storage policy.
- **Why no partial `ctx.fs` change is required:** the accepted product boundary is host-owned storage, and the current implementation has Node-specific persistence invariants that a future provider design must preserve. This lane does not claim that a safe policy-aware implementation is impossible or rely on an unpinned inventory of missing `ctx.fs` capabilities. Any future migration must specify and verify the complete provider contract and resolve issue #2's identity and migration questions simultaneously.
- **Write and initialization semantics:** source addition, page upsert, first-use initialization/schema creation, and `/wiki reindex` require host writes. `status`, source/page listing, and `lint` are strictly non-mutating. `readSource`, `readPage`, and search are initialization-capable because their current service paths may create the root, `sources/`, `pages/`, `.index/`, and missing `schema.md` before reading or evaluating index freshness; they are usable against an OS-read-only root only when that repository is already fully initialized. Search is additionally conditionally index-publishing: after complete initialization it is read-only only with a prebuilt fresh index, while an absent/incomplete repository or a missing/stale index requires creation or publication and fails when the OS boundary denies writes. This lane deliberately documents and regression-protects those current semantics rather than planning a product-source acquire-only read change.
- **Required work:** document the exclusion and every write-capable or initialization-capable surface prominently; correct wording that implies DSH approval is enforced; remove the unconditional bundled profile activation in favor of explicit operator opt-in; and use an actually composed DSH sandbox/read-only mechanism for a disposable controlled test. The test must positively prove a filesystem operation governed by that mechanism is denied while an explicitly opted-in llmwiki host-store mutation succeeds. If the pinned runtime exposes no executable composed mechanism, omit that comparison test, record the limitation, and do not use an inert environment variable as evidence. Separately test OS-read-only roots in absent, incomplete, fully initialized/fresh-index, and fully initialized/missing-or-stale-index states. Before invoking the service, each fixture must prove that a direct Node sentinel write or `mkdir` by the same executing identity is denied; use a genuinely unprivileged subprocess or enforced read-only mount where needed, and record the gate as unsupported/blocked rather than accepting `chmod` when denial cannot be established. On a fully initialized root with a fresh index, `status`, lists, `lint`, source/page reads, and search remain usable without byte/path changes; missing/stale-index search and explicit mutations fail without publication. On an absent or incomplete root, `status`, lists, and `lint` remain non-mutating, while `readSource`, `readPage`, and search take their initialization-capable paths, fail when initialization cannot write, and create/publish nothing.
- **Repository disposition:** resolved with no runtime fix required after unanimous CLEAN C21 re-review. GitHub closure remains separately authorization-gated and unchecked in C22. The future closure comment must carry the warning, exact initialization-capable read/search semantics, conditional search publication, proven OS denial or explicit unsupported/blocked result, and explicit opt-in default; it must also state that deployments requiring DSH-enforced read-only behavior, remote providers, or tenant isolation must not opt in to this plugin in that execution boundary.

### 15.5 Compatibility, migration, and operator contract

This adjudication makes no product-source, storage-format, tool-schema, service-API, default-root-value, or dependency change. Existing roots, source/page IDs, canonical bytes, indexes, and direct callers remain compatible without copying or conversion. C21 does change bundled profile activation from unconditional to explicit opt-in; owned README upgrade/release guidance and examples must identify that operational cutover without claiming a data migration.

Operators must choose deliberately:

1. **Opt in and retain existing shared storage:** explicitly enable the plugin and keep the configured root. Prefer an explicit absolute host-state path so its policy ownership is not confused with a DSH workspace.
2. **Isolate trusted projects:** mount separate plugin contexts/processes with distinct explicit roots. Changing only `SessionHeader.cwd` is insufficient; reusing one root shares durable files, and concurrent separate-process writers are unsupported.
3. **Require hard read-only, tenant isolation, DSH approval, or remote-provider semantics:** do not opt in to llmwiki in that execution. Host filesystem permissions or deployment-level process isolation are the applicable controls for the current product. On a fully initialized OS-read-only root, `status`, lists, `lint`, and source/page reads are usable; search is usable without writes only when the prebuilt index is fresh. `readSource`, `readPage`, and search are not reliable on an absent or incomplete read-only root because they may initialize repository paths/schema, and search additionally fails without publication when the initialized index is missing or stale.

No automatic root discovery, copying, splitting, or deletion is approved. The plugin cannot infer which project owns data from a historically shared root, so automatic migration could disclose or misassign evidence.

### 15.6 Future reopen criteria

Issues #2 and #3 must be reopened together, as one breaking storage/execution-world design, if the supported product is changed to workspace-scoped or DSH-policy-governed storage. Such a proposal must first freeze all of the following before implementation:

- canonical repository identity and same-workspace sharing rules;
- relative versus absolute root behavior and a non-ambiguous compatibility mode;
- caller-less/direct service semantics and complete tool/command caller projection;
- per-root initialization, bounded lifecycle, disposal, and serialization;
- the pinned `ctx.fs` and composed sandbox/provider capabilities actually required for recursive listing, directory lifecycle, byte/text fidelity, atomic/CAS writes, symlink containment, multi-file crash recovery, and controlled-denial testing;
- read-only search/index behavior, observation events, approval/escalation, structured denial errors, and a secure activation default;
- legacy shared-root migration and rollback without automatic data assignment;
- focused local/sandbox/provider, two-workspace, permission, compatibility, packed-profile, and documentation tests.

Until that complete contract is approved, introducing only workspace cwd selection or only `ctx.fs` would create mismatched identity and permission ownership and is prohibited.

### 15.7 Sequential implementation and review chunks

All issue work is sequential and independently reviewable, verifiable, committable, and resumable. C19B remains a separate lane:

1. **C20 — Freeze issues #2/#3 adjudication:** complete. Planning commit `d0eb13d` changed exactly `docs/plan/PLAN.md` and `docs/plan/CHECKLIST.md` and was review-clean. The incomplete first accounting attempt, `b1908d7`, changed only `docs/plan/CHECKLIST.md`. Corrective accounting commit `c311a1b` changed exactly the required two artifacts, `docs/plan/PLAN.md` and `docs/plan/CHECKLIST.md`, and C20 is fully accounted.
2. **C21 — Publish and regression-protect the host-store contract:** complete after implementation commit `81f63bd`, review-fix commits `fb579f2` and `164bed6`, recorded focused verification, and unanimous final independent re-review verdicts of **CLEAN**. The implementation documents the public contract and activation cutover, retains and extends the fixed-root regressions, proves the composed policy boundary and Linux read-only behavior, and leaves product source, public APIs, dependencies, storage bytes, and root defaults unchanged.
3. **C22a — Durable pre-closure review and blocked preflight accounting:** repository-local work is complete. Review A's sole initial finding—weak captured-root command status/lint assertions—was directly fixed by `9c7cf07`, changing exactly `tests/plugin.spec.ts`; the distinct later independently pinned SHA-256 source-ID requirement was adversarial re-review hardening completed by `e9f504f`, also changing exactly `tests/plugin.spec.ts`. Review B and the final split/aggregate independent re-reviews were unanimously **CLEAN**, every finding is resolved with corrected attribution, the approved exact comments and digests are durable, and all previously recorded repository-local gates passed. Pre-closure commit `fc4897c` changed exactly `docs/plan/PLAN.md` and `docs/plan/CHECKLIST.md`. Its non-mutating preflight recorded issue #2 and issue #3 as open with `state_reason=null`, `closed_at=null`, zero comments, empty comments/events/timeline results, and no approved comment present; canonical URLs remain `https://github.com/EveGoodEvening/dsh-llmwiki/issues/2` and `https://github.com/EveGoodEvening/dsh-llmwiki/issues/3`. GitHub supports closing with `state_reason=not_planned`. Authenticated identity is `null`; `GET /user` returned HTTP 401; no `gh` installation or stored auth, token, enabled GitHub MCP, or authenticated browser relay is available; repository owner/push/Triage authorization was not established; therefore `can_close=false`. Repository-local C22 work is complete, while external mutation is blocked, not deferred.
4. **C22b — Resumable external mutation and durable accounting:** `BLOCKED-GITHUB-CLOSURE: no authenticated GitHub identity or Issues: write owner/push/Triage authorization is available`. No comment was posted and neither issue was closed. Safe resume requires an authenticated GitHub session or repository-scoped token with Issues: write plus owner, push, or Triage authority. Rerun the complete non-mutating preflight; confirm `GET /user`, repository permission, both current issue/comment milestone states, and `not_planned` support; durably commit that successful authorization update before mutation. Then idempotently process each issue in order: inventory the exact approved comment and post it only if absent; confirm and record its URL; close only if still open using `state_reason=not_planned`; re-read issue and comments; skip every already-confirmed milestone. Partial-mutation accounting is deferred unless an authorized mutation partially succeeds or fails, then becomes required: after any such failure, inventory both issues and durably account confirmed successes before resuming. Only after both comments and both closures are confirmed may the decision-ID closure rows and final closure accounting be completed.

**Approved exact issue #2 closure comment**
SHA-256 of the exact UTF-8 comment bytes (no trailing newline): `3eed98911b6c5e9b1aa7277b086c748a7f296367d488e758caffd977c0f431a0`

```text
Closing as not planned because the reported behavior still exists, but it is the supported product boundary rather than a runtime defect.

`dsh-llmwiki` identifies a repository by the plugin activation's configured host root. A relative root is resolved once against the host process cwd at activation; an absolute root is used directly. Tool agents, command agents, `SessionHeader.cwd`, sessions, and workspace metadata do not select another repository. Tests now independently pin the expected SHA-256 source ID and prove that distinct tool and command agents observe the captured root, that sequential activations using the same root share durable data across dispose/remount, and that distinct configured roots remain isolated.

Activation state and the in-process mutation queue remain local to each activation. Separate activations or processes writing one shared root concurrently are unsupported, and a shared root/activation must not be used for mutually untrusted tenants.

No runtime fix or data migration is needed. Reopen issues #2 and #3 together only if the product is to adopt workspace-scoped, DSH-policy-governed storage; that requires a joint breaking design for identity, caller-less service behavior, lifecycle/locking, provider capabilities, migration/rollback, and compatibility tests.
```

**Approved exact issue #3 closure comment**
SHA-256 of the exact UTF-8 comment bytes (no trailing newline): `3ce1a464ae939bb9800c73460528110b81dfd64e73b0a61bc5210c841112a6ae`

```text
Closing as not planned because the reported policy bypass still exists, but it is the explicitly supported host-storage boundary rather than a runtime defect.

`dsh-llmwiki` persists through direct Node filesystem APIs under its configured host root. It does not use `ctx.fs`, DSH filesystem intents/observations, remote/workspace providers, `ctx.approval`, or the DSH sandbox provider. This host-managed store is disabled by the bundled profile by default and requires explicit operator opt-in with a configured root. The packed-profile tests prove both the empty secure default and explicit enable/disable/re-enable behavior. A composed DSH sandbox control denies a governed stock write while an explicitly enabled llmwiki host-store write succeeds, proving the exclusion rather than implying policy enforcement. Linux private read-only-mount tests also prove same-identity OS denial and unchanged bytes/paths.

`status`, source/page listing, and lint are non-mutating. `readSource`, `readPage`, and search may initialize an absent or incomplete repository. Search may also publish a missing or stale derived index; it is write-free only for a fully initialized repository with a fresh prebuilt index. On a fully initialized OS-read-only root, status, lists, lint, and source/page reads work, and search works only with that fresh index. External tool guards do not cover direct service calls, commands, initialization, or derived-index writes.

Deployments requiring DSH-enforced read-only behavior, remote-provider semantics, approval enforcement, or tenant isolation must not opt in within that execution boundary. No runtime `ctx.fs` migration or data migration is needed. Reopen issues #2 and #3 together only for a joint breaking storage/identity redesign with pinned provider capabilities, denial and read-only semantics, migration/rollback, and compatibility coverage.
```

Commit order remains acyclic: C20 planning → C20 accounting → C21 implementation/review → C22 pre-closure; if authorization is blocked, a later successful-preflight update commit follows that blocked commit; then zero or more external-action/partial-accounting pairs → completion of only remaining external actions → final closure accounting. Each accounting or authorization-update commit records only already-created commits and already-observed external state; no external action depends on a later accounting commit except resumption, which consumes the latest durable partial state.

Each implementation/review/pre-closure commit records its contents without requiring its own hash. A later accounting commit records prior commit hashes and path sets. A chunk is not complete merely because its draft exists: all specified review lenses, finding dispositions, verification evidence, and exact ledgers must be durable. C22 may begin mutation only when both independent reviews pass, the approved comment for the issue is durably fixed, and the latest durable preflight authorizes it. Thereafter each decision ID advances independently only when both its comment and closure milestones are confirmed. A finding that invalidates the shared host-store premise reopens both decisions for a joint breaking redesign rather than allowing a partial product fix.

Current issue-lane ledger: `d0eb13d` is the valid C20 planning commit with exact paths `docs/plan/PLAN.md` and `docs/plan/CHECKLIST.md`; `b1908d7` is the incomplete C20 accounting attempt with exact path `docs/plan/CHECKLIST.md`; `c311a1b` is the exact-two-artifact corrective C20 accounting commit with exactly `docs/plan/PLAN.md` and `docs/plan/CHECKLIST.md`, completing C20 accounting; `81f63bd` is the C21 implementation commit with exactly `README.md`, `cordis.patch.yml`, `docs/plan/CHECKLIST.md`, `examples/README.md`, `scripts/check-determinism.ts`, `tests/built-package.e2e.spec.ts`, `tests/plugin.spec.ts`, and `tests/service.spec.ts`; `fb579f2` is the C21 review-fix commit with exactly `docs/plan/PLAN.md`, `docs/plan/CHECKLIST.md`, `tests/plugin.spec.ts`, and `tests/service.spec.ts`; and `164bed6` is the Linux-scope review-fix commit with exactly `tests/service.spec.ts`. The inclusion of `docs/plan/CHECKLIST.md` in `81f63bd` deviated from C21's accounting-only tracker ownership rule; the ledger records the actual path rather than rewriting history. Three independent final C21 re-reviews unanimously returned **CLEAN** with no findings, so all C21 implementation, verification, review, commit, and accounting work is complete. C22 Review A's sole initial finding was fixed by `9c7cf07` and the distinct adversarial source-ID hardening by `e9f504f`, each changing exactly `tests/plugin.spec.ts`; `2b34007` and `0922a96` each changed exactly `docs/plan/PLAN.md` and `docs/plan/CHECKLIST.md`. Review B and final C22 re-reviews were **CLEAN**. Pre-closure commit `fc4897c` changed exactly `docs/plan/PLAN.md` and `docs/plan/CHECKLIST.md`. The durable read-only preflight found issues #2/#3 open, `state_reason=null`, `closed_at=null`, comments/events/timeline empty, and approved comments absent; `not_planned` is supported. Authenticated identity is `null`, `GET /user` returned 401, no `gh`/token/GitHub MCP/authenticated relay is available, and `can_close=false`. Repository-local C22 work is complete; external mutation is blocked under `BLOCKED-GITHUB-CLOSURE: no authenticated GitHub identity or Issues: write owner/push/Triage authorization is available`. Posting, closing, resulting comment URLs/closed states, decision-ID GitHub closure, partial-mutation accounting, and final closure accounting remain unchecked. C19B remains separately externally blocked under its existing exact blocker, and `GAP-SCHEMA` remains intentionally unresolved by its separate product decision.

## 16. Current-channel compatibility and OIDC release (2026-09-29)

### 16.1 Boundary and evidence

This new lane is tracked only by `CHECKLIST.md` C23–C27. §§1–15 and their completed ledgers are historical evidence, not claims that today's npm channel is supported. At an earlier 2026-09-29 primary npm snapshot, `@deepseek-ai/dsh` **latest** was `0.1.7-rc.2`, Cordis latest `4.0.4`, Loader latest `1.0.5`, Include `1.0.9`, Timer `1.1.6`, Group `1.0.4`, and Cordis HMR `1.0.19`; `@deepseek-ai/dsh` **next** was then-unproven `0.2.0-rc.2`. Those tags do not imply Group or Cordis HMR belongs in that 0.1.7 DSH profile: its tested closure used `@deepseek-ai/dsh-hmr@0.1.7-rc.2`. The top-level 0.1.7 host manifest coordinated DSH services exactly at `0.1.7-rc.2` and Cordis `~4.0.4`/Loader `~1.0.5`/Include `~1.0.9`/Timer `~1.1.6`. Individual DSH service tags may point to older versions: assert installed resolutions, not their tags. Historical primary metadata: https://registry.npmjs.org/-/package/@deepseek-ai%2Fdsh/dist-tags ; https://registry.npmjs.org/@deepseek-ai%2Fdsh/0.1.7-rc.2 ; https://registry.npmjs.org/@deepseek-ai%2Fcordis/4.0.4 ; https://registry.npmjs.org/@deepseek-ai%2Fcordis-plugin-loader/1.0.5 . Subsequent latest promotion and proof are recorded below; recheck registry state before publishing.

Later on 2026-09-29, a fresh primary-registry requery observed **both** `@deepseek-ai/dsh` `latest` and `next` resolving to `0.2.0-rc.2` (https://registry.npmjs.org/-/package/@deepseek-ai%2Fdsh/dist-tags). The preceding `latest=0.1.7-rc.2` observation and C24/C25 proof remain accurate *historical snapshots*, not evidence for the newly promoted default. At that handoff the exact `0.2.0-rc.2` host metadata/API, dependency closure, packed lifecycle and strict consumer compatibility had not yet been assessed. This required a C26 refresh before publication; its subsequently observed proof is recorded at the end of §16 and in C26 checklist rows. No C24/C25 history or pinned C19B closure was revised.

At C23 planning, the published plugin `0.1.6` peered only Cordis `4.0.1` and five DSH service families `0.1.0-rc.6 || 0.1.0-rc.8 || 0.1.1-rc.2`; the then-current family was *manifest-excluded and untested*. C24 subsequently reproduced that rejection and proved corrected packed support; published plugin version at the C24 handoff remained `0.1.6` (the prepared local version was `0.1.7`, subsequently published in C27). The retained packed E2E exercises top-level DSH `0.1.0-rc.6` resolving services `0.1.0-rc.8` and top-level DSH `0.1.1-rc.2` resolving services `0.1.1-rc.2`. The exact pinned `tests/fixtures/agent-smoke/runner` Cordis `4.0.1`/Loader `1.0.2`/DSH `0.1.1-rc.2` closure and its lock/hash guards belong to separate C19B; preserve them. Development dependencies and root lock describe the older *development/test* closure, not what a disposable newer-host profile resolves. Do not infer an API rewrite from manifest differences or claim credentialed semantic/model proof from model-free lifecycles. Node `^22.19.0 || >=24` remains the declared runtime engine; a local Node `22.16` is below it and cannot establish support. Use Node 24 for proof. The release-time vacancy recheck was completed before `0.1.7` publication.

### 16.2 Minimal safe cutover and strict chunk order

C24 cutover sequence (completed): capture a **before-fix** current-host disposable packed/profile repro recording the actual peer rejection, never relabel a manifest mismatch as an observed activation failure. Extend coherent Cordis `4.0.4` and exact DSH service `0.1.7-rc.2` peers while retaining legacy families; the strict consumer TS6200 failure additionally required migrating Schemastery from a runtime dependency to host peer `^3.18.1`, retaining the exact `3.18.1` development pin and generating the matching root lock with pnpm `11.7.0`. Keep the C19B agent-runner locks unchanged. The current-host E2E installs exact top-level `@deepseek-ai/dsh@0.1.7-rc.2` with mutually compatible Cordis `4.0.4`/Loader `1.0.5`/Include `1.0.9`/Timer `1.1.6`/DSH HMR `0.1.7-rc.2` resolutions, not legacy Cordis HMR or stale per-service dist-tags. The retained legacy cases use their own Cordis `4.0.1` fixture closure. Verified scope includes packed artifact, default-disabled/no wiki root, explicit opt-in patch and boot, exactly nine stable tools, `/wiki` status/lint/reindex, one prompt, non-creating status, exact immutable source and canonical page bytes with cross-remount persistence, catalogs/read/search/lint, and disable/remove/re-add/remount with stable root bytes and registrations. The focused case and full serialized `pnpm run test:e2e` passed. No runtime/API change was required.

The C24 before-fix replay ran the new current-host E2E case in a disposable Node 24 copy with **both** the starting `f315198` `package.json` **and its matching `pnpm-lock.yaml`** restored, then recorded profile-add rejection against the old peers; restoring only the manifest would have invalidated frozen installation after the Schemastery dependency-to-peer move. Never revert the real checkout or alter its dependency tree. Current-family declaration proof also used a strict disposable consumer compile: root `pnpm run typecheck` uses only the old pinned dev family.

Chunk boundaries are strict: **C23** two-authority planning only (these docs); **C24** current-host before-fix repro and compatibility implementation/evidence (`package.json`, `tests/built-package.e2e.spec.ts` ownership units, root `pnpm-lock.yaml` only if necessary; each independently reviewable unit at most five files); **C25** prominent public compatibility docs and executable install examples (`README.md`, `examples/README.md`, `AGENTS.md` lesson only after C24 proof; no unsupported next/model claims); **C26** synchronized release preparation and full gates (`package.json`, generated `pnpm-lock.yaml` only if needed, `README.md`, `examples/README.md`, existing workflow only if a demonstrated release defect requires it; transfer ownership from C24/C25); **C27** branch-first release, separate immutable annotated tag push, public workflow/npm provenance verification, and durable accounting (`docs/plan/PLAN.md`, `docs/plan/CHECKLIST.md` accounting only). Within each chunk independent ≤5-file ownership units may be assigned separately, but implementation chunks C24→C25→C26→C27 are sequential; do not run release gates against concurrent edits. Review every changed unit for peer-closure correctness, activation/security/lifecycle behavior, docs truth, and release packaging; record findings, fixes, scoped reruns, exact commit/path accounting and review verdict before the next chunk. One commit per independently verifiable unit using Conventional Commits, with later accounting commits recording prior hashes (never self-record a hash). If the current host cannot actually activate after warranted fixes, do not advertise it or release under the new compatibility claim; preserve legacy support and report the concrete blocker. Roll back the *unpublished* candidate manifest/docs/case coherently if necessary; do not rewrite previously published npm versions or push a tag before all gates pass. Once published, correct with a new version rather than moving a released tag.

The newly promoted default remains **inside C26**, not a reopened C24/C25 or a new C27 push. Before release preparation, inspect fresh `0.2.0-rc.2` host metadata and relevant API changes; establish its mutually coherent actual Cordis/Loader/Include/Timer/Group/HMR and five DSH-service resolutions; add exact compatible peers and an independent packed host row without deleting any verified legacy or `0.1.7-rc.2` row. Run a disposable old-manifest/lock before-fix admission repro and corrected after-fix admission, a strict typed consumer against actual `0.2.0-rc.2` closure, and the full default-disabled, explicit opt-in, tool/command/prompt, durable-byte, disable/remove/re-add/remount lifecycle. Correct any actual incompatibility instead of declaring success from dist-tags. Only after observable proof revise public/versioned docs to describe the newly verified default, independently review and fix findings, then run full gates on the final cutover; C27 cannot begin until that sequence is green and committed.

For this C26 refresh the preceding C26-owned-path list expands to `tests/built-package.e2e.spec.ts` for the independent host row and narrowly necessary source/test files only if the observed `0.2.0-rc.2` API or lifecycle demands a real correction. Keep each independently reviewed ownership unit at most five files, with generated lock changes under the existing metadata unit. This new prerequisite supersedes the older C26 metadata/docs-only description without altering completed historical chunk accounting.

### 16.3 Proof and release protocol

Focused before/after host proof: `pnpm exec vitest run --config vitest.e2e.config.ts tests/built-package.e2e.spec.ts -t '0.1.7-rc.2'` (before adding a case, use a disposable throwaway equivalent; record actual exit/diagnostic). Ordinary `pnpm run smoke` proves the pinned root-dev composition only, not latest DSH; the credentialed `pnpm run smoke:agent` remains optional and separate. After C24, use Node 24 and pnpm `11.7.0`: `pnpm install --frozen-lockfile`; `pnpm run typecheck`; `pnpm run lint`; `pnpm test` in a Linux environment with sudo and mount namespace/tmpfs capability (release workflow: `trap 'sudo -n chown -R "$(id -u):$(id -g)" node_modules' EXIT; sudo -n env "PATH=$PATH" "HOME=$HOME" CI=true pnpm test`); `pnpm run test:e2e` (serialized, actual packed host); `pnpm run check:determinism`; `pnpm run smoke`; `npm run prepack` and `npm pack --ignore-scripts --json --pack-destination <temp>`/`pnpm pack --dry-run --json` for manifest/artifact checks. The Linux private read-only tmpfs test must **run**; skip/host-capability failure is not passing. Check package/version/tarball strings and packed manifest, export, patch, license, no sources/secrets/fixtures, and clean disposable roots. Never replace full profile coverage with unit tests or smoke.

For local full gates, avoid altering the user's host dependencies: use a single `node:24-bookworm-slim` container with the checkout mounted **read-only** at `/source`, a writable container-only `/work` copy excluding `.git`, `node_modules`, `.pnpm-store`, `lib`, and `coverage`, and a container-local pnpm store. Give it `--cap-add=SYS_ADMIN --security-opt seccomp=unconfined --security-opt apparmor=unconfined` so the required mount-namespace/private read-only tmpfs test can run; install `mount` inside the container if absent and use corepack pnpm `11.7.0`. Verify exact Node/pnpm versions and mount proof rather than accepting a capability skip. If local root execution makes `sudo -n` unavailable, run `CI=true pnpm test` as container root with mount capability and separately require the workflow's exact sudo invocation on GitHub; do not report the two commands as identical. Isolation also permits baseline-manifest repro without host checkout reverts or `node_modules` churn.

After verified support, place an exact tested host/Cordis/Loader matrix near the start of README Requirements, distinguishing top-level DSH from resolved DSH service family and the frozen legacy/dev runner. Retain the opt-in host-store policy warning and accurate example recipes. Update dated AGENTS lessons *after observed proof*, including stale registry-version observations and the continued C19B boundary. Choose `0.1.7` only after rechecking public npm vacancy; if occupied, select an available version. Synchronize `package.json` version, all README/example `.tgz` strings and generated artifact name, without changing the pinned agent runner. Review a single prepared branch commit history and push **master/branch first** so `.github/workflows/publish.yml` is registered; verify remote branch/workflow. Prior verified same-repository `0.1.6` OIDC publication (GitHub run `36574449750`, registry Trusted Publisher and provenance), together with unchanged current workflow and public package metadata, suffices to attempt a new release even when npm's private Trusted Publisher repository/workflow/empty-environment/direct-publish settings cannot be inspected. Check those settings if accessible, including OIDC `id-token: write` and direct npm publish permission, but block before tagging only on an observed contrary authorization or configuration denial; record the precise blocker. Recheck public npm vacancy and remote tag absence, then create a fresh annotated `v<package.json version>` at the reviewed commit and push that tag **separately**; never force or move an existing tag. The tag workflow verifies exact `v${package.json.version}`, frozen install, typecheck, lint, privileged unit gate, packed E2E, determinism, smoke, then `npm publish --access public` with OIDC. Inspect the new public GitHub Actions run and npm registry exact version/dist-tag, tarball integrity and provenance/Trusted Publisher metadata; prior `0.1.6` success, a local dry-run, or a tag push alone is not proof of this publication. If new CI or publication fails, record its observed outcome and resolve by a new version rather than moving the tag; do not fabricate a release. C19B real-model proof, `GAP-SCHEMA`, and C22 GitHub issue mutation retain their existing independent blocked/unresolved states, not prerequisites or silent closures for this release.

The `0.1.7` candidate and the prior `next 0.2` exclusion in C25 public guidance were bounded by earlier C24 proof and are not operative advice. C26 subsequently proved the newly default `0.2.0-rc.2` host and prepared the `0.1.7` artifact; C27 published and independently probed that artifact as recorded below. Preserve historical C24/C25 records and the separately pinned C19B runner.

Planning review disposition (two independent P2 findings, no release evidence recorded): the release tag now follows the selected `package.json` version instead of fixing the `0.1.7` candidate, and prior verified same-repository OIDC publication plus unchanged workflow/public metadata permit an attempt despite unreadable private npm settings, subject to any observed contrary denial and mandatory verification of the new CI/registry outcome.

C23 planning snapshot (superseded as the operative handoff by C24 below): planning commit `ad1c9fe` (`docs(plan): scope current dsh compatibility release`) changed exactly `docs/plan/PLAN.md` and `docs/plan/CHECKLIST.md`. Both independent corrected-plan re-reviews returned CLEAN; `git diff --check` passed. At that point C24 before-fix disposable repro was next; the supported-engine Node 24.21.0 baseline ordinary smoke had exercised only the pinned development closure, and current-host compatibility/publication were unverified.

C24 type-consumer intermediate finding (resolved): strict current-host compilation initially exposed conflicting Schemastery 3.18.1/3.18.4 global declarations (TS6200). C24 moved Schemastery to host peer `^3.18.1`, preserving exact development version 3.18.1 and the frozen agent runner. Strict packed declaration checks passed for both the legacy 0.1.1-rc.2/4.0.1/1.0.2 and current 0.1.7-rc.2/4.0.4/1.0.5 DSH/Cordis/Loader families with one shared Schema 3.18.4 and physical Context/Schema identity. The before-fix replay restored matching baseline manifest **and lock** in its disposable copy. Initial profile probes stopped before activation on incidental package-manager diagnostic wording; they were not evidence of plugin activation rejection. Temporary fixture projects explicitly declared pnpm 11.7.0, and the brittle diagnostic wording assertion was removed, not re-pinned.

C24 observed runtime proof: the baseline `f315198` package/lock was rejected by DSH 0.1.7-rc.2 during profile add for its five incompatible DSH peer ranges (exit 1, profile rollback, no risk exemption). The same targeted packed lifecycle passed with corrected metadata. Node 24.21.0/pnpm 11.7.0 frozen install, typecheck, lint, 248/248 unit tests including the actual private read-only tmpfs proof, all 10 serialized packed/Loader E2E cases, determinism and ordinary smoke passed under CI flags. No source API or storage-format migration was needed; no real-model run or release is claimed.

C24 is complete in green implementation commit `e248772` (`fix: support current dsh and cordis host family`), changing exactly `package.json`, `pnpm-lock.yaml`, `tests/built-package.e2e.spec.ts`, `docs/plan/PLAN.md`, and `docs/plan/CHECKLIST.md`. Independent peer/lock/backward-compatibility and lifecycle/security/task-accounting reviews both returned CLEAN; review-closure commit `24663e7` changed exactly `docs/plan/PLAN.md` and `docs/plan/CHECKLIST.md`. C25 public version guidance is the active sequential chunk; C25 review/publication, C26 version/full release gates, and C27 release remain unperformed.

C25 documentation is drafted in `README.md`, `examples/README.md` and `AGENTS.md`, with chronology reconciled in both authorities. Focused packed direct-Loader/current-host tests passed 2/2, plus frozen install, build, ordinary smoke and patch-whitespace verification under Node 24.21.0/pnpm 11.7.0. This is composition-level evidence, not a claim to have executed every line of the longer example walkthrough. C25 independent review is pending; version/tag/publication remain unperformed.

C25 is complete in `fdea425` (`docs: explain verified dsh host compatibility`), changing exactly `README.md`, `examples/README.md`, `AGENTS.md` and both planning authorities. Two independent documentation/install and security/accounting reviews returned CLEAN after the recorded focused gates. C26 version synchronization and final release verification are next.

C26 prerequisite update (2026-09-29): registry `@deepseek-ai/dsh` `latest` **and** `next` now point to `0.2.0-rc.2`. C24/C25 prove only their previously observed `0.1.7-rc.2` default plus existing legacy rows; no `0.2.0-rc.2` compatibility, source/metadata edit, full-gate pass, release or tag is implied. Complete the unchecked C26 refresh in `CHECKLIST.md` before version synchronization and C27; no user-approved scope reduction exists.

C26 dependency-review adjudication: the proposed removal of five default-host service-version assertions is discarded. Published `dsh@0.2.0-rc.2` depends on `dsh-base@0.2.0-rc.2`, which supplies commands/session/system-prompt/tools; tools/session supply brand, all at exact 0.2.0-rc.2. The published app-boot package requires Group `~1.0.4` as a non-optional peer; normal host peer installation supplies it. Direct CLI dependency lists alone did not describe the runtime graph. Assert actual installed resolutions, without adding synthetic service/Group packages or claiming an extra bundle row. Evidence: https://registry.npmjs.org/@deepseek-ai%2Fdsh-base/0.2.0-rc.2 and https://registry.npmjs.org/@deepseek-ai%2Fdsh-app-boot/0.2.0-rc.2 . Runtime proof is still pending; use matching `e248772` manifest/lock snapshots for the specific 0.2 admission before/after replay.

C26 refreshed-plan gate passed: both independent re-review lenses returned CLEAN after primary transitive-manifest verification and the recorded finding disposition; patch hygiene passed. Proceed with the exact 0.2 peer/packed/type prerequisite before further release documentation or tag work.

C26 refresh implementation and focused proof (2026-09-29): reviewed refresh-plan commit `149ca94` preceded the new host work. With the matching old `e248772` package manifest and lock restored in a disposable Node 24.21.0/pnpm 11.7.0 case, DSH `0.2.0-rc.2` profile add rejected five old service peer ranges (exit 1, profile rollback, no exemption). The corrected exact five `0.2.0-rc.2` peers passed admission in the same case. The actual new host installed five DSH services `0.2.0-rc.2`, Cordis `4.0.4`, Loader `1.0.5`, Include `1.0.9`, Timer `1.1.6`, DSH HMR `0.2.0-rc.2` and Group `1.0.4` through the normal app-boot peer (no synthetic Group package or bundle row). Focused packed modern/default lifecycles passed 2/2 with disabled-by-default/no root, explicit patch, nine tools, wiki command and prompt, non-creating status, durable source/page bytes, disable/remove/re-add/remount and registration stability. Strict local-tarball `0.1.7` consumers with `skipLibCheck: false` passed against DSH `0.1.1-rc.2`, `0.1.7-rc.2` and `0.2.0-rc.2` closures with one physical Schemastery `3.18.4` and shared Context/Schema identity; profile add accepted the local tarball on all four host rows. No API or storage-code migration was necessary. Root frozen install/typecheck/lint/ordinary smoke passed in this focused proof, but the C26 full 11-case E2E and final release gates, public docs review, commit accounting and C27 publication have not passed or occurred. C19B remains externally blocked and no real model claim follows from this offline evidence.

C26 local release-candidate gates passed on Node 24.21.0/pnpm 11.7.0/npm 11.20.0 under CI flags: frozen install, typecheck, lint, 248 unit tests with the real read-only tmpfs proof, 51 keyless agent-smoke contract tests, 11 serialized E2E cases across four DSH host versions, determinism, ordinary smoke and both npm/pnpm packaging checks. Prepared version is 0.1.7; npm pack contains 38 allowed entries with integrity `sha512-4MB/AO7+NXxAM5rPioLShm+c+XNkk/QH1lL15hsB0TqM9KB4dV4xJAy1sMj8ABUmEZoa+JohcSuFRDhsaqlJzA==`. Independent final split review is pending. Local root-container proof is complete; the separate exact GitHub-hosted sudo command and OIDC publication remain C27 post-tag requirements, not an impossible pre-tag prerequisite or a claimed local success.

C26 is complete: green release candidate `057f494` changed exactly `package.json`, `tests/built-package.e2e.spec.ts`, `README.md`, `examples/README.md`, `AGENTS.md` and both planning authorities; sole final-review status correction `d39c061` changed only `docs/plan/CHECKLIST.md`. All final review lenses are CLEAN after independent re-review. The complete post-review gate rerun passed again (248 unit, 51 keyless agent contract, 11 E2E, compiler/lint, determinism/smoke and npm/pnpm packing), with identical 38-entry tarball integrity. Release tag target is the exact reviewed/tested `d39c061148329e1893041a8b68692605f3f33e39`; subsequent planning-only accounting did not move that target. At the C26 handoff, fresh remote/registry preflight found v0.1.7/version 0.1.7 absent and latest DSH/Cordis still 0.2.0-rc.2/4.0.4. The C27 release subsequently succeeded; see the observed CI, registry and installed-artifact evidence below.

C27 dispatch and publication (2026-09-29): `master` was pushed first and remotely verified at `0a8f19387fc6f862aaabab65920630ef9083f104`; workflow `publish.yml` remained active (ID 370123575). Annotated tag `v0.1.7` was pushed separately, with object `4695d5b49a5439aabb4adcd8c55fe57335ffd076` and exact reviewed target `d39c061148329e1893041a8b68692605f3f33e39`. The [tag-triggered workflow run](https://github.com/EveGoodEvening/dsh-llmwiki/actions/runs/36590994555) (job `109483728324`) succeeded, including exact-tag guard, frozen install, typecheck/lint, hosted `sudo` private-mount unit proof, packed E2E, determinism/smoke and OIDC npm publication. Canonical [exact-version metadata](https://registry.npmjs.org/@evegoodevening/dsh-llmwiki/0.1.7) and [latest metadata](https://registry.npmjs.org/@evegoodevening/dsh-llmwiki/latest) both resolve `0.1.7`; the exact version records `gitHead=d39c061148329e1893041a8b68692605f3f33e39`, `npmUser.name=GitHub Actions`, `trustedPublisher.id=github`, npm 11.20.0/Node 24.21.0, and 38 files. Published SHA-1 `14c5a53b9c33159d561b043f22a688cfd92e459d` and SRI `sha512-4MB/AO7+NXxAM5rPioLShm+c+XNkk/QH1lL15hsB0TqM9KB4dV4xJAy1sMj8ABUmEZoa+JohcSuFRDhsaqlJzA==` match both independently packed local full-gate artifacts. The decoded [public attestation statement](https://registry.npmjs.org/-/npm/v1/attestations/@evegoodevening%2fdsh-llmwiki@0.1.7) matched package PURL/SHA-512, `refs/tags/v0.1.7`, repository, `.github/workflows/publish.yml`, target commit and GitHub-hosted builder/run `36590994555/attempts/1`; this is a decoded-statement comparison, **not** independent cryptographic signature verification. Early encoded/query metadata and `npm view` calls yielded 404/old latest 0.1.6 before the canonical endpoints established publication; no cause is inferred. A disposable install of the actual public-registry artifact passed `skipLibCheck: false` consumer compiles on DSH `0.1.1-rc.2`, `0.1.7-rc.2`, `0.2.0-rc.2` with shared physical Schemastery `3.18.4` and Context/Schema identity; actual DSH profile add accepted the published artifact on all four top-level host rows `0.1.0-rc.6`, `0.1.1-rc.2`, `0.1.7-rc.2`, `0.2.0-rc.2`, retaining default-disabled bundle/explicit opt-in. This post-release probe was not a second full runtime E2E or a model call: the earlier 11-case packed E2E exercised all tools/commands/lifecycle against tarball bytes with the same published SRI. C19B credentialed semantic/model acceptance and C22 authorized GitHub issue closure remain independent, unchecked blockers.

C23–C27 exact commit/path ledger (verified against committed path sets): C23 `ad1c9fe` and approval `6b60624` each changed only `docs/plan/PLAN.md`, `docs/plan/CHECKLIST.md`; C24 `e248772` changed `package.json`, `pnpm-lock.yaml`, `tests/built-package.e2e.spec.ts` and both planning authorities, and closure `24663e7` changed only those two authorities; C25 `fdea425` changed `AGENTS.md`, `README.md`, `examples/README.md` and both planning authorities, and closure `7844463` changed only those two authorities; C26 refresh plan `149ca94` changed only those two authorities, candidate `057f494` changed `AGENTS.md`, `README.md`, `examples/README.md`, `package.json`, `tests/built-package.e2e.spec.ts` and both planning authorities, correction `d39c061` changed only `docs/plan/CHECKLIST.md`, and preparation closure `0a8f193` changed only the two planning authorities; C27 dispatch ledger `fa244f6` changed only the two planning authorities. No source/runtime or workflow mutation followed the reviewed release tag target. The independently reviewed publication-evidence draft and final closure are recorded below; no self-hash is recorded.

C27 final accounting is complete. Publication-evidence draft `36bc2e9` changed exactly `AGENTS.md`, `docs/plan/PLAN.md` and `docs/plan/CHECKLIST.md`; independent evidence/commit-ledger and completeness/task-accounting reviews both returned CLEAN, including the classified 8 C19B and 11 C22 older unchecked tasks. This final two-authority closure does not record its own hash or change tag `v0.1.7`/product bytes. All four requested compatibility/fix/version-guidance/release goals and every C23–C27 checkbox are complete. The older separately blocked credentialed-model and Issues-API lanes remain unchanged; no runnable current-goal task is deferred.


## 17. August and September handoff adjudication and safe breaking release (2026-09-29)

### 17.1 Authority, evidence and resume boundary

This section and C28–C35 extend the existing authorities; they do not replace either historical handoff or re-chunk completed C01–C27. Both `handoff-2026-0830.md` and `handoff-2026-0903.md` are historical observations, not executable current ownership. All six research outputs (`handoff-understand-1` through `-6`) were read. The accounting worker's unconfirmed-TOCTOU disposition is rejected: AGENTS.md and security research record confirmed real-filesystem outside-file disclosure and outside-directory creation on Node 24.21.0. Do not rerun that baseline attack to reconfirm it. New implementation and security proofs remain required.

Parent-observed current baseline: Node 24.21.0/pnpm 11.7.0 frozen installation, build and ordinary smoke, 254/254 unit tests across eight files including actual private read-only tmpfs proof, and 50/50 dedicated offline agent tests passed. No language server is available. This is baseline evidence, not evidence for the fixes below. Planning authors run no gates, formatters, commits or external mutations.

Parent's fresh zero-I/O C19B observations: credentialPresent=false, modelIdentifierSyntaxValid=false, explicitNetworkOptIn=false. No real model run or sanitized latest evidence exists; offline tests cannot close C19B. Parent observed no `gh` executable, GH_TOKEN=false, GITHUB_TOKEN=false, ghStoredAuth=false. Git SSH `git push --dry-run origin master` succeeded (Everything up-to-date), proving branch push access only, not Issues API identity/permission.

Current unauthenticated primary reads supersede historical C22 open-state assertions: [issue #2](https://api.github.com/repos/EveGoodEvening/dsh-llmwiki/issues/2) is closed, reason `completed`, closed_at `2026-09-03T03:46:06Z`; [issue #3](https://api.github.com/repos/EveGoodEvening/dsh-llmwiki/issues/3) is closed, reason `completed`, closed_at `2026-09-03T03:46:08Z`. Both have zero comments and their comments endpoints return `[]`. Preserve the historical ledger verbatim as dated evidence; it is not today's state. Exact approved comments/URLs and supported `not_planned` milestones are not established. Do not mutate/reopen/reclose either issue. Any authorized future resume must reconcile the reason discrepancy explicitly, inventory before acting, and never repeat a confirmed close. C22 remains incomplete, separate from this release.

### 17.2 Exhaustive disposition ledger

| August/September issue or distinct claim | Current disposition and concrete reason | Authority/next work |
|---|---|---|
| GAP-INGEST: investigation, classification, affected pages, links and preserved disagreements | Agent-layer contract implemented by C17; narrow behavioral proof externally blocked. Host-store service does not own model orchestration. | Existing C19B only; no new ingest API. |
| GAP-CATALOG: interrupted ingest discoverability | Resolved by C16 deterministic source/page catalogs, full-record validation and pagination; September acknowledges them. | Preserve catalog recovery semantics. |
| GAP-SCHEMA: schema co-evolution | As-designed human-owned create-only schema. Mutation needs separate authorization, confirmation/audit, validation/cancellation and lost-update contract; page CAS does not authorize schema edits. | No schema mutation tool or silent rewrite. |
| GAP-SEMANTIC-LINT: contradictions, supersession, unsupported claims, links/concepts | Structural lint is model-free; separate C17 agent review exists, controlled behavior still C19B-blocked. | No model/network calls in lint/service. |
| GAP-EVIDENCE: claim-level attribution, quote/range localization and entailment | Source IDs prove record existence, not claim support. Adding claim locators changes durable format and requires an approved attribution workflow; no current claim-grounding guarantee is violated. | Preserve honest source-linked positioning. |
| GAP-MODEL-E2E: controlled scenario proof | C19A harness implemented, C19B blocked by fresh false credential/model/network prerequisites. | Do not infer model behavior from offline/release tests. |
| Broad/open-domain evaluation, general semantic quality and long-term consistency | Separately evaluated product/research gap, not the controlled C19B contract. No broad competence claim, agreed corpus, oracle or acceptance target exists. | Not approved implementation scope; no broad-eval scaffold. |
| CLAIM-COMPLETE/full Karpathy product | Resolved positioning: model-free storage/retrieval/structural-integrity substrate, not full autonomous wiki. | Preserve C17 public boundary. |
| DEF-INDEX-TRUST/forged derived sections and term frequencies | Resolved C14 exact canonical page-derived index/state verification shared by search/status/lint. | Retain anti-forgery tests and trust predicate. |
| DEF-UPSERT-POSTCOMMIT/commit then reported failure | Resolved C15: page receipt remains truthful after rename; no index unlink and no postcommit abort failure. | Preserve during anchored atomic cutover/CAS. |
| DEF-CANONICAL-LINT | Resolved C16 byte-canonical rerender comparison, non-mutating diagnostics. | Preserve canonical-only citation eligibility. |
| DEF-UTF8-PROGRESS | Resolved C15 stable limit error when no whole code point fits a non-EOF source slice. | Preserve bounded progress behavior. |
| DEF-EMPTY-SOURCE/blank provenance origin | Resolved C15 validation before initialization plus persisted metadata validation; whitespace content remains permitted. | No reopening. |
| DEF-STALE-TARBALL (August 0.1.0; September 0.1.1 versus then 0.1.3) | Historical defects resolved C18/C26/C27; current 0.1.7 artifact references match release. | Synchronize fresh candidate only in C34. |
| Query/answer/write-back workflow | Independently assessed: retrieval primitives and controlled read-only fresh-session answer exist; general answer guidance and persisting valuable query analysis are not accepted autonomous-maintenance guarantees. Writes require explicit maintenance authorization; adding query writes changes agent policy, not substrate correctness. | No autonomous write-back or query transaction; separate product decision required. |
| Same-activation stale page writes | Required correctness fix: FIFO mutations do not protect prior read/think/write cycles. | C30 required CAS; migrate every caller, no blind-write shim. |
| Multi-page transaction/intent journal | As-designed per-page atomicity, not all-pages atomicity or replay. Durable intent requires approved identity, authorization, partial commit/replay/idempotency, cancellation, retention and CAS interaction; host store cannot infer intended page sets. | Agent catalogs/rescan/reconciliation remain available; no log/journal/batch API. |
| Read-only tool label versus initialization | Required wording fix, not runtime policy redesign. C21 intentionally permits source/page reads to initialize root/directories/default schema, outside DSH approval. | C32 truthful descriptions; preserve C21 semantics. |
| Full-corpus index reconstruction | As-designed integrity cost: editable cache pair has no independent trust root, so hashes/mtime/mutual consistency alone permit forgery. O(total page content) is accepted absent benchmark and target. | No unsafe cache shortcut; future measured optimization must retain exact page-derived trust and snapshot/layout invariants. |
| Query-missing late-match snippets | Required bounded quality fix; prefix extraction currently ignores body match position. | C32 deterministic query-aware snippets, unchanged ranking/API. |
| Filesystem containment TOCTOU | Confirmed security defect, not unconfirmed inference or justified by shared-writer warning. Existing checks and leaf O_NOFOLLOW do not anchor ancestors; disclosure and outside mkdir were observed. | C29 complete descriptor-anchored cutover including paths/atomic/service/indexer/lint. |
| Partial source publication/process-death retry | Required narrow recovery: content-only final source currently fails same-byte retry. Valid immutable metadata/provenance must never be rewritten. | C31 repair only provable pre-metadata writer states. |
| Workspace identity / DSH filesystem approval exclusions (#2/#3) | C20/C21 host-root product boundary remains intentional; containment repair does not adopt ctx.fs, approval or workspace isolation. Public issue closure is separate and historical milestones remain unproved. | C22 external lane only, no issue mutation here. |
| Release/OIDC substrate | Existing tag guard and Trusted Publisher workflow found sound; previous 0.1.7 publication does not prove new fixes. Required CAS is public breaking change before 1.0. | Candidate **0.2.0**: release research observed exact npm version HTTP404 and `git ls-remote` exact tag absence (exit2); GitHub tag REST403 is not vacancy evidence. Recheck immediately before tagging; never silently 0.1.8; C34 bumps only after fix gates. |

### 17.3 Frozen implementation contracts

**Containment:** Centralize actual filesystem I/O in descriptor-anchored capabilities, not check-then-use pathnames. Anchor from `/`, walk every configured-root component one child at a time while holding its parent directory descriptor, and open directories with O_DIRECTORY|O_NOFOLLOW. Reject symlinks and nonregular files before reading via their opened descriptors; compare read snapshots for content changes. Enumerate through anchored directory descriptors. Creation, exclusive temp open, write/fsync, same-parent rename, cleanup unlink, and directory sync must use held descriptor-relative aliases throughout. Source cleanup must be bounded anchored traversal, never pathname recursive rm. Initialization, schema/status, all source/page/catalog/count operations, cached index reuse/publication, index corpus traversal and lint all migrate in one cutover; no leaf-only exception or pathname fallback. Preserve authorized lexical aliases only through safe component resolution without accepting symlink traversal. Use one root pin per complete queued operation, closing only when work actually completes; after first successful initialization retain root dev/ino and refuse replacement on later operations. Keep display paths separate from authority, bounded live handles, static symlink lint diagnostics without following them, and all catalog/corpus membership revalidation. Linux `/proc/self/fd` is the capability-detected executable backend to prove on real Node 24 (usable procfs and required flags/operations, not OS string alone); other systems fail closed UNSAFE_FILESYSTEM until an independently reviewed relative-I/O backend and real platform smoke establish support. No unsupported `/dev/fd` portability claim. This is an explicit operator compatibility boundary, not an unresolved prerequisite. Pinned objects can remain authorized if renamed outside the lexical root: do not promise present-time lexical containment against movement of already-pinned directories, hardlink injection, hostile mounts/procfs replacement or privileged actors. The guarantee is no symlink-substitution redirection into outside targets; host ownership/OS controls remain essential. The reviewed design artifact is `local://handoff-containment-contract.md`; its small internal Directory capability interface is shared by consumers, never exposed as a speculative public API. Disposable backend proof recipe is `node /tmp/handoff-fd-capability.mjs`, with real Node/kernel/filesystem, nofollow traversal, anchored read/mkdir/temp/rename/unlink/enumeration, unchanged outside tree and handle closure observed by parent before implementation approval. Retain direct host I/O and C21 read initialization.

**Page CAS:** `UpsertPageInput.expectedSha256: string | null` is required, declared as a required nullable parameter in the existing open-top-level `defineTool` parameter schema; unknown keys remain behaviorally irrelevant under §3.6. Null is create-only and conflicts if present. A canonical lowercase 64-hex hash is update-only and conflicts if absent or if exact current page bytes hash differently. Missing/invalid preconditions fail validation, never blind-write. Add `PageRead.sha256` for exact returned bytes and stable `PAGE_CONFLICT`. Compare using anchored read inside the activation queue immediately before atomic commit; preserve winner bytes and postcommit truthfulness. This protects supported same-activation stale work, not unsupported cross-process/activation writers. Read/list hashes drive updates, null drives creates, receipts carry resulting hashes. No compatibility alias/default. Inventory direct service, tool payload, script and test callers, including fixtures and updated agent invocation instructions; migrate every one before integration.

**Source retry:** Complete valid records dedupe with byte-identical first committed metadata/provenance. Only a final source directory with no committed `metadata.json` is recoverable, and only when empty or containing hash-matching durable content and/or recognized writer atomic-temp children. Share actual temp recognition; reject unknown children, symlinks, mismatched bytes or any invalid/unexpected committed metadata fail-closed without mutation. Metadata commits last; recovered record uses retry provenance because none committed previously. Revalidate complete record after recovery. Reads/catalogs/lint never repair or recognize partial records as valid.

**Snippets/read tools:** Body-scoring exact normalized query tokens that fully fit the cap must appear as a complete token in deterministic contiguous Unicode-safe context, using stable earliest occurrence/tie selection. Total UTF-8 bytes including markers stay within maxSnippetBytes. Title/heading-only matches or no fitting body token use deterministic bounded body prefix. Ranking, hit order, counts and API shape do not change. Source/page tool descriptions disclose first-use host layout/default-schema initialization outside DSH approval; do not switch reads to acquire-only/NOT_INITIALIZED.

### 17.4 Sequential chunks and explicit ownership

Each chunk finishes integration, scoped behavioral proof, independent review/security review as relevant, all finding dispositions, and a Conventional Commit before the next begins. Parent is integration/accounting owner, not implementation reviewer. Parallelism only inside the current chunk on genuinely disjoint units; each unit below has at most five explicit paths. Shared contracts above precede consumers. Transfer source/test ownership between chunks explicitly; no simultaneous shared edits. The planning-only accounting unit is always `docs/plan/PLAN.md`, `docs/plan/CHECKLIST.md` (two paths), separate from implementation units. Record only observed evidence and already-created prior commit/path sets; never fabricate/self-record a commit hash.

| Chunk | Units, dependency and acceptance |
|---|---|
| C28 planning adjudication | Two planning paths only; this ledger, exact inherited-task accounting and independent dual-authority/design re-review. No implementation or release mutation. |
| C29 full containment cutover | A foundation: `src/paths.ts`, `src/atomic.ts`, `tests/ids-paths.spec.ts`, `tests/markdown.spec.ts`, `README.md`. Freeze capability interface first. B dependent service: `src/service.ts`, `tests/service.spec.ts`, `tests/service-postcommit.spec.ts`. C dependent corpus/diagnostics: `src/indexer.ts`, `src/lint.ts`, `tests/indexer.spec.ts`, `tests/lint.spec.ts`. B/C may run disjointly only after A contract lands within this chunk. Integrate all consumers before committing. Real-FS deterministic syscall-boundary injection proves schema/page/source/index reads cannot disclose outside markers and parent swaps during root/init/nested mkdir/temp/rename/cleanup cannot mutate outside sentinel/tree; preserve all prior symlink/snapshot/read-only/atomic abort/postcommit behavior. Scoped descriptor-anchored smoke/regressions plus dedicated security review mandatory. |
| C30 required page CAS breaking cutover | A core/tool/prompt: `src/types.ts`, `src/errors.ts`, `src/service.ts`, `src/tools.ts`, `src/prompt.ts`. B dependent behavioral callers: `tests/service.spec.ts`, `tests/service-postcommit.spec.ts`, `tests/plugin.spec.ts`, `tests/loader.e2e.spec.ts`, `tests/built-package.e2e.spec.ts`. C dependent runnable/public callers: `scripts/check-determinism.ts`, `scripts/smoke.ts`, `README.md`. B/C consume frozen A schema; inventory every upsert occurrence including embedded tool payloads/fixtures, migrate in their existing path owner, split any newly found paths into explicit ≤5-path units before edits rather than omit them. Disposable-root smoke: create H0, capture twice, A updates H0, B conflicts and A bytes/hash remain; null-present, hash-absent, invalid/missing precondition and read/list/receipt hash consistency. Tool required-nullable schema and packed service path must work. Independent API/backward-break and security review. |
| C31 narrow source crash recovery | Unit: `src/service.ts`, `src/atomic.ts`, `tests/service.spec.ts`. Anchored primitives from C29 and unchanged CAS from C30 required. Smoke/regressions for empty/content-only/recognized-temp crash states, matching retry completes one read/catalog-valid record; complete record preserves metadata bytes; malformed metadata, mismatched/unknown/symlink states remain unmodified. Dedicated provenance/containment review. |
| C32 retrieval quality and initialization disclosure | A snippets: `src/indexer.ts`, `tests/indexer.spec.ts`, `README.md`. B disjoint descriptions: `src/tools.ts`, `tests/plugin.spec.ts`. Prove late body term visible, UTF-8 cap and whole tokens, deterministic context/ties, title/heading-only and too-large-token fallback without ranking change. Actual missing-page/source reads retain initialization while tools disclose it. No sentence-pinning tests. Independent retrieval/API and policy review. |
| C33 test-contract cleanup and integrated fix closure | Unit: `tests/plugin.spec.ts`, `tests/service.spec.ts`, `tests/built-package.e2e.spec.ts`, `tests/agent-smoke.spec.ts`. Delete full prompt/default-schema snapshots, phrase/includes pins and smoke-source YAML string test; retain meaningful schema/registration, durable custom schema, actual tool/runtime/profile behavior and offline trace oracles. Do not repin prose. Independent split storage/security and API/retrieval/product-accounting reviews across C29–C33, fix every finding in explicit ≤5-path units, rerun affected behavioral proof and integrate. All fix gates must close before version bump. |
| C34 breaking candidate and final release gates | Metadata/public artifacts unit: `package.json`, `examples/README.md`, `README.md`, `pnpm-lock.yaml` only if package-manager generated metadata requires it. Fresh npm/tag vacancy selects 0.2.0 if vacant; if occupied choose next vacant pre-1.0 minor, not patch. Document required CAS migration, Linux backend/operator boundary and synchronized tarball/install references; no agent-runner lock changes. Existing workflow unchanged unless demonstrated defect. Full gates below; final independent security/storage/API and docs/package/release reviews, finding closure then full post-review rerun before commit/branch/tag transfer. |
| C35 branch-first immutable tag/OIDC/registry closure | Accounting unit two planning paths only. Reviewed versioned commit and all C34 evidence required. Recheck exact version/tag vacancy and permission; push branch first, verify remote reviewed commit and active publish.yml; create/push annotated v<manifest version> separately at exact reviewed target, never force/move/re-push. Observe exact hosted run/guard/full sudo mount gates/publish success; verify exact npm/latest version, gitHead, tarball inventory/hash/integrity and Trusted Publisher provenance/attestation; install the actual registry artifact in a disposable strict consumer/current-host profile and exercise activation, required CAS and durable readback. Local packed E2E is not published-registry proof. Independently review release/accounting and record prior commit/path ledger and exact tag object/target/run/artifact URLs. No GitHub Release existence claim without creation; no local npm publish. |

**Behavioral and full gates:** Scoped real-runtime proofs above precede each chunk transfer; no mocks/source-text assertions substitute for outside-tree, winner-byte, provenance or snippet observations. Parent runs full integration once units land, not while siblings edit. C34 uses the existing isolated read-only `/source`, writable `/work` Node24 container with pnpm11.7.0/npm11.20.0, SYS_ADMIN/private mount capability and actual no-skip read-only tmpfs proof: frozen install, `pnpm peers check`, `pnpm ignored-builds`, typecheck, lint, `CI=true pnpm test`, separate offline agent contract tests, serialized `CI=true GITHUB_ACTIONS=true pnpm run test:e2e`, determinism, ordinary smoke, npm prepack/pack and pnpm pack dry-run. Audit actual package contents/declarations and retained current/legacy host lifecycle/strict consumers. C19B real-model smoke remains separately blocked, never fetch/run a model from keyless gates. Hosted exact sudo command and OIDC outcome are post-tag C35 observations, not fabricated local proof.

**Rollback/operator notes:** Back up host root with writers stopped before upgrading. No source/page durable format migration is planned; CAS changes callers and Linux anchoring changes OS admission. Operators on unproved platforms must not opt in; fail closed rather than degrade containment. Keep root ownership/OS controls and unsupported shared-writer warning. Before tagging, rollback is an ordinary reviewed revert of unreleased chunks with callers reverted together; do not restore unsafe containment as a security workaround. After publication never move/delete the tag or overwrite npm version: stop deployment, pin known artifact with documented security caveat, then issue a reviewed new minor/patch appropriate to its contract. On hosted/publish failure inventory branch/tag/run/registry first, distinguish no publication from publication-before-failure, and never replay an immutable tag or blindly republish an occupied version. Repair release via a fresh reviewed version/tag when needed. C19B/C22 external blockers do not authorize model/network/issue mutation and do not gate this separately requested substrate release.

**Next exact handoff:** independent planning review owns only `docs/plan/PLAN.md` and `docs/plan/CHECKLIST.md` for corrections; after C28 review/accounting commit, C29 foundation implementer owns exactly `src/paths.ts`, `src/atomic.ts`, `tests/ids-paths.spec.ts`, `tests/markdown.spec.ts`, `README.md`. Supply frozen anchored capability contract to service and corpus consumers before their disjoint C29 work; complete C29 runtime/security review and commit before C30. No future gate is marked complete by this planning draft.
 Parent executed the disposable backend smoke in privileged isolated Linux Node24.21.0: PASS, kernel6.8.0-63-generic, filesystemType2035054128; one-component root acquisition, nofollow directory/file opens, pinned-parent read/mkdir, exclusive temp/fsync/rename/unlink, alias enumeration, leaf/root rejection, unchanged outside tree/sentinel, preserved exclusive collision and all tracked handles closed. This proves backend feasibility only, not product containment fix.

C28 closure: reviewed planning commit `780342e` (`docs(plan): adjudicate handoff defects and breaking release`) changed exactly `docs/plan/PLAN.md` and `docs/plan/CHECKLIST.md`. The sole P2 finding corrected the unsupported closed-input claim to the existing open-top-level `defineTool` parameter contract without weakening mandatory CAS or closed output schemas. Both independent corrected-plan re-reviews returned CLEAN; `git diff --check` passed. C29 foundation ownership now follows this accounting commit; no implementation or release acceptance is inferred.
