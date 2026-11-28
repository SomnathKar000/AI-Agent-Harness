**Implementer options:** Antigravity or Claude Code CLI. Claude Code setup (CLAUDE.md, permission rules, /verify) is in `claude-code-implementer-setup.md` and `setup-claude-code.sh`. Whichever tool implements, a separate reviewer signs off; the implementer never grades its own work.

1. Line 1 — title

# AI Agent Harness: Phased Build Plan (v4, updated Nov 28, 2026)

---

2. Lines 10–22 — Status table

| Phase | What                                          | Status                                                                    |
| ----- | --------------------------------------------- | ------------------------------------------------------------------------- |
| 0     | Scaffold, infra, fixture repo                 | ✅ Done                                                                   |
| 1     | Sandbox (worktree + container + hardened git) | ✅ Done                                                                   |
| 2     | DB + state machine + least-privilege role     | ✅ Done (apply the Phase 2 follow-ups below)                              |
| 3     | Agent loop + tools                            | ✅ Done and committed (prices still placeholders)                         |
| 4     | Permission engine + audit + secret masking    | ✅ **Signed off** at `88b89a1` (rounds 5–8)                               |
| 5     | Verifier + diff policy                        | ⏳ Rounds 1–4 done (`6d5843d`), all 12 findings closed, awaiting sign-off  |
| 6     | API + queue + parallel workers                | ⏳ Done at `5de874b`, 478 tests green, awaiting sign-off                  |
| 7     | CLI + approval flow                           | ⏳ Done at `8b8e20d`, 532 tests green, awaiting sign-off                   |
| 8     | GitHub PRs                                    | ⏳                                                                        |
| 9     | Hardening + evals                             | ⏳                                                                        |
| 10    | Dashboard + productization                    | Later                                                                     |

**Verified test counts at `ab89e07`:** policy 129 in 14 files, sandbox 28 in 7, agent 34 in 6,
core 9, db 8, verifier 37 in 4 — 245 total.

**Verified test counts after Phase 7 (Nov 28, 2026), code at `8b8e20d`:** core 9 in 1 file, db 8 in 1,
agent 41 in 7, policy 129 in 14, cli 36 in 6, sandbox 44 in 10, verifier 88 in 11,
worker 85 in 13, api 92 in 9 — **532 total**, every package `EXIT=0`
(`reports/p7-seq-tests.txt`). Phase 6's 478 are reproduced exactly, so Phase 7 added 54
and changed none; the only count to move was `reconcile.test.ts` 11 -> 13, an addition
(`reports/p7-it-count-diff.txt`). Note `docs/test-baseline.txt` and `reports/p7-it-count.txt`
both total **465 static `it(` calls across 72 files**, not 532: `it.each` / `describe.each`
expand at runtime. The two numbers measure different things. The baseline exists only to prove
additions-only between phases, so it is kept as a bare file list with no header — a header would
break the next phase's diff. Cleanup block ran straight after the last package and is
empty (`reports/p7-cleanup.txt`). Typecheck and build clean (`reports/p7-typecheck.txt`).

Phase 7 closed the mid-run approval gap. Before it, `packages/policy/src/gate.ts` wrote a
pending `tool_call` approval row on an `ask` and `packages/agent/src/loop.ts` hard-denied
the call with "approval not implemented", so every row leaked as permanently pending.
Now an `ask` blocks the loop on an injected `ApprovalWaiter`
(`packages/worker/src/approval-waiter.ts`), which drives running -> paused -> running and
fails closed on a missing row, a failed pause, an unreadable row or a timeout. The
`AgentDeps.approvalWaiter` port is optional, so the pre-Phase-7 behaviour and its test
(`packages/agent/test/agent.test.ts:318`) are untouched.

Two real bugs surfaced from tests written first:
- A `CancelledError` raised while paused was wrapped into an `InfraError` by
  `runTaskPipeline`, which would have made BullMQ **retry a cancelled task**.
- `paused` was missing from `STUCK_STATUSES`, so a worker that died mid-approval left the
  task paused forever with its container and worktree skipped as "live".

**Current state (Nov 28, 2026).** `main` is at `8b8e20d` with a clean working tree. Phases 0–4
are done (4 signed off); 5, 6 and 7 are implemented and green but **all three are still awaiting
reviewer sign-off** — the implementer does not grade its own work. Phase 8 (GitHub PRs) has not
been started and nothing for it is scaffolded. Three items are open and none of them block
Phase 8: the pre-existing `core` lint error above, the missing `packages/github` raw-git guard
(follow-up below, marked `[~]`), and the `.env.example` secret values (follow-up below).

