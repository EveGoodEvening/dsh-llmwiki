# dsh-llmwiki implementation checklist

## How to use this tracker

- Every unchecked item is actionable. Mark an item `[x]` only after its stated acceptance and verification complete.
- Work chunks in dependency order. Chunks explicitly marked parallel-safe may run concurrently only after their dependencies are complete.
- Each implementation chunk owns its listed paths until an explicit sequential transfer in this file. Parallel chunks must not edit the same path; later integration chunks may edit a transferred path only after every earlier owner has committed it.
- `PLAN.md` is the architecture authority. A necessary design change must update `PLAN.md` and this checklist in the same commit before implementation proceeds.
- Status at planning handoff: **all implementation, review, verification, and release items are not started**. `PLAN.md` and this file are the only completed artifacts; no plugin code exists.
- Required commit style is Conventional Commits. Run no unrelated repository-wide commands between a chunk's implementation and its focused verification.

## Dependency graph

```text
C01 repository shell
 └─ C02 domain/path safety
     └─ C03 canonical persistence
         ├─ C04 deterministic retrieval ─┐
         └─ C05 deterministic lint ──────┤
                                        └─ C06 service orchestration
                                            ├─ C07 model tools/prompt
                                            └─ C08 human command
                                                 \         /
                                                  C09 plugin/bundle integration
                                                           |
                                                  C10 contract/composition tests
                                                           |
                                                  C11 docs/example/smokes
                                                           |
                                                  C12 cleanup and release gates
                                                           |
                                                  C13 split final review
```

C04 and C05 are parallel-safe after C03 under the fixed `PLAN.md` §3.4 index contract. C07 and C08 source paths are parallel-safe after C06, but their `tests/plugin.spec.ts` work follows the explicit C07→C08 sequential handoff. All other edges are strict.

### Newly discovered constraints

- Verified installable manifest baseline: `packageManager: pnpm@11.7.0`; `engines.node: ^22.19.0 || >=24`; exact peers `@deepseek-ai/cordis@4.0.1`, `@deepseek-ai/dsh-brand@0.1.0-rc.6`, and `@deepseek-ai/dsh-{commands,session,system-prompt,tools}@0.1.0-rc.6`, mirrored exactly in dev dependencies; runtime `@deepseek-ai/schemastery@3.18.1`; dev TypeScript `6.0.3`, ESLint `9.39.2`, `@typescript-eslint/parser` `8.67.0`, `@typescript-eslint/eslint-plugin` `8.67.0`, tsdown `0.22.2`, tsx `4.22.4`, Vitest and `@vitest/coverage-v8` `4.1.8`, and `@types/node` `22.20.0`. The locally inspected dsh rc.5 packages are unpublished; primary npm version records prove rc.6 is installable, and its published declarations/runtime are byte-identical to the inspected local rc.5 APIs. Exact pins prevent resolution to the older rc.1 `latest`. C02 adds dsh-brand because the first branded domain types are introduced there.
- C01 may declare only scripts whose target files/configuration exist at C01 completion. C11 creates the determinism/smoke targets and then adds their package scripts; C09 creates the bundle patch and only then adds its manifest publication fields. Shared manifest ownership is sequential: C01→C02→C09→C11→C12 for `package.json`; C01→C02→C12 for `pnpm-lock.yaml`. C02's manifest/lock delta is narrowly limited to exact `@deepseek-ai/dsh-brand@0.1.0-rc.6` peer+dev entries and the pnpm-generated lock update.
- `pnpm-lock.yaml` is generated or updated by the orchestrator running pnpm `11.7.0`; workers must not hand-author it.
- Official pnpm `11.7.0` build-policy contract: settings under `package.json#pnpm` are ignored; C01 must commit the exact minimal `pnpm-workspace.yaml` policy specified below. With `packages` omitted the project remains root-only, omitted dependencies remain denied under default `strictDepBuilds: true`, the sole approved build is pinned to exact `esbuild@0.28.2`, and `minimumReleaseAgeExclude` is unrelated to dependency build approval.
- Vitest 4 coverage uses `coverage.include` and `coverage.thresholds.perFile`; do not use obsolete `coverage.all` or top-level `coverage.perFile`.
- dsh `defineTool` compiles an open top-level parameter object. C07/C10 must preserve `defineTool`, explicitly declare every supported parameter, reject/handle invalid declared fields, never rely on unknown keys, and use closed structured output/value objects where supported; they must not assert top-level unknown-key rejection.

---

## C01 — Initialize the package shell

**Commit:** `chore: initialize dsh-llmwiki package`  
**Depends on:** none  
**Owned paths:** `package.json`, `pnpm-lock.yaml`, `pnpm-workspace.yaml`, `tsconfig.json`, `tsconfig.eslint.json`, `tsdown.config.ts`, `vitest.config.ts`, `vitest.e2e.config.ts`, `eslint.config.js`, `.gitignore`, `LICENSE`
**Status:** complete. Implementation, acceptance, verification, review/fix, and commit are complete. Reverification confirmed exact `@typescript-eslint/parser` and `@typescript-eslint/eslint-plugin` `8.67.0` direct and locked versions, a dependency-clean frozen install exited zero, `pnpm peers check` reported no issues, `pnpm ignored-builds` printed `None`, the direct dependency list matched the exact contract, and typed lint exited zero. Committed as `93ab0a6` (`chore: initialize dsh-llmwiki package`).

### Implementation

- [x] Create `package.json` for public ESM package `dsh-llmwiki` with initial version `0.1.0`, MIT license, repository URL, exact `packageManager: "pnpm@11.7.0"`, exact `engines.node: "^22.19.0 || >=24"`, and no default runtime entry outside `lib/`.
- [x] Add `main: "lib/index.js"`, `types: "lib/types/index.d.ts"`, and conditional `exports` only for `.` and `./package.json`; do not export `src/*` or the not-yet-created `cordis.patch.yml`.
- [x] Restrict the initial `files` allowlist to built JavaScript, declarations, README, and license; exclude plans, tests, fixtures, examples, source TypeScript, coverage, local wiki data, and the not-yet-created bundle patch. C09 adds the patch entry after creating it.
- [x] Add exact peer dependencies `@deepseek-ai/cordis: 4.0.1` and `@deepseek-ai/dsh-commands`, `@deepseek-ai/dsh-session`, `@deepseek-ai/dsh-system-prompt`, and `@deepseek-ai/dsh-tools` at installable `0.1.0-rc.6`; mirror them exactly in dev dependencies. Add exact runtime dependency `@deepseek-ai/schemastery: 3.18.1`. Do not substitute unpublished rc.5 or a range/dist-tag that can resolve the older rc.1 `latest`.
- [x] Add exact dev dependencies TypeScript `6.0.3`, ESLint `9.39.2`, `@typescript-eslint/parser` `8.67.0`, `@typescript-eslint/eslint-plugin` `8.67.0`, tsdown `0.22.2`, tsx `4.22.4`, Vitest and `@vitest/coverage-v8` `4.1.8`, and `@types/node` `22.20.0`. Do not use `@typescript-eslint` `8.56.0`: its primary registry peer range `>=4.8.4 <6.0.0` excludes TypeScript `6.0.3`; parser/plugin `8.67.0` use `>=4.8.4 <6.1.0` and support ESLint `^8.57.0 || ^9.0.0 || ^10.0.0`.
- [x] Create committed `pnpm-workspace.yaml` with exactly:

  ```yaml
  allowBuilds:
    esbuild@0.28.2: true
  ```

  Do not add `packages`, `strictDepBuilds`, any other dependency, or a package-level `pnpm` build-policy field. This keeps the single package at the root, permits only exact `esbuild@0.28.2`, and leaves every omitted dependency fail-closed under pnpm `11.7.0`'s default `strictDepBuilds: true`.
