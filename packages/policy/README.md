# @harness/policy

Security-critical policy engine for AI agent tool calls.

## Features
- **Default-deny**: Any tool call or command not explicitly allowlisted or matched to an approved rule is denied.
- **File System Guard**: Enforces workspace confinement using realpath resolution, blocking parent traversals (`../../`), absolute escapes (`/etc/passwd`), and symlinks resolving outside the workspace.
- **Case and Unicode Normalization**: Protected paths are compared case-insensitively and after NFC and NFD normalization, after resolving `./`, `//`, and trailing slashes.
- **FIFO & Special Device Protection**: Checks files using `lstat` and `stat` without opening them to prevent blocking or hanging on FIFOs or character/block devices.
- **Sensitive Paths Protected**: Blocks reading/writing `.env*`, `*.pem`, `*.key`, `.git` (both as directory and worktree file), `.git/**` (hooks, config), and policy/audit files.
- **Human Approval (ASK)**: Modifying CI files (`.github/**`), package manager configurations (`.npmrc`), and adding dependencies (`pnpm add`, `npm install <pkg>`, `yarn add`) return `ASK`, creating an approval row.
- **Command Security**:
  - `git`: removed completely from agent allowlist (the harness runs git on the host via `runGit`).
  - `node`: only `node <script inside workspace>`, no flags before script path.
  - `package managers`: exactly `[pnpm|npm|yarn] test | run test | run lint | run typecheck | run build`. No flags like `-C`, `--dir`, `--prefix`, `--registry`, `--config`, and no `exec`/`dlx`/`npx`.
  - `tsc/vitest/eslint`: paths passed via `--config`, `-c`, `-p`, `--outDir`, `--outFile` must stay inside workspace.
  - Argv elements containing NUL, newlines, or longer than 4KB are denied.
- **Size Limits**: File paths over 1KB or containing NUL are denied. Write/edit content over 1MB is denied.
- **PolicyGate Integration**: Wires into `@harness/agent` as a `PolicyGate`, recording approvals, audit log entries, and task steps in PostgreSQL.

## Security Boundary Architecture: Soft vs Hard Boundaries

**Command allowlisting is a soft boundary**:
Because the agent has write access inside the workspace, it can edit workspace files such as `package.json` (e.g. modify test/build/lint scripts) or tool configurations. Therefore, command allowlists alone cannot guarantee that the executed scripts do not attempt unauthorized operations.

**The hard boundaries are**:
1. **The Container**: Linux container isolation (`NetworkMode: none`, `ReadonlyRootfs: true`, non-root user, memory/CPU/PIDs limits, only worktree mounted). Even if a malicious script runs, it has zero network access and cannot escape the worktree mount.
2. **Phase 5 Diff Policy**: Deterministic post-execution host checks on the git diff before any human review or PR creation.

### What Phase 5 Must Fail On:
The Phase 5 verifier must reject task results if the diff contains:
- Any changes to `.github/**` workflows or CI configurations without human approval.
- Any changes to `.npmrc` or package manager configurations.
- Any modifications to `package.json` scripts (`scripts` field additions, edits, or removals).
- Any modifications to policy files (`policy/**`, `*.policy.yaml`, `*.policy.yml`).
- Any test files deleted, disabled/skipped (`.skip`, `xit`, `it.todo`), or assertion removals.

## Secret Masking & Known Limitations
- **Exact String Masking**: Secret values collected from the worktree at task start (`.env*`, `.netrc`, `.npmrc`, `.pypirc`, `*.pem`, `*.key`, `id_rsa*`, etc.) are held in host memory and masked (`[REDACTED]`) from all tool outputs before truncation, database logging (`task_steps`, `audit_log`, `approvals`), and returning results to the model.
- **KNOWN LIMITATION: Separator-Split Secrets**: Separator-split secrets (e.g. an attacker script reading a secret and printing it character-by-character or split by separators such as `c-a-n-a-r-y`) or encoded/transformed variants are not matched by exact substring replacement and will NOT be masked.
- **Keep Real Secrets Out of the Worktree**: While container network isolation (`NetworkMode: none`) blocks exfiltration channels, real secrets must never be placed inside the worktree repository. Use placeholder test fixtures only.
