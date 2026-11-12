# Changelog

## [Unreleased]

### Changed

- Remove redundant js-yaml, brace-expansion, source-map-js, and Vite overrides now that patched releases resolve under the seven-day release-age policy. Retain the Zod security override and the DeepSeek release-age exemption.
- Move the packed demo's archive and installed-workspace paths from `/tmp` to `/var/tmp` so large temporary dependencies need not occupy RAM-backed storage. Align runner, profile-installation, and cleanup commands, and document checking the backing filesystem and cleaning up after use.

## [0.0.6] - 2026-11-07

### Added

- Add explicit DSH `0.2.2-rc.1` and Cordis `4.1.0` peer support while retaining every existing peer clause. The exact DSH entry also admits this new prerelease tuple under npm's strict semver. Add a native-dependency `0.2.2-rc.1` packed-profile lifecycle row with strict standalone peer/type and physical-peer identity checks.

### Changed

- Upgrade the root development baseline to DSH `0.2.2-rc.1`, Cordis `4.1.0`, Loader `1.1.0`, and Schemastery `3.19.0`. Replace the unused PTC runtime development dependency with the native tool executor, remove the retired `tools.mode` configuration, and migrate current-development tests and smoke to correlated batch tool results. Keep the independently pinned legacy agent-smoke runner and retained-host compositions unchanged; llmwiki itself does not select a host executor.

### Fixed

- Make the packed-profile E2E probe compatible with DSH hosts whose tool executor is a separate plugin (`0.2.2-alpha.2`): wait for the executor before assembling the system prompt, and dispatch probe tool calls through the batch `tools.execute` API there. This is a test-only change; the published plugin code is unchanged.

## [0.0.5] - 2026-10-31

### Changed

- Declare the five DSH service peers as the proven exact older versions plus `>=0.2.1-rc.5 <0.3.0-0`, so later DSH `0.2.x` releases (including prereleases) are admitted without a package update. Widen Cordis to `4.0.1 || >=4.0.4 <4.1.0-0`, which still excludes `4.0.2`/`4.0.3`. DSH admission and pnpm match prereleases inside ranges; npm's strict semver accepts stable `0.2.x` from `0.2.1` but, among prereleases, only `0.2.1-rc.5` and later `0.2.1-*`. The scheduled compatibility monitor remains the check for new upstream releases.

## [0.0.4] - 2026-10-31

### Security

- Patch the isolated agent-smoke runner lock against Zod `<4.6.6` (GHSA-mrhx-c7xc-m3w5) and body-parser `<2.4.0` (GHSA-27r3-jxmh-p828) with `zod@^4: 4.6.6` and `body-parser: 2.4.0` overrides, and pin `qs` `6.16.1` (required by body-parser `^6.16.1`) instead of a release younger than the seven-day age window. Exact legacy Cordis `4.0.1`, Loader `1.0.2`, and DSH `0.1.1-rc.2` pins are retained, and the runner's integrity digest is updated in both agent preflight and the read-only-policy E2E.

### Added

- Add exact DSH `0.2.1-rc.5` support for the five service peers. Upstream `0.2.1-rc.2` → `0.2.1-rc.5` changed only exact sibling versions in these packages' manifests (code, types and exports are identical), but DSH rejected `0.0.3` during `dsh plugin add` because its peer lists ended at `0.2.1-rc.2`. Keep `0.2.1-rc.2` and the previously supported hosts; the intermediate `0.2.1-rc.3`/`rc.4` are not admitted, and add a native-dependency `0.2.1-rc.5` packed-profile row with strict standalone peer/type checks.

### Changed

- Move the root development baseline to DSH `0.2.1-rc.5` (Cordis `4.0.5`, Loader `1.0.6`, Schemastery `3.18.5` unchanged). Only DSH package versions changed in the root lockfile; the independent agent-smoke runner keeps its legacy DSH `0.1.1-rc.2`/Cordis `4.0.1`/Loader `1.0.2` closure apart from the security overrides above.

## [0.0.3] - 2026-10-26

### Security

- Require patched Node.js `^22.23.4 || ^24.22.1 || >=26.12.1` in the package and isolated agent runner, enforce the same range in agent preflight, pin CI to Node `24.22.1` and release npm to `12.2.1`, and migrate pack-result consumers to npm 12's package-keyed JSON.
- Update Vitest/coverage to `4.1.12`; pin patched Vite `8.3.4`, js-yaml `4.3.2`, brace-expansion `1.1.21`/`5.0.12`, and source-map-js `1.2.2` without weakening the seven-day dependency age policy.
- Keep the retained DSH `0.2.0-rc.2` profile's expected Group `1.0.4` closure explicit in its isolated fixture instead of accepting fresh `1.0.5` resolution; latest-upstream compatibility lanes remain native.
- Audit the isolated agent-runner lock as well as the root graph; patch its MCP SDK `1.32.0`, proxy-addr `2.0.8`, fast-uri `3.1.8`, sharp `0.35.5`, ip-address `10.7.4`, and Hono `4.13.11`, retaining exact legacy Cordis/Loader pins and updating the runner's integrity digest.
- Keep the upgraded development graph on patched Zod `4.6.6` instead of DSH `0.2.1-rc.2`'s vulnerable `4.4.3` pin; preserve the seven-day release-age policy and the independent legacy runner.

