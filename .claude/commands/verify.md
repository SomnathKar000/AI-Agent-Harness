---
description: Run the harness verification block and write evidence files to reports/
---

Run these from the repo root. Redirect output to files in reports/ (create it if needed). Do not summarize or paraphrase output. When done, list the files and, for each, give only the final summary line from the file.

1. `git status --short` and `git log --oneline -5` -> reports/git-state.txt
2. `pnpm -r build` and `pnpm -r typecheck` -> reports/typecheck.txt
3. `pnpm -r test` -> reports/all-tests.txt
4. `pnpm --filter @harness/policy test -- --reporter=verbose` -> reports/policy-verbose.txt
5. `pnpm --filter @harness/sandbox test` twice -> reports/sandbox-run1.txt and reports/sandbox-run2.txt
6. CLEANUP: immediately after step 5, with NO other command in between (no container sweeps, no worktree cleanups, no fixture resets), run this labeled block and write it to reports/cleanup.txt:
   - `echo "--- containers ---"; docker ps -a --filter ancestor=harness-sandbox:latest`
   - `echo "--- buggy worktrees ---"; git -C fixtures/buggy-repo worktree list`
   - `echo "--- inj worktrees ---"; git -C fixtures/injection-repo worktree list`
   - `echo "--- buggy branches ---"; git -C fixtures/buggy-repo branch --list 'harness/*'`
   - `echo "--- inj branches ---"; git -C fixtures/injection-repo branch --list 'harness/*'`
   - `echo "--- worktrees dir ---"; ls -la ~/.harness/worktrees`
   - `echo "--- status ---"; git status --short`
   If anything is left over, report it as a finding. Do NOT clean it up yourself.
7. Test counts per file: `grep -c "  it(" packages/*/test/*.test.ts` -> reports/it-count.txt. Compare with docs/test-baseline.txt and write the differences to reports/it-count-diff.txt. Any file whose count went down, or a missing file, is a finding.
8. `git diff HEAD~1 -- . ':!pnpm-lock.yaml'` -> reports/last-commit.patch
9. `git ls-files | grep -E "^\.env$" || echo ".env not tracked"` -> reports/env-check.txt

Then print: the files written, which commands failed (with exit code), and anything UNVERIFIED. If a file is empty, say the command did not run; do not say "no matches".
