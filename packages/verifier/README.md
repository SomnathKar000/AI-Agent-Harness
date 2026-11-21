# @harness/verifier

Post-execution task verification runner and deterministic git diff policy validator.

## Hard Security Boundaries
- **Container-Only Execution**: Lint (`repo.lintCommand`), typecheck (`repo.typecheckCommand`), and tests (`repo.testCommand`) run exclusively inside container isolation (`NetworkMode: none`, read-only rootfs, non-root user). Code from the task worktree is never executed on the host.
- **Flaky Test Retries**: If tests fail on the initial run, they are rerun once. If the rerun passes, the test check is marked passed with `flaky: true`.
- **Host Git Confinement**: All host git operations use `runGit` from `@harness/sandbox` with security hardening flags (`core.hooksPath=/dev/null`, `core.sshCommand=/bin/false`, `protocol.ext.allow=never`). Raw git execution is prohibited.
- **Deterministic Diff Policy**: Computes the diff against the base branch on the host and fails if:
  - Any test file is deleted (`**/*.{test,spec}.*`, `test/**`, etc.)
  - Test files add disabled/skipped markers: `.skip`, `.only`, `xit`, `xdescribe`, or `it.todo`
  - Diff is net-negative on assertion calls (`expect(...)`, `assert(...)`) in test files
  - Test configs are edited (`vitest.config.*`, `jest.config.*`, coverage thresholds)
  - Diff touches `.github/**` or policy files without an approved ask
  - Diff modifies the `"scripts"` field of any `package.json`
  - Diff touches `.npmrc`
  - Diff exceeds a configurable line limit (default: 400 changed lines)
  - Diff contains `[REDACTED]` anywhere
  - Diff contains any secret value collected from `collectSecretValues(worktreePath)`
  - Diff matches common secret shapes: PEM private key blocks, AWS AKIA keys, GitHub PATs (`ghp_`), or Anthropic API keys (`sk-ant-`)
  - Note: Modifying lockfiles (`pnpm-lock.yaml`, `package-lock.json`, etc.) is recorded as a review item rather than a failure.
- **Worktree Disk Quota**: Fails if the total worktree disk size exceeds a configurable limit (default: 500MB).
- **Audit & Persistence**: Stores verification check results in PostgreSQL via `@harness/db` (`verifications` table).