### Added

- Add exact DSH `0.2.1-rc.2` support for the five service peers, retaining every previously supported version and the pinned legacy agent-smoke runner. Keep the new host in the packed-profile regression matrix with native dependencies and strict standalone peer/type checks.

### Changed

- Upgrade the root development baseline to DSH `0.2.1-rc.2`, Cordis `4.0.5`, Loader `1.0.6`, Schemastery `3.18.5`, and `node-addon-require-builtin` `0.1.9`; regenerate the lockfile, replace `dsh-code-runtime` with `dsh-ptc-runtime`, and remove `dsh-invariants`. Migrate ordinary smoke to `ToolCallId` and Loader tests to returned entry IDs, synchronous removal plus lifecycle waiting, and import-failure diagnostics rather than rejected creation promises.
- Validate the separately pinned agent-smoke version against its own runner manifest rather than the root development dependency; preserve its exact frozen lock, integrity checks, and legacy host fixtures.

### Fixed

- Pin the upstream-compatibility workflow to npm `12.2.1`, matching the release workflow and package-keyed pack-result parser. The runner's bundled older npm returned array metadata and stopped both probes at `build-and-pack` before host compatibility could be checked.
- Align the read-only-policy E2E runner digest with the already committed security-patched lock and agent-smoke preflight, preserving the exact-lock checks and legacy runtime without changing either dependency graph.
- Keep isolated agent preflight aligned with the development toolchain: honor the copied workspace's frozen-install policies and pinned pnpm version, parse machine-readable stdout separately from stderr while retaining the combined output limit, and explicitly activate llmwiki only in the disposable profile. The package remains disabled by default.

## [0.0.2] - 2026-10-17

### Added

- Dependency-audit issue notifications: a separate least-privilege reporter assigns and mentions the maintainer on failure, deduplicates repeated failures, closes the alert after a completed successful audit, and reopens it on regression. Setup and registry failures remain alerts rather than being mistaken for recovery.
- Simplified Chinese README with installation, usage, and development guidance.

### Changed

- Standardized installation documentation on the automatically loaded profile `cordis.patch.yml`, retaining explicit activation and writable wiki roots. Documented preserving existing patches, migrating external overlays without duplicate insertion, and removing the profile entry on uninstall.

### Fixed

- Added exact Cordis `4.0.5` peer support with DSH `0.2.0-rc.2`, retaining the previously supported versions and pinned legacy development dependencies. Latest-version compatibility hosts and strict consumers now apply the existing `@deepseek-ai/*` release-age exception so Cordis resolves with its required Loader/Include companions instead of mixing new core and older plugins; strict peer validation remains enabled.

## [0.0.1]

Initial release of `@evegoodevening/dsh-llmwiki`.

### Added

- Local-first Markdown wiki storage and retrieval as a DeepSeek Harness profile bundle, disabled by default and enabled through an operator-owned patch.
- Nine agent tools for status, immutable source capture and reads, paginated source/page catalogs, page reads and conditional writes, section search, and structural lint; `/wiki status`, `/wiki lint`, and `/wiki reindex` commands.
- SHA-256-addressed UTF-8 source records with preserved provenance, same-content deduplication, and narrow recovery of interrupted, uncommitted source writes.
- Source-linked Markdown pages with required `expectedSha256` write preconditions: `null` for creation or the current raw-Markdown hash for updates. Stale writes return `PAGE_CONFLICT`.
- Deterministic section-level lexical search with NFKC/lowercase tokenization, BM25 field weighting, bounded query-centered snippets, and automatic rebuilding of stale or semantically inconsistent indexes.
- Non-mutating status, catalogs, and structural lint covering storage integrity, links, and index freshness. Source/page reads and search may initialize storage; search may rebuild the index.
- Linux/procfs descriptor-contained filesystem operations with fail-closed capability checks and no pathname fallback. Concurrent writers across activations/processes and hostile root modification remain unsupported.
- Human-owned schema guidance and an agent workflow prompt separating structural lint from model-driven synthesis and semantic review. The plugin itself makes no model or network calls.
- Declared support for DSH `0.1.0-rc.6`, `0.1.1-rc.2`, `0.1.7-rc.2`, and `0.2.0-rc.2`, with the coherent service and Cordis families documented in the README.
- Packed-profile lifecycle and strict-consumer checks, deterministic filesystem race coverage, ordinary smoke, and a separately opted-in credentialed real-agent smoke harness.
- GitHub Actions workflows for npm Trusted Publishing, upstream compatibility monitoring, and an install-free dependency audit; a seven-day minimum dependency release age policy.
- Scoped third-party attribution and the complete retained upstream MIT notice for adapted workflow guidance, included in package artifacts.