- [x] Add scripts `build`, `clean`, `typecheck`, `lint`, `test`, `test:coverage`, and `test:e2e`, each targeting a file/configuration that exists at C01 completion. `test:e2e` must invoke Vitest with `--config vitest.e2e.config.ts`, not pass an unexpanded test-file glob. Do not declare `check:determinism` or `smoke`; C11 adds them after creating `scripts/check-determinism.ts` and `scripts/smoke.ts`. Do not add `prepack` before sources exist; C12 adds the clean-build lifecycle after the package surface is complete.
- [x] Configure `eslint.config.js` as ESLint `9.39.2` flat config using exact `@typescript-eslint/parser` and `@typescript-eslint/eslint-plugin` `8.67.0` over `src/**/*.ts`, `tests/**/*.ts`, `scripts/**/*.ts`, and root `*.ts`/`*.js`; ignore `lib/`, `coverage/`, `node_modules/`, example wiki data, and generated temporary roots. Use the dedicated `tsconfig.eslint.json` project for type-aware rules; it extends the production compiler options, sets `noEmit`, and explicitly includes future source, test, script, and root TypeScript configuration paths without adding them to the production build. `pnpm run lint` must execute ESLint with zero allowed warnings.
- [x] Configure strict NodeNext TypeScript, declaration output to `lib/types`, source maps, no unchecked indexed access, exact optional properties, and imports with explicit `.ts` specifiers that emit as `.js`.
- [x] Configure tsdown for one host ESM entry, preserving dsh/Cordis/Schemastery dependencies as externals and emitting `lib/index.js` plus source map.
- [x] Configure Vitest 4.1.8 for Node, isolated temporary directories, deterministic timezone/locale environment, and V8 coverage with `include: ['src/**/*.ts']` plus `thresholds.perFile: true` and threshold values of 90% lines, 90% statements, 90% functions, and 85% branches; do not use removed `coverage.all` or top-level `coverage.perFile`. The unit config must exclude `tests/**/*.e2e.spec.ts`; dedicated `vitest.e2e.config.ts` must include exactly `tests/**/*.e2e.spec.ts` for `test:e2e`.
- [x] Create `.gitignore` before running install/build commands; cover `node_modules/`, `lib/`, `coverage/`, logs, temp roots, generated `.index/`, packed tarballs, and editor/OS noise without ignoring planned examples.
- [x] Add the exact MIT license text and chosen holder/year so the first pack inspection contains the declared license.
- [x] Do not hand-author `pnpm-lock.yaml`; the orchestrator runs `pnpm install` with pnpm `11.7.0` during C01 verification, reviews the generated lockfile, verifies it from a dependency-clean state with `--frozen-lockfile`, and includes it in the C01 commit.
- [x] Keep `minimumReleaseAgeExclude` separate from build policy: it is unrelated to dependency build approval and must not substitute for or modify the exact minimal `allowBuilds` policy.

### Acceptance

- [x] `pnpm list --depth 0` resolves Cordis `4.0.1`, all four dsh packages at `0.1.0-rc.6`, Schemastery `3.18.1`, TypeScript `6.0.3`, ESLint `9.39.2`, and both TypeScript-ESLint packages at `8.67.0` exactly; no `@typescript-eslint` `8.56.0`, dsh rc.5/rc.1, range, or dist-tag-selected version is present.
- [x] After corrected lockfile generation, `pnpm ignored-builds` prints `None`; `esbuild@0.28.2` is permitted solely by the exact-version key in the committed `pnpm-workspace.yaml` policy specified above.
- [x] `pnpm install --frozen-lockfile` exits zero from a clean `node_modules` state with exact `esbuild@0.28.2`, TypeScript `6.0.3`, ESLint `9.39.2`, and TypeScript-ESLint parser/plugin `8.67.0`; a second `pnpm ignored-builds` prints `None`, `pnpm list --depth 0` shows no workspace-only, incompatible, or missing declared dependencies, and `pnpm-workspace.yaml` remains the exact root-only policy file.
- [x] Node assertions over raw `tsconfig.json` and `tsconfig.eslint.json` exit zero and confirm the production config uses `module` and `moduleResolution` `NodeNext`, enables `strict`, `exactOptionalPropertyTypes`, and `noUncheckedIndexedAccess`, emits declarations to `lib/types`, while the lint config extends it, sets `noEmit`, and includes future source, test, script, and root TypeScript configuration paths. Do not execute `tsc --showConfig` or `pnpm run typecheck` in C01: without any `src/**/*.ts` inputs they fail with TS18003; C02 performs the first real typecheck after creating source files.
- [x] `pnpm run lint --no-warn-ignored` executes type-aware ESLint `9.39.2` with `@typescript-eslint/parser` and `@typescript-eslint/eslint-plugin` `8.67.0` from `eslint.config.js` using `tsconfig.eslint.json`, recognizes TypeScript `6.0.3` without an unsupported-version warning, and exits zero with no warnings. Package-script routing and static unit/E2E config assertions confirm `test:e2e` uses dedicated `vitest.e2e.config.ts`, the unit config excludes `tests/**/*.e2e.spec.ts`, and the E2E config includes exactly that pattern; both dedicated Vitest configs exit zero with `--passWithNoTests`. Do not insert a standalone `--`, because pnpm `11.7.0` forwards that literal separator to ESLint. Every other declared script resolves to a real command and contains no `|| true`.
- [x] `pnpm pack --dry-run --json` lists only artifacts available at C01 and includes `LICENSE`; a Node assertion over `package.json.exports` confirms only `.` and `./package.json` are exported. The patch export/file entry is explicitly deferred to C09.

### Verification

- [x] Orchestrator: run pnpm `11.7.0` install after correcting the exact TypeScript-ESLint pins to regenerate/confirm `pnpm-lock.yaml`; workers must not synthesize lockfile content. Run `pnpm ignored-builds` and require exact output `None`, then assert the direct dependency versions are TypeScript `6.0.3`, ESLint `9.39.2`, and parser/plugin `8.67.0` with no `8.56.0` remaining.
- [x] Orchestrator: confirm committed `pnpm-workspace.yaml` exactly matches the two-line `allowBuilds`/`esbuild@0.28.2: true` policy above, remove the disposable dependency directory, run `pnpm install --frozen-lockfile` from that clean dependency state, then rerun `pnpm ignored-builds` and require exact output `None`.
- [x] Run raw Node assertions over `tsconfig.json` and `tsconfig.eslint.json`; confirm the production NodeNext/strict/declaration contract and the lint config's `extends`, `noEmit`, and future source/test/script/root-config coverage. Defer `tsc --showConfig` and `pnpm run typecheck` until C02 has created `src` inputs.
- [x] Run `pnpm run lint --no-warn-ignored` with exact ESLint `9.39.2` and TypeScript-ESLint parser/plugin `8.67.0`; require zero exit, zero warnings, and no unsupported-TypeScript warning for `6.0.3`. Assert package script routing and static unit/E2E config separation through `vitest.e2e.config.ts`; run both dedicated Vitest configs with `--passWithNoTests` and require zero exits.
- [x] Run `pnpm pack --dry-run --json` and assert the included path set and license presence; no missing-license deferral is allowed.

### Review/fix

- [x] Review metadata and the corrected direct/locked dependency graph against the selected dsh manifests, primary TypeScript-ESLint registry peer ranges, and `docs/cookbook/adding-a-package.md` invariants that apply out of tree; confirm exact ESLint `9.39.2` and parser/plugin `8.67.0`, with no `8.56.0` occurrence.
- [x] Remove unused dependencies and scripts; confirm `pnpm-workspace.yaml` contains only the root-only exact `esbuild@0.28.2: true` build allowlist, no package-level `pnpm` build-policy field or release-age workaround exists, every C01 script target exists now, `test:e2e` uses the dedicated Vitest config, typed lint uses parser/plugin `8.67.0` and covers future tests/scripts through `tsconfig.eslint.json`, and determinism/smoke, clean-build prepack, and bundle-patch manifest fields remain deferred to their owning chunks.
- [x] Commit only C01-owned paths with `chore: initialize dsh-llmwiki package`: `93ab0a6`.

---

## C02 — Add domain contracts and filesystem containment

**Commit:** `feat: add safe wiki filesystem primitives`  
**Depends on:** C01  
**Owned paths:** `src/types.ts`, `src/errors.ts`, `src/ids.ts`, `src/paths.ts`, `tests/ids-paths.spec.ts`, `package.json` and `pnpm-lock.yaml` (sequential ownership received from C01; add only exact dsh-brand peer/dev entries and generated lock resolution; transfer `package.json` to C09 and `pnpm-lock.yaml` to C12 after C02 commits)  
**Status:** complete, verified, and clean after three independent reviews; awaiting commit only

### Implementation

