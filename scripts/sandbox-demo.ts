#!/usr/bin/env -S node --experimental-strip-types
import path from 'node:path';
import {
  createWorkspace,
  startContainer,
  installDependencies,
  exec,
  destroy,
} from '../packages/sandbox/dist/index.js';

async function runDemo(): Promise<void> {
  const repoPath = path.resolve(process.cwd(), 'fixtures/buggy-repo');
  const taskId = `demo-${Date.now()}`;
  const baseBranch = 'main';

  console.log('=== Sandbox Demo: Running fixtures/buggy-repo tests in container ===\n');

  console.log(`1. Creating workspace for task ${taskId}...`);
  const workspace = await createWorkspace(repoPath, taskId, baseBranch);
  console.log(`   Worktree created at: ${workspace.worktreePath}`);
  console.log(`   Branch: ${workspace.branch}`);

  let containerId: string | undefined;

  try {
    console.log('\n2. Installing dependencies in short-lived container (with network)...');
    const installResult = await installDependencies(workspace, [
      'pnpm',
      'install',
      '--allow-build',
      'esbuild',
    ]);
    if (installResult.exitCode !== 0) {
      console.error('Dependency installation failed:', installResult.stderr);
      throw new Error(`pnpm install failed with exit code ${installResult.exitCode}`);
    }
    console.log('   Dependencies installed successfully.');

    console.log('\n3. Starting locked-down container (NetworkMode: none, ReadonlyRootfs: true)...');
    containerId = await startContainer(workspace, {
      memory: 512 * 1024 * 1024,
      nanoCpus: 1_000_000_000,
      pidsLimit: 100,
    });
    console.log(`   Container started with ID: ${containerId.slice(0, 12)}`);

    console.log('\n4. Executing `pnpm test` inside the locked-down container...');
    const testResult = await exec(containerId, ['pnpm', 'test'], {
      timeoutMs: 30000,
    });

    console.log('\n--- Container Test Run Stdout ---');
    console.log(testResult.stdout.trim());
    if (testResult.stderr.trim()) {
      console.log('\n--- Container Test Run Stderr ---');
      console.log(testResult.stderr.trim());
    }
    console.log(`\nExit Code: ${testResult.exitCode} (expected failure due to buggy-repo pagination bug)`);
    console.log(`Timed out: ${testResult.timedOut}`);
  } finally {
    console.log('\n5. Cleaning up container and worktree...');
    await destroy({ containerId, workspace });
    console.log('   Cleanup complete. Container stopped and removed, worktree and branch deleted.');
  }

  console.log('\n=== Sandbox Demo Finished Successfully ===');
}

runDemo().catch((err) => {
  console.error('Sandbox demo failed:', err);
  process.exit(1);
});
