import { describe, it, expect, afterEach } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import Docker from 'dockerode';
import { execa } from 'execa';
import {
  createWorkspace,
  startContainer,
  installDependencies,
  exec,
  resolveSafePath,
  readFile,
  writeFile,
  listDir,
  getDiff,
  destroy,
  type Workspace,
} from '../src/index.js';

// Resolve repo path relative to this test file location (packages/sandbox/test)
const BUGGY_REPO_PATH = path.resolve(import.meta.dirname, '../../../fixtures/buggy-repo');
const docker = new Docker();

describe('Sandbox Security and Lifecycle Integration Tests', { timeout: 60000 }, () => {
  let createdWorkspaces: Workspace[] = [];
  let createdContainers: string[] = [];

  afterEach(async () => {
    for (const containerId of createdContainers) {
      try {
        await destroy(containerId);
      } catch {
        // cleanup best-effort
      }
    }
    createdContainers = [];

    for (const ws of createdWorkspaces) {
      try {
        await destroy(undefined, ws);
      } catch {
        // cleanup best-effort
      }
    }
    createdWorkspaces = [];
  });

  describe('Path Resolution & File Operations', () => {
    it('path escape with "../../etc/passwd" is rejected', () => {
      const workspaceDir = path.join(os.tmpdir(), `test-ws-escape-${Date.now()}`);
      fs.mkdirSync(workspaceDir, { recursive: true });

      try {
        expect(() => {
          resolveSafePath(workspaceDir, '../../etc/passwd');
        }).toThrow(/outside workspace/i);

        expect(() => {
          resolveSafePath(workspaceDir, '../../../');
        }).toThrow(/outside workspace/i);
      } finally {
        fs.rmSync(workspaceDir, { recursive: true, force: true });
      }
    });

    it('symlink inside worktree pointing to /etc is rejected', () => {
      const workspaceDir = path.join(os.tmpdir(), `test-ws-symlink-${Date.now()}`);
      fs.mkdirSync(workspaceDir, { recursive: true });

      const evilSymlink = path.join(workspaceDir, 'evil_symlink');
      try {
        // Create symlink pointing to /etc
        fs.symlinkSync('/etc', evilSymlink);

        // Accessing the symlink directly or traversal through it must throw
        expect(() => {
          resolveSafePath(workspaceDir, 'evil_symlink');
        }).toThrow(/outside workspace/i);

        expect(() => {
          resolveSafePath(workspaceDir, 'evil_symlink/passwd');
        }).toThrow(/outside workspace/i);
      } finally {
        fs.rmSync(workspaceDir, { recursive: true, force: true });
      }
    });

    it('readFile, writeFile, and listDir safely operate inside workspace', async () => {
      const workspaceDir = path.join(os.tmpdir(), `test-ws-ops-${Date.now()}`);
      fs.mkdirSync(workspaceDir, { recursive: true });

      try {
        // Write file
        await writeFile(workspaceDir, 'subdir/hello.txt', 'hello world');
        expect(fs.readFileSync(path.join(workspaceDir, 'subdir/hello.txt'), 'utf8')).toBe('hello world');

        // Read file
        const content = await readFile(workspaceDir, 'subdir/hello.txt');
        expect(content).toBe('hello world');

        // List dir
        const files = await listDir(workspaceDir, 'subdir');
        expect(files).toContain('hello.txt');

        // Attempting to write outside must throw
        await expect(
          writeFile(workspaceDir, '../outside.txt', 'danger')
        ).rejects.toThrow(/outside workspace/i);

        // Attempting to read outside must throw
        await expect(
          readFile(workspaceDir, '../../../../etc/passwd')
        ).rejects.toThrow(/outside workspace/i);
      } finally {
        fs.rmSync(workspaceDir, { recursive: true, force: true });
      }
    });
  });

  describe('Container Security & Isolation', () => {
    it('network is unreachable from the container', async () => {
      const taskId = `test-net-${Date.now()}`;
      const ws = await createWorkspace(BUGGY_REPO_PATH, taskId, 'main');
      createdWorkspaces.push(ws);

      const containerId = await startContainer(ws);
      createdContainers.push(containerId);

      // Node fetch to an external IP must fail immediately in network: none
      const result = await exec(containerId, [
        'node',
        '-e',
        'fetch("http://1.1.1.1", { signal: AbortSignal.timeout(1000) }).then(() => process.exit(0)).catch(() => process.exit(42))',
      ]);

      expect(result.exitCode).toBe(42);
    });

    it('installDependencies runs in a container with network enabled', async () => {
      const taskId = `test-installdeps-${Date.now()}`;
      const ws = await createWorkspace(BUGGY_REPO_PATH, taskId, 'main');
      createdWorkspaces.push(ws);

      // Run dependency installer check in the container with network
      const installResult = await installDependencies(ws, [
        'node',
        '-e',
        'console.log("deps installed successfully")',
      ]);

      expect(installResult.exitCode).toBe(0);
      expect(installResult.stdout).toContain('deps installed successfully');
    });

    it('host paths outside /workspace are not visible', async () => {
      const taskId = `test-hostpaths-${Date.now()}`;
      const ws = await createWorkspace(BUGGY_REPO_PATH, taskId, 'main');
      createdWorkspaces.push(ws);

      const containerId = await startContainer(ws);
      createdContainers.push(containerId);

      // macOS /Users directory does not exist on the container
      const usersCheck = await exec(containerId, ['ls', '/Users']);
      expect(usersCheck.exitCode).not.toBe(0);

      // Root fs is read-only, cannot write to / or /root
      const writeRootCheck = await exec(containerId, ['touch', '/root/should_fail.txt']);
      expect(writeRootCheck.exitCode).not.toBe(0);

      // Worktree's parent on host (~/.harness) is not mounted
      const harnessParentCheck = await exec(containerId, ['ls', '/home/agent/.harness']);
      expect(harnessParentCheck.exitCode).not.toBe(0);

      // Only /workspace is mounted with worktree contents
      const wsCheck = await exec(containerId, ['ls', '/workspace']);
      expect(wsCheck.exitCode).toBe(0);
      expect(wsCheck.stdout).toContain('package.json');
    });

    it('exec timeout kills the command', async () => {
      const taskId = `test-timeout-${Date.now()}`;
      const ws = await createWorkspace(BUGGY_REPO_PATH, taskId, 'main');
      createdWorkspaces.push(ws);

      const containerId = await startContainer(ws);
      createdContainers.push(containerId);

      const start = Date.now();
      const result = await exec(containerId, ['sleep', '10'], { timeoutMs: 500 });
      const elapsed = Date.now() - start;

      expect(result.timedOut).toBe(true);
      expect(elapsed).toBeLessThan(4000);

      // Verify command was killed and sleep is not lingering
      const psCheck = await exec(containerId, ['sh', '-c', 'pgrep sleep || true']);
      expect(psCheck.stdout.trim()).toBe('');
    });

    it('memory limit is enforced', async () => {
      const taskId = `test-mem-${Date.now()}`;
      const ws = await createWorkspace(BUGGY_REPO_PATH, taskId, 'main');
      createdWorkspaces.push(ws);

      // Limit memory to 64MB
      const containerId = await startContainer(ws, { memory: 64 * 1024 * 1024 });
      createdContainers.push(containerId);

      // Script that tries to allocate 200MB memory in 10MB chunks
      const result = await exec(containerId, [
        'node',
        '-e',
        'const arr = []; while(true) { arr.push(Buffer.alloc(10 * 1024 * 1024)); }',
      ]);

      // Either killed with 137 (OOM killer) or Node process crashes with exitCode != 0
      expect(result.exitCode).not.toBe(0);
    });

    it('destroy() leaves no container or worktree behind', async () => {
      const taskId = `test-destroy-${Date.now()}`;
      const ws = await createWorkspace(BUGGY_REPO_PATH, taskId, 'main');
      const containerId = await startContainer(ws);

      // Confirm worktree exists and container is running
      expect(fs.existsSync(ws.worktreePath)).toBe(true);
      const inspectBefore = await docker.getContainer(containerId).inspect();
      expect(inspectBefore.State.Running).toBe(true);

      // Destroy both
      await destroy({ containerId, workspace: ws });

      // Worktree path should be removed
      expect(fs.existsSync(ws.worktreePath)).toBe(false);

      // Git branch harness/<taskId> should be deleted
      const { stdout: branchList } = await execa('git', ['branch', '--list', ws.branch], {
        cwd: BUGGY_REPO_PATH,
      });
      expect(branchList.trim()).toBe('');

      // Container should be removed
      await expect(docker.getContainer(containerId).inspect()).rejects.toThrow();
    });

    it('getDiff returns git diff against base branch', async () => {
      const taskId = `test-diff-${Date.now()}`;
      const ws = await createWorkspace(BUGGY_REPO_PATH, taskId, 'main');
      createdWorkspaces.push(ws);

      // Write a change in the worktree
      const fileToChange = path.join(ws.worktreePath, 'src/paginate.ts');
      const original = fs.readFileSync(fileToChange, 'utf8');
      fs.writeFileSync(fileToChange, original.replace('items.slice(startIndex, endIndex)', '[]'), 'utf8');

      const diff = await getDiff(ws);
      expect(diff).toContain('items.slice(startIndex, endIndex)');
      expect(diff).toContain('[]');
    });
  });
});
