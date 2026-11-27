# @harness/api

Fastify HTTP API for submitting tasks, watching them, and deciding approvals.

**Local only.** The host is the constant `127.0.0.1` in `src/config.ts`; there is no
environment variable that can bind it to a public interface. The bearer token is a thin
shared secret, not an authentication system.

## Auth

`HARNESS_TOKEN` is required, at least 16 characters, and has no default — the API refuses
to start without it. The check is an instance-wide `onRequest` hook, not a per-route
preHandler, so a route added later cannot forget it. `test/auth.test.ts` enumerates the
routes Fastify actually registered and fails if any answers anything but 401 while
unauthenticated. Comparison is constant time over SHA-256 digests, so neither the value nor
its length leaks.

## Routes

| Method | Path | Notes |
| --- | --- | --- |
| `GET/POST` | `/repos` | `POST` 201 |
| `GET` | `/repos/:id` | |
| `GET` | `/tasks` | `?status=&limit=` |
| `POST` | `/tasks` | inserts `queued`, then enqueues one job |
| `GET` | `/tasks/:id` | steps, verifications, approvals, cost totals |
| `GET` | `/tasks/:id/logs` | SSE: `step`, `status`, `end` |
| `POST` | `/tasks/:id/cancel` | 409 if the status does not allow it |
| `POST` | `/tasks/:id/retry` | `failed -> queued`, `attempt + 1`, re-enqueues |
| `GET` | `/approvals` | `?status=pending` |
| `POST` | `/approvals/:id/decide` | `{approved, note?}`, writes `audit_log` as `human` |

## Rules this package holds

- Query logic lives in `@harness/db`, not in route handlers (hard rule 1). The API imports
  neither the worker nor the sandbox; the queue arrives as an injected `TaskQueuePort`.
- Status changes go only through `transitionTask` (hard rule 9). A lost compare-and-set is
  a 409, never a 500.
- The API never writes `task_steps` (hard rule 15).
- A malformed body is a 400 with no field defaulted past the schema (hard rule 13).
- A human note is masked, truncated, then written (hard rule 14). An unexpected error
  returns `{"error":"internal_error"}` and nothing else: driver messages carry parameter
  values.
- `authorization` and `token` are redacted from the logger.

## Configuration

| Variable | Default | Notes |
| --- | --- | --- |
| `HARNESS_TOKEN` | **required** | ≥16 chars, no default |
| `HARNESS_PORT` | `3017` | a present-but-unparseable value throws |
| `REDIS_URL` | `redis://127.0.0.1:6379` | used by `startApi()` only |
