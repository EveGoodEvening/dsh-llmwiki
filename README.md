# dsh-llmwiki

Local-first, evidence-backed Markdown memory for DeepSeek Harness (dsh). / 面向 DeepSeek Harness 的本地优先、证据驱动 Markdown 记忆插件。

## Idea versus implementation / 理念与实现

Andrej Karpathy's `llm-wiki.md` is an **idea file, not an application specification**. Its useful principles are to preserve raw sources, let an LLM maintain an inspectable Markdown wiki derived from them, search before reading broadly, and keep knowledge navigable. This repository independently chooses the concrete storage and runtime contract: immutable content-addressed UTF-8 sources, canonical Markdown pages, deterministic section-level lexical search, atomic local files, seven bounded model tools, and one local maintenance command. It does not claim that Karpathy specified this file layout, API, tokenizer, BM25 implementation, dsh integration, security model, or recovery procedure.

Karpathy 的文件给出理念而非标准实现。本项目独立选择内容寻址来源、规范 Markdown 页面、确定性检索、dsh 工具与本地恢复流程；这些工程选择不是对原始理念文件的逐项复刻。

## Compatibility, installation, and profiles / 兼容、安装与配置档

Required versions are Node `^22.19.0 || >=24`, pnpm `11.7.0`, Cordis `4.0.1`, Schemastery `3.18.1`, and exact dsh peers `0.1.0-rc.6` (`dsh-brand`, `dsh-commands`, `dsh-session`, `dsh-system-prompt`, and `dsh-tools`). The exact rc.6 pins avoid npm's older rc.1 `latest`; rc.5 matched the inspected API but is unpublished.

From the directory that owns a dsh profile/package installation:

```sh
cd /path/to/your/dsh-profile
pnpm add dsh-llmwiki@0.1.0
```

The npm package declares `dsh.bundle.patch: ./cordis.patch.yml`; the supported profile bundle flow reads that patch and inserts the `llmwiki` row. For direct Cordis Loader composition, load `@deepseek-ai/dsh-tools` with `mode: native`, `@deepseek-ai/dsh-commands`, and `@deepseek-ai/dsh-system-prompt`, then load `dsh-llmwiki` with `inject: [tools, commands, systemPrompt]`. The complete direct composition is [`examples/cordis.yml`](examples/cordis.yml).

A profile patch override replaces the row's **entire `config` object**; it does not deep-merge. Copy every row below and change only the intended values. To disable or roll back, remove/disable the `llmwiki` row or bundle and restart the profile. The wiki root is not deleted; reinstalling a compatible version reuses durable sources/pages, and `.index` may be rebuilt.

## Configuration / 配置

| key | exact default | accepted values and runtime meaning |
|---|---:|---|
| `root` | `.llmwiki` | Non-empty path, resolved once to an absolute path from the process working directory when the service is constructed |
| `maxSourceBytes` | `2097152` | Positive integer; maximum exact UTF-8 bytes accepted for source content and maximum per-call source-read byte limit |
| `maxPageBytes` | `524288` | Positive integer; maximum UTF-8 bytes of the fully rendered canonical page |
| `maxResults` | `20` | Integer `1..100`; deployment result cap; a larger valid per-call search `limit` is silently tightened to this cap |
| `maxSnippetBytes` | `1200` | Integer `64..16384`; UTF-8-safe maximum snippet bytes |
| `commandDiagnosticLimit` | `20` | Integer `1..100`; diagnostics printed by `/wiki lint`; report counts still cover all diagnostics |

Unknown configuration keys are rejected. A replacement profile row must therefore contain the full default shape:

```yaml
config:
  root: .llmwiki
  maxSourceBytes: 2097152
  maxPageBytes: 524288
  maxResults: 20
  maxSnippetBytes: 1200
  commandDiagnosticLimit: 20
```

## Durable layout and format / 持久化布局与格式

