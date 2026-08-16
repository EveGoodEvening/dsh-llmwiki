# Project Guidance

## Lessons

- As of 2026-08-16, this repository's controlled npm package name is `@evegoodevening/dsh-llmwiki`; the unscoped `dsh-llmwiki` remains a different project (`chancelu/dsh-llmwiki`) and must never be used for this implementation. npm/pnpm pack the scoped package as `evegoodevening-dsh-llmwiki-<version>.tgz`.
- Install out-of-tree DSH profile bundles with `dsh plugin --profile <name> add <package-spec>`. The command runs pnpm in the profile directory and reconciles packages declaring `dsh.bundle` into `dsh.profile.bundles`; plain `pnpm add` does not perform that activation step.
- DSH profiles intentionally set `autoInstallPeers: false`; installing this bundle therefore prints missing-peer warnings even when the running DSH supplies the exact peers through its healed `$DSH_HOME/profiles/node_modules` fallback. Treat a successful profile boot as the compatibility proof, not `pnpm peers check`.
- `llmwiki_status` currently initializes an absent wiki root, creating `schema.md`, `sources/`, `pages/`, and `.index/`, despite its read-only tool wording. Treat this as a known semantic mismatch until the implementation or contract is corrected.
