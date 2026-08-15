# Project Guidance

## Lessons

- As of 2026-08-15, the unscoped npm name `dsh-llmwiki` is owned by a different project (`chancelu/dsh-llmwiki`). Never use a bare registry specifier for this repository unless package ownership and published metadata have been re-verified; use a locally built tarball until this project adopts a controlled package name.
- Install out-of-tree DSH profile bundles with `dsh plugin --profile <name> add <package-spec>`. The command runs pnpm in the profile directory and reconciles packages declaring `dsh.bundle` into `dsh.profile.bundles`; plain `pnpm add` does not perform that activation step.