- [x] Add exact `@deepseek-ai/dsh-brand: 0.1.0-rc.6` to both `peerDependencies` and `devDependencies` in `package.json`; import `Branded<B>` directly from that package, do not recreate a local brand helper, and update `pnpm-lock.yaml` only by running pnpm `11.7.0`.
- [x] Define immutable public DTOs in `src/types.ts`: config-independent status, source/page inputs and receipts, byte range/read, search hit, lint diagnostic/report, and index status.
- [x] Define `SourceId` and `PageId` with direct `Branded<B>` from `@deepseek-ai/dsh-brand`; expose validating constructors and never expose unchecked casts.
- [x] Define stable domain error codes and `LlmWikiError` in `src/errors.ts`; preserve internal causes without serializing paths/stacks into public tool output.
- [x] Validate source IDs as exactly 64 lowercase hexadecimal characters.
- [x] Normalize page IDs as POSIX logical paths without leading slash, `.md`, empty/`.`/`..` segments, backslash, control/NUL characters, or ambiguous percent-decoding behavior.
- [x] Resolve the configured root once. If absent, create it safely as a real directory; if it exists as a symlink or any non-directory filesystem object, reject it.
- [x] Centralize root/page/source/index path derivation; every derived path must prove containment beneath the resolved real root.
- [x] Reject symlinks in existing path components and target files using `lstat`/`realpath`; do not follow a symlink and then check afterward.
- [x] Add abort helpers that throw the stable `ABORTED` domain error before and between asynchronous I/O phases.

### Tests

- [x] Test valid source/page IDs, direct dsh-brand typing, and canonical round trips.
- [x] Test absolute paths, drive paths, UNC-like paths, `..`, `.`, doubled separators, backslashes, NUL/control characters, trailing `.md`, and empty IDs.
- [x] Test prefix-collision containment (`/wiki` vs `/wiki-escape`).
- [x] Test an existing configured-root symlink and existing configured-root non-directory are rejected; test an absent root is safely created as a real directory.
- [x] Test symlinked root child, symlinked parent segment, symlinked target, and broken symlink rejection on platforms that support symlinks.
- [x] Test pre-aborted and mid-operation abort mapping.
- [x] Test domain errors expose stable code/message and do not expose an internal stack in serialized DTOs.

### Acceptance

- [x] `pnpm exec vitest run tests/ids-paths.spec.ts` exits zero with 35 focused tests passing after exercising every rejected root/path/symlink case listed above and asserting every derived OS path remains below the resolved real root.
- [x] A focused import scan covers only files that exist in C02: `src/{types,errors,ids,paths}.ts` use the central C02 ID/path/error contracts without duplicate brand or validator declarations, and branded types import `Branded` directly from `@deepseek-ai/dsh-brand`. C03+ callsites are intentionally deferred until they exist.
- [x] The focused test records its temporary roots and asserts each is absent in teardown, including failure-path cases.

### Verification

- [x] The exact `@deepseek-ai/dsh-brand@0.1.0-rc.6` peer/dev manifest and generated lockfile transfer is complete; a clean `pnpm install --frozen-lockfile` exits zero, `pnpm list --depth 0` resolves direct `@deepseek-ai/dsh-brand@0.1.0-rc.6`, and `pnpm ignored-builds` prints `None`.
- [x] `pnpm exec vitest run tests/ids-paths.spec.ts` exits zero with 35 tests passing.
- [x] `pnpm run typecheck` exits zero.
- [x] `pnpm run lint` exits zero.

`pnpm run build` is explicitly not a C02 gate; bundle/build verification belongs to its later owning chunk.

### Review/fix

- [x] Independent accounting review: `package.json` and the generated `pnpm-lock.yaml` delta contain only exact `@deepseek-ai/dsh-brand@0.1.0-rc.6` peer/dev ownership changes, with no hand-authored lock data or unrelated manifest edits; review result: clean.
- [x] Independent correctness review: `src/{types,errors,ids,paths}.ts` and `tests/ids-paths.spec.ts` correctly implement the C02 domain, validation, containment, abort, and branded-ID contracts without duplicate validators or branded-ID escape holes; review result: clean.
- [x] Independent security review: `src/{types,errors,ids,paths}.ts` and `tests/ids-paths.spec.ts` reject traversal, configured-root symlinks and non-directories, symlinked path components and targets, containment prefix collisions, and identified TOCTOU hazards; review result: clean.
- [x] Fix review findings and rerun the dependency, focused-test, and typecheck gates; all three independent reviews were clean, so no fixes or gate reruns were required.
- [ ] Commit C02-owned paths with `feat: add safe wiki filesystem primitives`.

---

## C03 — Add atomic persistence and canonical Markdown

**Commit:** `feat: add canonical wiki markdown persistence`  
**Depends on:** C02  
**Owned paths:** `src/atomic.ts`, `src/markdown.ts`, `tests/markdown.spec.ts`, `tests/fixtures/corpus/source-a.txt`, `tests/fixtures/corpus/source-b.txt`  
**Status:** blocked on C02

### Implementation

- [ ] Implement canonical UTF-8 encode/decode helpers with explicit invalid-UTF-8 failure where bytes are read from disk.
- [ ] Implement sibling temporary-file writes using exclusive creation, complete write, file sync where supported, close, atomic rename, and best-effort directory sync.
- [ ] Guarantee temp cleanup on validation failure, I/O failure, abort, and rename failure; never report success before rename completes.
- [ ] Use collision-resistant temporary names only for ephemeral files; deterministic persisted output must never contain the random name.
- [ ] Implement strict frontmatter parser for exactly `title`, `summary`, and `sources`; reject aliases, tags, anchors, multiline YAML features, duplicate keys, unknown keys, malformed lists, duplicate source IDs, and unsorted source IDs.
- [ ] Implement canonical renderer with fixed key order, normalized LF line endings, YAML-safe quoted strings, sorted unique source IDs, one blank line after frontmatter, and a final newline.
- [ ] Require non-empty trimmed title, summary, source list, and Markdown body; preserve body content except documented line-ending/final-newline normalization.
- [ ] Implement ATX-heading section splitting with heading trail and one-based line positions; fenced-code `#` lines must not become headings.
- [ ] Add fixture source bytes containing ASCII, Unicode, CJK, and final-newline variations.

### Tests

- [ ] Round-trip canonical pages byte-for-byte.
- [ ] Cover every malformed/unknown/duplicate frontmatter case.
- [ ] Cover quotes, colon/hash characters, Unicode, CRLF normalization, empty body, and size boundary behavior.
- [ ] Cover heading hierarchy, repeated headings, headingless preamble, fenced code, and exact line numbers.
- [ ] Simulate write/rename failure and abort; assert old target remains byte-identical and no temp remains.
- [ ] Assert atomic replacement never exposes a partially rendered page to an external read after completion.

### Acceptance

- [ ] `pnpm exec vitest run tests/markdown.spec.ts` performs two parse/render cycles and byte-compares canonical output.
- [ ] Injected write/rename/abort failures leave the prior target hash unchanged and no sibling temp files.
- [ ] A table-driven rejection test covers every unsupported YAML feature and malformed case listed in C03.

### Verification

- [ ] Run `pnpm exec vitest run tests/markdown.spec.ts`.
- [ ] Run `pnpm run typecheck`.

### Review/fix

- [ ] Review persistence code for descriptor leaks, abort races, cleanup masking the primary error, and Windows rename assumptions.
- [ ] Review canonical rendering for YAML ambiguity and non-deterministic ordering.
- [ ] Fix findings and rerun focused tests.
- [ ] Commit C03-owned paths with `feat: add canonical wiki markdown persistence`.

---

## C04 — Build deterministic section indexing and BM25 search

**Commit:** `feat: add deterministic wiki search index`  
**Depends on:** C03  
**Parallel-safe with:** C05  
**Owned paths:** `src/tokenizer.ts`, `src/indexer.ts`, `tests/indexer.spec.ts`, `tests/fixtures/corpus/alpha.md`, `tests/fixtures/expected/search.json`; implements the exact `IndexStateV1`/`SearchIndexV1` contract in `PLAN.md` §3.4
**Status:** blocked on C03

### Implementation

- [ ] Implement NFKC lowercase Unicode letter/number tokenization without locale-sensitive APIs.
- [ ] Emit CJK runs and overlapping 2-character grams for runs longer than one character; document exact behavior in code comments and tests.
- [ ] Discover pages recursively without following symlinks and sort logical paths by code-unit comparison.
- [ ] Fingerprint exact page bytes with SHA-256 and build sorted section records from the canonical Markdown parser.
- [ ] Implement the exact closed `IndexStateV1` and `SearchIndexV1` JSON schemas, field order, sort order, numeric/hash validation, and `formatVersion: 1` contract from `PLAN.md` §3.4; permit only `averageSectionLength` as a finite non-negative floating-point numeric field, require every integer-count field to remain a non-negative safe integer (and positive where specified), and reject every unknown/incompatible/malformed field as derived-index corruption.
- [ ] Serialize canonical JSON with the contract's fixed key insertion order, sorted arrays, two-space indentation, and final newline.
- [ ] Implement fixed BM25 (`k1=1.2`, `b=0.75`) and title/heading/body boosts (`2.0/1.5/1.0`).
- [ ] Deduplicate query tokens, reject empty/tokenless queries, cap limit by configuration, and reject non-finite scores.
- [ ] Tie-break by page ID then section start line.
- [ ] Generate deterministic snippets capped by UTF-8 bytes without splitting code points; include page, heading trail, start line, score, snippet, and source IDs.
- [ ] Rebuild when page fingerprint mapping differs or index data is absent/incompatible/malformed; never trust mtimes for freshness.
- [ ] Atomically write canonical `search.json` first and `state.json` second; set `state.searchSha256` to the exact search bytes. Freshness requires that hash and both page mappings to match, so a crash/mismatched pair always forces rebuild.