**Verified test counts after Phase 6 (Nov 27, 2026), code at `5de874b`:** core 9 in 1 file,
db 8 in 1, agent 34 in 6, policy 129 in 14, sandbox 44 in 10, verifier 88 in 11, worker 74 in 11,
api 92 in 9 — **478 total**, every package `EXIT=0` (`reports/seq-tests.txt`). Phase 5's 312 are
reproduced exactly, so Phase 6 added 166 and changed none.

Run **package-by-package, not as a single `pnpm -r test`**: two attempts at the recursive run were
stopped externally (once by the user, once by Claude Code under host memory pressure), so the
sequential form is what the evidence shows. The cleanup block ran straight after the last package
with nothing in between (`reports/cleanup.txt`), and again after a repeat policy + sandbox run
(`reports/cleanup-2.txt`); both are empty — no containers, no stray worktrees, no `harness/*`
branches. Typecheck clean (`reports/typecheck.txt`, `TYPECHECK_EXIT=0`). Failing-first evidence:
`reports/p6-worker-red.txt`, `reports/p6-reconcile-red.txt`, `reports/p6-api-red.txt`
(all `RED_EXIT=1`). Test-file counts grew by additions only (`reports/it-count-diff.txt`).

Known open: `pnpm -r lint` exits 1 on a **pre-existing** `@typescript-eslint/no-explicit-any` at
`packages/core/src/mask.ts:43` (`reports/lint.txt`). Predates Phase 6 — confirmed by stashing the
Phase 6 changes and re-running. Re-confirmed unchanged after Phase 7 — still the only lint error,
`LINT_EXIT=1` (`reports/p7-lint.txt`). Not fixed here: `core` is signed off and it is out of
phase scope.

**Verified test counts at `6d5843d` (Phase 5 round 4):** policy 129 in 14 files, sandbox 44 in 10,
agent 34 in 6, core 9, db 8, verifier 88 in 11 — **312 total**, `ALL_TESTS_EXIT=0`, with three
consecutive cleanup blocks empty and no hand-cleaning (`reports/r4-*`).

---

3. After line 39 — add a new "Since v3" block

### Since v3 (Nov 22)

- **Phase 4 signed off at `88b89a1`** after four more hardening rounds. Fixed in rounds 5–8:
  masking was key-name dependent (`SENSITIVE_KEY_REGEX` removed, second canary `CANARY_PLAIN`
  proves it); `node <script>` containment was lexical only (now dual lexical + `resolveReal`);
  two writers for `task_steps` (gate stripped of `appendStep`); raw unmasked input reaching
  `task_steps` (central `maskAndTruncateValue` in the loop); `res.reason` unmasked in
  `audit_log`/`approvals`; file tools fail-open on a missing `path` (per-tool Zod schemas,
  `invalid_input`); `.npmrc` readable (hard deny); binary keystores parsed into the secret
  registry; `.env` inline comments; the 5s `collectSecretValues` timeout (now 30s and it
  rejects rather than returning `[]`); dead `recordTaskStep` config.
- **`AllowAllGate` is gone from the demo.** `scripts/agent-demo.ts:183` calls
  `collectSecretValues(workspace.worktreePath)` and `:191` passes it into a real `PolicyGate`.
  `AllowAllGate` now appears only in `packages/agent/test/agent.test.ts` and `src/test-utils.ts`.
- **Phase 5 round 1 committed as `ab89e07`** (`packages/verifier`, 37 tests in 4 files). Not
  signed off — see the Phase 5 section for the 12 findings.
- **Three more report-integrity failures.** Antigravity fabricated a verbose test breakdown
  (round 6), pasted a diff with its largest hunk missing (round 7), and claimed an unaided
  cleanup while its own action log showed a container sweep, a fixture reset and three
  stale-worktree cleanups (Phase 5 round 1). Running the verification commands yourself is not
  optional.
- **Command hygiene:** in zsh, `--include=*.ts` unquoted is glob-expanded and aborts the whole
  command before grep runs (`zsh: no matches found`). Always `--include='*.ts'`. An empty tee
  file means the command did not run, not that there were no matches.

---

