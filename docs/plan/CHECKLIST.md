# dsh-llmwiki implementation checklist

## How to use this tracker

- Every unchecked item is actionable. Mark an item `[x]` only after its stated acceptance and verification complete.
- Work chunks in dependency order. Chunks explicitly marked parallel-safe may run concurrently only after their dependencies are complete.
- Each implementation chunk owns its listed paths until an explicit sequential transfer in this file. Parallel chunks must not edit the same path; later integration chunks may edit a transferred path only after every earlier owner has committed it.
- `PLAN.md` is the architecture authority. A necessary design change must update `PLAN.md` and this checklist in the same commit before implementation proceeds.
- Status at planning handoff: **all implementation, review, verification, and release items are not started**. `PLAN.md` and this file are the only completed artifacts; no plugin code exists.
- Required commit style is Conventional Commits. Run no unrelated repository-wide commands between a chunk's implementation and its focused verification.
- Historical tracker status: **C01–C13 COMPLETE for their original deterministic-plugin scope**. The C14–C19B follow-up below is not complete; `GAP-SCHEMA` is intentionally unresolved and C19B is externally blocked.

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
- C10's discovered test-only direct dependency contract is exact development dependencies `@deepseek-ai/cordis-plugin-loader@1.0.2` and `node-addon-require-builtin@0.1.4`. Its patch-parsing paths do not import `@deepseek-ai/cordis-plugin-include`; exact `@deepseek-ai/cordis-plugin-include@1.0.6` remained transitive and unused by C10, so the provisional direct development pin was removed under the conditional contract. C10 may update `package.json` and the pnpm-generated `pnpm-lock.yaml` resolutions solely for the required Loader/helper dependencies.
- C01 may declare only scripts whose target files/configuration exist at C01 completion. C11 creates the determinism/smoke targets and then adds their package scripts; C09 creates the bundle patch and only then adds its manifest publication fields. Shared manifest ownership is sequential: C01→C02→C09→C10→C11→C12 for `package.json`; C01→C02→C10→C12 for `pnpm-lock.yaml`. C02's manifest/lock delta is narrowly limited to exact `@deepseek-ai/dsh-brand@0.1.0-rc.6` peer+dev entries and the pnpm-generated lock update; C10's delta is narrowly limited to its exact Loader/helper test dependencies and generated lock update, with Include retained only as an unused transitive resolution rather than a direct pin.
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
**Owned paths:** `src/types.ts`, `src/errors.ts`, `src/ids.ts`, `src/paths.ts`, `tests/ids-paths.spec.ts`, `package.json` and `pnpm-lock.yaml` (sequential ownership received from C01; add only exact dsh-brand peer/dev entries and generated lock resolution; transfer `package.json` to C09 and `pnpm-lock.yaml` to C10 after C02 commits)  
**Status:** complete. Implementation, acceptance, verification, three independent reviews, and commit are complete. Committed as `a614926` (`feat: add safe wiki filesystem primitives`).

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
- [x] Commit C02-owned paths with `feat: add safe wiki filesystem primitives`; committed as `a614926`.

---

## C03 — Add atomic persistence and canonical Markdown

**Commit:** `feat: add canonical wiki markdown persistence`  
**Depends on:** C02  
**Owned paths:** `src/atomic.ts`, `src/markdown.ts`, `tests/markdown.spec.ts`, `tests/fixtures/corpus/source-a.txt`, `tests/fixtures/corpus/source-b.txt`  
**Status:** complete. Implementation, acceptance, verification, review/fix, and commit are complete. Committed as `e558c29` (`feat: add canonical wiki markdown persistence`).

### Implementation

- [x] Implement canonical UTF-8 encode/decode helpers with explicit invalid-UTF-8 failure where bytes are read from disk.
- [x] Implement sibling temporary-file writes using exclusive creation, complete write, file sync where supported, close, atomic rename, and best-effort directory sync.
- [x] Guarantee temp cleanup on validation failure, I/O failure, abort, and rename failure; never report success before rename completes.
- [x] Use collision-resistant temporary names only for ephemeral files; deterministic persisted output must never contain the random name.
- [x] Implement strict frontmatter parser for exactly `title`, `summary`, and `sources`; reject aliases, tags, anchors, multiline YAML features, duplicate keys, unknown keys, malformed lists, duplicate source IDs, and unsorted source IDs.
- [x] Implement canonical renderer with fixed key order, normalized LF line endings, YAML-safe quoted strings, sorted unique source IDs, one blank line after frontmatter, and a final newline.
- [x] Require non-empty trimmed title, summary, source list, and Markdown body; preserve body content except documented line-ending/final-newline normalization.
- [x] Implement ATX-heading section splitting with heading trail and one-based line positions; fenced-code `#` lines must not become headings. Regression coverage confirms a lower-level heading is replaced when a higher-level heading follows, while the valid H2 ancestor is retained when H4 is followed by H3.
- [x] Add exact fixture source bytes in `tests/fixtures/corpus/source-a.txt` (ASCII, accented Unicode, CJK, final newline) and `source-b.txt` (CJK, no final newline), with byte-for-byte UTF-8 decode/encode assertions.

### Tests

- [x] Round-trip canonical pages byte-for-byte.
- [x] Cover every malformed/unknown/duplicate frontmatter case.
- [x] Cover quotes, colon/hash characters, Unicode, CRLF normalization, empty body, size boundary behavior, and symmetric render/parse rejection of U+2028 line separators and U+2029 paragraph separators in `title` and `summary`.
- [x] Cover heading hierarchy, repeated headings, headingless preamble, fenced code, exact line numbers, and the heading-level ancestor replacement/retention regression cases.
- [x] Simulate write/rename failure and abort; assert old target remains byte-identical and no temp remains. Also cover pre-abort, path-validation failure before temp creation, and late abort after committed rename.
- [x] Assert atomic replacement never exposes a partially rendered page to an external read after completion.

### Acceptance

- [x] `pnpm exec vitest run tests/markdown.spec.ts` performs two parse/render cycles and byte-compares canonical output; all 40 focused tests pass, including symmetric U+2028/U+2029 rejection during rendering and parsing.
- [x] Injected write/rename/mid-operation-abort failures leave the prior target hash unchanged and no sibling temp files; pre-abort and path-validation failure create no target/temp, successful replacement leaves no temp, and late abort after rename preserves committed bytes without false failure.
- [x] A table-driven rejection test covers every unsupported YAML feature and malformed case listed in C03.

### Verification

- [x] `pnpm exec vitest run tests/markdown.spec.ts` exits zero with 40 focused tests passing after the U+2028/U+2029 symmetric rejection fix.
- [x] `pnpm run typecheck` exits zero after the fix.
- [x] `pnpm run lint` exits zero after the fix.

### Review/fix

- [x] Review persistence code for descriptor leaks, abort races, cleanup masking the primary error, and Windows rename assumptions; review result: clean.
- [x] Review canonical rendering for YAML ambiguity and non-deterministic ordering; fixed asymmetric acceptance by rejecting U+2028 and U+2029 in both rendering and parsing, then confirmed the review clean.
- [x] Fix findings and rerun focused tests; 40 focused tests, typecheck, and lint are green.
- [x] Commit C03-owned paths with `feat: add canonical wiki markdown persistence`; committed as `e558c29`.

---

## C04 — Build deterministic section indexing and BM25 search

**Commit:** `feat: add deterministic wiki search index`  
**Depends on:** C03  
**Parallel-safe with:** C05  
**Owned paths:** `src/tokenizer.ts`, `src/indexer.ts`, `tests/indexer.spec.ts`, `tests/fixtures/corpus/alpha.md`, `tests/fixtures/expected/search.json`; implements the exact `IndexStateV1`/`SearchIndexV1` contract in `PLAN.md` §3.4
**Status:** complete. Implementation, acceptance, verification, three independent reviews, commit, and merge are complete. Committed as `401f364` (`feat: add deterministic wiki search index`). The merged C04/C05 union passed all 36 combined tests, typecheck, and lint.

### Implementation

- [x] Implement NFKC lowercase Unicode letter/number tokenization without locale-sensitive APIs.
- [x] Emit CJK runs and overlapping 2-character grams for runs longer than one character; document exact behavior in code comments and tests.
- [x] Discover pages recursively without following symlinks and sort logical paths by code-unit comparison.
- [x] Fingerprint exact page bytes with SHA-256 and build sorted section records from the canonical Markdown parser.
- [x] Implement the exact closed `IndexStateV1` and `SearchIndexV1` JSON schemas, field order, sort order, numeric/hash validation, and `formatVersion: 1` contract from `PLAN.md` §3.4; permit only `averageSectionLength` as a finite non-negative floating-point numeric field, require every integer-count field to remain a non-negative safe integer (and positive where specified), and reject every unknown/incompatible/malformed field as derived-index corruption.
- [x] Serialize canonical JSON with the contract's fixed key insertion order, sorted arrays, two-space indentation, and final newline.
- [x] Implement fixed BM25 (`k1=1.2`, `b=0.75`) and title/heading/body boosts (`2.0/1.5/1.0`).
- [x] Deduplicate query tokens, reject empty/tokenless queries, cap limit by configuration, and reject non-finite scores.
- [x] Tie-break by page ID then section start line.
- [x] Generate deterministic snippets capped by UTF-8 bytes without splitting code points; include page, heading trail, start line, score, snippet, and source IDs.
- [x] Rebuild when page fingerprint mapping differs or index data is absent/incompatible/malformed; never trust mtimes for freshness.
- [x] Atomically write canonical `search.json` first and `state.json` second; set `state.searchSha256` to the exact search bytes. Freshness requires that hash and both page mappings to match, so a crash/mismatched pair always forces rebuild.

### Tests

- [x] Test ASCII/Unicode/CJK token output and normalization.
- [x] Test title/heading/body boosts, document length normalization, repeated terms, query dedupe, and stable ties.
- [x] Test deterministic page discovery and section line numbers.
- [x] Test exact golden `search.json` bytes and rebuild equivalence across two roots with different mtimes; explicitly reject fractional, negative, unsafe, NaN, and infinite values for integer-count fields while accepting valid finite non-negative fractional `averageSectionLength`.
- [x] Test stale, absent, malformed, unknown-version, and mismatched state/index behavior.
- [x] Test result caps, UTF-8 snippet caps, empty result, and tokenless query rejection.
- [x] Test symlinked pages/directories are rejected rather than indexed.

### Acceptance

- [x] The focused indexer test creates equivalent durable corpora with different creation order, mtimes, roots, timezone, and locale, then byte-compares `search.json` and `state.json`; capture-time source metadata is intentionally excluded from that cross-root derived-output comparison.
- [x] The test runs identical query/index/config inputs twice and deep-compares serialized ordered result JSON.
- [x] The test deletes `.index`, searches again, and asserts durable page/source hashes are unchanged and rebuilt derived bytes equal the original.

### Verification

- [x] Run `TZ=UTC LC_ALL=C pnpm exec vitest run tests/indexer.spec.ts` (24 tests passed).
- [x] Run the same focused test with one alternate available timezone/locale and compare the golden result; deterministic golden bytes and hashes matched.
- [x] Run `pnpm run typecheck`.
- [x] Run `pnpm run lint`.

### Review/fix

- [x] Independent review 1: scoring math is clean for NaN/Infinity rejection, zero-length corpus behavior, and deterministic floating-point formatting.
- [x] Independent review 2: index commit ordering is clean for crash consistency.
- [x] Independent review 3: full C04 implementation, tests, and golden bytes are clean; no fixes or golden regeneration were required.
- [x] Commit C04-owned paths with `feat: add deterministic wiki search index`; committed as `401f364`, merged successfully, and the merged C04/C05 union passed all 36 combined tests, typecheck, and lint.

---

## C05 — Implement deterministic, read-only lint

**Commit:** `feat: add deterministic wiki linting`  
**Depends on:** C03  
**Parallel-safe with:** C04; both chunks consume the immutable `IndexStateV1`/`SearchIndexV1` contract already fixed in `PLAN.md` §3.4, and C05 must not edit C04-owned paths  
**Owned paths:** `src/lint.ts`, `tests/lint.spec.ts`, `tests/fixtures/corpus/beta.md`, `tests/fixtures/expected/lint.json`
**Status:** complete, committed as `fe2ae1b` (`feat: add deterministic wiki linting`), merged successfully, and verified on the merged union with 36 combined tests, typecheck, and lint passing

### Implementation

- [x] Define the complete stable diagnostic code table for schema/root/source/page/link/index/temp failures.
- [x] Implement sorted diagnostics ordered by path, line with missing last, code, then message using code-unit comparison.
- [x] Check root layout, `schema.md`, directory types, UTF-8 validity, and all symlink/root-escape conditions.
- [x] Verify each source directory name equals SHA-256 of exact `content`; validate immutable metadata schema and byte count, treating a valid capture time as provenance rather than a cross-root determinism input.
- [x] Validate every page path and canonical frontmatter/body contract without rewriting it.
- [x] Report duplicate normalized titles.
- [x] Parse relative Markdown links outside fenced code; validate page targets and reject links escaping `pages/`. Ignore external URL schemes and same-page anchors by documented rule.
- [x] Validate derived index presence/freshness against every field, ordering, version, page mapping, and `searchSha256` rule in `PLAN.md` §3.4; missing index is a warning, stale data/hash mismatch is a warning, and malformed/unknown-version data is an error, with exact codes/messages frozen by tests.
- [x] Report abandoned atomic temporary files without deleting them.
- [x] Return summary counts by severity and total files examined.
- [x] Ensure lint performs no writes, index rebuild, timestamp touches, or silent repairs.

### Tests

- [x] Add one isolated fixture/case for every diagnostic code.
- [x] Test multiple diagnostics on one file and exact global ordering.
- [x] Test source content hash mismatch, metadata byte mismatch, malformed JSON, missing content, and unknown metadata keys.
- [x] Test duplicate titles under Unicode normalization.
- [x] Test valid/broken/escaping links, anchors, external URLs, image links, fenced-code pseudo-links, and exact link diagnostic line numbers.
- [x] Test missing/stale/malformed/incompatible index diagnostics against C04 format.
- [x] Snapshot exact canonical lint JSON in `tests/fixtures/expected/lint.json`.
- [x] Hash every fixture before/after lint and assert byte identity plus unchanged file set.

### Acceptance

- [x] The focused lint test runs twice, byte-compares canonical reports, and asserts no diagnostic path begins with the temporary absolute root.
- [x] Before/after snapshots compare every file's bytes, mtime, and path set and show no lint-created change.
- [x] A diagnostic-code coverage table maps every invariant in `PLAN.md` §3.5/§4.2 to either a tested lint code or a tested operation-time rejection, with no unmapped row.

### Verification

