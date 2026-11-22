# @harness/verifier

Post-execution task verification runner and deterministic git diff policy validator.

## Hard Security Boundaries
- **Container-Only Execution**: Lint (`repo.lintCommand`), typecheck (`repo.typecheckCommand`), and tests (`repo.testCommand`) run exclusively inside container isolation (`NetworkMode: none`, read-only rootfs, non-root user). Code from the task worktree is never executed on the host. A missing or empty command is a FAILED check with rule `command_not_configured` — for lint exactly as for typecheck and tests. An unconfigured command means an unverified repo, never a skip and never a pass.
- **Fail-Closed on Timeouts**: All container command checks require `exitCode === 0 && !timedOut`. Any timed-out check fails immediately.
- **Flaky Test Retries**: If tests fail or time out on the initial run, they are rerun once. If the rerun passes cleanly, the test check is marked passed with `flaky: true`.
- **Host Git Confinement & Clean Worktree Guarantee**: All host git operations use `runGit` from `@harness/sandbox` with security hardening flags (`core.hooksPath=/dev/null`, `core.sshCommand=/bin/false`, `protocol.ext.allow=never`). Raw git execution is prohibited. Verification fails if `git status --porcelain` is non-empty.
- **Diff the Commit (Not the Working Tree)**: resolves `git merge-base <base> HEAD` once, then diffs `<mergeBase>..HEAD` with `--name-status -z -M -C` and `--numstat -z`. Rule 6 compares `git show <mergeBase>:<path>` against `git show HEAD:<path>`; `show` and `merge-base` are worktree-scoped in `runGit`, so git always runs with `cwd` = the main repo and an explicit `--git-dir`/`--work-tree`.
- **`worktree_clean` and `secret_scan` are named checks**: a dirty worktree and a secret scan that could not run each fail under their own name, as well as appearing in `diff_policy`. A scan that did not run is not a scan that found nothing.
- **Violations never echo source**: every violation reads `rule | path | line N`. The offending line is exactly where a secret would be, and these strings reach the database and the reviewer.
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
- **Worktree Disk Quota**: Fails if the total worktree disk size exceeds an injectable limit (default: 500MB), including `.git` contents, aborting the walk as soon as the limit is passed. The result carries `entriesVisited` and `earlyExit`, so the early exit is testable by count rather than by timing, and the reported size is a lower bound when the walk aborted.
- **Audit & Persistence**: Stores verification check results in PostgreSQL via `@harness/db` (`verifications` table) using `maskAndTruncate` from `@harness/core` — the same function `PolicyGate` uses, so there is one implementation, not two. Order is fixed: mask, then truncate, then write. The report returned to the caller is masked too, not only the rows.
