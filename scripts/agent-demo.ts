#!/usr/bin/env -S pnpm exec tsx
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

// Load .env fallback if not passed via --env-file
const envPath = path.resolve(process.cwd(), '.env');
if (fs.existsSync(envPath)) {
  const content = fs.readFileSync(envPath, 'utf8');
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx !== -1) {
      const key = trimmed.slice(0, eqIdx).trim();
      const val = trimmed.slice(eqIdx + 1).trim();
      if (!process.env[key]) {
        process.env[key] = val;
      }
    }
  }
}
import {
  createWorkspace,
  startContainer,
  installDependencies,
  exec,
  destroy,
  runGit,
  type Workspace,
} from '../packages/sandbox/dist/index.js';
import {
  runAgent,
  ClaudeClient,
  SandboxToolExecutor,
  type StepLogger,
  type LogStepParams,
} from '../packages/agent/dist/index.js';
import { AllowAllGate } from '../packages/agent/dist/test-utils.js';
import {
  createDb,
  createRepo,
  createTask,
  appendStep,
} from '../packages/db/dist/index.js';

async function runDemo(): Promise<void> {
  const repoPath = path.resolve(process.cwd(), 'fixtures/buggy-repo');
  const taskId = `demo-${Date.now()}`;
  const baseBranch = 'main';

  const dbUrl =
    process.env.DATABASE_URL ||
    'postgres://harness_app:harness_app_password@127.0.0.1:5433/harness';
  const db = createDb(dbUrl);

  console.log('=== Agent Demo: Fixing buggy-repo pagination bug ===\n');

  console.log(`1. Setting up database task record for ${taskId}...`);
  const repoId = `repo-${taskId}`;
  await createRepo(db, {
    id: repoId,
    name: 'buggy-repo',
    localPath: repoPath,
    defaultBranch: 'main',
  });
  await createTask(db, {
    id: taskId,
    repoId,
    title: 'Fix pagination bug in fixtures/buggy-repo',
    description:
      'In fixtures/buggy-repo, the pagination helper in src/paginate.ts returns wrong items because of an off-by-one calculation (page * pageSize instead of (page - 1) * pageSize). Tests currently fail. Understand the bug, reproduce it with the test suite, fix the bug in src/paginate.ts, run the full test suite (pnpm test) to verify all tests pass, and call finish with summary and root_cause.',
    status: 'running',
    maxSteps: 25,
    maxCostUsd: '1.00',
    maxMinutes: 10,
  });

  let totalPromptTokens = 0;
  let totalCompletionTokens = 0;
  let totalCostUsd = 0;
  const loggedSteps: LogStepParams[] = [];

  const dbLogger: StepLogger = {
    async logStep(params: LogStepParams): Promise<void> {
      loggedSteps.push(params);
      totalPromptTokens += params.promptTokens ?? 0;
      totalCompletionTokens += params.completionTokens ?? 0;
      totalCostUsd += params.costUsd ?? 0;

      if (params.kind === 'llm_call') {
        console.log(
          `\n[Step ${params.idx} - LLM Call] Prompt Tokens: ${params.promptTokens}, Completion Tokens: ${params.completionTokens}, Cost: $${(params.costUsd ?? 0).toFixed(4)}`
        );
      } else if (params.kind === 'tool_call') {
        console.log(
          `[Step ${params.idx} - Tool Call: ${params.toolName}] Decision: ${params.decision}`
        );
        console.log(`  Input: ${JSON.stringify(params.input)}`);
        const outputStr =
          typeof params.output === 'string'
            ? params.output
            : JSON.stringify(params.output);
        const preview =
          outputStr.length > 200 ? outputStr.slice(0, 200) + '...' : outputStr;
        console.log(`  Output: ${preview.replace(/\n/g, ' ')}`);
      }

      await appendStep(db, {
        id: crypto.randomUUID(),
        taskId: params.taskId,
        idx: params.idx,
        kind: params.kind,
        toolName: params.toolName ?? null,
        input: params.input as any,
        output: params.output as any,
        decision: params.decision ?? null,
        promptTokens: params.promptTokens ?? 0,
        completionTokens: params.completionTokens ?? 0,
        costUsd: (params.costUsd ?? 0).toFixed(4),
      });
    },
  };

  let workspace: Workspace | undefined;
  let containerId: string | undefined;

  try {
    console.log(`\n2. Creating workspace for task ${taskId}...`);
    workspace = await createWorkspace(repoPath, taskId, baseBranch);
    console.log(`   Worktree at: ${workspace.worktreePath}`);

    console.log('\n3. Installing dependencies in short-lived container (with network)...');
    const installRes = await installDependencies(workspace, [
      'pnpm',
      'install',
      '--allow-build',
      'esbuild',
    ]);
    if (installRes.exitCode !== 0) {
      throw new Error(`Failed to install dependencies: ${installRes.stderr}`);
    }
    console.log('   Dependencies installed successfully.');

    console.log('\n4. Starting locked-down container (NetworkMode: none, ReadonlyRootfs: true)...');
    containerId = await startContainer(workspace, {
      memory: 512 * 1024 * 1024,
      nanoCpus: 1_000_000_000,
      pidsLimit: 100,
    });
    console.log(`   Container ID: ${containerId.slice(0, 12)}`);

    console.log('\n5. Initializing agent components...');
    const llm = new ClaudeClient();
    const gate = new AllowAllGate();
    const executor = new SandboxToolExecutor((cmd, opts) => exec(containerId!, cmd, opts));

    console.log('\n6. Running agent loop (hard limits: 25 steps, $1.00, 10 minutes)...');
    const result = await runAgent(
      {
        id: taskId,
        description:
          'In this repo, the pagination helper in src/paginate.ts returns wrong items because of an off-by-one calculation (page * pageSize instead of (page - 1) * pageSize). Tests currently fail. Run the test suite with `pnpm test` using run_command to see the failure, inspect and edit src/paginate.ts to fix the calculation, re-run `pnpm test` to verify all tests pass, and call finish with summary and root_cause.',
        maxSteps: 25,
        maxCostUsd: 1.0,
        maxMinutes: 10,
      },
      {
        llm,
        gate,
        executor,
        logger: dbLogger,
      }
    );

    console.log('\n=== Agent Execution Finished ===');
    console.log(`Status: ${result.status}`);
    if (result.status === 'done') {
      console.log(`Summary: ${result.summary}`);
      console.log(`Root Cause: ${result.rootCause}`);
    } else if (result.status === 'needs_info') {
      console.log(`Question: ${result.question}`);
    } else {
      console.log(`Failure Reason: ${result.reason}`);
    }

    console.log('\n=== Metrics ===');
    console.log(`Total Steps: ${loggedSteps.length}`);
    console.log(`Total Cost: $${totalCostUsd.toFixed(4)}`);
    console.log(`Prompt Tokens: ${totalPromptTokens}`);
    console.log(`Completion Tokens: ${totalCompletionTokens}`);

    console.log('\n=== Final Git Diff ===');
    const diffResult = await runGit(workspace, ['diff']);
    console.log(diffResult.stdout.trim() || '(no diff)');
  } finally {
    console.log('\n7. Cleaning up container and worktree...');
    await destroy({ containerId, workspace });
    console.log('   Cleanup complete. Container and worktree destroyed.');
  }

  process.exit(0);
}

runDemo().catch((err) => {
  console.error('\nDemo run failed:', err);
  process.exit(1);
});
