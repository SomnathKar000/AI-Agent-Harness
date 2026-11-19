# @harness/sandbox

Docker container lifecycle management and git worktree isolation.

## Security Constraints

- Containers run as non-root user (`agent`, matching host UID/GID).
- `NetworkMode: "none"` at runtime.
- Read-only root filesystem (`ReadonlyRootfs: true`) with tmpfs on `/tmp`.
- Memory, CPU (`NanoCpus`), and process limits (`PidsLimit`) enforced.
- Only the task's git worktree is mounted at `/workspace`.
- The main repo's `.git` is never mounted or exposed to the container. All git operations (diff, commit, worktree creation/destruction) are performed from the host.
- Path operations strictly enforce workspace root boundaries using canonical paths (`realpath`), rejecting any symlinks or `..` traversals escaping the worktree.

## API

- `createWorkspace(repoPath, taskId, baseBranch)`: Creates a git worktree at `~/.harness/worktrees/<taskId>` on a new branch `harness/<taskId>`. Returns paths and branch info.
- `startContainer(workspace, limits)`: Starts a locked-down container from `harness-sandbox:latest` with network disabled, read-only rootfs, limits, and worktree mounted at `/workspace`.
- `installDependencies(workspace, installCommand)`: Runs a short-lived container with network enabled to install dependencies into the worktree `node_modules`.
- `exec(containerId, cmd, options)`: Runs a command inside the container with timeout enforcement and output size limits. Kills the command on timeout.
- `resolveSafePath(workspaceRoot, userPath)`: Resolves realpath, rejecting any path outside the worktree, including symlinks.
- `readFile(workspaceRoot, userPath, encoding)`: Reads a file inside workspace using safe path resolution.
- `writeFile(workspaceRoot, userPath, content, encoding)`: Writes a file inside workspace using safe path resolution.
- `listDir(workspaceRoot, userPath)`: Lists directory contents safely within workspace.
- `getDiff(workspace)`: Generates unified git diff against base branch from host.
- `destroy(target, workspace)`: Stops and removes container, removes worktree and deletes the task branch.