```text
.llmwiki/
├── schema.md
├── sources/<sha256>/
│   ├── content
│   └── metadata.json
├── pages/<logical-page-id>.md
└── .index/
    ├── search.json
    └── state.json
```

`content` is exact UTF-8 text. Empty source content is valid: `content` is a required string but the runtime imposes no non-empty constraint; its ID is still the SHA-256 of its zero bytes. Non-empty source names and media types are required. The lowercase 64-hex content SHA-256 is both source ID and directory name. Metadata records `id`, `name`, `mediaType`, `byteCount`, `capturedAt`, and optional non-empty `origin`. Same-content additions deduplicate and preserve the first record. There is no arbitrary host-path ingest: callers supply the text, and `origin` is provenance only.

Page IDs are normalized POSIX logical paths without a leading slash or `.md` suffix; empty, `.`, `..`, backslash, control-character, and ambiguous percent-decoding forms are rejected. Pages require a non-empty body and this canonical frontmatter subset:

```yaml
---
title: "Concise title"
summary: "Evidence-backed summary"
sources:
  - <sorted-existing-source-sha256>
---
```

`schema.md`, source records, and pages are durable. `.index` is derived, versioned, and disposable: delete the whole directory after corruption or an incompatible upgrade; search or `/wiki reindex` recreates it. Existing symlinks in the root or managed paths are rejected rather than followed.

## Model tools / 模型工具

The dsh `defineTool` contract produces an **open top-level argument object**. Every supported argument is declared below and declared fields are validated; irrelevant unknown top-level keys do not affect behavior and must not be treated as a supported extension. Structured output objects are closed where the schema supports it.

| tool | declared arguments and caps | mutation, side effects, and result contract |
|---|---|---|
| `llmwiki_status` | none | Returns initialization/schema, source/page counts, and index presence/freshness. It does not rebuild the index, but the first normal service operation initializes the root, required directories, and default `schema.md`. |
| `llmwiki_add_source` | required `name`, required string `content` (empty allowed), optional `mediaType`, optional `origin`; content capped by `maxSourceBytes` | Durable mutation. Stores caller-supplied UTF-8 evidence, never opens `origin` or a host path, and returns ID, dedupe state, and provenance metadata. |
| `llmwiki_read_source` | required exact `id`; optional non-negative byte `offset`; optional positive `limit` no greater than `maxSourceBytes` | Reads immutable evidence and metadata. Range endpoints are adjusted to avoid splitting UTF-8 code points; returns total byte count plus actual byte start/end. |
| `llmwiki_search` | required lexical `query`; optional positive integer `limit` | If index files are missing, malformed, incompatible, or stale, rebuilds **only derived `.index` files**. Returns ranked sections capped by `min(limit, maxResults)` (default `maxResults`), with snippets capped by `maxSnippetBytes`. |
| `llmwiki_read_page` | required logical page `id` | Reads one synthesized page and its cited source IDs; no page/source mutation. |
| `llmwiki_upsert_page` | required `id`, non-empty `title`, non-empty `summary`, non-empty unique existing `sources`, non-empty `body` | Sorts source IDs during canonical rendering, then atomically writes a page capped by `maxPageBytes`; removes both current index files to mark derived search data absent and returns page ID, creation state, and page SHA-256. |
| `llmwiki_lint` | none | Deterministic read-only inspection. It never initializes, fixes, deletes, rewrites, or rebuilds artifacts; returns all diagnostics and counts. A valid corpus without `.index` therefore reports an `INDEX_MISSING` warning. |

Model outputs are bounded by configuration. Pages are interpretations; source records are evidence. Search first, read the relevant pages and immutable sources, and cite existing source IDs rather than inventing them.

## Human command / 人工命令

| command token | behavior and side effects |
|---|---|
| `/wiki` or `/wiki status` | Calls status; may perform first-use root/schema/directory initialization, but does not rebuild the index |
| `/wiki lint` | Read-only lint; prints at most `commandDiagnosticLimit` diagnostics and full error/warning/file counts |
| `/wiki reindex` | Rebuilds derived index files and formats the service's atomic `ReindexReceipt`: `pageCount`, `sectionCount`, and `formatVersion` |

