# @harness/verifier

Post-execution task verification runner and deterministic git diff policy validator.

## Hard Security Boundaries
- **Container-Only Execution**: Lint (`repo.lintCommand`), typecheck (`repo.typecheckCommand`), and tests (`repo.testCommand`) run exclusively inside container isolation (`NetworkMode: none`, read-only rootfs, non-root user). Code from the task worktree is never executed on the host. Missing or empty `testCommand` or `typecheckCommand` results in a failed check. `lintCommand` is optional and recorded as an explicit skipped check.
- **Fail-Closed on Timeouts**: All container command checks require `exitCode === 0 && !timedOut`. Any timed-out check fails immediately.
- **Flaky Test Retries**: If tests fail or time out on the initial run, they are rerun once. If the rerun passes cleanly, the test check is marked passed with `flaky: true`.
- **Host Git Confinement & Clean Worktree Guarantee**: All host git operations use `runGit` from `@harness/sandbox` with security hardening flags (`core.hooksPath=/dev/null`, `core.sshCommand=/bin/false`, `protocol.ext.allow=never`). Raw git execution is prohibited. Verification fails if `git status --porcelain` is non-empty.
- **Diff the Commit (Not the Working Tree)**: Uses `git diff --merge-base <base> HEAD` and `--name-status -z`. Rule 6 reads `HEAD:<path>` via `git show HEAD:<path>`.
- **Deterministic Diff Policy**: Computes the diff against the merge-base on the host and fails if:
  - Any test file is deleted (`**/*.{test,spec}.*`, `test/**`, etc.) or renamed to a non-test file
  - Test files add disabled/skipped markers: `.skip`, `.only`, `xit`, `xdescribe`, or `it.todo`
  - Diff is net-negative on assertion calls (`expect(...)`, `assert(...)`) in test files
  - Test configs are edited (`vitest.config.*`, `jest.config.*`, coverage thresholds)
  - Diff touches `.github/**` or policy files without an approved ask (strictly exact or directory prefix ending in `/`)
  - Diff modifies the `"scripts"` field of any `package.json`
  - Diff touches `.npmrc`
  - Diff exceeds a configurable line limit (default: 400 changed lines)
  - Diff contains `[REDACTED]` anywhere
  - Diff contains any secret value collected from `collectSecretValues(worktreePath)` (collection failure fails verification)
  - Diff matches common secret shapes: PEM private key blocks, AWS AKIA keys, GitHub PATs (`ghp_`, `github_pat_`, `gho_`, `ghs_`, `ghu_`, `ghr_`), GitLab PATs (`glpat-`), Slack tokens (`xox[baprs]-`), Google API keys (`AIza`), or Anthropic API keys (`sk-ant-`)
  - Note: Modifying lockfiles (`pnpm-lock.yaml`, `package-lock.json`, etc.) is recorded as a review item rather than a failure.
- **Worktree Disk Quota**: Fails if the total worktree disk size exceeds a configurable limit (default: 500MB), including `.git` contents, aborting immediately upon exceeding quota.
- **Audit & Persistence**: Stores verification check results in PostgreSQL via `@harness/db` (`verifications` table) with secret masking and 2048-char truncation.
