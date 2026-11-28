# @harness/cli

`harness` — the command line for submitting tasks and deciding what the agent is allowed
to do.

## Hard rules this package holds

- **HTTP only.** The CLI talks to the API and nothing else. It imports no `worker`,
  `sandbox`, `db`, `policy`, `verifier` or `agent` code, opens no database handle and no
  queue connection (hard rule 1). `test/guard.test.ts` enforces this by reading `src/`.
- **The token stays in a header.** `HARNESS_TOKEN` is sent as `Authorization: Bearer`,
  never in a URL or a query string, and every line printed to a terminal passes through a
  scrubber first — so a token echoed back by a proxy, or buried in an error raised
  somewhere we do not control, still cannot reach the screen.
- **No defaults for secrets.** A missing or empty `HARNESS_TOKEN` is an error with exit
  code 2, not a guess (hard rule 13).

## Configuration

| Variable | Required | Default | Notes |
| --- | --- | --- | --- |
| `HARNESS_TOKEN` | yes | none | Must match the token the API was started with. |
| `HARNESS_URL` | no | `http://127.0.0.1:3017` | Must be a valid http/https URL; a malformed value is an error, not a fallback. |

## Commands

| Command | What it does |
| --- | --- |
| `harness repo list` | List registered repositories |
| `harness repo add --name <n> --path <p> [--branch] [--test-command] …` | Register a repository |
| `harness task list [--status] [--limit]` | List tasks |
| `harness task create --repo <id> --description <text> [--max-steps]` | Queue a task |
| `harness task show <id>` | One task with its verifications, approvals and cost |
| `harness task cancel <id>` | Cancel a task |
| `harness task retry <id>` | Re-queue a failed task (`attempt + 1`) |
| `harness logs <id>` | Follow the task's log stream until it reaches a terminal state |
| `harness approvals list [--status] [--task]` | Pending human decisions (pending by default) |
| `harness approve <approvalId> [--note]` | Approve a request |
| `harness reject <approvalId> [--note]` | Reject a request |

## The approval loop

Two kinds of approval reach `harness approvals list`:

- **`tool_call`** — the policy engine returned `ask` for something the agent wanted to do
  mid-run. The task is sitting in `paused` and the agent loop is blocked waiting. Approve
  it and the tool runs; reject it and the agent is told no and carries on.
- **`final_diff`** — the agent finished and verification passed. The task is in
  `awaiting_approval` and the diff is waiting for review.

A `tool_call` approval that nobody answers is denied on a timeout rather than left open,
and the row is marked `rejected` so it does not linger as pending.
