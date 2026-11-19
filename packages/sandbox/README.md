# @harness/sandbox

Docker container lifecycle management and git worktree isolation.

Hard rule: Containers run with non-root user, no network at runtime, CPU/memory/time limits, and only the task's worktree mounted.
