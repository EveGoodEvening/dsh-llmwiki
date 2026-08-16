# Project Guidance

## Lessons

- As of 2026-08-16, this repository's controlled npm package name is `@evegoodevening/dsh-llmwiki`; the unscoped `dsh-llmwiki` remains a different project (`chancelu/dsh-llmwiki`) and must never be used for this implementation. npm/pnpm pack the scoped package as `evegoodevening-dsh-llmwiki-<version>.tgz`.
- Install out-of-tree DSH profile bundles with `dsh plugin --profile <name> add <package-spec>`. The command runs pnpm in the profile directory and reconciles packages declaring `dsh.bundle` into `dsh.profile.bundles`; plain `pnpm add` does not perform that activation step.