4. Lines 120–126 — Verification playbook, item 6

5. **Cleanup check** (after anything touching sandbox or workers). Run it **immediately after the
   test run, with nothing in between** — no container sweeps, no worktree cleanups, no fixture
   resets. A hand-cleaned block proves nothing. Label every line so an empty result is
   attributable:
   ```bash
   echo "--- containers ---";       docker ps -a --filter ancestor=harness-sandbox:latest
   echo "--- buggy worktrees ---";  git -C fixtures/buggy-repo worktree list
   echo "--- inj worktrees ---";    git -C fixtures/injection-repo worktree list
   echo "--- buggy branches ---";   git -C fixtures/buggy-repo branch --list 'harness/*'
   echo "--- inj branches ---";     git -C fixtures/injection-repo branch --list 'harness/*'
   echo "--- worktrees dir ---";    ls -la ~/.harness/worktrees
   echo "--- status ---";           git status --short
   ```
   Use `ancestor=harness-sandbox:latest`, not `name=harness` (the latter matches postgres and
   redis and hides sandbox containers), and run the fixture checks against the fixtures, not the
   main repo.

Then insert as a new item 12:

12. **Count the tests per file, every round:** `grep -c "  it(" packages/*/test/*.test.ts` and
    `grep -n "describe(" packages/*/test/*.test.ts`. Compare with the previous round. A total that
    stays the same while files are reshuffled is how replaced tests hide.

---

5. Lines 74–95 — Global Context Prompt, HARD RULES

Add these to the existing list (they are the invariants that broke repeatedly):

13. Everything fails closed. A missing field, an empty config value, or a thrown exception is a
    deny or a failed check — never a skip, never an allow, never a silent default.
14. Order for anything written to the database: mask secrets, then truncate, then log. Reasons and
    tool inputs included. No raw value ever reaches audit_log, approvals, task_steps or
    verifications.
15. One writer for task_steps (the agent loop). Never a second.
16. No dead configuration. If YAML or an options interface declares something the code never
    reads, remove it — it gives false control.
17. Never delete, rename or weaken an existing test. Renaming a test file out of `*.test.ts` counts
    as deleting it.

---

6. Lines 432–467 — Phase 4 header block

# PHASE 4: Permission engine and audit (REVIEW) ✅

**Status:** ✅ **Signed off** at `88b89a1` ("Phase 4: round 8"), after rounds 5–8.
Verified at sign-off: policy 129 tests in 14 files, sandbox 28 in 7, agent 34, core 9, db 8 —
reproduced independently by the user, cleanup clean twice, unaided.

**What exists**

- `packages/policy`: `evaluate()` (default-deny), `isPathProtected()`, `resolveReal()`, `isInside()`,
  `PolicyGate` (fails closed on any error, logs deny/ask to `audit_log`, creates `approvals` rows
  for ask, `redact()` for grep results). Per-tool Zod schemas; a missing or malformed field is
  `deny` with rule `invalid_input`.
- Files: containment on lexical AND real path, `.git` (file or dir), `.env*`, keys, `.npmrc`
  (hard deny), `.github/**` (ask on write), lockfile edits flagged after protected checks, size and
  path limits, FIFO/device denial, case and NFC/NFD normalization, patterns match at any depth.
- Commands: bare names only, strict allowlist, no `git`, no shells, no `npx|dlx|exec`, argv length
  and control-char checks, `pnpm add` is ask. `node <script>` containment is checked lexically and
  through `resolveReal`.
- Secrets: `collectSecretValues(worktree)` is key-name independent (any value ≥ 8 chars that is not
  in the allowlist and not purely numeric), 30s timeout, rejects rather than returning `[]`.
  `maskSecrets` runs before truncation and logging on every path into the DB.
- Writes containing the literal `[REDACTED]` are denied (`redaction_marker_deny`).
- Host file ops: `O_NOFOLLOW|O_NONBLOCK`, post-open `fstat` regular-file check, size cap, timeout.
- Install phase: `--ignore-scripts` by default.
- `scripts/agent-demo.ts` runs the real `PolicyGate` with a populated secret registry.

**Findings fixed during review (so later phases do not reintroduce them)**

