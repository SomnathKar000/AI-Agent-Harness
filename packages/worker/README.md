# @harness/worker

Runs one task end to end: worktree, container, agent, verification, human review.

BullMQ dispatches jobs; **Postgres is the source of truth for state** (hard rule 9). A job
carries nothing but `{ taskId }`.

## Pipeline

`runTaskPipeline(taskId, deps)` in `src/pipeline.ts`:

```
load task + repo         missing row or empty config value -> failed, no fallback
claim                    transitionTask queued -> running (compare-and-set)
createWorkspace          branch + worktree recorded on the task row
installDependencies      short-lived container, network on
commit install artifacts their own commit; its sha is the agent's diff baseline
startContainer           locked down, no network
collectSecretValues      -> PolicyGate  (the Phase 6 wiring contract)
runAgent                 real gate, real container, steps written by one logger
commit agent changes     the verifier reads the committed diff and fails a dirty worktree
verifyTask               against the post-install baseline, not the base branch
  pass -> awaiting_approval + a final_diff approval
  fail -> up to 2 fix rounds (verifying -> running), then failed
finally                  destroy container + worktree, always
```

**Why the install gets its own commit.** `pnpm install` writes a lockfile and generated
files into the worktree. Committing them with the agent's work would attribute them to the
agent and bury a two-line fix under a thousand lines of lockfile, failing the diff-size
rule. Committing them separately keeps the branch installable *and* keeps the agent's diff
honest.

## Mid-run approvals (Phase 7)

When the policy engine returns `ask`, the gate writes a pending `tool_call` approval row
and the agent loop blocks on an `ApprovalWaiter` injected by this package
(`src/approval-waiter.ts`). The waiter drives the state machine around the wait:

```
running --transitionTask--> paused        (approvalId recorded in the audit detail)
  ... poll the approval row every approvalPollMs ...
paused  --transitionTask--> running       (the human decided, either way)
```

It fails closed throughout (hard rule 13). A missing approval row, a failed pause, an
unreadable row or **no answer within the timeout** all resolve to `rejected`, and the row
is marked `rejected` so no pending approval is left for someone to answer after the fact.
The agent is then told no and carries on; it is never silently allowed through.

The one outcome that is not a rejection is a cancel: the waiter throws `CancelledError`,
the agent loop rethrows it rather than treating it as a denial, and the pipeline lets it
past its `InfraError` wrapper so BullMQ does not retry a cancelled task.

`paused` is in `STUCK_STATUSES`, so a worker that dies mid-approval does not strand the
task: the next startup fails it with `worker_restart` and cleans its container and
worktree. Without that, nothing would be listening when the human finally answered.

This writes no `task_steps` row — the agent loop remains the only writer (hard rule 15).

## Cancellation

`POST /tasks/:id/cancel` writes `cancelled` to Postgres. A poller inside the pipeline
re-reads the task status, destroys the container — which makes any in-flight exec fail —
and the run stops at the next step boundary. There is deliberately no Redis cancel flag:
that would be a second source of truth.

## Retries

Only `InfraError` escapes the processor, so BullMQ retries Docker, Postgres and Redis
failures and nothing else. A failed agent, a failed verification and a cancelled task all
resolve normally.

## Startup reconciliation

`reconcileOrphans()` runs before the worker accepts jobs: sandbox containers no live task
claims are removed, worktree directories with no live task are removed, stale worktree
metadata is pruned, and any task still sitting in `running`/`verifying`/`pushing` is marked
`failed` with reason `worker_restart`.

## Configuration

| Variable | Default | Notes |
| --- | --- | --- |
| `REDIS_URL` | `redis://127.0.0.1:6379` | |
| `WORKER_CONCURRENCY` | `3` | a present-but-unparseable value throws |

The Anthropic key stays in this host process and is never passed into a container
(hard rule 4).
