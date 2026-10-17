# Changelog

## [Unreleased]

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