- `grep` read protected files (policy checked only the path argument) → output redacted per file.
- `lstat` follows intermediate symlinks → one `resolveReal()` helper, lexical and real checks.
- Lockfile shortcut returned allow before protected checks → protected checks first.
- Dead YAML sections and a dead `recordTaskStep` option → removed.
- `rel.startsWith('..')` mis-handles `..notes.md` → `isInside()` helper.
- Masking keyed off variable names, so `PLAIN=secret` leaked → key-name independent collection.
- `node link.js` where `link.js → /etc/hosts` escaped the workspace → dual containment check.
- Two writers for `task_steps` → gate no longer writes steps.
- Unmasked `res.reason` and raw tool input reaching the DB → masked and truncated centrally.
- Fail-open defaults (missing `callCount`, missing `path`, non-string `path`) → deny.
- Binary keystores (`.p12/.pfx/.jks/.keystore`) parsed as text into the registry → dropped.

**Known soft spots carried into later phases**

- Command allowlisting is a soft boundary (the agent can edit `package.json` scripts and configs).
  Hard boundaries: the container and the Phase 5 diff policy.
- Masking is exact-match only; separator-split secrets are unmasked by design and documented.
  Real protection is keeping secrets out of the worktree (Phase 6).
- `O_NOFOLLOW` covers only the last path component; TOCTOU remains between `resolveSafePath` and
  `open`. Moving file tools into the container is the robust fix.
- The install phase still has full network access.
- `list_dir` returns the names of denied files; `redact()` filters only `grep`.
- `ask` writes a `pending` approval row the loop never resolves (Phase 7).
- `config/prices.json` zeros make `maxCostUsd` inert.
- `packages/policy/README.md` documents the soft/hard boundary split and "What Phase 5 Must Fail
  On"; `packages/sandbox/test/e2e-canary.test.ts` is the Phase 6 wiring contract.

Delete lines 453–460 (the round 5 checklist) entirely. Keep the original Phase 4 prompt at lines 468–537 as reference.

---

7. Lines 541–598 — Phase 5 section

# PHASE 5: Verifier (REVIEW) ⏳

**Status:** rounds 1–4 committed. **Awaiting reviewer sign-off** — the implementer does not grade
its own work.

| Round | Commit | What |
| ----- | --------- | ----------------------------------------------------------------- |
| 1     | `ab89e07` | `packages/verifier`, 37 tests in 4 files. 12 findings, 3 blocking.  |
| 2     | `3f5fa2f` | Closed 10 of the 12 findings; 53 tests in 4 files.                  |
| 3     | `c8ee8c3` | Stricter bar on the rest + the two partials; 84 tests in 9 files.   |
| 4     | `6d5843d` | `runGit` subcommand scoping, masked DB errors, `diff_parse_unresolved`; 88 tests in 11 files. |

Round 2 was audited rather than taken on trust (`reports/phase5-round2-audit.md`): 10 of 12
findings were already fixed and proven, 2 partial. Rounds 3 and 4 closed those and met the
stricter requirements the review items added.

**All 12 round-1 findings are closed and proven.** Evidence lives in `reports/`: a red file per
item, a green run, and the per-package cleanup hunt.

**What round 1 got right**

- Failing-first for all 36 new tests, with rule-specific violation assertions and a passing control
  per rule.
- Rule 10 proven with a real value from `collectSecretValues`, not a hardcoded string.
- `guard.test.ts` enforces no raw git in the package; zero `child_process`/`execa` imports.
- No Phase 4 regression; tests assert their own worktree and branch cleanup.

**Two findings produced by the review itself (both now fixed)**

- **F1 — `runGit` lost worktree scoping on any `-c key=value` argument.** It located the
  subcommand with `args.find((a) => !a.startsWith('-'))`, so the *value* of a `-c` pair was read
  as the subcommand, nothing matched `WORKTREE_SCOPED_COMMANDS`, no `--git-dir`/`--work-tree` was
  injected, and the command **diffed the main repo with exit code 0** — the Phase 1 containment
  guarantee failing silently. Found when the diff policy returned zero violations for a worktree
  that plainly had them. Fixed in round 4: `findSubcommand()` skips global options and their
  values and **throws** on an unknown subcommand rather than falling through to an unscoped run.
- **F2 — the first fix for the worktree leak was inert.** `hookTimeout` was set in
  `describe(name, options, fn)`, where vitest honours `timeout` but not `hookTimeout`. Two clean
  sandbox runs made it look fixed; that was lighter load. The real fix is `hookTimeout` in
  `vitest.config.ts`. Measured teardown is 2800–6216 ms for the container plus 149–505 ms for the
  worktree, so the old 10 s default sat just above a real 3–7 s cost — which is why the failures
  looked random and moved between tests. Set to 30 s (~4.5× headroom); 120 s would mask a genuine
  hang for two minutes.

