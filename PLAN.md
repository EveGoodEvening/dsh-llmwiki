# dsh-llmwiki implementation plan

## 1. Mission and scope

Build `dsh-llmwiki` as a **host-only, local-first, static DeepSeek Harness (dsh) Cordis plugin**. The plugin gives the model an evidence-backed Markdown wiki, deterministic local retrieval and linting, immutable raw-source capture, and a small human command surface. It ships as one public npm package that is also a dsh profile bundle.

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

The compatibility baseline is now fixed rather than inferred: `packageManager` is `pnpm@11.7.0`; `engines.node` is `^22.19.0 || >=24`; peer dependencies are exact versions `@deepseek-ai/cordis@4.0.1` and `@deepseek-ai/dsh-commands`, `@deepseek-ai/dsh-session`, `@deepseek-ai/dsh-system-prompt`, and `@deepseek-ai/dsh-tools` at `0.1.0-rc.6`, mirrored exactly in development dependencies; runtime `@deepseek-ai/schemastery` is exactly `3.18.1`; and development tooling is TypeScript `6.0.3`, ESLint `9.39.2`, `@typescript-eslint/parser` `8.67.0`, `@typescript-eslint/eslint-plugin` `8.67.0`, tsdown `0.22.2`, tsx `4.22.4`, Vitest/`@vitest/coverage-v8` `4.1.8`, and `@types/node` `22.20.0`. The exact `0.1.0-rc.5` dsh packages inspected locally are not published. Primary npm registry version records for [`dsh-commands`](https://registry.npmjs.org/@deepseek-ai%2fdsh-commands), [`dsh-session`](https://registry.npmjs.org/@deepseek-ai%2fdsh-session), [`dsh-system-prompt`](https://registry.npmjs.org/@deepseek-ai%2fdsh-system-prompt), and [`dsh-tools`](https://registry.npmjs.org/@deepseek-ai%2fdsh-tools) prove `0.1.0-rc.6` is installable; published rc.6 declaration/runtime files are byte-identical to the locally inspected rc.5 API files, so exact rc.6 pins preserve the planned contracts while avoiding the older rc.1 `latest` dist-tag. Primary registry manifests also show that [`@typescript-eslint/parser@8.56.0`](https://registry.npmjs.org/@typescript-eslint%2fparser/8.56.0) declares TypeScript `>=4.8.4 <6.0.0` and therefore excludes TypeScript `6.0.3`, whereas [`@typescript-eslint/parser@8.67.0`](https://registry.npmjs.org/@typescript-eslint%2fparser/8.67.0) declares TypeScript `>=4.8.4 <6.1.0` and ESLint `^8.57.0 || ^9.0.0 || ^10.0.0`; [`@typescript-eslint/eslint-plugin@8.67.0`](https://registry.npmjs.org/@typescript-eslint%2feslint-plugin/8.67.0) declares the same TypeScript/ESLint ranges and parser `^8.67.0`. Thus the exact stable parser/plugin `8.67.0` pins include TypeScript `6.0.3` and ESLint `9.39.2`; `8.56.0` is prohibited.

Chunk staging must reflect files that actually exist. C01 defines only script commands whose targets exist in the repository shell/current configuration, but it does not execute TypeScript compilation: with no `src/**/*.ts` input yet, `tsc --showConfig` exits with TS18003 before producing usable configuration output. C01 therefore validates the raw `tsconfig.json` compiler options with a Node assertion; C02, after creating the first source files, is the first chunk to execute `pnpm run typecheck` (and any real `tsc --showConfig` inspection if needed). C11 creates `scripts/check-determinism.ts` and `scripts/smoke.ts` and then adds the corresponding `check:determinism` and `smoke` package scripts under its sequential package-manifest ownership. Likewise, C01 must not publish or declare `cordis.patch.yml`: C09 creates that file and adds its `dsh.bundle.patch`, `exports`, and `files` entries.

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
- immutable source ingestion and reading;
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
- Symlinks are rejected anywhere below the wiki root for source/page/index operations. Root creation and traversal use `lstat`/`realpath` checks to prevent configured-root escape.

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

Register exactly these tools through `ctx.tools.register(defineTool(...))`:

| Tool | Mutation | Contract |
|---|---:|---|
| `llmwiki_status` | no | Return initialization state, counts, schema text, and index freshness. This is the discovery entry point. |
| `llmwiki_add_source` | yes | Accept `name`, exact UTF-8 `content`, optional `mediaType` and `origin`; preserve bytes, return source ID and dedupe state. Content input avoids granting arbitrary host-file reads. |
| `llmwiki_read_source` | no | Accept exact source ID plus optional byte-bounded offset/limit; return byte range and metadata. |
| `llmwiki_search` | derived-index rebuild only | Accept query and optional limit; return ranked section evidence with page, heading, line, score, snippet, and source IDs. |
| `llmwiki_read_page` | no | Accept normalized page ID; return exact Markdown plus parsed metadata. |
| `llmwiki_upsert_page` | yes | Accept page ID, title, summary, source IDs, and body; validate known evidence and atomically write canonical Markdown. Return created/updated plus content hash. |
| `llmwiki_lint` | no | Return deterministic diagnostics and summary counts. |

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

The prompt says, concisely:

- call `llmwiki_status` before relying on the wiki;
- search first, then read relevant pages/sources;
- treat pages as synthesized notes and source records as evidence;
- cite source IDs in every page write and never invent IDs;
- use `llmwiki_upsert_page` only when new evidence changes durable knowledge;
- do not claim lint repairs; lint is read-only.

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
reindex(signal?: AbortSignal): Promise<IndexStatus>
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
├── .npmignore
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

## 6. Component design and ownership

| Component | Paths | Responsibility | Depends on |
|---|---|---|---|
| Repository/package shell | `package.json`, `pnpm-lock.yaml`, `pnpm-workspace.yaml`, configs (including `eslint.config.js`), `.gitignore`, license | ESM public package, fail-closed dependency build policy, build/test/lint scripts, published files, exact dsh peers | none |
| Domain primitives | `types.ts`, `errors.ts`, `ids.ts`, `paths.ts` | branded IDs, stable DTOs/errors, root containment | Node stdlib |
| Persistence codecs | `atomic.ts`, `markdown.ts` | atomic writes; strict canonical page/frontmatter parse/render | primitives |
| Retrieval | `tokenizer.ts`, `indexer.ts` | deterministic section records, fingerprints, BM25 search/index | codecs/primitives |
| Lint | `lint.ts` | stable read-only diagnostics across source/page/index trees | retrieval/codecs |
| Service | `service.ts`, `config.ts` | lifecycle-facing orchestration, mutation queue, limits, all public methods | all core modules, Cordis, Schemastery |
| dsh adapters | `prompt.ts`, `presentation.ts`, `tools.ts`, `command.ts`, `index.ts` | exact prompt/tool/command registration and `ctx.llmwiki` publication | service + dsh APIs |
| Bundle | `cordis.patch.yml` + manifest fields | profile installation/composition | published package |
| Tests | `tests/**` | observable contracts, cleanup, Loader/built artifact | shipping entry path |
| Example/docs | `examples/**`, `README.md`, scripts | install/use/migrate/operate and runnable proof | built package |

## 7. End-to-end data flows

### 7.1 Source ingest and page update

1. Model calls `llmwiki_status`; service initializes missing root/schema/directories but never overwrites existing user files.
2. Model obtains source text through the conversation or another separately authorized tool.
3. `llmwiki_add_source` validates UTF-8 byte cap, hashes exact bytes, and atomically creates immutable source files or returns dedupe.
4. Model reads captured evidence by source ID as needed.
5. Model calls `llmwiki_upsert_page` with known source IDs.
6. Service validates page ID, source existence, size/frontmatter fields, and body; renders canonical Markdown; atomically renames; invalidates index state.
7. A subsequent search compares hashes, rebuilds derived index if stale, and returns ranked section evidence.

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
- Explicitly assert no default export and test dsh export unwrapping.
- Built package smoke and determinism scripts import the public named exports from `lib/index.js` under plain Node semantics after `pnpm run build`; neither script imports `src/index.ts` or a private module. The smoke also resolves bundled `cordis.patch.yml` from package exports.
- `npm pack --dry-run` contains only documented runtime/types/patch/readme/license artifacts and excludes source fixtures, plans, tests, and local wiki data.
- Runnable smoke creates a temporary wiki, ingests evidence, writes a page, searches it, lints cleanly, disposes Cordis, and externally re-reads byte-identical source/page files.
- Determinism script builds the same corpus in two fresh roots and byte-compares canonical index/search/lint output.

`pnpm run lint` is ESLint `9.39.2` flat-config linting via `eslint.config.js`, using exact `@typescript-eslint/parser` `8.67.0` and `@typescript-eslint/eslint-plugin` `8.67.0`; it owns and lint-checks `src/**/*.ts`, `tests/**/*.ts`, `scripts/**/*.ts`, and `*.{ts,js}` while ignoring `lib/`, `coverage/`, `node_modules/`, example wiki data, and generated temporary roots. Typed linting uses the dedicated C01-owned `tsconfig.eslint.json`, which extends the production compiler options, sets `noEmit`, and explicitly includes future `src/**/*.ts`, `tests/**/*.ts`, `scripts/**/*.ts`, and root TypeScript configuration files so those paths receive type-aware rules as they are created without broadening the production build. The parser/plugin `8.67.0` peer ranges include exact TypeScript `6.0.3` and ESLint `9.39.2`; incompatible `8.56.0` is prohibited. `pnpm run test` uses `vitest.config.ts`, which excludes `tests/**/*.e2e.spec.ts`; `pnpm run test:e2e` uses dedicated `vitest.e2e.config.ts`, whose `include` is exactly `tests/**/*.e2e.spec.ts`, so each suite is selected by executable Vitest configuration rather than an unexpanded shell glob.

### 8.3 Planned commands

Use the package manager selected in `packageManager` and locked in `pnpm-lock.yaml`:

```sh
pnpm install --frozen-lockfile
pnpm ignored-builds
pnpm run typecheck
pnpm run lint
pnpm run test
pnpm run test:coverage
pnpm run build
pnpm run test:e2e
pnpm run check:determinism
pnpm run smoke
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

Parallel agents must not edit shared files outside their owned path list. Sequential integration ownership transfers are authoritative in `CHECKLIST.md`: C06→C10 for `tests/harness.ts`, C07→C08→C10 for `tests/plugin.spec.ts`, C01→C09→C11→C12 for `package.json`, and C01→C12 for `pnpm-lock.yaml`, `pnpm-workspace.yaml`, package/build/lint/test configs, `.gitignore`, and `LICENSE`. C09 adds bundle patch manifest fields only after creating `cordis.patch.yml`; C11 adds only the determinism/smoke script entries after creating their targets. `src/index.ts`, `src/types.ts`, `src/service.ts`, and `README.md` otherwise remain integration-owner files. Any needed cross-chunk contract change is proposed to the current owner rather than duplicated. Golden fixture rewrites are owned by the listed fixture/test chunk and must be reviewed as contract changes.

## 10. Risks, mitigations, and rollback

| Risk | Mitigation | Rollback |
|---|---|---|
| dsh prerelease API drift or unavailable local version | Pin the installable exact rc.6 peers/dev dependencies whose published declarations/runtime are byte-identical to the inspected local rc.5 APIs; Loader and packed-artifact smokes exercise named exports and registries. | Revert compatibility commit or pin the last verified installable exact versions; persisted wiki format remains independent. |
| Path traversal/symlink escape | Centralize all path resolution; reject symlinks; adversarial tests. | Disable plugin row/remove bundle while preserving `.llmwiki`; repair affected release before remount. |
| Partial writes/process crash | Exclusive temp + sync + rename; lint abandoned temps; immutable raw content. | Delete abandoned temps and `.index`; rebuild. Never rewrite source content as recovery. |
| Index nondeterminism/corruption | Canonical sorting/JSON, content hashes, fixed scoring constants, byte-comparison script. | Delete `.index`; next operation rebuilds. |
| Model writes unsupported claims | Require existing source IDs, prompt search/read-before-write, lint missing evidence. | Revert/delete page manually; source records remain intact. No automated destructive fix. |
| Tool context bloat | Seven narrow schemas, bounded snippets/results, concise prompt. | Profile can disable the one plugin row; no persisted-data migration required. |
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
12. `chore: finalize package and release gates`

If review fixes are non-trivial, amend the owning unshared commit or add `fix(<scope>): ...` immediately after it. Do not hide behavior changes in cleanup/docs commits.

## 12. Final split review

Perform two independent reviews after all gates pass:

### Review A — domain, safety, determinism

Review `src/{types,errors,ids,paths,atomic,markdown,tokenizer,indexer,lint,service}.ts`, fixtures, and unit tests. Reproduce traversal/symlink/cancellation/corruption cases; byte-compare deterministic outputs; verify lint is non-mutating and sources immutable.

### Review B — dsh integration, packaging, experience

Review `src/{config,prompt,presentation,tools,command,index}.ts`, manifest/config/build files, `cordis.patch.yml`, Loader/built smokes, README, and example. Verify exact dsh APIs, named exports/inject, fiber cleanup, prompt/tool output contracts, package contents, profile rollback, and no accidental UI/server/vector scope.

After fixes, rerun the smallest affected test first, then every gate in §8.3. The release tracker closes only when both reviews have no unresolved findings, the packed-tarball clean-profile smoke passes, documentation matches actual defaults/tool names, and the working tree contains no generated wiki/index/build artifacts.

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
- Deferred a clean-build `prepack` lifecycle to C12, after sources and the complete package surface exist; its absence does not make the source-less C01 shell incomplete.

Discarded:

- `git init` was not added: the worktree already contains `.git` and is on an unborn branch. Reinitializing is redundant and risks altering user-owned repository metadata; C01 starts with tracked package files and the first commit instead.
- The prior requirement to prohibit `pnpm-workspace.yaml` and use `pnpm.onlyBuiltDependencies` was discarded as factually incorrect for pnpm `11.7.0`: project build policy must be committed in `pnpm-workspace.yaml`, while package-level `pnpm` settings are ignored.
- The Node `>=24` engine complaint was discarded: `engines.node` declares plugin runtime/production compatibility with the exact dsh host range `^22.19.0 || >=24`; a dev-only Babel parser dependency's narrower engine metadata does not constrain plugin consumers.
- The claim that frozen installation still fails was discarded as stale: after the workspace build-policy correction, an observed dependency-clean pnpm `11.7.0` install exited zero. Frozen-lockfile installation remains a later reproducibility gate.