- [x] Run `TZ=UTC LC_ALL=C pnpm exec vitest run tests/lint.spec.ts` — 12 focused tests passed, covering deterministic diagnostic ordering/output, read-only filesystem snapshots, index validation, link diagnostic line numbers, symlinked index files, and symlinked required directories.
- [x] Run `pnpm run typecheck` — passed.
- [x] Run `pnpm run lint` — passed.

### Review/fix

- [x] Review diagnostic severity/message stability and path privacy; fixed symlink handling so index-file targets are never read and only stable relative-path diagnostics are emitted; review result: clean.
- [x] Review link parsing for false traversal acceptance and fenced-code false positives; also fixed required-directory symlinks to report exactly once without traversal or duplicate path diagnostics; review result: clean.
- [x] Fix findings and review any golden lint diff line by line; symlink regressions are covered by focused tests, the golden lint fixture required no change, and all 12 focused tests, typecheck, and lint are green.
- [x] Commit C05-owned paths with `feat: add deterministic wiki linting` — `fe2ae1b`; merged successfully, with merged-union gates passing (36 combined tests, typecheck, and lint).

---

## C06 — Orchestrate the `ctx.llmwiki` service

**Commit:** `feat: add llmwiki service orchestration`  
**Depends on:** C04 and C05  
**Owned paths:** `src/config.ts`, `src/service.ts`, `tests/service.spec.ts`, `tests/harness.ts` (C06 creates `tests/harness.ts`; ownership transfers sequentially to C10 only after C06 commits)
**Status:** complete, verified, review-clean, and committed as `bb3b354` (`feat: add llmwiki service orchestration`).

### Implementation

- [x] Define Schemastery `Config` with exact defaults/ranges from `PLAN.md`; resolve it once into a fully required immutable config.
- [x] Add `declare module '@deepseek-ai/cordis' { interface Context { llmwiki: LlmWikiService } }` in the service/public entry path.
- [x] Implement `LlmWikiService extends Service`, call `super(ctx, 'llmwiki')`, and expose only the planned public methods.
- [x] Initialize missing root/directories/default `schema.md` idempotently; never overwrite existing schema or user files.
- [x] Implement one FIFO in-process mutation queue covering initialization, source creation, page writes, and index rebuild commits; reads may run concurrently only when they cannot observe an in-flight partial operation.
- [x] Implement immutable source ingest with exact UTF-8 bytes, SHA-256 ID, canonical immutable metadata, exclusive creation, and idempotent dedupe. Capture time records the actual ingest event and is intentionally nondeterministic across fresh roots; dedupe within one root must preserve the first metadata byte-for-byte without rewriting capture time.
- [x] Enforce source/page size caps by UTF-8 byte count before durable mutation.
- [x] Implement byte-bounded source reads without splitting UTF-8 code points; define offset semantics unambiguously as byte offsets.
- [x] Implement page read/upsert; verify all referenced sources immediately before atomic commit.
- [x] Wire index freshness/rebuild/search and lint without duplicating their algorithms.
- [x] Invalidate derived state after successful page mutation; a failed page mutation must not invalidate a previously fresh index.
- [x] Observe abort before queued work begins and between I/O phases; remove cancelled queued work without starving later mutations.
- [x] Map expected filesystem failures into stable domain errors while retaining internal causes.

### Tests

- [x] Test first initialization, repeated initialization, pre-existing schema, and partial directory layouts.
- [x] Test exact source bytes, content hash, canonical metadata, capture-time variation across fresh roots without including metadata in derived-output determinism comparisons, dedupe within one root preserving the original metadata byte-for-byte, and the source size boundary.
- [x] Test read ranges including multibyte boundaries, zero/EOF offsets, and cap enforcement.
- [x] Test page create/update, unknown source rejection, page cap, old-file preservation, and index invalidation.
- [x] Test FIFO mutation ordering and concurrent deduplicated source creation.
- [x] Test queued and mid-operation cancellation and absence of false success.
- [x] Test corrupted on-disk source/page/index behavior maps to planned errors or lint output.
- [x] Test service disposal/remount does not retain queue state or handles.

### Acceptance

- [x] `pnpm exec vitest run tests/service.spec.ts` exercises every method in `PLAN.md` §4 and exits zero, including durable external rereads, aborts, limits, and corruption cases.
- [x] A static import-boundary assertion in `tests/service.spec.ts` fails if adapters import private filesystem modules instead of the service API.
- [x] Service tests compare externally reread source/page bytes with expected canonical bytes rather than accepting receipts alone.

### Verification

- [x] Run `pnpm exec vitest run tests/path.spec.ts tests/service.spec.ts` (64 combined path and service tests passed).
- [x] Run `pnpm run typecheck` (green).
- [x] Run `pnpm run lint` (green).
- [x] Audited fixes cover activation-root capture, prompt queued abort, UTF-8 ranges, safe regular-file/symlink/error handling, non-creating `acquireWikiPaths` symlink-ancestor containment, invalid-search preflight and cap semantics, evidence recheck, invalidation propagation, index/status/disposal behavior, mediaType validation, read-only lint behavior for absent and pristine roots, and expanded coverage for service orchestration boundaries.

### Review/fix

- [x] Review queue cancellation, atomic visibility, error leakage, and service lifecycle.
- [x] Review configuration defaults against `PLAN.md` and ensure every operational limit comes from resolved config.
- [x] Fix findings and rerun focused tests.
- [x] Commit C06-owned paths with `feat: add llmwiki service orchestration`; committed as `bb3b354`.

---

## C07 — Add model tools, presentation, and prompt