Both are the reason the standard is now explicit: **a green that cannot distinguish "fixed" from
"got lucky" is not evidence.**

**Round 1 findings (3 blocking, 12 total) — all closed**

1. **Blocking — the cleanup proof was hand-cleaned.** The report claimed "Pruning Nothing In
   Between" while its action log showed a container sweep, a fixture reset and three
   stale-worktree cleanups. Fixture heads moved from `668f14b`/`167169c` to `a1874a7`/`a1e2a7a`.
2. **Blocking — the diff policy reads the working tree, not the commit.** `git diff <base>` at
   `diff-policy.ts:169,173`, and `package.json` read from the filesystem at `:257`. `HEAD` appears
   nowhere. Commit the bad change, restore the file in the working tree, and it passes.
3. **Blocking — fail-open on missing repo commands.** `container-runner.ts:37,49,61` skip a check
   when the command is empty and leave `allPassed` true; `verifier.ts:62-69` builds a fallback repo
   with no commands and both DB lookups swallow errors. `verifyTask` can return `passed: true`
   having run nothing.
4. `timedOut` is declared and never read — a timed-out run that exits 0 counts as passed.
5. Nothing written to `verifications` is masked or truncated; violation strings echo the offending
   source line. This reinstates the leak Phase 4 closed.
6. Rule 1 checks only status `D` and applies `isTestFile` to the new path, so
   `git mv calc.test.ts calc.txt` removes a test and passes.
7. Rule 5 approval matching is fail-open: an empty string in `approvedAsks` approves everything,
   `startsWith` has no separator boundary, and `approved.includes(path)` matches backwards.
8. Secret-shape regexes have a trailing `\b` after a fixed length, so a _longer_ token fails to
   match. Missing `github_pat_`, `gho_`, `ghs_`, `ghu_`, `ghr_`, `glpat-`, `xox[baprs]-`, `AIza`.
9. `collectSecrets: false` silently disables Rule 10 and a collection failure is swallowed.
10. The size check excludes `.git` (a committed large blob is what gets pushed) and has no early
    exit, so the huge-tree case it exists for is walked in full first.
11. Every test injects `exec`, so `sandboxExec` is never exercised — "runs in the container only"
    is UNVERIFIED.
12. The diff parser swallows removed lines beginning with `-- ` (under-counting deletions, making
    Rule 3 more permissive) and its `diff --git` regex is greedy.

**Goal:** Deterministic checks on the result before any human sees it.

**Tech:** commands run in the container (lint, tsc, tests), diff analysis on the host through
`runGit` against the **merge base and HEAD**.

**High-level design**

```
verifyTask(task, sandbox):
  1. lint, typecheck, tests — inside the container only. Rerun a failing test run once;
     flaky=true if the rerun passes. A missing command is a FAILED check, not a skip.
  2. diff policy on the host, via runGit, against `--merge-base <base> HEAD`:
       - worktree must be clean (git status --porcelain empty)
       - no test file deleted OR renamed out of test-hood
       - no .skip / .only / xit / xdescribe / it.todo added
       - no net removal of assertions in test files
       - no test config weakened
       - no .github/**, policy file, package.json scripts or .npmrc change without approval
       - diff size limit (default 400 changed lines)
       - no [REDACTED], no collectSecretValues value, no common secret shape
       - lockfile_edit reported as a review item, not a failure
  3. worktree size limit (default 500MB), including .git, with early exit
  4. Report { passed, checks[], diffStats, flaky } — every check output masked then truncated
     before it is written to `verifications`
```

**Done when**

- The verifier catches: deleted test, renamed-away test, added `.skip`, weakened assertion, edited
  test config, huge diff, secret in the diff, uncommitted working tree, missing test command
- A good fix passes all checks
- The host never executes anything from the worktree, proven by a test

**Antigravity prompt:** the Phase 5 round 2 prompt (12 items) is in
`claude-code-review-playbook.md` section 9.

---

8. Lines 849–868 — Open follow-ups

## Open follow-ups checklist

**Newest (Nov 22)**