### Tests

- [ ] Test ASCII/Unicode/CJK token output and normalization.
- [ ] Test title/heading/body boosts, document length normalization, repeated terms, query dedupe, and stable ties.
- [ ] Test deterministic page discovery and section line numbers.
- [ ] Test exact golden `search.json` bytes and rebuild equivalence across two roots with different mtimes; explicitly reject fractional, negative, unsafe, NaN, and infinite values for integer-count fields while accepting valid finite non-negative fractional `averageSectionLength`.
- [ ] Test stale, absent, malformed, unknown-version, and mismatched state/index behavior.
- [ ] Test result caps, UTF-8 snippet caps, empty result, and tokenless query rejection.
- [ ] Test symlinked pages/directories are rejected rather than indexed.

### Acceptance

- [ ] The focused indexer test creates equivalent durable corpora with different creation order, mtimes, roots, timezone, and locale, then byte-compares `search.json` and `state.json`; capture-time source metadata is intentionally excluded from that cross-root derived-output comparison.
- [ ] The test runs identical query/index/config inputs twice and deep-compares serialized ordered result JSON.
- [ ] The test deletes `.index`, searches again, and asserts durable page/source hashes are unchanged and rebuilt derived bytes equal the original.

### Verification

- [ ] Run `TZ=UTC LC_ALL=C pnpm exec vitest run tests/indexer.spec.ts`.
- [ ] Run the same focused test with one alternate available timezone/locale and compare the golden result.
- [ ] Run `pnpm run typecheck`.

### Review/fix

- [ ] Review scoring math for NaN/Infinity, zero-length corpus, and unstable floating formatting.
- [ ] Review index commit ordering for crash consistency.
- [ ] Fix findings, regenerate the golden only when behavior intentionally changes, and review the byte diff.
- [ ] Commit C04-owned paths with `feat: add deterministic wiki search index`.

---

## C05 — Implement deterministic, read-only lint

**Commit:** `feat: add deterministic wiki linting`  
**Depends on:** C03  
**Parallel-safe with:** C04; both chunks consume the immutable `IndexStateV1`/`SearchIndexV1` contract already fixed in `PLAN.md` §3.4, and C05 must not edit C04-owned paths  
**Owned paths:** `src/lint.ts`, `tests/lint.spec.ts`, `tests/fixtures/corpus/beta.md`, `tests/fixtures/expected/lint.json`
**Status:** blocked on C03

### Implementation

- [ ] Define the complete stable diagnostic code table for schema/root/source/page/link/index/temp failures.
- [ ] Implement sorted diagnostics ordered by path, line with missing last, code, then message using code-unit comparison.
- [ ] Check root layout, `schema.md`, directory types, UTF-8 validity, and all symlink/root-escape conditions.
- [ ] Verify each source directory name equals SHA-256 of exact `content`; validate immutable metadata schema and byte count, treating a valid capture time as provenance rather than a cross-root determinism input.
- [ ] Validate every page path and canonical frontmatter/body contract without rewriting it.
- [ ] Report duplicate normalized titles.
- [ ] Parse relative Markdown links outside fenced code; validate page targets and reject links escaping `pages/`. Ignore external URL schemes and same-page anchors by documented rule.
- [ ] Validate derived index presence/freshness against every field, ordering, version, page mapping, and `searchSha256` rule in `PLAN.md` §3.4; missing index is a warning, stale data/hash mismatch is a warning, and malformed/unknown-version data is an error, with exact codes/messages frozen by tests.
- [ ] Report abandoned atomic temporary files without deleting them.
- [ ] Return summary counts by severity and total files examined.
- [ ] Ensure lint performs no writes, index rebuild, timestamp touches, or silent repairs.

### Tests

- [ ] Add one isolated fixture/case for every diagnostic code.
- [ ] Test multiple diagnostics on one file and exact global ordering.
- [ ] Test source content hash mismatch, metadata byte mismatch, malformed JSON, missing content, and unknown metadata keys.
- [ ] Test duplicate titles under Unicode normalization.
- [ ] Test valid/broken/escaping links, anchors, external URLs, image links, and fenced-code pseudo-links.
- [ ] Test missing/stale/malformed/incompatible index diagnostics against C04 format.
- [ ] Snapshot exact canonical lint JSON in `tests/fixtures/expected/lint.json`.
- [ ] Hash every fixture before/after lint and assert byte identity plus unchanged file set.

### Acceptance

- [ ] The focused lint test runs twice, byte-compares canonical reports, and asserts no diagnostic path begins with the temporary absolute root.
- [ ] Before/after snapshots compare every file's bytes, mtime, and path set and show no lint-created change.
- [ ] A diagnostic-code coverage table maps every invariant in `PLAN.md` §3.5/§4.2 to either a tested lint code or a tested operation-time rejection, with no unmapped row.

### Verification

- [ ] Run `TZ=UTC LC_ALL=C pnpm exec vitest run tests/lint.spec.ts`.
- [ ] Run `pnpm run typecheck`.

### Review/fix

- [ ] Review diagnostic severity/message stability and path privacy.
- [ ] Review link parsing for false traversal acceptance and fenced-code false positives.
- [ ] Fix findings and review any golden lint diff line by line.
- [ ] Commit C05-owned paths with `feat: add deterministic wiki linting`.

---

## C06 — Orchestrate the `ctx.llmwiki` service

**Commit:** `feat: add llmwiki service orchestration`  
**Depends on:** C04 and C05  
**Owned paths:** `src/config.ts`, `src/service.ts`, `tests/service.spec.ts`, `tests/harness.ts` (C06 creates `tests/harness.ts`; ownership transfers sequentially to C10 only after C06 commits)
**Status:** blocked on C04 and C05

### Implementation

- [ ] Define Schemastery `Config` with exact defaults/ranges from `PLAN.md`; resolve it once into a fully required immutable config.
- [ ] Add `declare module '@deepseek-ai/cordis' { interface Context { llmwiki: LlmWikiService } }` in the service/public entry path.
- [ ] Implement `LlmWikiService extends Service`, call `super(ctx, 'llmwiki')`, and expose only the planned public methods.
- [ ] Initialize missing root/directories/default `schema.md` idempotently; never overwrite existing schema or user files.
- [ ] Implement one FIFO in-process mutation queue covering initialization, source creation, page writes, and index rebuild commits; reads may run concurrently only when they cannot observe an in-flight partial operation.
- [ ] Implement immutable source ingest with exact UTF-8 bytes, SHA-256 ID, canonical immutable metadata, exclusive creation, and idempotent dedupe. Capture time records the actual ingest event and is intentionally nondeterministic across fresh roots; dedupe within one root must preserve the first metadata byte-for-byte without rewriting capture time.
- [ ] Enforce source/page size caps by UTF-8 byte count before durable mutation.
- [ ] Implement byte-bounded source reads without splitting UTF-8 code points; define offset semantics unambiguously as byte offsets.
- [ ] Implement page read/upsert; verify all referenced sources immediately before atomic commit.
- [ ] Wire index freshness/rebuild/search and lint without duplicating their algorithms.
- [ ] Invalidate derived state after successful page mutation; a failed page mutation must not invalidate a previously fresh index.
- [ ] Observe abort before queued work begins and between I/O phases; remove cancelled queued work without starving later mutations.
- [ ] Map expected filesystem failures into stable domain errors while retaining internal causes.

### Tests

- [ ] Test first initialization, repeated initialization, pre-existing schema, and partial directory layouts.
- [ ] Test exact source bytes, content hash, canonical metadata, capture-time variation across fresh roots without including metadata in derived-output determinism comparisons, dedupe within one root preserving the original metadata byte-for-byte, and the source size boundary.
- [ ] Test read ranges including multibyte boundaries, zero/EOF offsets, and cap enforcement.
- [ ] Test page create/update, unknown source rejection, page cap, old-file preservation, and index invalidation.
- [ ] Test FIFO mutation ordering and concurrent deduplicated source creation.
- [ ] Test queued and mid-operation cancellation and absence of false success.
- [ ] Test corrupted on-disk source/page/index behavior maps to planned errors or lint output.
- [ ] Test service disposal/remount does not retain queue state or handles.