Any other token returns `Usage: /wiki [status|lint|reindex]`. Commands execute locally and do **not** trigger a model turn.

## Deterministic retrieval / 确定性检索

Text is Unicode NFKC-normalized and lowercased without locale-sensitive APIs. Letter/number runs are tokens; CJK-only runs also emit overlapping two-code-point grams. Search indexes Markdown sections and uses fixed BM25 (`k1=1.2`, `b=0.75`) with title/heading/body boosts `2.0/1.5/1.0`. Query tokens are deduplicated. Score ties sort by page ID and then section start line. Snippets are capped in UTF-8 bytes without splitting code points. Canonically sorted JSON and exact page hashes make equivalent durable corpora produce byte-identical indexes.

## Lint, recovery, security, and limits / 检查、恢复、安全与限制

Lint covers root/schema/required-directory shape, UTF-8, symlinks, source directory ID/content hash/metadata, canonical page path/Markdown/source references, duplicate titles, orphan pages, escaping or broken page links, missing/malformed/incompatible/stale indexes, and abandoned atomic-write temporary files. Lint is observational only.

Recovery procedure:

1. Stop every extra writer; only one process may write a wiki. The service serializes operations in one process but has no cross-process lock.
2. Run `/wiki lint`. Inspect abandoned `.*.tmp-*` files before manually removing them.
3. For any index warning/error, delete the complete `.index` directory and run `/wiki reindex` (or let the next search rebuild it).
4. Repair pages by restoring canonical Markdown and valid source citations. Never edit immutable source content or identity metadata in place.
5. Back up the root before major-version changes or manual durable-data repair.

The plugin is host-only and local-only. It makes no network request, subprocess call, or autonomous model call. Model/host-supplied content is stored below the configured root. Root containment, strict logical IDs, regular-file checks, and fail-closed symlink rejection prevent path traversal through plugin APIs. Anyone with filesystem read permission on the root can read all preserved evidence. Limits bound individual source/page writes, source-read ranges, result counts, snippets, and command display; they are not quotas on total corpus size, page count, source count, disk usage, or execution time.

## Model experience

The stable prompt section is named `tool:llmwiki`, ordered at `116`, with this exact text:

```text
Use the llmwiki as durable, evidence-backed memory:
- Call llmwiki_status before relying on the wiki.
- Search first, then read only the relevant pages and immutable source records.
- Treat wiki pages as synthesized notes; source records are the preserved evidence.
- Cite real source IDs in every page write. Never invent a source ID.
- Use llmwiki_upsert_page only when new evidence changes durable knowledge.
- llmwiki_lint is read-only. Do not claim that it repaired anything.
```

The section participates in normal system-prompt ordering. Seven tool schemas add direct model-context cost; bounded results and command diagnostics limit growth. Stable prompt/schema prefixes are KV-cache friendly, but profile configuration or available-tool changes can change the prefix, and this plugin guarantees no cache behavior.

## Migration and versioning / 迁移与版本

Source and page formats are durable contracts. `.index` carries `formatVersion: 1` and may always be discarded. Future durable migrations must be explicit, copy-first, verifiable, and rollbackable; they must never silently rewrite evidence.

## Runnable example / 可运行示例

See [`examples/README.md`](examples/README.md) for a packed clean-directory run that observes pre-search `INDEX_MISSING`, then status/search/lint, first hit `getting-started` line 12, row disablement, and cleanup.

## Known limitations and deferred work / 已知限制与延后工作

Single-process writer only; UTF-8 text sources only; no delete/fix API, browser UI, server, file watcher, embeddings/vector search, graph extraction, hosted sync, arbitrary-path ingest, autonomous collection, corpus quota, or cross-process lock. These are independent implementation choices, not claims made by Karpathy's idea file.