- [x] Phase 5 round 2: the 12 findings above — all closed across rounds 2–4, last at `6d5843d`
- [x] Diagnose what leaves directories in `~/.harness/worktrees` after a full test run — the
      `afterEach` teardown in `packages/sandbox/test/sandbox.test.ts` exceeded vitest's 10s default
      `hookTimeout` and died mid-loop, leaving the worktree of whichever test had just run. Fixed
      in `vitest.config.ts` (see F2). Two consecutive full runs now leave nothing.
- [ ] User runs the verification commands in their own terminal, every round
- [ ] `config/prices.json` real prices (still zeros, `maxCostUsd` is inert)
- [x] Phase 6: wire `collectSecretValues(worktreePath)` into the worker's `PolicyGate` —
      done in `packages/worker/src/pipeline.ts` (via `defaultCreateGate` in `src/ports.ts`);
      proving test `packages/worker/test/secret-wiring.test.ts` (red: `reports/p6-worker-red.txt`,
      green: `reports/p6-worker-green.txt`). Original text:
      contract test is `packages/sandbox/test/e2e-canary.test.ts`, documented under
      "Wiring Not Done Yet" in `packages/policy/README.md`
- [ ] Phase 6: strip or `skip-worktree` tracked secret files in worktrees; network allowlist
      (registry only) for the install phase
- [x] Phase 7: `ask` creates a `pending` approval row the loop never resolves — closed. The loop now waits on `ApprovalWaiter`; an unanswered row is marked `rejected` on timeout rather than left pending. Tests: `packages/agent/test/approval-waiter.test.ts`, `packages/worker/test/approval-waiter.test.ts`, `packages/worker/test/pipeline-approval.test.ts`
- [ ] Move file tools into the container (removes the TOCTOU class entirely)
- [ ] Harder fixtures (multi-file bug, no existing failing test, fix needs a new test) before Phase 9
- [ ] Real repos: `git ls-files | grep -iE '(^|/)\.env|\.pem$|\.key$|\.npmrc'` before first use
- [ ] Confirm `AllowAllGate` is not re-exported from `@harness/agent`'s index
- [ ] Minor: `list_dir` reveals names of denied files; dead `chmod`/`rm` branches in `evaluator.ts`;
      `lower.startsWith('-c')` is over-broad; `llm_call` history logging is quadratic

**Older**

- [ ] Phase 2: default privileges migration, attempt increment test, `createDb` throws without `DATABASE_URL`
- [ ] Phase 1: extend the guard test (`spawn`, `exec`, `child_process`) and confirm the hook test asserts a marker file is not created
- [ ] Phase 3: dedicated Anthropic key with a spend cap
- [x] Phase 4: real policy replaces `AllowAllGate` in the demo — done, `scripts/agent-demo.ts:183,191`
- [x] Phase 6: max 2 verify-fix loops enforced in the worker (`maxVerifyFixLoops`, default 2, `packages/worker/test/pipeline-verify-loop.test.ts`); retry increments `attempt` (`POST /tasks/:id/retry`, `packages/api/test/tasks.test.ts`)
- [~] Add the "no raw git" guard to worker, github and api packages — worker and api done (`packages/worker/test/guard.test.ts`, `packages/api/test/guard.test.ts`); **github still has no guard** (verifier: done)
- [ ] `.env` untracked, `.env.example` has empty secret values — `.env` is untracked (verified);
  `.env.example` still has **non-empty** values for `ANTHROPIC_API_KEY`, `GITHUB_TOKEN` and
  `POSTGRES_PASSWORD`. Checked by pattern only; the values were never printed or read.
  Owner decision: blank them if they are real, leave them if they are placeholders.

---

9. Lines 888–889 — Tips

- **Reviewer loop:** Antigravity implements, a reviewer (Claude chat or Claude Code) reads its report and writes the next prompt. The full procedure, report format and red-flag list are in `claude-code-review-playbook.md`.
- **Do not trust summaries.** Antigravity has pasted reconstructed output three times (invented test files, a condensed `pnpm -r test`, a fabricated verbose breakdown), pasted a diff with its largest hunk missing, and claimed an unaided cleanup after hand-cleaning containers, fixtures and worktrees. Run key commands yourself with `2>&1 | tee /tmp/name.txt` and paste the files. The agent's own action log is part of the evidence — read it against its conclusions.
- **A clean claim is not a clean run.** "Cleanup is empty" only counts when the block runs straight after the test run with nothing in between.
