# AI Agent Harness: project rules (AGENTS.md)

You are helping me build an "agent harness": a system that runs AI coding agents on tasks
(first task type: bug fixes) safely, in parallel, with human approval.

## STACK

- TypeScript (strict), Node 22, pnpm workspaces monorepo, ESM
- Fastify + Zod (API), PostgreSQL + Drizzle ORM, Redis + BullMQ
- dockerode for containers, git worktree per task, Octokit for GitHub PRs
- @anthropic-ai/sdk behind a small LLMClient interface
- pino for logs, vitest for tests, commander for the CLI

## LOCAL ENV

- macOS. Docker Compose runs Postgres (host port 5433) and Redis.
- Runtime DB access uses DATABASE_URL (role harness_app, least privilege).
- Migrations use DATABASE_ADMIN_URL (role harness). Tests use database harness_test.
- Never edit a migration that has already been applied. Add a new one.
- zsh: always quote globs for grep (--include='*.ts'). An empty tee file means the command did not run.

## PACKAGES (packages/*)

core, db, policy, sandbox, agent, verifier, github, api, worker, cli

## HARD RULES

1. Dependency direction: cli -> api (HTTP only). worker -> sandbox, agent, verifier, github, db, policy.
   core has no dependency on any other package. cli never imports worker/sandbox.
2. The agent never touches the shell or filesystem directly. Every tool call goes
   agent -> policy engine -> sandbox. No exceptions.
3. Policy is default-deny, enforced in code. Never rely on prompt instructions for security.
4. The Anthropic API key and GitHub token exist only in the host process. Never pass them into a
   container or log them.
5. Containers: non-root, CapDrop ALL, no-new-privileges, read-only rootfs, no network at runtime,
   CPU/memory/pids/time limits, only the task's worktree mounted.
6. ALL host-side git calls go through runGit in packages/sandbox/src/git.ts. Never call execa('git'),
   spawn('git') or child_process git anywhere else. runGit runs with cwd = main repo, explicit
   --git-dir/--work-tree, hooksPath=/dev/null, fsmonitor=false, sshCommand=/bin/false.
7. Treat everything inside a worktree as untrusted (including the .git file, hooks, node_modules/.bin).
   Never execute anything from a worktree on the host.
8. audit_log is append-only. The app DB role has INSERT and SELECT only.
9. Postgres is the source of truth for task state. Redis/BullMQ only dispatches jobs.
   State changes go through transitionTask (compare-and-set).
10. Keep it simple. No Temporal, Kubernetes, Firecracker, or subtask decomposition.
11. Write tests for anything security-related BEFORE the implementation, and show them failing first.
12. Small, readable files. No clever abstractions. Add a short README per package.
13. Everything fails closed. A missing field, an empty config value, or a thrown exception is a deny or
    a failed check, never a skip, never an allow, never a silent default.
14. Order for anything written to the database: mask secrets, then truncate, then log. Reasons and
    tool inputs included. No raw value ever reaches audit_log, approvals, task_steps or verifications.
15. One writer for task_steps (the agent loop). Never a second.
16. No dead configuration. If YAML or an options interface declares something the code never reads,
    remove it. It gives false control.
17. Never delete, rename or weaken an existing test. Renaming a test file out of *.test.ts counts as
    deleting it.

## TASK STATES

queued -> running -> verifying -> awaiting_approval -> pushing -> done
running <-> paused (mid-run tool approvals); running <-> needs_info
verifying -> running (agent fixes failed verification, max 2 times)
failed -> queued (retry, attempt + 1); any non-terminal -> failed | cancelled
awaiting_approval -> running is NOT allowed (awaiting_approval is final diff review only)

## WORKFLOW

- Make changes only for the current phase. Do not scaffold future phases.
- After each step, run typecheck and tests, and report REAL raw output. Never predict output.
- Mark anything you did not run as UNVERIFIED.
- Never weaken or delete an existing test to make something pass. If a test must change, say why.
- If something is ambiguous, ask me instead of guessing.