**Commit:** `feat: expose llmwiki model tools and prompt`  
**Depends on:** C06  
**Parallel-safe with:** C08 for owned source paths only; `tests/plugin.spec.ts` transfers sequentially as stated below  
**Owned paths:** `src/prompt.ts`, `src/presentation.ts`, `src/tools.ts`, `tests/plugin.spec.ts` (C07 owns and creates the test file; C08 may add only its coordinated command-test hunk after C07's tool/prompt hunk is committed; full-file ownership transfers sequentially to C10 after both C07 and C08 commit)  
**Status:** complete, verified, review-clean, committed as `d2714e2` (`feat: expose llmwiki model tools and prompt`), and merged successfully. The optional `llmwiki_read_source` byte range was fixed so omitted `offset`/`length` stay absent rather than becoming an unintended range; all seven exact tools are registered, prompt order `116` is verified, and presentation, schema, injection, and lifecycle coverage is recorded. The merged C07/C08 union passed all 43 service+plugin tests, typecheck, and lint.

### Implementation

- [x] Add the stable `LLMWIKI_SYSTEM_PROMPT` text exactly described by `PLAN.md`; keep it concise and free of deployment-specific values.
- [x] Register prompt section `tool:llmwiki` at order `116`.
- [x] Implement pure `presentCall` functions with stable titles/kinds for all seven tools.
- [x] Implement pure result presentation/fallbacks; search/read views must contain no hidden I/O or mutable state.
- [x] Register exactly `llmwiki_status`, `llmwiki_add_source`, `llmwiki_read_source`, `llmwiki_search`, `llmwiki_read_page`, `llmwiki_upsert_page`, and `llmwiki_lint` through `ctx.tools.register(defineTool(...))`.
- [x] Preserve `defineTool`; explicitly declare every supported top-level parameter with required flags, descriptions, and configured bounds. Because dsh compiles that top-level object open, do not claim closure or rely on unknown keys; reject/handle invalid values for declared fields and use closed structured output/value object schemas where supported, with canonical JSON values compatible with `@deepseek-ai/dsh-session`.
- [x] Ensure `llmwiki_add_source` accepts exact UTF-8 `content`, not arbitrary host paths.
- [x] Ensure `llmwiki_upsert_page` accepts structured title/summary/source IDs/body rather than raw unvalidated file bytes.
- [x] Translate expected `LlmWikiError` values into stable model-visible failures; do not expose stack, absolute root, temp path, or internal cause.
- [x] Pass `exec.signal` through every service call.
- [x] Ensure prompt and schemas explain index-first query and evidence-backed writes without claiming autonomous ingestion or lint fixes.

### Tests

- [x] Assert exact tool-name set; no accidental delete/fix/path-read tool exists.
- [x] Validate every declared parameter and every successful structured output/value against the dsh `defineTool` schemas; cover invalid declared fields and verify unknown top-level keys do not influence handler behavior, without asserting that the compiled open parameter object rejects them.
- [x] Exercise each tool through the real tool registry using the shared harness.
- [x] Test domain error mapping, cancellation, configured cap enforcement, and JSON serializability.
- [x] Assert presentation functions are deterministic and unchanged by external service mutation.
- [x] Snapshot the exact prompt section text/name/order.
- [x] Dispose the owning fiber and assert all seven tools and prompt section disappear; remount and assert one registration each.

### Acceptance

- [x] The focused plugin test invokes all seven exact tool names through the registry and completes status, source add/read, search, page read/upsert, and lint without direct service calls.
- [x] Every invocation validates declared inputs and its closed structured output/value schema where supported, invalid declared fields are rejected/handled, irrelevant unknown top-level keys cannot change behavior, configured byte/result caps hold, source provenance appears where required, and results serialize/replay identically.
- [x] The prompt snapshot contains the exact synthesized-page versus immutable-source distinction and its name/order assertion passes.

### Verification

- [x] `pnpm exec vitest run tests/plugin.spec.ts -t 'tools|prompt|presentation'` exits zero with 5 focused tests passing, covering all seven tools plus presentation, schema validation, injection, prompt name/order `116`, disposal, and remount lifecycle behavior.
- [x] `pnpm run typecheck` exits zero.
- [x] `pnpm run lint` exits zero.

### Review/fix

- [x] Review tool descriptions as model instructions for ambiguity, unsupported claims, and accidental authority escalation; review result: clean.
- [x] Review all output schemas against actual returned values and malformed on-disk cases; review result: clean after correcting optional `llmwiki_read_source` range handling so omitted `offset`/`length` remain absent.
- [x] Fix findings and rerun the focused test selection; 5 focused plugin tests, typecheck, and lint are green.
- [x] Commit C07-owned paths with `feat: expose llmwiki model tools and prompt`; committed as `d2714e2`, merged successfully, and the merged C07/C08 union passed all 43 service+plugin tests, typecheck, and lint.

---

## C08 — Add the `/wiki` maintenance command

**Commit:** `feat: add wiki maintenance command`  
**Depends on:** C06  
**Parallel-safe with:** C07 for `src/command.ts` only; command tests wait for C07's test commit  
**Owned paths:** `src/command.ts`; after C07 commits its hunk, C08 receives temporary ownership only of the command-test hunk in `tests/plugin.spec.ts`, then transfers that hunk with the rest of the file to C10 after C08 commits  
**Status:** complete, verified, review-clean, committed as `35a89e4` (`feat: add wiki maintenance command`), and merged successfully. Review fixes make reindex reporting consume the service's atomic `ReindexReceipt`, preserve runtime cancellation semantics, and verify zero model calls across command paths. The merged C07/C08 union passed all 43 service+plugin tests, typecheck, and lint.

### Implementation

- [x] Register lowercase command `wiki` with description and input hint `[status|lint|reindex]`.
- [x] Parse trimmed command input exactly; empty input aliases `status`; reject extra tokens and unknown subcommands with stable usage text.
- [x] Implement status text with initialized state, source/page counts, and index freshness.
- [x] Implement lint text with severity counts and first `commandDiagnosticLimit` sorted diagnostics plus explicit truncation count.
- [x] Implement force-reindex text with page/section counts and index version.
- [x] Pass `CommandInvocation.signal` into the service and map expected domain errors to `{ kind: 'error', text }`.
- [x] Let unexpected programmer/I/O errors reject for dsh handling; never stringify stack/cause into command output.
- [x] Ensure no command path invokes a model, adds sources, writes pages, deletes files, or repairs lint findings.

### Tests

- [x] After C07 commits, add only command registry cases to the designated command-test section of `tests/plugin.spec.ts`; do not rewrite C07 tool/prompt assertions.
- [x] Test empty/status, lint clean/dirty/truncated, reindex, invalid syntax, domain error, and abort.
- [x] Assert command registration descriptor and result text are stable.
- [x] Dispose the owning fiber and assert command removal; remount once without duplicate registration.

### Acceptance

- [x] The focused command test invokes empty input, `status`, `lint`, and `reindex` through the command registry, asserts zero model-service calls, and matches exact stable results.
- [x] Unknown subcommands and extra tokens match the exact usage error and expose no stack/path/cause.
- [x] A dirty lint corpus exceeding `commandDiagnosticLimit` returns exactly that many diagnostics plus the exact remaining-count text.

### Verification

- [x] Run the service+plugin test selection; all 43 tests pass, including atomic `ReindexReceipt` reporting, runtime cancellation, deterministic truncation, expected/unexpected error handling, disposal/remount lifecycle, and zero model calls across command paths.
- [x] Run `pnpm run typecheck`; exits zero.
- [x] Run `pnpm run lint`; exits zero.

### Review/fix

- [x] Review direct-command behavior against `@deepseek-ai/dsh-commands` exact contracts; fix reindex output to use the service's atomic `ReindexReceipt` and assert zero model calls across command paths.
- [x] Review runtime cancellation and diagnostic truncation off-by-one behavior; preserve cancellation semantics and confirm exact limit/remaining-count output.
- [x] Fix findings and rerun the service+plugin test selection; all 43 tests pass, typecheck and lint are green.
- [x] Commit `src/command.ts` and the coordinated test hunk with `feat: add wiki maintenance command`; committed as `35a89e4`, merged successfully, and the merged C07/C08 union passed all 43 service+plugin tests, typecheck, and lint.

---

## C09 — Wire the static Cordis plugin and dsh bundle

**Commit:** `feat: ship dsh bundle composition`  
**Depends on:** C07 and C08  
**Owned paths:** `src/index.ts`, `cordis.patch.yml`, `package.json` (sequential ownership received from C02; transferred to C10 after C09 commits)
**Status:** complete, verified, review-clean, and committed as `bd939e3` (`feat: ship dsh bundle composition`). Typecheck, lint, and build pass; all 15 implemented plugin tests pass. The built package import exposes the exact expected named exports, has no default export, and reports `name = 'llmwiki'` with exact `inject = ['tools', 'commands', 'systemPrompt']`. Bundle/package shape is host-only: one `dsh.bundle.patch` file (`cordis.patch.yml`) containing exactly one patch insert, exported and packed exactly once, with no wrapper package, client artifact/export, slots, browser dependencies, CSS, server, or RPC surface.

### Implementation

- [x] Export named `name = 'llmwiki'`, `inject = ['tools', 'commands', 'systemPrompt']`, `Config`, `apply`, service class, public DTOs, branded constructors, and domain error types from `src/index.ts`.
- [x] Do not add a default export.
- [x] In `apply`, construct/register `LlmWikiService`, then register prompt/tools/command only through the service and current Cordis fiber.
- [x] Ensure activation is dependency-key driven and contains no assumptions about patch row order.
- [x] Create `cordis.patch.yml` as one bundle patch insert with `id: llmwiki`, `name: dsh-llmwiki`, and the complete default config from `PLAN.md`.
- [x] After creating the patch, add `dsh.bundle.patch: ./cordis.patch.yml` plus `./cordis.patch.yml` export and `files` allowlist entries to `package.json`; these fields must not have existed in C01.
- [x] Confirm users can replace the row's complete config from a profile patch and can disable/remove the row for rollback.
- [x] Keep the package host-only: no `dsh.client`, `./client`, slots, browser dependencies, CSS, server, or RPC surface.

### Acceptance

- [x] The C09 Node import command exits zero, prints `llmwiki` plus the exact inject array, verifies the exact named-export set, and fails if a default export exists.
- [x] Static composition assertions prove `cordis.patch.yml` contains exactly one patch insert whose `llmwiki` row uses the bare package specifier and carries the complete default config.
- [x] Static package/pack assertions prove the patch is exported and packed exactly once and introduces no wrapper package or client artifact; all 15 implemented plugin tests pass.

### Verification

- [x] Run `pnpm run typecheck`.
- [x] Run `pnpm run build`.
- [x] Run `node -e "import('./lib/index.js').then(m => { if ('default' in m) process.exit(1); console.log(m.name, m.inject) })"` and verify the exact named exports and inject array.
- [x] Run `pnpm pack --dry-run` and confirm `cordis.patch.yml` is included exactly once, with no client or wrapper artifact; `pnpm run lint` also exits zero.

### Review/fix

- [x] Independent review 1: `package.json`/`cordis.patch.yml` match the dsh `packages/bundle/base` composition shape, and `src/index.ts` matches the named plugin shape from `packages/extensions/tool-cordis`; review result: clean.
- [x] Independent review 2: the patch's full default config and the exported schema agree exactly, with dependency-key activation and no patch-row-order assumption; review result: clean.
- [x] Independent review 3: C09 acceptance and verification cover only the implemented static plugin, composition, import, and pack contract; the disable/remove/re-enable `.llmwiki` hash lifecycle remains solely C10-owned; review result: clean.
- [x] Fix review findings and rerun build/import/pack checks; all three independent reviews were clean, so no fixes or reruns were required.
- [x] Commit C09-owned changes with `feat: ship dsh bundle composition`; committed as `bd939e3`.

---

## C10 — Complete contract, lifecycle, Loader, and built-package tests

**Commit:** `test: cover llmwiki contracts and loader lifecycle`  
**Depends on:** C09  
**Owned paths:** `tests/plugin.spec.ts`, `tests/loader.e2e.spec.ts`, `tests/built-package.e2e.spec.ts`, `tests/harness.ts`, with optional sequential updates to `package.json` and `pnpm-lock.yaml`; test ownership of `tests/plugin.spec.ts` transfers from C07/C08 and `tests/harness.ts` from C06, package ownership transfers from C09, and lock ownership transfers from C02 when C10 begins. C10's only direct additions are exact `@deepseek-ai/cordis-plugin-loader@1.0.2` and exact `node-addon-require-builtin@0.1.4`, plus pnpm-generated lock resolutions; its patch parser does not import `@deepseek-ai/cordis-plugin-include`, so the provisional direct `1.0.6` pin was removed and only a transitive, unused resolution may remain. Transfer `package.json` to C11 and `pnpm-lock.yaml` to C12 after C10.  
**Status:** complete, verified, review-clean, and committed as `c343e67` (`test: cover llmwiki contracts and loader lifecycle`). After the two scope-preserving review fixes, the first built-entry probe runs only from a disposable consumer root, and the unused direct `@deepseek-ai/cordis-plugin-include@1.0.6` development dependency was removed with the pnpm-generated lockfile reverified so Include remains transitive-only and unused. All 17 plugin tests and all 6 E2E tests pass after reverification, and build, typecheck, and lint are green. The verified scope covers the real Loader lifecycle and byte-identical `.llmwiki` hash across disable/remove/re-enable, packed bare-package resolution and patch parsing, declaration consumption from the installed package, rejection of source/default/client bypasses, and hermetic cleanup.

### Implementation/testing

- [x] Add exact development dependencies `@deepseek-ai/cordis-plugin-loader@1.0.2` and `node-addon-require-builtin@0.1.4`. The patch tests do not import `@deepseek-ai/cordis-plugin-include`; it remained transitive and unused, so remove the provisional direct `1.0.6` development pin under the conditional contract and update the lockfile only through pnpm `11.7.0`.
- [x] Consolidate the shared real Cordis test harness; mock only nondeterministic/external boundaries (none should be needed for core wiki I/O). The source Loader harness must use the root-installed exact development dependencies directly, with no test-local package setup, package-manager invocation, or per-test network install.
- [x] Add a complete HMR lifecycle test that mounts all required dsh services and llmwiki, observes service/tools/prompt/command, disposes llmwiki, proves removal, and remounts cleanly.
- [x] Add a disable/remove/re-enable Loader composition test that hashes `.llmwiki` before disable/removal and after re-enable, asserts byte-identical equality, and proves the existing wiki remains readable across the lifecycle.
- [x] Assert `'default' in importedModule` is false.
- [x] Exercise dsh's actual export-unwrapping/Loader behavior so replacing named exports with a default export makes the test fail.
- [x] Boot a test-only Cordis configuration through the real root-installed Loader using the bare package entry and exact required service rows.
- [x] In the real registry/Loader path, exercise each tool with valid declared parameters, invalid values for every declared parameter category, and irrelevant unknown top-level keys; assert invalid declared values fail safely and unknown keys neither alter service inputs nor affect results, without expecting the open compiled parameter object itself to reject unknown keys.
- [x] Invoke status, add-source, upsert-page, search, read, lint, and `/wiki` through registries in the Loader composition; assert durable files externally.
- [x] Prove row order does not matter by placing llmwiki before at least one dependency in the test composition and observing eventual activation.
- [x] Test missing required dependency leaves plugin pending/unavailable and adding/removing that dependency activates/unloads it according to Cordis lifecycle.
- [x] Build before built-artifact tests; launch plain Node against the installed packed package's public `lib/index.js` entry rather than tsx, source paths, private imports, or repository aliases.
- [x] Create the tarball with `pnpm pack --json`, parse the complete JSON payload, and validate exactly one emitted `.tgz` path; never scrape human-readable output or select the last whitespace-delimited token.
- [x] Create a disposable consumer root and explicitly install the tarball, `@deepseek-ai/cordis-plugin-loader@1.0.2`, exact runtime peers `@deepseek-ai/cordis@4.0.1`, `@deepseek-ai/dsh-brand@0.1.0-rc.6`, and `@deepseek-ai/dsh-{commands,session,system-prompt,tools}@0.1.0-rc.6`, plus `node-addon-require-builtin@0.1.4`; do not directly install `@deepseek-ai/cordis-plugin-include@1.0.6` because the consumer's patch parser does not import it, and do not rely on its unused transitive presence.
- [x] Launch packed-consumer children with `NODE_PATH`, `NODE_OPTIONS`, and every source/workspace alias removed; do not symlink the repository package, point Loader aliases/base URLs at source, or write any probe script/file under the repository. Any required probe file lives inside the disposable consumer root.
- [x] Use real consumer-root resolution guards for the package entry, patch export, Loader, helper, and runtime peers: resolve and realpath the loaded targets, require the package entry and patch to be contained by the disposable root's installed `dsh-llmwiki`, and fail on any repository, source, private-module, workspace, or root-`node_modules` resolution. Loose substring checks and source-text scans do not satisfy this guard.
- [x] Resolve `dsh-llmwiki/cordis.patch.yml` via package exports from the built/packed package and parse the patch.
- [x] Assert a genuinely missing/malformed composition exits non-zero rather than swallowing load failure.
- [x] Keep every e2e temporary profile/wiki self-owned and disposed in `afterEach` even after failures.

### Acceptance

- [x] `pnpm run build && pnpm run test:e2e` loads through the bare built/package entry; a guard fails if any test substitutes a source/private import for that path.
- [x] The source Loader suite resolves the exact root-installed Loader/helper dependencies and performs no package-manager or network installation during individual tests.
- [x] The packed-consumer suite parses pack JSON structurally, installs its tarball/runtime peers/helper in a disposable root, runs with sanitized module-resolution environment, passes real resolution/realpath guards, and leaves no probe files in the repository.
- [x] Tool contract assertions prove all supported parameters are explicitly declared, invalid declared fields are rejected/handled, unknown top-level keys cannot affect behavior, and every structured output/value object is closed where the dsh schema surface supports closure.
- [x] The named-export, exact-inject, disposal/remount registry-count, and package-resolution assertions each run in the C10 suites and exit zero.
- [x] Registry-invoked mutations are followed by external byte/hash assertions for source and page files.

### Verification

- [x] Run `pnpm exec vitest run tests/plugin.spec.ts`; all 17 plugin tests pass, including real Loader activation/unload/remount and byte-identical lifecycle hash coverage.
- [x] Run `pnpm run build && pnpm run test:e2e`; build and all 6 E2E tests pass, including packed bare-package resolution, exported patch parsing, installed declaration consumption, source/default/client bypass guards, and hermetic consumer/profile cleanup.
- [x] Temporarily introduce a local default-export regression, observe the Loader guard fail, revert it, and rerun green; do not commit the regression.
- [x] Run `pnpm run typecheck`; typecheck passes. `pnpm run lint` also passes.

### Review/fix

- [x] Review the source Loader harness and packed-consumer tests for hand-built stand-ins, per-test installs, inherited module aliases, repository probe files, weak pack-output parsing, substring-only resolution checks, or any bypass of shipping Loader/package paths; review confirmed the built-entry probe is confined to the disposable consumer root and the shipping Loader/package paths remain guarded.
- [x] Review teardown for leaked fibers, temp profiles, environment changes, or unhandled subprocesses; review result: clean.
- [x] Complete the two scope-preserving review fixes and rerun C10 verification: regenerated `pnpm-lock.yaml` after removing the unused direct Include manifest pin, reverified that Include remains transitive-only and unused, and kept the first built-entry probe inside a disposable consumer root rather than the repository. Reverification retained all 17 passing plugin tests and all 6 passing E2E tests, with build, typecheck, and lint green.
- [x] Commit C10-owned paths with `test: cover llmwiki contracts and loader lifecycle`; committed as `c343e67`.

---

## C11 — Add docs, runnable example, determinism check, and smoke

**Commit:** `docs: add llmwiki usage and runnable example`  
**Depends on:** C10  
**Owned paths (docs/example):** `README.md`, `examples/README.md`, `examples/cordis.yml`, `examples/demo-wiki/schema.md`, `examples/demo-wiki/pages/getting-started.md`  
**Owned paths (evidence/example):** `examples/demo-wiki/sources/<fixture-sha256>/content`, `examples/demo-wiki/sources/<fixture-sha256>/metadata.json`, `scripts/check-determinism.ts`, `scripts/smoke.ts`, `package.json` (sequential ownership received from C10 solely to add the two script entries, then transferred to C12)  
**Status:** complete, verified, review-clean, and committed as `cb67064` (`docs: add llmwiki usage and runnable example`). The accidental absolute-tarball self-dependency was removed from `package.json`, a dependency-clean `pnpm install --frozen-lockfile` succeeded, and the automated README/runtime audit is now integrated into `pnpm run check:determinism`, where it compares the documented config defaults, tool names, and command tokens with exported runtime definitions. Final reverification was green for `pnpm run build`, `pnpm run check:determinism`, `pnpm run smoke`, `pnpm run typecheck`, `pnpm run lint`, and the exact clean-temporary-directory packed demo. The demo booted enabled, reported zero pre-search lint errors with `INDEX_MISSING`, found `getting-started` first at the documented line, completed the documented lifecycle, booted disabled without llmwiki contributions, and exited zero throughout.

### Documentation

- [x] Write README overview that explicitly distinguishes Karpathy's idea-file principles from this repository's implementation choices.
- [x] Document the supported exact dsh rc.6, Cordis, and Schemastery versions, Node/pnpm requirements, installation as profile bundle, direct Cordis row installation, and clean removal/rollback; explain that exact pins avoid the older rc.1 `latest` and that rc.5 is unpublished despite matching the inspected API.
- [x] Document complete default config and warn that dsh patch overrides replace the entire row config rather than deep-merge it.
- [x] Document exact `.llmwiki` layout, source immutability, page frontmatter subset, logical page IDs, single-writer limitation, derived-index deletion/rebuild, and symlink policy.
- [x] Document all seven tool names with mutation/read behavior, bounded outputs, and evidence expectations.
- [x] Document `/wiki [status|lint|reindex]` and that it does not trigger a model turn.
- [x] Document deterministic tokenizer/BM25/tie-break/snippet behavior sufficiently for users to understand reproducibility without exposing irrelevant implementation trivia.
- [x] Document every lint diagnostic category, read-only behavior, and manual recovery for abandoned temps/corrupt index.
- [x] Add security/privacy section: local-only, no network/subprocess/model calls, model-supplied source content, root containment, and no arbitrary path ingest.
- [x] Add migration/versioning policy: source/page formats are durable; `.index` is versioned/disposable; future durable migrations must be explicit and copy-first.
- [x] Add Model Experience with exact prompt literal, prompt section name/order, tool-schema context effect, bounded result behavior, and KV-cache effect.
- [x] End README with Known Limitations and Deferred Work: single process writer, UTF-8 text sources only, no delete/fix/UI/vector/graph/sync, no cross-process lock.

### Example

- [x] Create a minimal `examples/cordis.yml` composition using the built package and required dsh services; do not depend on source-only path aliases.
- [x] Create example schema guidance and one evidence-backed page with canonical frontmatter.
- [x] Commit exact example source content and metadata whose directory/hash/byte count are independently verified.
- [x] Omit example `.index` so running the example proves rebuildability.
- [x] Write example README with exact run commands and expected status/search/lint outcomes.

### Determinism script

- [x] Implement `scripts/check-determinism.ts`, executed with `tsx` after `pnpm run build`, to import only public named exports from built `lib/index.js`; create two fresh wiki roots with identical logical content but different creation order/mtimes.
- [x] Run indexing/search/lint through those built public service APIs and compare exact canonical `search.json`, `state.json`, and normalized search/lint result bytes.
- [x] Fail non-zero while printing the first differing artifact and byte offset; clean both roots in `finally`.
- [x] Ensure script contains no fixture-update mode and never rewrites committed goldens.
- [x] After `scripts/check-determinism.ts` exists, add `check:determinism` to `package.json` using `tsx`; do not alter C09 bundle metadata or unrelated manifest fields.

### Smoke script

- [x] Implement `scripts/smoke.ts`, executed with `tsx` after `pnpm run build`, to import only built `lib/index.js`; boot real Cordis composition, initialize a temp wiki, add source, write page, search/read/lint, invoke command, and dispose.
- [x] After disposal, externally reread source/page bytes, assert source hash and zero lint errors, and confirm registries no longer expose llmwiki contributions.
- [x] Fail non-zero with the failed assertion named and clean the temporary profile/wiki in `finally`; `pnpm run smoke` must fail clearly if `lib/index.js` is absent, so verification always builds first.
- [x] After `scripts/smoke.ts` exists, add `smoke` to `package.json` using `tsx`; both newly added scripts must name their real C11 targets and contain no fallback/`|| true` behavior.

### Acceptance

- [x] Following `README.md` in a clean temporary directory installs the packed package, boots the example, exercises status/search/lint, disables the row, and exits zero at every documented command.
- [x] The automated documentation audit integrated into `pnpm run check:determinism` compares every config default, tool name, and command token in README tables with exported runtime definitions and exits zero.
- [x] The exact example corpus produces zero lint errors and a search whose first hit is `getting-started` at the documented line.
- [x] `pnpm run check:determinism` byte-compares both roots and audits README/runtime parity, and `pnpm run smoke` completes the built-package lifecycle; neither script scans source text to claim success.

### Verification

- [x] From a dependency-clean state, run `pnpm install --frozen-lockfile` and confirm the removed absolute-tarball self-dependency is absent.
- [x] Run `pnpm run build`.
- [x] Run `pnpm run check:determinism`, including its automated README/runtime audit.
- [x] Run `pnpm run smoke`.
- [x] Run `pnpm run typecheck`.
- [x] Run `pnpm run lint`.
- [x] Run the exact commands in `examples/README.md` from a clean temporary directory, including the enabled and disabled packed-demo boots.

### Review/fix

- [x] Review example files as user-facing durable data: hash, byte count, source reference, canonical page format, and no generated index.
- [x] Review docs for claims not exercised by tests/smokes; remove or add proof.
- [x] Complete the two scope-preserving review fixes and rerun C11 verification: the accidental absolute-tarball self-dependency is absent from `package.json`, the dependency-clean frozen install succeeds, and the automated documentation audit against exported runtime definitions is integrated into `pnpm run check:determinism`; the clean packed demo, audit, determinism, smoke, build, typecheck, and lint evidence are reverified.
- [x] Commit C11-owned paths with `docs: add llmwiki usage and runnable example`; committed as `cb67064`.

---

## C12 — Repository hygiene, coverage, package, and clean-profile release gates

**Commit:** `chore: finalize package and release gates` — `ef39d90`  
**Depends on:** C11  
**Owned paths:** sequential cleanup ownership of `.gitignore`, `LICENSE`, `package.json`, `pnpm-lock.yaml`, `pnpm-workspace.yaml`, `tsconfig.json`, `tsconfig.eslint.json`, `tsdown.config.ts`, `vitest.config.ts`, `vitest.e2e.config.ts`, and `eslint.config.js` (package ownership arrives through C01→C02→C09→C10→C11→C12; lock ownership arrives through C01→C02→C10→C12); `.npmignore` is intentionally neither owned nor created because `package.json#files` plus the structured-pack and dry-run pack gates exactly constrain publication; minimal behavior fixes return to their original source/test/doc owner and use scoped `fix:` commits
**Status:** complete, verified, review-clean, and committed as `ef39d90` (`chore: finalize package and release gates`). The strengthened packed proof is complete: declaration/runtime/profile child phases ran while repository `src/` and repository `node_modules/` were physically unavailable under a tracked move/reverse-restore contract; the complete recursive normalized-path/SHA-256 `.llmwiki` manifest, including `.index/*`, was identical at every lifecycle checkpoint; and the complete recursively normalized lint DTO was identical between initial and restored boots. The final rerun on Node `v24.18.0`, pnpm `11.7.0`, dsh `0.1.0-rc.6`, and Ubuntu `24.04.4 LTS` / Linux `6.8.0-71-generic` `x86_64` passed the dependency-clean frozen install, peer and ignored-build checks, typecheck, lint, all 185 unit tests, aggregate coverage `94.89%` statements / `89.64%` branches / `97.92%` functions / `97.51%` lines with every per-file threshold green, warning-free build, all 7 E2E tests through the actual registry profile add/disable/remove/re-add lifecycle, determinism hash `f4b636ac0401093955bf3938ec8616014da149dc30b5707a9980cac82781fd12`, smoke, structured pack, and exact dry-run pack allowlist. The C12-boundary artifact/profile/quarantine cleanup audit passed; C13's independent final closure audit and physical post-accounting generated-artifact re-audit also returned **CLEAN**, completing the tracker.

### Repository cleanup

- [x] Audit and tighten the C01 `.gitignore`; it already protects generated artifacts before this chunk begins.
- [x] Intentionally omit `.npmignore`: the `package.json#files` allowlist is the single publication boundary, and explicit structured-pack plus `pnpm pack --dry-run` gates prove the exact emitted set without a second exclusion policy that could drift or hide required declarations, patch, README, or license files.
- [x] Verify the C01 MIT license text and holder/year match `package.json`; correct either under C12's sequential ownership if necessary.
- [x] Under C12's explicit sequential ownership, delete scaffolding, unused exports/imports/dependencies, duplicate helpers, stale comments, fixture-update utilities, and generated local artifacts; update `package.json`, lockfile, and build/type/lint/test configs together when dependency/config cleanup requires it.
- [x] Add a `prepack` lifecycle that performs a clean production build before packing now that sources and the complete public package surface exist; verify a stale `lib/` cannot enter the tarball and keep this lifecycle out of C01 while no source entry exists.
- [x] Confirm no `TODO`, placeholder, no-op, fake fallback, hidden network/subprocess/model call, UI/client/server/vector/graph code, or undocumented delete/fix operation remains.
- [x] Confirm no `AGENTS.md` was fabricated; add one only if actual implementation produced durable repository-specific lessons, and if so update the plan/file tree/checklist before doing it.

### Focused and full gates
**Final release environment:** Node `v24.18.0`; pnpm `11.7.0`; dsh `0.1.0-rc.6`; Ubuntu `24.04.4 LTS`; Linux `6.8.0-71-generic` `x86_64`.

- [x] Run `pnpm install --frozen-lockfile` from a dependency-clean state; it exits zero, `pnpm peers check` reports no issues, and `pnpm ignored-builds` reports `None`.
- [x] Run `pnpm run typecheck`; it exits zero.
- [x] Run `pnpm run lint`; it exits zero with no warnings.
- [x] Run `pnpm run test`; all 185 unit tests pass.
- [x] Run `pnpm run test:coverage`; Vitest 4.1.8 V8 reports aggregate coverage of 94.89% statements, 89.64% branches, 97.92% functions, and 97.51% lines, while every `src/**/*.ts` file included via `coverage.include` passes the required 90% lines, 90% statements, 90% functions, and 85% branches with `coverage.thresholds.perFile: true`, without obsolete `coverage.all`, top-level `coverage.perFile`, plumbing-only tests, or exclusions of reachable lines.
- [x] Run `pnpm run build`; it exits zero without warnings or deprecation warnings.
- [x] Rerun `pnpm run test:e2e`; all 7 final E2E tests pass, including consumer-local declaration isolation and the permanent actual registry-installed dsh `0.1.0-rc.6` profile lifecycle through add, disable, remove, and re-add CLI `--patch` boots.
- [x] Run `pnpm run check:determinism`; it exits zero with determinism hash `f4b636ac0401093955bf3938ec8616014da149dc30b5707a9980cac82781fd12`.
- [x] Run `pnpm run smoke`; it exits zero.
- [x] Run `pnpm pack --dry-run`; the exact publication set is constrained to npm-required `package.json` plus the `package.json#files` allowlist: `lib/**/*.js`, `lib/**/*.js.map`, `lib/types/**/*.d.ts`, `lib/types/**/*.d.ts.map`, `cordis.patch.yml`, `README.md`, and `LICENSE`, with no source, fixtures, plans, tests, examples, or local wiki data.

### Packed-tarball clean-profile gate

- [x] Run `npm run prepack` explicitly, prove the clean production build removes a stale `lib/` marker and recreates the public entry, then run `npm pack --ignore-scripts --json --pack-destination <temp>` and parse the complete JSON payload for exactly one emitted tarball beneath the disposable destination. Keep `pnpm pack --dry-run` as the separate manifest inspection; never return to stale `pnpm pack --json` or mixed-output token scraping.
- [x] Create a clean temporary dsh profile/project outside this repository.
- [x] Install the tarball through the supported dsh plugin/profile flow.
- [x] Before packed declaration compilation/runtime probing and before each actual packed-profile boot, moved repository `src/` and repository `node_modules/` to unique hidden sibling paths so both originals were physically unavailable for that child phase. The shared helper records each completed move, starts the child only after both moves succeed, reverse-restores every moved path before returning or propagating setup/child failure, and surfaces restoration failures explicitly. Consumer/profile installation, build, and plugin add occurred before hiding; sanitized environments and realpath containment guards remained additional requirements rather than substitutes for physical unavailability.
- [x] Booted the actual registry-installed dsh rc.6 runtime with the selected temporary profile and installed bundle through CLI `--patch` probes while both repository paths were unavailable; no probe constructed a direct `Context`, imported or mounted `dsh-llmwiki`, or manually mounted the dsh runtimes. The initial enabled boot proved exactly seven llmwiki tools, one `/wiki` command, and one assembled `tool:llmwiki` prompt section with the expected text, then exercised status, source add/read, page upsert/read, search, lint, `/wiki status`, `/wiki lint`, and `/wiki reindex` through the real profile surface.
- [x] After the initial enabled boot, captured a sorted full recursive `.llmwiki` manifest containing every regular file as normalized relative POSIX path plus SHA-256 bytes, including schema, source content/metadata, pages, log, and derived `.index/*`; the baseline contained an `.index/*` entry. Also captured the complete lint DTO recursively normalized with locale-sorted object keys and original array order, then canonically serialized it for exact equality.
- [x] Disabled the bundle and booted the same profile, then removed the package and booted again; both states proved the service, seven tools, `/wiki`, and assembled `tool:llmwiki` prompt section absent, and both complete `.llmwiki` manifests exactly equaled the initial baseline.
- [x] Re-added and re-enabled the same tarball, proved the complete manifest still equaled the baseline before boot, then ran a restore-only boot that read the exact original source ID/content and page ID/canonical Markdown before any source add, page upsert, or reindex. The post-boot complete manifest remained exactly equal to the initial baseline, and the restored complete normalized lint canonical string equaled the initial value byte-for-byte; exactly seven tools, one `/wiki` command, and one expected assembled prompt section were restored.
- [x] Cleaned the temporary profile, project, tarball, installed dependencies, probes, hidden repository-path quarantines, and all dsh state created specifically for the actual-profile-boot gate after the strengthened focused and full reruns passed.

### Acceptance

- [x] Reran from a dependency-clean state on Node `v24.18.0`, pnpm `11.7.0`, dsh `0.1.0-rc.6`, and Ubuntu `24.04.4 LTS` / Linux `6.8.0-71-generic` `x86_64`: `pnpm install --frozen-lockfile`, `pnpm peers check`, `pnpm ignored-builds`, `pnpm run typecheck`, `pnpm run lint`, `pnpm run test`, `pnpm run test:coverage`, `pnpm run build`, `pnpm run test:e2e`, `pnpm run check:determinism`, `pnpm run smoke`, explicit `npm run prepack`, structured `npm pack --ignore-scripts --json --pack-destination <temp>`, and separate `pnpm pack --dry-run`. Every command exited zero; peers reported no issues; ignored builds reported `None`; all 185 unit tests and all 7 E2E tests passed; aggregate coverage was `94.89%` statements / `89.64%` branches / `97.92%` functions / `97.51%` lines with every per-file threshold green; build was warning-free; determinism produced `f4b636ac0401093955bf3938ec8616014da149dc30b5707a9980cac82781fd12`; smoke passed; and the dry-run publication set exactly matched the authoritative `package.json#files` allowlist plus npm-required `package.json`.
- [x] The packed declaration consumer installed exact `typescript@6.0.3` inside its disposable root, resolved and realpathed the consumer-local compiler beneath consumer `node_modules`, and consumed the installed tarball's declarations during a child phase in which repository `src/` and repository `node_modules/` had both been moved away and were physically unavailable, with every moved path restored before the helper returned or propagated failure.
- [x] The permanent packed-profile E2E installed the produced tarball through the supported dsh rc.6 plugin/profile registry flow, then performed every CLI `--patch` boot while repository `src/` and repository `node_modules/` were both physically unavailable; it exercised status, source add/read, page upsert/read, search, lint, `/wiki status`, `/wiki lint`, and `/wiki reindex` without directly importing or mounting the plugin.
- [x] The same permanent E2E proved exact lifecycle preservation with a sorted recursive manifest of every `.llmwiki` regular file's normalized relative POSIX path and SHA-256 bytes: initial, disabled, removed, re-added-before-boot, and restored manifests were identical, including derived `.index/*`. The restore-only boot read the exact original source/page before mutation or reindex, and its complete recursively normalized lint DTO canonical string was byte-for-byte equal to the initial value; enabled/re-added and disabled/removed service/tool/command/assembled-prompt counts remained exact.
- [x] After the strengthened focused test and full reverification, repeated the final repository artifact audit and confirmed no generated `node_modules/`, `lib/`, `coverage/`, `.index/`, disposable root, tarball, dependency, probe, hidden quarantine, or gate-specific dsh profile/project/store output remained.

### Review/fix

**Review note:** C12's three scope-preserving proof corrections are complete without changing product behavior, release scope, owned paths, or the gate set. Relevant declaration/runtime/profile child phases observed repository `src/` and repository `node_modules/` physically unavailable under the tracked move/reverse-restore contract; every lifecycle checkpoint compared the complete recursive `.llmwiki` normalized-path/SHA-256 manifest including `.index/*`; and initial/restored boots compared canonical strings for the complete recursively normalized lint DTO. The explicit `npm run prepack` then `npm pack --ignore-scripts --json --pack-destination <temp>` structured-pack path and separate `pnpm pack --dry-run` exact allowlist inspection remained intact. The strengthened focused E2E and full final rerun passed with the exact environment, 185-test, coverage, build, 7-E2E, determinism-hash, smoke, and pack evidence recorded above. Review found no remaining actionable C12 defect; C12 is review-clean and committed as `ef39d90`.

- [x] Classify the observed structured-pack gate failure to its test-infrastructure interaction with C12 `prepack`; fix the test source rather than weakening the gate, scraping mixed lifecycle output, or special-casing the fixture.
- [x] Rerun the smallest failing packed E2E, then all C12 gates after the structured-pack fix; the verified path explicitly runs `npm run prepack` followed by `npm pack --ignore-scripts --json --pack-destination <temp>`, parses the complete JSON payload, and retains separate `pnpm pack --dry-run` manifest inspection.
- [x] Strengthened the packed E2E so declaration consumption and every actual-profile child boot run while repository `src/` and repository `node_modules/` are moved to unique hidden sibling paths and physically unavailable, with every completed move reverse-restored before return/error propagation; retained consumer-local TypeScript `6.0.3`, Loader/helper/exact-peer containment guards, sanitized environments, and the prohibition on repository package or `node_modules` symlinks.
- [x] Replaced selected source/page hash and lint-count proof with exact lifecycle equality: recursively enumerated every regular file under `.llmwiki` into a sorted normalized relative-POSIX-path/SHA-256 manifest, explicitly proved `.index/*` inclusion, and compared the complete manifest after initial, disabled, removed, re-add-before-boot, and restored states; recursively normalized the complete lint DTO with locale-sorted object keys/retained array order and compared the initial/restored canonical strings before any restored mutation or reindex.
- [x] Reran the strengthened focused actual-profile lifecycle E2E, then every existing C12 gate without weakening, replacing, or omitting any command or acceptance criterion; all 7 E2E tests and every final gate passed with the exact evidence recorded above.
- [x] Removed generated outputs after the C12 final rerun and repeated the explicit C12-boundary repository artifact audit; no `node_modules/`, `lib/`, `coverage/`, generated `.index/`, disposable root, tarball, dependency, probe, hidden quarantine, or gate-specific dsh profile/project/store state remained at that boundary. C13's final post-accounting physical re-audit confirmed the same generated-artifact cleanliness and closed the tracker.
- [x] Commit only cleanup/config/gate changes with `chore: finalize package and release gates`; use a scoped `fix:` commit instead if behavior changed. Commit identity: `ef39d90`.

---

## C13 — Final split review and release tracker closure

**Commits and focused conventional order:** C12 `ef39d90` (`chore: finalize package and release gates`) → C13-A `094fbc0` (`fix(index): recreate deleted derived index`) → C13-B `92daa29` (`test(package): pin native profile dependency`) → final tracker-only `docs: close implementation tracker` (this atomic `PLAN.md`/`CHECKLIST.md` commit; no hash is pre-recorded)  
**Depends on:** C12  
**Owned paths:** review-only across the repository; fixes return to the owning chunk paths; final tracker closure owns only `PLAN.md` and `CHECKLIST.md`  
**Status:** complete. C13-A-01 is resolved and committed as `094fbc0`; its focused 4-case service run, typecheck, lint, targeted re-review, and complete Review A rerun all returned green/**CLEAN** with zero unresolved findings. C13-B-01 is resolved and committed as `92daa29`; its focused actual-profile lifecycle test, typecheck, lint, independent targeted re-review, and aggregate Review B all returned green/**CLEAN** with zero unresolved findings. The complete final C12 gate rerun and packed-tarball actual registry-profile add/disable/remove/re-add scenario are complete with the exact environment and evidence recorded below. The independent final closure audit returned **CLEAN**, and physical post-accounting inspection confirmed generated-artifact cleanliness. C13 and the whole tracker are complete with zero unchecked tasks and zero unresolved findings. This `PLAN.md`/`CHECKLIST.md`-only atomic closure is recorded as `docs: close implementation tracker`; no hash is invented before the commit exists.

### Review A — domain, safety, and determinism

**Resolved finding C13-A-01 (major):** The original reproduction deleted the complete `.index/` directory after initialization and observed `ENOENT` from `src/indexer.ts#writeIndex` on the next search. `src/indexer.ts` now recreates `paths.index` through the C02-owned `ensureWikiDirectory` primitive in `src/paths.ts` before either atomic index write; `tests/service.spec.ts` deletes the complete derived directory and proves the next search restores identical results and byte-identical `search.json`/`state.json` while source and page bytes remain unchanged. Focused evidence: 4/4 selected service cases passed, typecheck passed, lint passed, and the independent targeted re-review returned **CLEAN**. The complete Review A rerun subsequently returned **CLEAN** with zero unresolved findings after covering every audit, import scan, reproduction, non-mutation, index-recovery, and finding-accounting item below. Commit accounting: `094fbc0` (`fix(index): recreate deleted derived index`).

- [x] Review `src/types.ts`, `src/errors.ts`, `src/ids.ts`, and `src/paths.ts` for public-contract ambiguity, unchecked casts, traversal, symlink, and path privacy failures.
- [x] Review `src/atomic.ts` and `src/markdown.ts` for crash consistency, partial writes, cleanup masking errors, descriptor leaks, and canonical-format ambiguity.
- [x] Review `src/tokenizer.ts` and `src/indexer.ts` for locale/time/random dependence, unstable sorting, floating edge cases, stale-index acceptance, and snippet byte bugs.
- [x] Review `src/lint.ts` for mutation, incomplete invariants, false traversal acceptance, unstable diagnostics, and absolute-path leakage.
- [x] Review `src/service.ts` for queue starvation/races, cancellation false success, source overwrite, index/data coupling, and configuration bypass.
- [x] Run an integration import scan across every C03–C10 filesystem callsite and prove each imports the C02 ID/path/error primitives rather than redeclaring brands, path containment, source-ID validation, or page-ID normalization.
- [x] Reproduce at least: `../` escape, symlink escape, source hash mismatch, aborted queued write, interrupted temp file, malformed index, equal-score tie, and two-root determinism.
- [x] Confirm lint leaves the complete tested file tree byte-identical.
- [x] Confirm deleting `.index` and rerunning search restores equivalent derived output: the C13-A-01 regression recreates byte-identical `search.json`/`state.json`, preserves source/page bytes and search results, and passed in the focused 4-case service run.
- [x] Record each finding with severity, exact path/symbol, reproduction, and owning chunk; resolve every finding or explicitly prove it invalid.
**Aggregate Review A status: CLEAN (zero unresolved findings).** The complete rerun covered every audit, import scan, reproduction, non-mutation, index-recovery, and finding-accounting item above. This **CLEAN** result is included in the completed C13 release closure.


### Review B — dsh integration, packaging, and user/model experience
**Independent review accounting: CLEAN.** After the C13-B-01 deterministic disposable-workspace fix and focused verification, an independent targeted Review B re-review returned **CLEAN** with zero unresolved findings.

**Resolved finding C13-B-01 (major):** Registry-transitive `koffi` drifted to `3.1.5`, defeating the fail-closed exact build allowlist and breaking deterministic packed-consumer installation. `tests/built-package.e2e.spec.ts` now gives the disposable packed-profile workspace an exact `koffi: 3.1.4` override, matches it with exact `koffi@3.1.4: true` under `allowBuilds`, asserts the installed `node_modules/koffi/package.json` version is exactly `3.1.4`, and requires `pnpm ignored-builds` to report `None`, without broadening native-build trust. The focused profile lifecycle test, typecheck, and lint passed, and the independent targeted Review B re-review returned **CLEAN**. Commit accounting: `92daa29` (`test(package): pin native profile dependency`).


- [x] Review `src/config.ts`, `src/index.ts`, `src/tools.ts`, `src/prompt.ts`, `src/presentation.ts`, and `src/command.ts` against exact dsh APIs cited in `PLAN.md`.
- [x] Confirm named exports, exact `inject`, Schemastery Config, `ctx.llmwiki`, seven tool registrations, prompt section, and command are fiber-owned and HMR-clean.
- [x] Confirm tools preserve `defineTool`, explicitly declare and validate every supported parameter, do not rely on unknown top-level keys, use closed structured output/value schemas where supported, and retain pure rendering/presentation, bounded results, safe errors, and `exec.signal`.
- [x] Confirm `/wiki` is lowercase, abortable, direct/no-model, bounded, and mutation-limited to reindexing derived data.
- [x] Review `package.json`, build configs, and `cordis.patch.yml` for the installable exact rc.6 dsh peer/dev pins, exact Cordis/Schemastery versions, exact C10 Loader/helper dev pins, absence of a direct Include pin because no patch-parsing path imports it (an unused transitive resolution may remain), public exports, bundle metadata, complete config replacement, host-only scope, and tarball contents; confirm no unpublished rc.5 or rc.1 dist-tag resolution remains.
- [x] Review Loader and built-artifact tests for per-test network installs, inherited `NODE_PATH`/`NODE_OPTIONS`/source aliases, repository probe files, non-JSON pack scraping, weak resolution guards, bypasses, or mocks that would let a broken package ship.
- [x] Review README/example against actual tool names, prompt literal, defaults, filesystem format, limitations, rollback, and tested behavior.
- [x] Confirm no browser UI, HTTP server, hosted sync, graph, embedding/vector, SQLite, watcher, subprocess, network, hidden LLM call, delete tool, or lint fixer entered scope.
- [x] Record the final independent Review B result: after C13-B-01's exact override, installed-version assertion, matching build allowlist, ignored-build proof, and focused lifecycle/typecheck/lint pass, the targeted re-review returned **CLEAN** with zero unresolved findings.
**Aggregate Review B status: CLEAN (zero unresolved findings).** The full final C12 rerun and actual registry packed-profile scenario also pass. The independent final closure audit and physical generated-artifact re-audit are **CLEAN**; C13 is closed.

### Post-review fixes and regression verification

- [x] Apply C13-A-01 in its original owning paths and strengthen the observable regression that failed on the reproduced bug: `src/indexer.ts` and `tests/service.spec.ts`.
- [x] Apply C13-B-01 in its original built-package E2E gate path: pin the disposable packed-profile workspace override to exact `koffi` `3.1.4`, match `allowBuilds` to exact `koffi@3.1.4`, assert the installed version, and require `pnpm ignored-builds` to report `None` without broader native-build trust.
- [x] Record `094fbc0` (`fix(index): recreate deleted derived index`) as the focused C13-A commit immediately after C12 `ef39d90`.
- [x] Record `92daa29` (`test(package): pin native profile dependency`) as the focused C13-B commit immediately after C13-A `094fbc0`.
- [x] Rerun the focused reproduction/regression for C13-A-01 immediately after its fix: 4/4 selected service cases, typecheck, and lint passed; independent targeted re-review returned **CLEAN**.
- [x] Rerun the focused C13-B-01 profile lifecycle test and prove the disposable consumer resolves exact `koffi` `3.1.4`, its `allowBuilds` key matches, and `pnpm ignored-builds` reports `None`; the focused lifecycle test, typecheck, and lint passed.
- [x] Obtain an independent targeted Review B re-review of the exact override, installed-version assertion, matching build allowlist, ignored-build proof, and focused regression; it returned **CLEAN** with zero unresolved findings.
- [x] Rerun the focused test/command for any additional finding discovered by the complete Review A rerun: not applicable because the complete rerun returned **CLEAN** with no additional findings requiring a focused fix or re-review.
- [x] Rerun all C12 gates after the final finding: on Node `v24.18.0`, pnpm `11.7.0`, dsh `0.1.0-rc.6`, and Ubuntu `24.04.4 LTS` / Linux `6.8.0-71-generic` `x86_64`, the dependency-clean frozen install, peer check, ignored-build check (`None`), typecheck, lint, 185 unit tests, aggregate coverage `94.89/89.64/97.92/97.51`, warning-free build, all 7 E2E tests, determinism hash `f4b636ac0401093955bf3938ec8616014da149dc30b5707a9980cac82781fd12`, smoke, structured pack, and exact dry-run allowlist all passed.
- [x] Rerun the packed-tarball clean-profile install, exercise, rollback, and re-enable scenario after the packaging fix: the supported actual registry profile flow successfully added, disabled, removed, and re-added the tarball while preserving the complete `.llmwiki` manifest and restoring the exact service, seven tools, `/wiki` command, prompt section, source/page reads, search, lint, and reindex behavior.

### Final tracker audit

- [x] Confirm every earlier checkbox is either completed or has a documented, approved scope change reflected in both `PLAN.md` and this checklist; no silent skips.
- [x] Confirm every target file in `PLAN.md` exists and every extra committed file has a documented purpose; `.npmignore` is intentionally absent from both the authoritative target tree and repository because `package.json#files` plus the pack gates exactly constrain publication.
- [x] Confirm all affected call sites, tests, docs, examples, package exports, patch metadata, Review A, and Review B agree with the final behavior and release evidence.
- [x] Confirm the focused conventional commit order is reviewable and exact: C12 `ef39d90` → C13-A `094fbc0` → C13-B `92daa29`; no unrelated changes are included in those commits.
- [x] Confirm the post-accounting repository artifact status is clean: physical re-audit found no `node_modules/`, `lib/`, `coverage/`, generated `.index/`, disposable root, tarball, dependency, probe, hidden quarantine, or gate-specific dsh profile/project/store state; only the intended `PLAN.md`/`CHECKLIST.md` tracker-only closure delta remains for this atomic commit.
- [x] Record in this existing tracker as release/PR-description evidence the exact verified environment: Node `v24.18.0`, pnpm `11.7.0`, dsh `0.1.0-rc.6`, Ubuntu `24.04.4 LTS`, Linux `6.8.0-71-generic` `x86_64`. Final delivery repeats these values, satisfying the no-new-file rule.
- [x] Record in this existing tracker as release/PR-description evidence the exact successful gates and packed-profile outcome: clean frozen install, clean peers, ignored builds `None`, typecheck, lint, 185 unit tests, coverage `94.89/89.64/97.92/97.51`, warning-free build, 7 E2E tests with actual registry profile add/disable/remove/re-add, determinism hash `f4b636ac0401093955bf3938ec8616014da149dc30b5707a9980cac82781fd12`, smoke, structured pack, and `pnpm pack --dry-run` exact allowlist. Final delivery repeats this evidence rather than creating a new repository file.
- [x] Close the implementation tracker after the independent closure audit and physical generated-artifact re-audit both returned **CLEAN**; C01–C13 now have zero unchecked tasks and zero unresolved findings.

## Planned commit ledger

- [x] `chore: initialize dsh-llmwiki package` — `93ab0a6`
- [x] `feat: add safe wiki filesystem primitives` — `a614926`
- [x] `feat: add canonical wiki markdown persistence` — `e558c29`
- [x] `feat: add deterministic wiki search index` — `401f364`
- [x] `feat: add deterministic wiki linting` — `fe2ae1b`
- [x] `feat: add llmwiki service orchestration` — `bb3b354`
- [x] `feat: expose llmwiki model tools and prompt` — `d2714e2`
- [x] `feat: add wiki maintenance command` — `35a89e4`
- [x] `feat: ship dsh bundle composition` — `bd939e3`
- [x] `test: cover llmwiki contracts and loader lifecycle` — `c343e67`
- [x] `docs: add llmwiki usage and runnable example` — `cb67064`
- [x] `chore: finalize package and release gates` — `ef39d90`
- [x] `fix(index): recreate deleted derived index` — `094fbc0`
- [x] `test(package): pin native profile dependency` — `92daa29`
- [x] Any additional review-driven `fix(<scope>): ...` commit — N/A; Review A and Review B found no further fix after `094fbc0` and `92daa29`, so the conditional ledger entry is complete.
- [x] `docs: close implementation tracker` — this atomic tracker-only `PLAN.md`/`CHECKLIST.md` closure commit; no hash is invented or pre-recorded.

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
- [x] Resolved C02 pre-gate: exact direct `@deepseek-ai/dsh-brand@0.1.0-rc.6` peer/dev ownership and generated lockfile transfer were completed; C02 uses `Branded<B>`, narrows its import scan to existing modules, defers the all-callsite scan to C13, and enforces real-directory-only configured roots. Completion and commit evidence: C02 is complete and committed as `a614926` (`feat: add safe wiki filesystem primitives`).
- [x] Recorded C10's exact Loader/helper development dependencies and resolved the conditional Include outcome: the provisional direct `@deepseek-ai/cordis-plugin-include@1.0.6` pin was removed because Include remained transitive and unused. The dependency/lock cleanup and disposable-root built-entry probe fixes were completed and reverified with robust pack JSON parsing, disposable-root installs, sanitized resolution, real resolve/realpath guards, and no repository probe files; C10 is complete, verified, review-clean, and committed as `c343e67`.
- [x] Corrected the stale planned `reindex` return type from `IndexStatus` to the atomic `ReindexReceipt` (`pageCount`, `sectionCount`, and `formatVersion`). C11's documentation/runtime alignment, determinism/smoke/packed-demo tightening, accidental self-dependency removal, clean frozen install, and automated README/runtime audit were completed and reverified; C11 is complete, verified, review-clean, and committed as `cb67064`.
- [x] Completed C12's three strengthened evidence proofs without changing scope: repository `src/` and repository `node_modules/` were physically unavailable during packed declaration/runtime/profile child phases under guaranteed reverse restoration; the complete recursive normalized-path/SHA-256 `.llmwiki` manifest, including `.index/*`, was identical at initial, disabled, removed, re-added-before-boot, and restored checkpoints; and the complete recursively normalized lint DTO canonical strings were identical between initial and restored boots. The authoritative package gate remained explicit `npm run prepack` followed by `npm pack --ignore-scripts --json --pack-destination <temp>`, with separate `pnpm pack --dry-run`; the strengthened E2E and every final C12 gate passed with 185 unit tests, coverage `94.89/89.64/97.92/97.51`, 7 E2E tests, and determinism hash `f4b636ac0401093955bf3938ec8616014da149dc30b5707a9980cac82781fd12`. C12 is complete, verified, review-clean, and committed as `ef39d90`; C13's independent final closure audit and physical generated-artifact re-audit are **CLEAN**, and the tracker is complete.

---

## C14–C19B — Handoff adjudication follow-up

This section resumes the completed historical C01–C13 tracker. C01–C13 remain complete for their original deterministic-plugin scope; they do not close the follow-up below. `PLAN.md` §14 is the decision authority. The preserved `handoff-2026-0830.md` is evidence, not a second tracker and is not rewritten by this final reconciliation. The current repository now has `AGENTS.md` from separate guidance commit `99addd9`; that commit is outside C19A's exact-19 accounting.

### Exact 13-ID status ledger

| ID | Exists | Fix? | Approved result | Verification owner | Dependencies | Current status |
|---|---:|---:|---|---|---|---|
| `GAP-INGEST` | yes | yes, agent workflow | Explicit schema/catalog/search/classify/update/link/conflict/structural-lint workflow; no service-side model call | C17 contract implementation and gates verified; C19B alone supplies durable behavioral closure | `GAP-CATALOG`, then credentials/model access | remains open solely pending externally blocked C19B |
| `GAP-CATALOG` | yes | yes | Exact §14.3 deterministic source/page catalogs plus unreferenced-source structural diagnostics | C16 all migration surfaces | C14–C15 sequencing only | complete in C16; independent static closure review CLEAN; final commit `e8a8c2b` (`fix(catalog): preserve safe path semantics`) contains exactly `src/lint.ts`, `src/service.ts`, `tests/lint.spec.ts`, and `tests/service.spec.ts` |
| `GAP-SCHEMA` | yes | no in this follow-up | Truthful create-only human ownership wording; mutation needs a separately approved product contract covering authorization/confirmation, audit evidence, validation, cancellation, and optimistic-concurrency/lost-update behavior | C17 proves preservation and unresolved wording only | external product decision | intentionally unresolved by product decision; C19B does not close it and full handoff closure remains prohibited |
| `GAP-SEMANTIC-LINT` | yes | yes, agent layer | Explicit semantic-review pass over cataloged pages/cited/new sources; deterministic lint unchanged | C17 contract implementation and gates verified; C19B alone supplies seeded contradiction/stale-conclusion behavioral closure | C16, credentials/model access | remains open solely pending externally blocked C19B |
| `GAP-EVIDENCE` | yes | yes, positioning only | Replace semantic evidence claims with exact source-linked invariant | C17 metadata/docs/prompt/tool-description audit | none | complete in C17 after clean three-lens static product review and final commit `10eccf7` |
| `GAP-MODEL-E2E` | yes | yes, split | C19A committed opt-in smoke implementation; C19B separately executes and commits sanitized evidence | C19A keyless preflight; C19B real DeepSeek run | C16–C18; external access for C19B | C19A complete in commit `89fce38`; remains open solely pending externally blocked C19B; `latest.json` is absent and no credentialed model/network run occurred |
| `CLAIM-COMPLETE` | yes, implied only | yes, umbrella wording | Substrate-level positioning; explicitly no full schema-co-evolution claim | C17 coherent package/docs/prompt audit | ingest/schema/lint/evidence decisions | complete in C17 after clean three-lens static product review and final commit `10eccf7` |
| `DEF-INDEX-TRUST` | yes | yes | Shared page-derived semantic freshness for search/status/lint | C14 forged-pair and review-fix regressions | none | complete in C14; independent three-lens final review clean, with only stale tracker accounting found and corrected; final commit `6ba64b3` |
| `DEF-UPSERT-POSTCOMMIT` | yes | yes | No post-commit derived-index failure; fingerprints/trust predicate drive staleness | C15 injected cleanup-denial and rebuild regression | C14 | complete in C15; three-lens final review found no product/test issue, only stale accounting; commit `f2411ae` |
| `DEF-CANONICAL-LINT` | yes | yes | Exact rerendered-byte canonical check, read-only diagnostic | C16 lint regressions/non-mutation proof | grouped with C16 lint edits | complete in C16; independent static closure review CLEAN; final commit `e8a8c2b` (`fix(catalog): preserve safe path semantics`) contains exactly `src/lint.ts`, `src/service.ts`, `tests/lint.spec.ts`, and `tests/service.spec.ts` |
| `DEF-UTF8-PROGRESS` | yes | yes | Stable error when no complete code point fits; successful reads stay capped and advance | C15 multibyte pagination regressions | none | complete in C15; three-lens final review found no product/test issue, only stale accounting; commit `f2411ae` |
| `DEF-EMPTY-SOURCE` | yes | yes | Reject zero-byte content and trim-empty origin consistently; whitespace-only content remains valid | C15 service/plugin/lint validation regressions | none | complete in C15; three-lens final review found no product/test issue, only stale accounting; commit `f2411ae` |
| `DEF-STALE-TARBALL` | yes | yes | Copyable commands use/capture actual scoped `0.1.1` artifact | C18 docs audit | C17 documentation stabilization | complete in C18; independent static documentation review CLEAN; commit `ff4b213` has actual subject `docs: use current packed artifact name` and exactly four paths: `README.md`, `docs/plan/CHECKLIST.md`, `docs/plan/PLAN.md`, and `examples/README.md` |

No other ID is pending. The ledger contains exactly 13 distinct IDs. “Resolved” may not be used for `GAP-SCHEMA` unless a later user-approved mutation contract and implementation milestone replaces this explicit unresolved decision.

### Follow-up dependency graph

```text
C14 page-derived index trust
  └─ C15 truthful mutation and source reads
       └─ C16 frozen deterministic catalogs and complete structural lint
            └─ C17 workflow/semantic-review guidance and honest positioning
                 └─ C18 packed-artifact instructions
                      └─ C19A committable opt-in agent-smoke implementation
                           └─ C19B credentialed execution + sanitized evidence (externally blocked)
```

The ordering is intentionally stricter than the minimum technical dependency graph. Shared paths transfer sequentially: C15 received `src/lint.ts` from C14 for the persisted trim-empty-origin invariant and transferred it to C16 after commit `f2411ae`. C19A must commit reviewed implementation without waiting for credentials; C19B owns only execution evidence and any narrowly necessary correction discovered by the real run.

## C14 — Restore page-derived index trust

**Draft commit:** `1b7754d` (`fix(index): verify derived index semantics`)  
**Review-fix commit:** `11ba0a0` (`fix(index): harden page snapshot trust`)  
**Stable-page-snapshot commit:** `54321a8` (`fix(index): trust stable page snapshots`)  
**Corpus-snapshot commit:** `03db8b8` (`fix(index): validate corpus snapshots`)  
**Final commit:** `6ba64b3` (`fix(index): align lint snapshot trust`)  
**Depends on:** C13 historical closure only  
**IDs:** `DEF-INDEX-TRUST`  
**Owned paths:** `src/indexer.ts`, `src/service.ts`, `src/lint.ts`, `tests/indexer.spec.ts`, `tests/service.spec.ts`, `tests/lint.spec.ts`, affected index goldens only if canonical expected bytes legitimately change  
**Status:** complete. Draft implementation committed as `1b7754d`; first review fixes committed as `11ba0a0`; stable-page-snapshot fixes committed as `54321a8`; corpus-snapshot fixes committed as `03db8b8`. Independent three-lens final review found the implementation clean across the shared index trust rule and final lint/corpus invalid-path behavior; its only finding was stale tracker accounting, corrected here. Final commit `6ba64b3` has actual subject `fix(index): align lint snapshot trust` and exactly five paths: `src/indexer.ts`, `src/lint.ts`, `src/service.ts`, `tests/lint.spec.ts`, and `tests/service.spec.ts`. `DEF-INDEX-TRUST`, C14, and the follow-up C14 ledger are complete. The active-next dependency pointer is C15; C15 work remains not started.

### Implementation

- [x] Define one shared page-derived freshness/trust predicate; do not let service status/search and lint implement divergent acceptance rules.
- [x] Build the expected canonical index from current page bytes, or an exactly equivalent page-derived semantic invariant, before accepting an existing pair as fresh.
- [x] Compare all semantic index content, not only structure, mutual hash, format version, and copied fingerprints.
- [x] Keep `.index` derived/disposable, deterministic, model-free, and safe to delete/rebuild.

### Verification

- [x] Forge canonical `search.json` content with text/frequencies absent from pages, update its companion hash, and retain current page fingerprints.
- [x] Prove search never returns forged text, status never reports the forged pair fresh, and lint emits the designated integrity/staleness diagnostic.
- [x] Prove the next rebuild restores canonical page-derived bytes and the same legitimate search results across repeated roots/runs.
- [x] Preserve malformed/unknown-version/deleted-index behavior and lint non-mutation.
- [x] Enforce status-classification precedence and cover the corrected classification with a regression.
- [x] Read pages safely from the same snapshot used for trust evaluation and cover same-snapshot behavior with a regression.
- [x] Trust page-derived `sectionCount` in status and cover the corrected status result with a regression.
- [x] Detect descriptor changes before or after page reads against a stable snapshot and cover both boundaries with regressions.
- [x] Record the exact stats-bearing `.md` membership/path metadata map in the corpus snapshot and revalidate the complete snapshot at every acceptance, reporting, and write boundary.
- [x] Validate the corpus snapshot before any derived mutation, propagate `UNSAFE_FILESYSTEM`/`ABORTED`, and cover the boundary races with deterministic regressions.

### Completion

- [x] After the current final lint/corpus invalid-path fixes, focused indexer/service/lint tests pass: `pnpm exec vitest run tests/indexer.spec.ts tests/service.spec.ts tests/lint.spec.ts` passed 109/109; `pnpm run typecheck` passed; `pnpm run lint` passed.
- [x] Record draft commit `1b7754d` with actual subject `fix(index): verify derived index semantics` and all eight committed paths: the six C14 product/test paths plus `docs/plan/PLAN.md` and `docs/plan/CHECKLIST.md` tracker bookkeeping.
- [x] Record first review-fix commit `11ba0a0` with actual subject `fix(index): harden page snapshot trust` and all six committed paths: `docs/plan/CHECKLIST.md`, `docs/plan/PLAN.md`, `src/indexer.ts`, `src/service.ts`, `tests/indexer.spec.ts`, and `tests/service.spec.ts`.
- [x] Record stable-page-snapshot commit `54321a8` with actual subject `fix(index): trust stable page snapshots` and all six committed paths: `docs/plan/CHECKLIST.md`, `docs/plan/PLAN.md`, `src/indexer.ts`, `src/service.ts`, `tests/indexer.spec.ts`, and `tests/service.spec.ts`.
- [x] Record corpus-snapshot commit `03db8b8` with actual subject `fix(index): validate corpus snapshots` and exactly five committed paths: `docs/plan/CHECKLIST.md`, `docs/plan/PLAN.md`, `src/indexer.ts`, `src/service.ts`, and `tests/indexer.spec.ts`.
- [x] Independent three-lens final review confirmed every index consumer uses the shared trust rule and the final lint/corpus invalid-path fixes are clean; only stale tracker accounting remained, corrected here.
- [x] Record final commit `6ba64b3` with actual subject `fix(index): align lint snapshot trust` and exactly five paths: `src/indexer.ts`, `src/lint.ts`, `src/service.ts`, `tests/lint.spec.ts`, and `tests/service.spec.ts`.

## C15 — Make mutation and source reads truthful

**Commit:** `f2411ae` (`fix(service): make writes and ranges truthful`)  
**Depends on:** C14  
**IDs:** `DEF-UPSERT-POSTCOMMIT`, `DEF-UTF8-PROGRESS`, `DEF-EMPTY-SOURCE`  
**Committed paths:** `docs/plan/CHECKLIST.md`, `docs/plan/PLAN.md`, `src/lint.ts`, `src/service.ts`, `src/tools.ts`, `tests/lint.spec.ts`, `tests/plugin.spec.ts`, `tests/service-postcommit.spec.ts`, `tests/service.spec.ts`  
**Status:** complete. Independent three-lens final review found no product or test issue; only stale tracker accounting remained, corrected here. `src/lint.ts` ownership is transferred to C16.

### Implementation

- [x] Remove page-upsert post-commit index unlinking; once atomic page rename commits, no later fallible cleanup/abort check may turn the operation into failure.
- [x] Rely on C14 freshness to classify the retained old index as stale and rebuild on demand.
- [x] Preserve the maximum-byte contract: when offset is before EOF and no complete UTF-8 code point fits, return a stable explicit range error; every successful non-EOF read must advance and remain within the requested cap.
- [x] Reject exact zero-byte source content before filesystem mutation.
- [x] Reject optional origin when present but trim-empty; apply the same invariant while parsing persisted metadata so lint and service agree.
- [x] Preserve whitespace-only source content as valid unless this chunk explicitly changes and documents the public contract; do not accidentally replace zero-byte validation with trimmed-content validation.

### Verification

- [x] Simulate index unlink denial/retained stale files, upsert a page, and prove success receipt plus committed bytes; subsequent status/search must detect/rebuild stale derived data.
- [x] Exercise late cancellation and prove it cannot report failure after commit.
- [x] For `漢`, prove limit `1` yields the stable range error and limit `3` advances to EOF; mixed ASCII/multibyte paging never splits, exceeds the cap, or returns a successful zero-progress page before EOF.
- [x] Prove empty content and trim-empty origin create no source directory/metadata; absent origin and meaningful non-empty sources retain dedupe behavior.
- [x] Prove lint diagnoses persisted metadata with trim-empty origin.

### Completion

- [x] Focused service/service-postcommit/plugin/lint tests passed 95/95: `pnpm exec vitest run tests/service.spec.ts tests/service-postcommit.spec.ts tests/plugin.spec.ts tests/lint.spec.ts`; `pnpm run typecheck` passed; `pnpm run lint` passed.
- [x] Public tool/error text matches the executable contract.
- [x] Independent three-lens C15 review found no product or test issue; only stale tracker accounting remained.
- [x] Record commit `f2411ae` with actual subject `fix(service): make writes and ranges truthful` and exactly nine paths: `docs/plan/CHECKLIST.md`, `docs/plan/PLAN.md`, `src/lint.ts`, `src/service.ts`, `src/tools.ts`, `tests/lint.spec.ts`, `tests/plugin.spec.ts`, `tests/service-postcommit.spec.ts`, and `tests/service.spec.ts`; transfer `src/lint.ts` to C16.

## C16 — Add deterministic recovery catalogs and complete structural lint

**Draft commit:** `6516d17` (`feat(catalog): add deterministic wiki listings`)
**Review-fix commit:** `e50f45b` (`fix(catalog): validate complete listings`)
**Traversal-fix commit:** `99ab707` (`fix(catalog): bound directory traversal`)
**Final commit:** `e8a8c2b` (`fix(catalog): preserve safe path semantics`)
**Depends on:** C15  
**IDs:** `GAP-CATALOG`, `DEF-CANONICAL-LINT`  
**Owned paths:** `src/types.ts`, `src/errors.ts`, `src/service.ts`, `src/tools.ts`, `src/presentation.ts`, `src/prompt.ts`, `src/lint.ts` (sequential ownership received from C15), `src/index.ts` if public exports require it; `tests/service.spec.ts`, `tests/lint.spec.ts`, `tests/plugin.spec.ts`, `tests/loader.e2e.spec.ts`, `tests/built-package.e2e.spec.ts`, affected goldens/fixtures; `scripts/check-determinism.ts`, `scripts/smoke.ts`; `README.md`, `examples/README.md`; no package/config/lock/patch change because catalogs reuse `maxResults`  
**Status:** complete. Independent static closure review CLEAN; final commit and C16 follow-up ledger recorded. C17–C19A are also complete; C19B remains externally blocked.

### Frozen contract

- [x] Add service methods exactly `listSources(request?, signal?)` and `listPages(request?, signal?)`, and tools exactly `llmwiki_list_sources` and `llmwiki_list_pages`.
- [x] Migrate to the exact nine-tool order in `PLAN.md` §14.3; remove every exact-seven enumeration/expectation without aliases or compatibility shims.
- [x] Implement exact `CatalogRequest`, `SourceCatalogEntry/Page`, and `PageCatalogEntry/Page` fields and field order from §14.3 with closed output objects.
- [x] Reuse resolved `maxResults`: omitted `limit` means configured `maxResults`; valid range is `1..maxResults`, whose configuration maximum remains `100`; add no config/manifest/bundle field.
- [x] Implement the exact canonical unpadded-base64url cursor forms, kind separation, validation, `INVALID_CURSOR`, `nextCursor: null`, and live-seek mutation semantics from §14.3.
- [x] Sort source ID/page ID by locale-independent code-unit order and seek strictly after the decoded key.
- [x] Fail the whole listing on invalid persisted records with `CATALOG_CORRUPT`, on unsafe filesystem state with `UNSAFE_FILESYSTEM`, and on cancellation with `ABORTED`; never skip malformed entries or leak host paths.
- [x] Return empty pages for missing/uninitialized roots without initialization or mutation; listing performs no index rebuild, clock/network/model/subprocess work.
- [x] Add exact warning `SOURCE_UNREFERENCED` path/message/order from §14.3.

### Implementation

- [x] Add DTOs/errors/service traversal, tool schemas/handlers/presentation, cancellation points, and bounded deterministic serialization exactly as frozen.
- [x] Add unreferenced-source lint without changing or deleting any source.
- [x] After a page parses, rerender through the single canonical Markdown renderer and byte-compare; emit `PAGE_INVALID_MARKDOWN` for any parseable noncanonical bytes without rewriting.
- [x] Update prompt/docs only enough to expose catalog recovery; broad workflow/positioning remains C17-owned.
- [x] Migrate every named owned test/script/doc surface, including exact tool counts/order, Loader disposal/reactivation, built tarball/profile schema/output, prompt enumeration, determinism and ordinary smoke.

### Verification

- [x] Persist a source, interrupt before page upsert, create a fresh service/session, and recover its exact ID and safe immutable metadata solely through `llmwiki_list_sources`.
- [x] Cover empty/single/multi-page catalogs; default/configured/request caps; end cursor; malformed/noncanonical/cross-kind cursor; exact order; repeated serialization; cancellation; no path leakage.
- [x] Mutate between pages and prove frozen live-seek behavior: unchanged keys never duplicate, deleted keys are harmless, inserts `<= after` are omitted, and inserts `> after` may appear.
- [x] Corrupt source metadata/content and page UTF-8/frontmatter/hash inputs and prove whole-call `CATALOG_CORRUPT`; prove unsafe symlinks remain `UNSAFE_FILESYSTEM`; prove no entry is silently skipped.
- [x] Prove an unreferenced source is reported, clears when cited, and reappears when citation is removed; lint remains byte-for-byte non-mutating.
- [x] Diagnose reordered frontmatter, alternate supported serialization, CRLF, blank-line differences, and missing final newline; canonical pages remain clean.
- [x] Exercise direct service and direct tool invocations, plugin, Loader, built-package/profile packed tools, smoke, determinism, nine-tool schema/order/type coverage, presentation, prompt, docs, and closed structured outputs; correct the packed probe to inspect the catalog result.

### Completion

- [x] Focused service/lint/plugin tests passed 115/115; `pnpm run typecheck`, `pnpm run lint`, and `pnpm run build` passed; Loader plus packed/profile E2E passed 8/8; smoke and determinism passed; dependency audit reported no vulnerabilities and no dependency delta.
- [x] Independent static closure review confirmed §14.3 and the final static closure fixes are implemented without an alternate cursor/API/config convention; catalogs and lint remain deterministic/model-free. Verdict: CLEAN.
- [x] Record final commit `e8a8c2b` with actual subject `fix(catalog): preserve safe path semantics` and exactly four product/test paths: `src/lint.ts`, `src/service.ts`, `tests/lint.spec.ts`, and `tests/service.spec.ts`.

**Recorded commits and paths:** `6516d17` contains exactly 18 paths: `README.md`, `docs/plan/CHECKLIST.md`, `docs/plan/PLAN.md`, `examples/README.md`, `scripts/check-determinism.ts`, `scripts/smoke.ts`, `src/errors.ts`, `src/lint.ts`, `src/presentation.ts`, `src/prompt.ts`, `src/service.ts`, `src/tools.ts`, `src/types.ts`, `tests/built-package.e2e.spec.ts`, `tests/lint.spec.ts`, `tests/loader.e2e.spec.ts`, `tests/plugin.spec.ts`, and `tests/service.spec.ts`. `e50f45b` has actual subject `fix(catalog): validate complete listings` and exactly eight paths: `README.md`, `docs/plan/CHECKLIST.md`, `docs/plan/PLAN.md`, `src/service.ts`, `tests/built-package.e2e.spec.ts`, `tests/loader.e2e.spec.ts`, `tests/plugin.spec.ts`, and `tests/service.spec.ts`. `99ab707` has actual subject `fix(catalog): bound directory traversal` and exactly four paths: `docs/plan/CHECKLIST.md`, `docs/plan/PLAN.md`, `src/service.ts`, and `tests/service.spec.ts`. Independent static closure review verdict: CLEAN. Final commit `e8a8c2b` has actual subject `fix(catalog): preserve safe path semantics` and exactly four product/test paths: `src/lint.ts`, `src/service.ts`, `tests/lint.spec.ts`, and `tests/service.spec.ts`. `GAP-CATALOG`, `DEF-CANONICAL-LINT`, C16, and the C16 follow-up ledger are complete. C17 and C18 are complete; `GAP-SCHEMA` remains intentionally unresolved, C19A is active next and not started, and C19B remains externally blocked.

## C17 — Cut over agent workflows and honest positioning

**Draft commit:** `565514f` (`docs: clarify llmwiki workflow and guarantees`)  
**Review-fix commit:** `587f375` (`docs: enforce authorized wiki maintenance`)  
**Final commit:** `10eccf7` (`docs: synchronize wiki maintenance guidance`)  
**Depends on:** C16  
**Contracts frozen/implemented by this chunk:** `GAP-INGEST`, `GAP-SEMANTIC-LINT`; both IDs remain open pending C19B behavioral closure  
**IDs completed by this chunk:** `GAP-EVIDENCE`, `CLAIM-COMPLETE`  
**ID explicitly not closed:** `GAP-SCHEMA`  
**Owned paths:** `src/prompt.ts`, current default-schema definition, tool/command descriptions where needed, `package.json` description, `README.md`, `examples/README.md`, exact prompt/schema/documentation assertions  
**Status:** complete. Required gates passed, the three-lens static product review was clean, and final commit `10eccf7` is recorded with exact path accounting. `GAP-INGEST` and `GAP-SEMANTIC-LINT` remain open pending C19B; `GAP-SCHEMA` remains unresolved.

### Implementation

- [x] Position the product as a local-first, source-linked Markdown wiki storage/retrieval and structural-integrity substrate; remove complete-realization and semantic-entailment implications.
- [x] State the enforced evidence invariant exactly: pages cite existing immutable source records; claim-level support is not deterministically verified.
- [x] Freeze evidence maintenance: status/schema first; source/page catalogs; search/read; classify `new`, `update`, `contradiction`, or `no material change`; update every materially affected page; preserve disagreement; maintain links; run structural lint.
- [x] Freeze a separately named agent semantic-review pass after structural lint. It must list/read all pages in the selected scope, read their cited sources plus new candidate sources, classify `contradiction`, `superseded`, `unsupported`, or `missing-link`, identify page/source IDs visibly, and only perform durable updates when the user request authorizes maintenance.
- [x] State that semantic findings are agent judgments, never `llmwiki_lint` diagnostics; keep service/lint model-free and structural.
- [x] Strengthen the default schema as concise user-owned organization/workflow guidance while preserving create-only initialization and byte-identical custom schemas.
- [x] State `GAP-SCHEMA` durably unresolved: there is no schema mutation API because user authorization/confirmation, audit evidence, and optimistic-concurrency/lost-update behavior need a separate product decision. Do not call governance wording a schema-capability fix or claim full handoff closure.
- [x] Keep historical C01–C13 “COMPLETE” statements scoped to that original plan.

### Verification

- [x] Exact prompt/default-schema tests freeze both agent workflows, classifications, authorization boundary, and structural/semantic separation.
- [x] Initialization writes the strengthened default only when absent; an existing schema is never rewritten.
- [x] Package metadata, README, example, prompt, tools, and command descriptions agree on source-linked, structural-lint, service-layer, agent-layer, and unresolved-schema boundaries.
- [x] Documentation names all nine C16 tools accurately and keeps outputs bounded/copyable.
- [x] A text audit finds no unqualified entailment/full-realization claim, no model judgment attributed to `llmwiki_lint`, and no claim that schema mutation is fixed.

### Completion

- [x] Changed-contract documentation/prompt tests pass; these freeze and implement the two workflow contracts but do not count as behavioral closure.
- [x] Independent three-lens static product review confirmed unconditional lint sequencing, secondary guidance order, current PLAN workflow wording, the full default schema, and the unresolved schema decision are synchronized and executable through public tools. Verdict: CLEAN.
- [x] Record final commit `10eccf7` while leaving `GAP-INGEST` and `GAP-SEMANTIC-LINT` open for C19B.

**Verified gates:** focused plugin/service tests 83/83; `pnpm run typecheck`; `pnpm run lint`; `pnpm run build`; determinism check; built-package E2E 8/8.

**Recorded draft:** `565514f` has actual subject `docs: clarify llmwiki workflow and guarantees` and exactly 13 paths: `README.md`, `docs/plan/CHECKLIST.md`, `docs/plan/PLAN.md`, `examples/README.md`, `examples/demo-wiki/schema.md`, `package.json`, `scripts/check-determinism.ts`, `src/prompt.ts`, `src/service.ts`, `src/tools.ts`, `tests/built-package.e2e.spec.ts`, `tests/plugin.spec.ts`, and `tests/service.spec.ts`.

**Recorded review-fix commit:** `587f375` has actual subject `docs: enforce authorized wiki maintenance` and exactly seven paths: `README.md`, `scripts/check-determinism.ts`, `src/prompt.ts`, `src/service.ts`, `tests/built-package.e2e.spec.ts`, `tests/plugin.spec.ts`, and `tests/service.spec.ts`.

**Recorded final commit:** `10eccf7` has actual subject `docs: synchronize wiki maintenance guidance` and exactly eight paths: `README.md`, `examples/README.md`, `scripts/check-determinism.ts`, `src/prompt.ts`, `src/service.ts`, `tests/built-package.e2e.spec.ts`, `tests/plugin.spec.ts`, and `tests/service.spec.ts`. Its scope is unconditional lint sequencing, secondary guidance order, current PLAN workflow wording, and the full default schema. Tracker-only closure updates are limited to `docs/plan/CHECKLIST.md` and `docs/plan/PLAN.md`.

## C18 — Repair packed-artifact instructions

**Commit:** `ff4b213` — actual subject `docs: use current packed artifact name`
**Depends on:** C17  
**IDs:** `DEF-STALE-TARBALL`  
**Owned paths:** `README.md`, `examples/README.md`; commit path accounting also includes tracker docs `docs/plan/CHECKLIST.md` and `docs/plan/PLAN.md`
**Status:** complete. Independent static documentation review verdict: CLEAN. `DEF-STALE-TARBALL`, C18, review, commit, and ledger are complete. C19A is complete in commit `89fce38`; C19B remains externally blocked.

### Implementation and verification

- [x] Replace exactly four stale `evegoodevening-dsh-llmwiki-0.1.0.tgz` references with exact current `evegoodevening-dsh-llmwiki-0.1.1.tgz` references.
- [x] Preserve `@evegoodevening/dsh-llmwiki`; never substitute the unrelated unscoped package.
- [x] Audit README/examples: zero stale `0.1.0.tgz` matches and exactly four current `evegoodevening-dsh-llmwiki-0.1.1.tgz` matches.
- [x] Verify `pnpm pack` produced `/tmp/dsh-llmwiki-c18-pack/evegoodevening-dsh-llmwiki-0.1.1.tgz`, supporting each documented local/profile install command.
- [x] Complete independent static review. Verdict: CLEAN.
- [x] Record commit `ff4b213` with actual subject `docs: use current packed artifact name` and exactly four committed paths: `README.md`, `docs/plan/CHECKLIST.md`, `docs/plan/PLAN.md`, and `examples/README.md`.

## C19A — Implement the opt-in real-agent smoke

**Commit:** `89fce38` (`test(agent): add opt-in real-model smoke harness`)  
**Depends on:** C18  
**IDs:** `GAP-MODEL-E2E` implementation; prepares C19B behavioral proof for `GAP-INGEST` and `GAP-SEMANTIC-LINT`  
**Owned paths (exactly 19):** `README.md`, `docs/plan/PLAN.md`, `docs/plan/CHECKLIST.md`, `package.json`, `vitest.config.ts`, `vitest.agent-smoke.config.ts`, `scripts/agent-smoke.ts`, `tests/agent-smoke.spec.ts`, `tests/fixtures/agent-smoke/instructions.txt`, `tests/fixtures/agent-smoke/operations-runbook.md`, `tests/fixtures/agent-smoke/project-aurora.md`, `tests/fixtures/agent-smoke/schema.md`, `tests/fixtures/agent-smoke/source-a.txt`, `tests/fixtures/agent-smoke/source-b.txt`, `tests/fixtures/agent-smoke/runner/package.json`, `tests/fixtures/agent-smoke/runner/pnpm-lock.yaml`, `tests/fixtures/agent-smoke/runner/pnpm-workspace.yaml`, `tests/fixtures/agent-smoke/session-pinned/pinned-project/pinned-session/session.jsonl`, and `tests/fixtures/agent-smoke/recovery-valid/pinned-project/recovery-session/session.jsonl`. `tests/fixtures/agent-smoke/latest.json` is C19B-owned and absent.
**Status:** complete. Commit `89fce38` has actual subject `test(agent): add opt-in real-model smoke harness` and exactly the 19 owned paths above. Implementation, independent static product review, focused verification 51/51, `pnpm run typecheck`, `pnpm run lint`, ordinary tests 242/242, dependency audit, commit, and C19A ledger are complete. Separate commit `99addd9` has actual subject `docs(agents): record real-agent smoke constraints` and contains only `AGENTS.md`; it is outside C19A's exact-19 accounting. No credentialed model/network run occurred.

### Implementation contract

- [x] Add exact script `smoke:agent: "tsx scripts/agent-smoke.ts"`; no existing test/build/coverage/determinism/smoke/prepack/release script may invoke it.
- [x] Use pinned `@deepseek-ai/dsh-agent@0.1.1-rc.2` with the packed plugin in a disposable DSH profile/root and provider exactly `deepseek`; explicitly select plaintext unpacked JSONL persistence (`compression: none`, `packChunks: false`), disable the first-prompt `session-title-llm` provider, and discover new IDs at `<sessions>/<project>/<session>` after validating the pinned header; do not substitute direct tool calls for the agent turn.
- [x] Pin and override the disposable runner to exact `@deepseek-ai/cordis@4.0.1` and `@deepseek-ai/cordis-plugin-loader@1.0.2`, regenerate its integrity-bearing lock offline, and reject any resolved Cordis `4.0.2` or Loader `1.0.3` entry.
- [x] Require `LLMWIKI_AGENT_SMOKE_MODEL` with no default and `DEEPSEEK_API_KEY`; support only optional evidence override `LLMWIKI_AGENT_SMOKE_EVIDENCE`, defaulting to `tests/fixtures/agent-smoke/latest.json`.
- [x] Implement `pnpm run smoke:agent -- --preflight` exactly as `PLAN.md` §14.2: local/package/profile/evidence checks without a model request; absent key exits nonzero as `BLOCKED_MISSING_CREDENTIAL`; empty/invalid model/config gets a distinct safe configuration failure.
- [x] Seed a deterministic scenario containing: an existing page with a dated conclusion from source A; newer source B materially contradicting/superseding it; a second linked affected page; and instructions requiring catalog recovery, evidence maintenance, separate semantic review, later-session query, and structural lint.
- [x] Assert external tool trace and durable files/hashes/source IDs; discovery requires both seeded pages and source A only, the post-add/pre-update boundary requires exact source B, and semantic review requires both pages and both sources.
- [x] Validate fresh-session recovery from the strict completed-turn persisted final assistant event: require the Meridian endpoint and both exact durable source IDs; retain only the passing assertion, never response text, prompts, completions, raw content, or absolute paths.
- [x] Generate sanitized canonical evidence only after a real run, with the exact fields in `PLAN.md`; keyless preflight must not create or overwrite `latest.json`.

### Keyless verification and completion

- [x] Prove `--preflight` precisely reports missing credentials/configuration without network/model calls and leaves scenario/profile/root/evidence clean.
- [x] Prove by script-routing and Vitest-config assertions that every ordinary offline gate remains independent, excludes `tests/agent-smoke.spec.ts`, and never invokes the dedicated smoke preflight suite.
- [x] Review scenario assertions, redaction, cleanup, provider/model handling, and evidence schema without claiming a real-model pass. Independent static product review verdict: CLEAN.
- [x] Record committed C19A implementation after keyless verification: commit `89fce38`, actual subject `test(agent): add opt-in real-model smoke harness`, exactly the 19 owned paths above.

## C19B — Execute credentialed agent and semantic-review acceptance

**Commit:** `test: record llmwiki agent smoke evidence`  
**Depends on:** committed C19A  
**IDs behaviorally closed only after all acceptance below passes:** `GAP-INGEST`, `GAP-SEMANTIC-LINT`, `GAP-MODEL-E2E`; does not close `GAP-SCHEMA`  
**Owned paths:** `tests/fixtures/agent-smoke/latest.json` and only narrowly necessary C19A corrections exposed by the real run  
**Status:** externally blocked. The required authorized credential, explicit safe invokable model, permitted/opted-in outbound network access, and zero-exit preflight are not available as a complete set. Prior blocker probes returned `BLOCKED_MISSING_CREDENTIAL` and `BLOCKED_NETWORK_NOT_OPTED_IN`; `tests/fixtures/agent-smoke/latest.json` is absent; no credentialed model or network run occurred. No earlier chunk supplies behavioral closure.

### Exact unblock/preflight condition

- [ ] `DEEPSEEK_API_KEY` is non-empty and authorized; `LLMWIKI_AGENT_SMOKE_MODEL` explicitly names a safe DeepSeek model successfully invokable through pinned DSH agent `0.1.1-rc.2`; `LLMWIKI_AGENT_SMOKE_NETWORK=allow` is explicitly set and outbound access to the configured DeepSeek endpoint is permitted; `pnpm run smoke:agent -- --preflight` exits zero. Until all four conditions hold, preserve the exact applicable blocker classification (`BLOCKED_MISSING_CREDENTIAL` or `BLOCKED_NETWORK_NOT_OPTED_IN`).
- [x] Classify the remaining work as externally blocked rather than inventing, requesting commitment of, or persisting a secret. C14–C19A remain complete/releasable under their own gates.

### Credentialed acceptance

- [ ] Run exactly `pnpm run smoke:agent`; require a real DSH agent/model turn and zero exit.
- [ ] Prove the agent catalogs and reads existing pages/sources before maintenance, identifies the seeded stale conclusion/contradiction in a separately visible semantic-review result, and names affected page/source IDs.
- [ ] Independently inspect durable bytes: the affected page is updated or preserves an explicit disagreement with both source IDs; the linked affected page is maintained; no silent schema rewrite occurs.
- [ ] Start a fresh session and prove catalog/search/read recover the prior state; inspect deterministic structural lint separately from semantic commentary.
- [ ] Commit sanitized `tests/fixtures/agent-smoke/latest.json` containing schema version, provider/model, UTC timestamps, package/tarball hash, scenario ID, ordered assertion results, safe tool names, durable IDs/hashes, lint counts, and overall result; confirm it contains no prompt/completion, source/page content, credential/header, or absolute path.
- [ ] Clean disposable profile/root and independently review evidence. C19B completion requires all assertions and alone supplies behavioral closure for `GAP-INGEST`, `GAP-SEMANTIC-LINT`, and `GAP-MODEL-E2E`; mocks, direct tool calls, self-report, or keyless skip never qualify.

## Follow-up commit ledger

- [x] C14 — draft `1b7754d` (`fix(index): verify derived index semantics`), review fixes `11ba0a0` (`fix(index): harden page snapshot trust`), stable-page-snapshot fixes `54321a8` (`fix(index): trust stable page snapshots`), corpus-snapshot fixes `03db8b8` (`fix(index): validate corpus snapshots`), and final commit `6ba64b3` (`fix(index): align lint snapshot trust`) recorded. The final commit contains exactly `src/indexer.ts`, `src/lint.ts`, `src/service.ts`, `tests/lint.spec.ts`, and `tests/service.spec.ts`; independent three-lens review was clean except stale accounting, corrected in this tracker update.
- [x] C15 — commit `f2411ae` recorded with actual subject `fix(service): make writes and ranges truthful` and exactly nine paths: `docs/plan/CHECKLIST.md`, `docs/plan/PLAN.md`, `src/lint.ts`, `src/service.ts`, `src/tools.ts`, `tests/lint.spec.ts`, `tests/plugin.spec.ts`, `tests/service-postcommit.spec.ts`, and `tests/service.spec.ts`. Independent three-lens final review found no product or test issue; only stale tracker accounting remained, corrected in this tracker update. `DEF-UPSERT-POSTCOMMIT`, `DEF-UTF8-PROGRESS`, `DEF-EMPTY-SOURCE`, and C15 are complete; `src/lint.ts` ownership is transferred to C16.
- [x] C16 — draft `6516d17` (`feat(catalog): add deterministic wiki listings`), review-fix commit `e50f45b` (`fix(catalog): validate complete listings`), and traversal-fix commit `99ab707` (`fix(catalog): bound directory traversal`) recorded with their exact path accounting above. Independent static closure review verdict: CLEAN. Final commit `e8a8c2b` has actual subject `fix(catalog): preserve safe path semantics` and exactly four product/test paths: `src/lint.ts`, `src/service.ts`, `tests/lint.spec.ts`, and `tests/service.spec.ts`. `GAP-CATALOG`, `DEF-CANONICAL-LINT`, C16, and the C16 follow-up ledger are complete.
- [x] C17 — draft `565514f` has actual subject `docs: clarify llmwiki workflow and guarantees` and exactly the 13 paths recorded above. Review-fix commit `587f375` has actual subject `docs: enforce authorized wiki maintenance` and exactly the seven paths recorded above. Independent three-lens static product review verdict: CLEAN. Final commit `10eccf7` has actual subject `docs: synchronize wiki maintenance guidance` and exactly eight paths: `README.md`, `examples/README.md`, `scripts/check-determinism.ts`, `src/prompt.ts`, `src/service.ts`, `tests/built-package.e2e.spec.ts`, `tests/plugin.spec.ts`, and `tests/service.spec.ts`. C17 review, commit, and ledger are complete; `GAP-EVIDENCE` and `CLAIM-COMPLETE` are complete; `GAP-INGEST` and `GAP-SEMANTIC-LINT` remain open pending C19B; `GAP-SCHEMA` remains unresolved.
- [x] C18 — commit `ff4b213` has actual subject `docs: use current packed artifact name` and exactly four paths: `README.md`, `docs/plan/CHECKLIST.md`, `docs/plan/PLAN.md`, and `examples/README.md`. Independent static documentation review verdict: CLEAN. `DEF-STALE-TARBALL`, C18, its review, commit, and ledger are complete.
- [x] C19A — commit `89fce38` has actual subject `test(agent): add opt-in real-model smoke harness` and exactly 19 paths: `README.md`, `docs/plan/CHECKLIST.md`, `docs/plan/PLAN.md`, `package.json`, `scripts/agent-smoke.ts`, `tests/agent-smoke.spec.ts`, `tests/fixtures/agent-smoke/instructions.txt`, `tests/fixtures/agent-smoke/operations-runbook.md`, `tests/fixtures/agent-smoke/project-aurora.md`, `tests/fixtures/agent-smoke/recovery-valid/pinned-project/recovery-session/session.jsonl`, `tests/fixtures/agent-smoke/runner/package.json`, `tests/fixtures/agent-smoke/runner/pnpm-lock.yaml`, `tests/fixtures/agent-smoke/runner/pnpm-workspace.yaml`, `tests/fixtures/agent-smoke/schema.md`, `tests/fixtures/agent-smoke/session-pinned/pinned-project/pinned-session/session.jsonl`, `tests/fixtures/agent-smoke/source-a.txt`, `tests/fixtures/agent-smoke/source-b.txt`, `vitest.agent-smoke.config.ts`, and `vitest.config.ts`. C19A implementation, review, commit, and ledger are complete. Separate guidance commit `99addd9` has actual subject `docs(agents): record real-agent smoke constraints` and exactly one path, `AGENTS.md`; it is outside C19A exact-19 accounting.
- [ ] C19B — externally blocked by the exact unchecked prerequisite and acceptance rows above. It requires an authorized non-empty `DEEPSEEK_API_KEY`, a safe explicit `LLMWIKI_AGENT_SMOKE_MODEL` successfully invokable through pinned DSH agent `0.1.1-rc.2`, `LLMWIKI_AGENT_SMOKE_NETWORK=allow` with permitted outbound access to the configured DeepSeek endpoint, and zero-exit `pnpm run smoke:agent -- --preflight`. `tests/fixtures/agent-smoke/latest.json` is absent; no credentialed/model/network run occurred. It alone behaviorally closes `GAP-INGEST`, `GAP-SEMANTIC-LINT`, and `GAP-MODEL-E2E`; `GAP-SCHEMA` remains intentionally unresolved pending its separate product decision.
