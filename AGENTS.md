You are helping me build an "agent harness": a system that runs AI coding agents
on tasks (first task type: bug fixes) safely, in parallel, with human approval.

STACK

- TypeScript (strict), Node 22, pnpm workspaces monorepo, ESM
- Fastify + Zod (API), PostgreSQL + Drizzle ORM, Redis + BullMQ
- dockerode for containers, git worktree per task, Octokit for GitHub PRs
- @anthropic-ai/sdk behind a small LLMClient interface
- pino for logs, vitest for tests, commander for the CLI

PACKAGES (packages/\*)
core, db, policy, sandbox, agent, verifier, github, api, worker, cli

HARD RULES

1. Dependency direction: cli -> api (HTTP only). worker -> sandbox, agent, verifier, github, db, policy.
   core has no dependency on any other package. cli never imports worker/sandbox.
2. The agent never touches the shell or filesystem directly. Every tool call goes
   agent -> policy engine -> sandbox. No exceptions.
3. Policy is default-deny, enforced in code. Never rely on prompt instructions for security.
4. The Anthropic API key and GitHub token exist only in the host process. Never pass
   them into a container or log them.
5. Containers: non-root user, no network at runtime, CPU/memory/time limits,
   only the task's worktree mounted.
6. audit_log is append-only. The app DB role has INSERT and SELECT only.
7. Postgres is the source of truth for task state. Redis/BullMQ only dispatches jobs.
8. Keep it simple. No Temporal, Kubernetes, Firecracker, or subtask decomposition.
9. Write tests for anything security-related BEFORE the implementation.
10. Small, readable files. No clever abstractions. Add a short README per package.

WORKFLOW

- Make changes only for the current phase. Do not scaffold future phases.
- After each step, run typecheck and tests, and report real output.
- If something is ambiguous, ask me instead of guessing.
