@AGENTS.md

# Implementer rules (Claude Code)

## Scope and workflow
- Work on ONE phase at a time. Read docs/harness-build-plan.md for the current phase. Do not scaffold later phases.
- Start every task in plan mode (/plan): list the files you will touch and the tests you will write. Wait for approval.
- Tests first for anything security-related: write the test, run it, save the FAILING output to reports/, then implement.
- Never weaken, delete, skip, rename or rewrite an existing test to make something pass. If a test must change, stop and say why before changing it.
- Signed-off packages (core, db, policy, sandbox, agent): ask before editing their tests or the policy file. Fixes there need a stated reason.
- Do not commit, amend, push, or run docker compose / pnpm install without approval. Commit messages: "Phase N: <what>". New commit, never amend.
- Use /verify at the end of every task. Report only what the evidence files in reports/ show. Mark anything not run as UNVERIFIED.
- Never print, read or log .env values or API keys. Do not read ~/.ssh or ~/.aws.

## Reporting
- End each task with: what changed (files), what was proven (test names, failing-first then passing), what is UNVERIFIED, open risks.
- Never summarize or reconstruct command output. Point to the file in reports/.
- Do not claim a clean cleanup unless the cleanup block ran straight after the test run with nothing in between.

## Style
- TypeScript strict, ESM, small files, no clever abstractions. Short READMEs per package.