### Acceptance

- [ ] `pnpm exec vitest run tests/service.spec.ts` exercises every method in `PLAN.md` §4 and exits zero, including durable external rereads, aborts, limits, and corruption cases.
- [ ] A static import-boundary assertion in `tests/service.spec.ts` fails if adapters import private filesystem modules instead of the service API.
- [ ] Service tests compare externally reread source/page bytes with expected canonical bytes rather than accepting receipts alone.

### Verification

- [ ] Run `pnpm exec vitest run tests/service.spec.ts`.
- [ ] Run `pnpm run typecheck`.

### Review/fix

- [ ] Review queue cancellation, atomic visibility, error leakage, and service lifecycle.
- [ ] Review configuration defaults against `PLAN.md` and ensure every operational limit comes from resolved config.
- [ ] Fix findings and rerun focused tests.
- [ ] Commit C06-owned paths with `feat: add llmwiki service orchestration`.

---

## C07 — Add model tools, presentation, and prompt

**Commit:** `feat: expose llmwiki model tools and prompt`  
**Depends on:** C06  
**Parallel-safe with:** C08 for owned source paths only; `tests/plugin.spec.ts` transfers sequentially as stated below  
**Owned paths:** `src/prompt.ts`, `src/presentation.ts`, `src/tools.ts`, `tests/plugin.spec.ts` (C07 owns and creates the test file; C08 may add only its coordinated command-test hunk after C07's tool/prompt hunk is committed; full-file ownership transfers sequentially to C10 after both C07 and C08 commit)  
**Status:** blocked on C06

### Implementation

- [ ] Add the stable `LLMWIKI_SYSTEM_PROMPT` text exactly described by `PLAN.md`; keep it concise and free of deployment-specific values.
- [ ] Register prompt section `tool:llmwiki` at order `116`.
- [ ] Implement pure `presentCall` functions with stable titles/kinds for all seven tools.
- [ ] Implement pure result presentation/fallbacks; search/read views must contain no hidden I/O or mutable state.
- [ ] Register exactly `llmwiki_status`, `llmwiki_add_source`, `llmwiki_read_source`, `llmwiki_search`, `llmwiki_read_page`, `llmwiki_upsert_page`, and `llmwiki_lint` through `ctx.tools.register(defineTool(...))`.
- [ ] Preserve `defineTool`; explicitly declare every supported top-level parameter with required flags, descriptions, and configured bounds. Because dsh compiles that top-level object open, do not claim closure or rely on unknown keys; reject/handle invalid values for declared fields and use closed structured output/value object schemas where supported, with canonical JSON values compatible with `@deepseek-ai/dsh-session`.
- [ ] Ensure `llmwiki_add_source` accepts exact UTF-8 `content`, not arbitrary host paths.
- [ ] Ensure `llmwiki_upsert_page` accepts structured title/summary/source IDs/body rather than raw unvalidated file bytes.
- [ ] Translate expected `LlmWikiError` values into stable model-visible failures; do not expose stack, absolute root, temp path, or internal cause.
- [ ] Pass `exec.signal` through every service call.
- [ ] Ensure prompt and schemas explain index-first query and evidence-backed writes without claiming autonomous ingestion or lint fixes.

### Tests

- [ ] Assert exact tool-name set; no accidental delete/fix/path-read tool exists.
- [ ] Validate every declared parameter and every successful structured output/value against the dsh `defineTool` schemas; cover invalid declared fields and verify unknown top-level keys do not influence handler behavior, without asserting that the compiled open parameter object rejects them.
- [ ] Exercise each tool through the real tool registry using the shared harness.
- [ ] Test domain error mapping, cancellation, configured cap enforcement, and JSON serializability.
- [ ] Assert presentation functions are deterministic and unchanged by external service mutation.
- [ ] Snapshot the exact prompt section text/name/order.
- [ ] Dispose the owning fiber and assert all seven tools and prompt section disappear; remount and assert one registration each.

### Acceptance

- [ ] The focused plugin test invokes all seven exact tool names through the registry and completes status, source add/read, search, page read/upsert, and lint without direct service calls.
- [ ] Every invocation validates declared inputs and its closed structured output/value schema where supported, invalid declared fields are rejected/handled, irrelevant unknown top-level keys cannot change behavior, configured byte/result caps hold, source provenance appears where required, and results serialize/replay identically.
- [ ] The prompt snapshot contains the exact synthesized-page versus immutable-source distinction and its name/order assertion passes.

### Verification

- [ ] Run `pnpm exec vitest run tests/plugin.spec.ts -t 'tools|prompt|presentation'`.
- [ ] Run `pnpm run typecheck`.

### Review/fix

- [ ] Review tool descriptions as model instructions for ambiguity, unsupported claims, and accidental authority escalation.
- [ ] Review all output schemas against actual returned values and malformed on-disk cases.
- [ ] Fix findings and rerun the focused test selection.
- [ ] Commit C07-owned paths with `feat: expose llmwiki model tools and prompt`.

---

## C08 — Add the `/wiki` maintenance command

**Commit:** `feat: add wiki maintenance command`  
**Depends on:** C06  
**Parallel-safe with:** C07 for `src/command.ts` only; command tests wait for C07's test commit  
**Owned paths:** `src/command.ts`; after C07 commits its hunk, C08 receives temporary ownership only of the command-test hunk in `tests/plugin.spec.ts`, then transfers that hunk with the rest of the file to C10 after C08 commits  
**Status:** blocked on C06

### Implementation

- [ ] Register lowercase command `wiki` with description and input hint `[status|lint|reindex]`.
- [ ] Parse trimmed command input exactly; empty input aliases `status`; reject extra tokens and unknown subcommands with stable usage text.
- [ ] Implement status text with initialized state, source/page counts, and index freshness.
- [ ] Implement lint text with severity counts and first `commandDiagnosticLimit` sorted diagnostics plus explicit truncation count.
- [ ] Implement force-reindex text with page/section counts and index version.
- [ ] Pass `CommandInvocation.signal` into the service and map expected domain errors to `{ kind: 'error', text }`.
- [ ] Let unexpected programmer/I/O errors reject for dsh handling; never stringify stack/cause into command output.
- [ ] Ensure no command path invokes a model, adds sources, writes pages, deletes files, or repairs lint findings.

### Tests

- [ ] After C07 commits, add only command registry cases to the designated command-test section of `tests/plugin.spec.ts`; do not rewrite C07 tool/prompt assertions.
- [ ] Test empty/status, lint clean/dirty/truncated, reindex, invalid syntax, domain error, and abort.
- [ ] Assert command registration descriptor and result text are stable.
- [ ] Dispose the owning fiber and assert command removal; remount once without duplicate registration.

### Acceptance

- [ ] The focused command test invokes empty input, `status`, `lint`, and `reindex` through the command registry, asserts zero model-service calls, and matches exact stable results.
- [ ] Unknown subcommands and extra tokens match the exact usage error and expose no stack/path/cause.
- [ ] A dirty lint corpus exceeding `commandDiagnosticLimit` returns exactly that many diagnostics plus the exact remaining-count text.

### Verification

- [ ] Run `pnpm exec vitest run tests/plugin.spec.ts -t 'command|wiki'`.
- [ ] Run `pnpm run typecheck`.

### Review/fix

- [ ] Review direct-command behavior against `@deepseek-ai/dsh-commands` exact contracts.
- [ ] Review cancellation and diagnostic truncation off-by-one behavior.
- [ ] Fix findings and rerun focused tests.
- [ ] Commit `src/command.ts` and the coordinated test hunk with `feat: add wiki maintenance command`.

---

## C09 — Wire the static Cordis plugin and dsh bundle

**Commit:** `feat: ship dsh bundle composition`  
**Depends on:** C07 and C08  
**Owned paths:** `src/index.ts`, `cordis.patch.yml`, `package.json` (sequential ownership received from C02; transferred to C11 after C09 commits)
**Status:** blocked on C07 and C08

### Implementation

- [ ] Export named `name = 'llmwiki'`, `inject = ['tools', 'commands', 'systemPrompt']`, `Config`, `apply`, service class, public DTOs, branded constructors, and domain error types from `src/index.ts`.
- [ ] Do not add a default export.
- [ ] In `apply`, construct/register `LlmWikiService`, then register prompt/tools/command only through the service and current Cordis fiber.
- [ ] Ensure activation is dependency-key driven and contains no assumptions about patch row order.
- [ ] Create `cordis.patch.yml` as one bundle patch insert with `id: llmwiki`, `name: dsh-llmwiki`, and the complete default config from `PLAN.md`.
- [ ] After creating the patch, add `dsh.bundle.patch: ./cordis.patch.yml` plus `./cordis.patch.yml` export and `files` allowlist entries to `package.json`; these fields must not have existed in C01.
- [ ] Confirm users can replace the row's complete config from a profile patch and can disable/remove the row for rollback.
- [ ] Keep the package host-only: no `dsh.client`, `./client`, slots, browser dependencies, CSS, server, or RPC surface.

### Acceptance

- [ ] The C09 Node import command exits zero, prints `llmwiki` plus the exact inject array, and fails if a default export exists.
- [ ] A Loader composition using the bare package specifier activates the plugin from the one bundled patch row; `pnpm pack --dry-run --json` shows no wrapper package or client artifact.
- [ ] A disable/remove/re-enable composition test hashes `.llmwiki` before and after and asserts equality.

### Verification

- [ ] Run `pnpm run typecheck`.
- [ ] Run `pnpm run build`.
- [ ] Run `node -e "import('./lib/index.js').then(m => { if ('default' in m) process.exit(1); console.log(m.name, m.inject) })"`.
- [ ] Run `pnpm pack --dry-run` and confirm `cordis.patch.yml` is included exactly once.

### Review/fix

- [ ] Compare `package.json`/`cordis.patch.yml` shape with dsh `packages/bundle/base` and named plugin shape with `packages/extensions/tool-cordis`.
- [ ] Review the full default config in patch and schema for exact agreement.
- [ ] Fix findings and rerun build/import/pack checks.
- [ ] Commit C09-owned changes with `feat: ship dsh bundle composition`.

---

## C10 — Complete contract, lifecycle, Loader, and built-package tests

**Commit:** `test: cover llmwiki contracts and loader lifecycle`  
**Depends on:** C09  
**Owned paths:** `tests/plugin.spec.ts`, `tests/loader.e2e.spec.ts`, `tests/built-package.e2e.spec.ts`, `tests/harness.ts`; sequential ownership of `tests/plugin.spec.ts` transfers from C07/C08 and `tests/harness.ts` from C06 when C10 begins
**Status:** blocked on C09

### Implementation/testing

- [ ] Consolidate the shared real Cordis test harness; mock only nondeterministic/external boundaries (none should be needed for core wiki I/O).
- [ ] Add a complete HMR lifecycle test that mounts all required dsh services and llmwiki, observes service/tools/prompt/command, disposes llmwiki, proves removal, and remounts cleanly.
- [ ] Assert `'default' in importedModule` is false.
- [ ] Exercise dsh's actual export-unwrapping/Loader behavior so replacing named exports with a default export makes the test fail.
- [ ] Boot a test-only Cordis configuration through the real Loader using the bare package entry and exact required service rows.
- [ ] In the real registry/Loader path, exercise each tool with valid declared parameters, invalid values for every declared parameter category, and irrelevant unknown top-level keys; assert invalid declared values fail safely and unknown keys neither alter service inputs nor affect results, without expecting the open compiled parameter object itself to reject unknown keys.
- [ ] Invoke status, add-source, upsert-page, search, read, lint, and `/wiki` through registries in the Loader composition; assert durable files externally.
- [ ] Prove row order does not matter by placing llmwiki before at least one dependency in the test composition and observing eventual activation.
- [ ] Test missing required dependency leaves plugin pending/unavailable and adding/removing that dependency activates/unloads it according to Cordis lifecycle.
- [ ] Build before built-artifact tests; launch plain Node against `lib/index.js` rather than tsx/source paths.
- [ ] Resolve `dsh-llmwiki/cordis.patch.yml` via package exports from the built/packed package and parse the patch.
- [ ] Assert a genuinely missing/malformed composition exits non-zero rather than swallowing load failure.
- [ ] Keep every e2e temporary profile/wiki self-owned and disposed in `afterEach` even after failures.

### Acceptance

- [ ] `pnpm run build && pnpm run test:e2e` loads through the bare built/package entry; a guard fails if any test substitutes a source/private import for that path.
- [ ] Tool contract assertions prove all supported parameters are explicitly declared, invalid declared fields are rejected/handled, unknown top-level keys cannot affect behavior, and every structured output/value object is closed where the dsh schema surface supports closure.
- [ ] The named-export, exact-inject, disposal/remount registry-count, and package-resolution assertions each run in the C10 suites and exit zero.
- [ ] Registry-invoked mutations are followed by external byte/hash assertions for source and page files.

### Verification

- [ ] Run `pnpm exec vitest run tests/plugin.spec.ts`.
- [ ] Run `pnpm run build && pnpm run test:e2e`.
- [ ] Temporarily introduce a local default-export regression, observe the Loader guard fail, revert it, and rerun green; do not commit the regression.
- [ ] Run `pnpm run typecheck`.

### Review/fix

- [ ] Review tests for hand-built stand-ins that bypass shipping Loader/package paths.
- [ ] Review teardown for leaked fibers, temp profiles, environment changes, or unhandled subprocesses.
- [ ] Fix findings and rerun C10 verification.
- [ ] Commit C10-owned paths with `test: cover llmwiki contracts and loader lifecycle`.

---

## C11 — Add docs, runnable example, determinism check, and smoke

**Commit:** `docs: add llmwiki usage and runnable example`  
**Depends on:** C10  
**Owned paths (docs/example):** `README.md`, `examples/README.md`, `examples/cordis.yml`, `examples/demo-wiki/schema.md`, `examples/demo-wiki/pages/getting-started.md`  
**Owned paths (evidence/example):** `examples/demo-wiki/sources/<fixture-sha256>/content`, `examples/demo-wiki/sources/<fixture-sha256>/metadata.json`, `scripts/check-determinism.ts`, `scripts/smoke.ts`, `package.json` (sequential ownership received from C09 solely to add the two script entries, then transferred to C12)  
**Status:** blocked on C10

### Documentation

- [ ] Write README overview that explicitly distinguishes Karpathy's idea-file principles from this repository's implementation choices.
- [ ] Document the supported exact dsh rc.6, Cordis, and Schemastery versions, Node/pnpm requirements, installation as profile bundle, direct Cordis row installation, and clean removal/rollback; explain that exact pins avoid the older rc.1 `latest` and that rc.5 is unpublished despite matching the inspected API.
- [ ] Document complete default config and warn that dsh patch overrides replace the entire row config rather than deep-merge it.
- [ ] Document exact `.llmwiki` layout, source immutability, page frontmatter subset, logical page IDs, single-writer limitation, derived-index deletion/rebuild, and symlink policy.
- [ ] Document all seven tool names with mutation/read behavior, bounded outputs, and evidence expectations.
- [ ] Document `/wiki [status|lint|reindex]` and that it does not trigger a model turn.
- [ ] Document deterministic tokenizer/BM25/tie-break/snippet behavior sufficiently for users to understand reproducibility without exposing irrelevant implementation trivia.
- [ ] Document every lint diagnostic category, read-only behavior, and manual recovery for abandoned temps/corrupt index.
- [ ] Add security/privacy section: local-only, no network/subprocess/model calls, model-supplied source content, root containment, and no arbitrary path ingest.
- [ ] Add migration/versioning policy: source/page formats are durable; `.index` is versioned/disposable; future durable migrations must be explicit and copy-first.
- [ ] Add Model Experience with exact prompt literal, prompt section name/order, tool-schema context effect, bounded result behavior, and KV-cache effect.
- [ ] End README with Known Limitations and Deferred Work: single process writer, UTF-8 text sources only, no delete/fix/UI/vector/graph/sync, no cross-process lock.

### Example

- [ ] Create a minimal `examples/cordis.yml` composition using the built package and required dsh services; do not depend on source-only path aliases.
- [ ] Create example schema guidance and one evidence-backed page with canonical frontmatter.
- [ ] Commit exact example source content and metadata whose directory/hash/byte count are independently verified.
- [ ] Omit example `.index` so running the example proves rebuildability.
- [ ] Write example README with exact run commands and expected status/search/lint outcomes.

### Determinism script

- [ ] Implement `scripts/check-determinism.ts`, executed with `tsx` after `pnpm run build`, to import only public named exports from built `lib/index.js`; create two fresh wiki roots with identical logical content but different creation order/mtimes.
- [ ] Run indexing/search/lint through those built public service APIs and compare exact canonical `search.json`, `state.json`, and normalized search/lint result bytes.
- [ ] Fail non-zero while printing the first differing artifact and byte offset; clean both roots in `finally`.
- [ ] Ensure script contains no fixture-update mode and never rewrites committed goldens.
- [ ] After `scripts/check-determinism.ts` exists, add `check:determinism` to `package.json` using `tsx`; do not alter C09 bundle metadata or unrelated manifest fields.

### Smoke script

- [ ] Implement `scripts/smoke.ts`, executed with `tsx` after `pnpm run build`, to import only built `lib/index.js`; boot real Cordis composition, initialize a temp wiki, add source, write page, search/read/lint, invoke command, and dispose.
- [ ] After disposal, externally reread source/page bytes, assert source hash and zero lint errors, and confirm registries no longer expose llmwiki contributions.
- [ ] Fail non-zero with the failed assertion named and clean the temporary profile/wiki in `finally`; `pnpm run smoke` must fail clearly if `lib/index.js` is absent, so verification always builds first.
- [ ] After `scripts/smoke.ts` exists, add `smoke` to `package.json` using `tsx`; both newly added scripts must name their real C11 targets and contain no fallback/`|| true` behavior.

### Acceptance

- [ ] Following `README.md` in a clean temporary directory installs the packed package, boots the example, exercises status/search/lint, disables the row, and exits zero at every documented command.
- [ ] A documentation audit script/assertion compares every config default, tool name, and command token in README tables with exported runtime definitions and exits zero.
- [ ] The exact example corpus produces zero lint errors and a search whose first hit is `getting-started` at the documented line.
- [ ] `pnpm run check:determinism` byte-compares both roots and `pnpm run smoke` completes the built-package lifecycle; neither script scans source text to claim success.

### Verification

- [ ] Run `pnpm run build`.
- [ ] Run `pnpm run check:determinism`.
- [ ] Run `pnpm run smoke`.
- [ ] Run the exact commands in `examples/README.md` from a clean temporary directory.
- [ ] Run a focused documentation audit comparing README config/tool/command tables with `src/config.ts`, `src/tools.ts`, and `src/command.ts`.

### Review/fix

- [ ] Review example files as user-facing durable data: hash, byte count, source reference, canonical page format, and no generated index.
- [ ] Review docs for claims not exercised by tests/smokes; remove or add proof.
- [ ] Fix findings and rerun C11 verification.
- [ ] Commit C11-owned paths with `docs: add llmwiki usage and runnable example`.

---

## C12 — Repository hygiene, coverage, package, and clean-profile release gates

**Commit:** `chore: finalize package and release gates`  
**Depends on:** C11  
**Owned paths:** `.npmignore` plus sequential cleanup ownership of `.gitignore`, `LICENSE`, `package.json`, `pnpm-lock.yaml`, `pnpm-workspace.yaml`, `tsconfig.json`, `tsconfig.eslint.json`, `tsdown.config.ts`, `vitest.config.ts`, `vitest.e2e.config.ts`, and `eslint.config.js` (package ownership arrives through C01→C02→C09→C11→C12; lock ownership arrives through C01→C02→C12); minimal behavior fixes return to their original source/test/doc owner and use scoped `fix:` commits
**Status:** blocked on C11

### Repository cleanup

- [ ] Audit and tighten the C01 `.gitignore`; it already protects generated artifacts before this chunk begins.
- [ ] Add `.npmignore` only if the `files` allowlist does not fully express exclusions; verify it cannot exclude required declarations/patch/readme/license.
- [ ] Verify the C01 MIT license text and holder/year match `package.json`; correct either under C12's sequential ownership if necessary.
- [ ] Under C12's explicit sequential ownership, delete scaffolding, unused exports/imports/dependencies, duplicate helpers, stale comments, fixture-update utilities, and generated local artifacts; update `package.json`, lockfile, and build/type/lint/test configs together when dependency/config cleanup requires it.
- [ ] Add a `prepack` lifecycle that performs a clean production build before packing now that sources and the complete public package surface exist; verify a stale `lib/` cannot enter the tarball and keep this lifecycle out of C01 while no source entry exists.
- [ ] Confirm no `TODO`, placeholder, no-op, fake fallback, hidden network/subprocess/model call, UI/client/server/vector/graph code, or undocumented delete/fix operation remains.
- [ ] Confirm no `AGENTS.md` was fabricated; add one only if actual implementation produced durable repository-specific lessons, and if so update the plan/file tree/checklist before doing it.

### Focused and full gates

- [ ] Run `pnpm install --frozen-lockfile`.
- [ ] Run `pnpm run typecheck`.
- [ ] Run `pnpm run lint`.
- [ ] Run `pnpm run test`.
- [ ] Run `pnpm run test:coverage`; Vitest 4.1.8 V8 must report every `src/**/*.ts` file included via `coverage.include` at or above 90% lines, 90% statements, 90% functions, and 85% branches with `coverage.thresholds.perFile: true`, without obsolete `coverage.all`, top-level `coverage.perFile`, plumbing-only tests, or exclusions of reachable lines.
- [ ] Run `pnpm run build`.
- [ ] Run `pnpm run test:e2e`.
- [ ] Run `pnpm run check:determinism`.
- [ ] Run `pnpm run smoke`.
- [ ] Run `pnpm pack --dry-run`; inspect every included path and package size.

### Packed-tarball clean-profile gate

- [ ] Create a packed tarball with `pnpm pack` in a temporary output directory.
- [ ] Create a clean temporary dsh profile/project outside this repository.
- [ ] Install the tarball through the supported dsh plugin/profile flow.
- [ ] Boot dsh with the installed bundle and no source-path aliases.
- [ ] Exercise status, source add, page upsert, search/read, lint, `/wiki status`, `/wiki lint`, and `/wiki reindex` through the real surface available in that profile.
- [ ] Stop dsh and externally verify durable source/page bytes and disposable index.
- [ ] Remove/disable the bundle row, boot again, prove llmwiki contributions are absent and `.llmwiki` remains untouched.
- [ ] Re-enable/reinstall the same package, boot, and prove the existing wiki is readable and lint result unchanged.
- [ ] Clean the temporary profile, project, tarball, and any dsh state created specifically for this gate.

### Acceptance

- [ ] From a dependency-clean state, run `pnpm install --frozen-lockfile`, `pnpm run typecheck`, `pnpm run lint`, `pnpm run test`, `pnpm run test:coverage`, `pnpm run build`, `pnpm run test:e2e`, `pnpm run check:determinism`, `pnpm run smoke`, and `pnpm pack --dry-run`; record a zero exit code for each.
- [ ] Install the produced tarball into a temporary profile with repository source renamed/unavailable; boot and exercise the listed surfaces successfully.
- [ ] Hash durable source/page files before disable and after re-enable and assert equality; assert llmwiki registry entries are absent while disabled.
- [ ] After cleanup, an explicit repository status/artifact audit finds no untracked/generated `lib`, coverage, `.index`, temp-root, tarball, or dependency output.

### Review/fix

- [ ] Classify any gate failure to its owning chunk; fix the source rather than weakening the gate or special-casing the fixture.
- [ ] Rerun the smallest failing command, then all C12 gates after the fix.
- [ ] Commit only cleanup/config/gate changes with `chore: finalize package and release gates`; use a scoped `fix:` commit instead if behavior changed.

---

## C13 — Final split review and release tracker closure

**Commit:** no mandatory commit; use scoped `fix:` commits for findings, then rerun gates  
**Depends on:** C12  
**Owned paths:** review-only across the repository; fixes return to the owning chunk paths  
**Status:** blocked on C12

### Review A — domain, safety, and determinism

- [ ] Review `src/types.ts`, `src/errors.ts`, `src/ids.ts`, and `src/paths.ts` for public-contract ambiguity, unchecked casts, traversal, symlink, and path privacy failures.
- [ ] Review `src/atomic.ts` and `src/markdown.ts` for crash consistency, partial writes, cleanup masking errors, descriptor leaks, and canonical-format ambiguity.
- [ ] Review `src/tokenizer.ts` and `src/indexer.ts` for locale/time/random dependence, unstable sorting, floating edge cases, stale-index acceptance, and snippet byte bugs.
- [ ] Review `src/lint.ts` for mutation, incomplete invariants, false traversal acceptance, unstable diagnostics, and absolute-path leakage.
- [ ] Review `src/service.ts` for queue starvation/races, cancellation false success, source overwrite, index/data coupling, and configuration bypass.
- [ ] Run an integration import scan across every C03–C10 filesystem callsite and prove each imports the C02 ID/path/error primitives rather than redeclaring brands, path containment, source-ID validation, or page-ID normalization.
- [ ] Reproduce at least: `../` escape, symlink escape, source hash mismatch, aborted queued write, interrupted temp file, malformed index, equal-score tie, and two-root determinism.
- [ ] Confirm lint leaves the complete tested file tree byte-identical.
- [ ] Confirm deleting `.index` and rerunning search restores equivalent derived output.
- [ ] Record each finding with severity, exact path/symbol, reproduction, and owning chunk; resolve every finding or explicitly prove it invalid.

### Review B — dsh integration, packaging, and user/model experience

- [ ] Review `src/config.ts`, `src/index.ts`, `src/tools.ts`, `src/prompt.ts`, `src/presentation.ts`, and `src/command.ts` against exact dsh APIs cited in `PLAN.md`.
- [ ] Confirm named exports, exact `inject`, Schemastery Config, `ctx.llmwiki`, seven tool registrations, prompt section, and command are fiber-owned and HMR-clean.
- [ ] Confirm tools preserve `defineTool`, explicitly declare and validate every supported parameter, do not rely on unknown top-level keys, use closed structured output/value schemas where supported, and retain pure rendering/presentation, bounded results, safe errors, and `exec.signal`.
- [ ] Confirm `/wiki` is lowercase, abortable, direct/no-model, bounded, and mutation-limited to reindexing derived data.
- [ ] Review `package.json`, build configs, and `cordis.patch.yml` for the installable exact rc.6 dsh peer/dev pins, exact Cordis/Schemastery versions, public exports, bundle metadata, complete config replacement, host-only scope, and tarball contents; confirm no unpublished rc.5 or rc.1 dist-tag resolution remains.
- [ ] Review Loader and built-artifact tests for bypasses/mocks that would let a broken package ship.
- [ ] Review README/example against actual tool names, prompt literal, defaults, filesystem format, limitations, rollback, and tested behavior.
- [ ] Confirm no browser UI, HTTP server, hosted sync, graph, embedding/vector, SQLite, watcher, subprocess, network, hidden LLM call, delete tool, or lint fixer entered scope.
- [ ] Record each finding with severity, exact path/symbol, reproduction, and owning chunk; resolve every finding or explicitly prove it invalid.

### Post-review fixes and regression verification

- [ ] Apply each Review A finding in its original owning paths and add/strengthen an observable regression test that fails on the reproduced bug where appropriate.
- [ ] Apply each Review B finding in its original owning paths and update docs/examples only after behavior is fixed.
- [ ] Use conventional `fix(<scope>): ...` commits for behavior findings; use `docs:`/`test:`/`chore:` only when behavior truly does not change.
- [ ] Rerun the focused test/command for every finding immediately after its fix.
- [ ] Rerun all C12 gates after the final finding is fixed.
- [ ] Rerun the packed-tarball clean-profile install, exercise, rollback, and re-enable scenario after any packaging/integration fix.

### Final tracker audit

- [ ] Confirm every earlier checkbox is either completed or has a documented, approved scope change reflected in both `PLAN.md` and this checklist; no silent skips.
- [ ] Confirm every target file in `PLAN.md` exists and every extra committed file has a documented purpose.
- [ ] Confirm all affected call sites, tests, docs, examples, package exports, and patch metadata agree.
- [ ] Confirm all conventional commits are ordered as planned and each is reviewable; no generated artifacts or unrelated changes are included.
- [ ] Confirm repository status is clean after all generated outputs are removed.
- [ ] Record the exact verified Node, pnpm, dsh package, and operating-system versions in the release/PR description (not a new repository file unless release process requires it).
- [ ] Record exact successful gate commands and packed-profile scenario outcome in the release/PR description.
- [ ] Close the implementation tracker only when Review A and Review B have zero unresolved findings and every release gate is green.

## Planned commit ledger

- [ ] `chore: initialize dsh-llmwiki package`
- [ ] `feat: add safe wiki filesystem primitives`
- [ ] `feat: add canonical wiki markdown persistence`
- [ ] `feat: add deterministic wiki search index`
- [ ] `feat: add deterministic wiki linting`
- [ ] `feat: add llmwiki service orchestration`
- [ ] `feat: expose llmwiki model tools and prompt`
- [ ] `feat: add wiki maintenance command`
- [ ] `feat: ship dsh bundle composition`
- [ ] `test: cover llmwiki contracts and loader lifecycle`
- [ ] `docs: add llmwiki usage and runnable example`
- [ ] `chore: finalize package and release gates`
- [ ] Any review-driven `fix(<scope>): ...` commits are inserted immediately after the finding is resolved and listed in the PR/release description.

## Planning correction disposition

- [x] Recorded the exact verified pnpm, Node, dsh/Cordis peer, Schemastery, TypeScript, ESLint, TypeScript-ESLint, tsdown, tsx, Vitest/coverage, and Node-types contract.
- [x] Removed C01's premature determinism/smoke scripts and assigned creation plus manifest wiring to C11 without changing chunk IDs or dependency edges.
- [x] Removed C01's premature bundle patch export/files requirements and retained their creation and manifest wiring in C09.
- [x] Clarified that the orchestrator's install verification generates `pnpm-lock.yaml`; workers do not hand-author it.
- [x] Replaced obsolete Vitest coverage semantics with `coverage.include` and `coverage.thresholds.perFile`.
- [x] Replaced unpublished dsh rc.5 pins with installable exact rc.6 peer/dev pins, recorded primary npm evidence and byte-identical rc.6 declaration/runtime compatibility with the inspected local rc.5 APIs, and prevented fallback to the older rc.1 `latest`.
- [x] Replaced the impossible closed top-level `defineTool` parameter-schema requirement with explicit declared parameters, invalid-declared-field validation, no behavioral reliance on unknown keys, and closed structured output/value objects where supported; updated C07/C10 tests and Review B disposition without changing chunk IDs or dependencies.
- [x] Corrected the pnpm `11.7.0` build-policy location: package-level `pnpm` settings are ignored, so C01 now owns and commits the exact minimal root-only `pnpm-workspace.yaml` policy specified in C01; omitted dependencies remain denied by default `strictDepBuilds: true`, `minimumReleaseAgeExclude` is unrelated, and both ignored-build checks must print `None`.
- [x] Discarded the prior prohibition on `pnpm-workspace.yaml` and the `pnpm.onlyBuiltDependencies` requirement because both contradict pnpm `11.7.0`'s official project-policy behavior.
- [x] Replaced C01's premature `tsc --showConfig` gate after observing TS18003 with no source inputs: C01 uses an executable Node assertion over raw compiler options, and C02 retains the first real typecheck after creating `src` files.
- [x] Replaced `pnpm run lint -- --no-warn-ignored` with `pnpm run lint --no-warn-ignored` after observing pnpm `11.7.0` forward the standalone separator literally to ESLint; zero warnings remain mandatory.
- [x] Corrected `test:e2e` to require a dedicated `vitest.e2e.config.ts` with a real Vitest `include`, and reopened only the affected C01 acceptance/review gates while implementation fixes are pending.
- [x] Added C01-owned `tsconfig.eslint.json` and an explicit typed-lint project strategy covering future source, tests, scripts, and root TypeScript configuration files; reopened the affected acceptance/review gates.
- [x] Narrowed `pnpm-workspace.yaml#allowBuilds` from an all-version package key to exact `esbuild@0.28.2` and reopened its affected acceptance/review gates.
- [x] Replaced incompatible `@typescript-eslint` `8.56.0`, whose primary parser registry manifest limits TypeScript to `<6.0.0`, with exact stable parser/plugin `8.67.0`; primary parser/plugin manifests allow TypeScript `<6.1.0` and ESLint 9, including exact TypeScript `6.0.3` and ESLint `9.39.2`. Reopened the affected C01 dependency, install, lint, and review items until install/frozen-install and typed lint are reverified.
- [x] Deferred the clean-build `prepack` lifecycle and stale-output check to C12, where source and package outputs exist; C01 is not incomplete for omitting it.
- [x] Discarded the Node `>=24` complaint because the engine range describes plugin runtime/production compatibility with the exact dsh host contract; dev-only Babel parser engine metadata does not constrain consumers.
- [x] Discarded the frozen-install failure claim as stale after the dependency-clean pnpm `11.7.0` install exited zero under the corrected workspace policy; frozen install remains a later gate.
- [ ] Pending C02 pre-gate: add exact direct `@deepseek-ai/dsh-brand@0.1.0-rc.6` peer/dev ownership, regenerate the lockfile under C01→C02 transfer, use its `Branded<B>` type, narrow the C02 import scan to existing modules, defer the all-callsite scan to C13, and enforce real-directory-only configured roots.
