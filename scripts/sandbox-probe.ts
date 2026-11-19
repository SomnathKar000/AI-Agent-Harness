#!/usr/bin/env -S node --experimental-strip-types
import path from 'node:path';
import fs from 'node:fs';
import {
  createWorkspace,
  startContainer,
  exec,
  readFile,
  writeFile,
  destroy,
  type ContainerLimits,
} from '../packages/sandbox/dist/index.js';

async function main(): Promise<void> {
  const repoPath = path.resolve(process.cwd(), 'fixtures/buggy-repo');
  const taskId = `probe-${Date.now()}`;
  const baseBranch = 'main';

  console.log(`=== Starting Sandbox Security Probe (Task: ${taskId}) ===\n`);

  console.log('1. Creating workspace via createWorkspace()...');
  const workspace = await createWorkspace(repoPath, taskId, baseBranch);
  console.log(`   Worktree: ${workspace.worktreePath}`);
  console.log(`   Branch: ${workspace.branch}`);

  const limits: ContainerLimits = {
    memory: 512 * 1024 * 1024,
    nanoCpus: 1_000_000_000,
    pidsLimit: 100,
  };

  console.log('\n2. Starting container via startContainer()...');
  const containerId = await startContainer(workspace, limits);
  console.log(`   Container started: ${containerId.slice(0, 12)}`);

  async function probeExec(label: string, cmd: string[]) {
    console.log(`\n--- CHECK: ${label} ---`);
    console.log(`Command: ${cmd.join(' ')}`);
    const result = await exec(containerId, cmd, { timeoutMs: 10000 });
    console.log(`Exit Code: ${result.exitCode}`);
    console.log(`Stdout: ${result.stdout ? result.stdout.trim() : '(none)'}`);
    console.log(`Stderr: ${result.stderr ? result.stderr.trim() : '(none)'}`);
    return result;
  }

  try {
    // 1. Network checks
    await probeExec(
      'network: node net.connect to 1.1.1.1:443 (must fail)',
      ['node', '-e', 'import net from "node:net"; const s = net.connect(443, "1.1.1.1"); s.on("error", (e) => { console.error(e.code || e.message); process.exit(1); }); s.on("connect", () => { console.log("connected"); process.exit(0); });']
    );

    await probeExec(
      'network: getent hosts google.com (must fail)',
      ['getent', 'hosts', 'google.com']
    );

    // 2. Host filesystem visibility checks
    await probeExec(
      'filesystem: ls / (container root filesystem)',
      ['ls', '/']
    );

    await probeExec(
      'filesystem: ls /Users /Volumes (host paths must not exist)',
      ['ls', '/Users', '/Volumes']
    );

    // 3. Environment check for secrets
    await probeExec(
      'env: check for secrets in environment (must print nothing)',
      ['sh', '-c', 'env | grep -i -E "anthropic|github|token|key" || true']
    );

    // 4. Read-only rootfs checks (must fail)
    await probeExec(
      'readonly rootfs: touch /etc/x (must fail)',
      ['touch', '/etc/x']
    );

    await probeExec(
      'readonly rootfs: touch /x (must fail)',
      ['touch', '/x']
    );

    // 5. Controls: writable mounts (must succeed)
    await probeExec(
      'control: touch /workspace/ok (must succeed)',
      ['touch', '/workspace/ok']
    );

    await probeExec(
      'control: touch /tmp/ok (must succeed)',
      ['touch', '/tmp/ok']
    );

    // 6. Host-side symlink escape checks
    console.log('\n--- CHECK: host-side symlink escape rejection ---');
    const symlinkPath = path.join(workspace.worktreePath, 'symlink-etc');
    fs.symlinkSync('/etc', symlinkPath);
    console.log(`Created symlink inside worktree: ${symlinkPath} -> /etc`);

    console.log('\nTesting readFile on symlink-etc/passwd:');
    try {
      await readFile(workspace.worktreePath, 'symlink-etc/passwd');
      console.log('Result: UNEXPECTED SUCCESS (should have been rejected)');
    } catch (err: any) {
      console.log('Result: REJECTED AS EXPECTED');
      console.log(`Error: ${err.message}`);
    }

    console.log('\nTesting writeFile on symlink-etc/x:');
    try {
      await writeFile(workspace.worktreePath, 'symlink-etc/x', 'dangerous content');
      console.log('Result: UNEXPECTED SUCCESS (should have been rejected)');
    } catch (err: any) {
      console.log('Result: REJECTED AS EXPECTED');
      console.log(`Error: ${err.message}`);
    }

    // 7. CONTAINER UP & 60s pause
    console.log('\nCONTAINER UP');
    console.log('Waiting 60 seconds before cleanup...');
    await new Promise((resolve) => setTimeout(resolve, 60000));
    console.log('60 seconds wait complete. Proceeding to destroy...');
  } finally {
    console.log('\nCleaning up container and worktree...');
    await destroy({ containerId, workspace });
    console.log('Cleanup complete.');
  }

  console.log('\n=== Probe Execution Finished ===');
}

main().catch((err) => {
  console.error('Probe failed:', err);
  process.exit(1);
});
