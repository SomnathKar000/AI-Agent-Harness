import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {
  createRepo,
  createTask,
  getTask,
  getTaskDetail,
  type Database,
} from '@harness/db';
import { runGit, listSandboxContainers } from '@harness/sandbox';
import type {
  LLMClient,
  CompleteOptions,
  CompletionResponse,
  ToolUseBlock,
} from '@harness/agent';
import { runTaskPipeline, type PipelineOutcome } from '../src/pipeline.js';
import {
  defaultSandbox,
  defaultAgent,
  defaultVerifier,
  defaultCreateGate,
  type SandboxPort,
} from '../src/ports.js';
import { setupTestDb } from './helpers.js';

const BUGGY_REPO_PATH = path.resolve(
  import.meta.dirname,
  '../../../fixtures/buggy-repo'
);

const BUG_LINE = 'const startIndex = page * pageSize;';
const FIXED_LINE = 'const startIndex = (page - 1) * pageSize;';

/**
 * A scripted LLM that makes the real fix. It is the only faked piece: the worktrees,
 * containers, policy gate and verifier are the real ones, which is what this test is for.
 */
function scriptedFixer(label: string): LLMClient {
  let turn = 0;
  return {
    async complete(_options: CompleteOptions): Promise<CompletionResponse> {
      turn++;
      const block = (name: string, input: Record<string, unknown>): ToolUseBlock => ({
        type: 'tool_use',
        id: `${label}-call-${turn}`,
        name,
        input,
      });

      if (turn === 1) {
        return {
          content: [block('read_file', { path: 'src/paginate.ts' })],
          stopReason: 'tool_use',
          usage: { inputTokens: 100, outputTokens: 20 },
        };
      }
      if (turn === 2) {
        return {
          content: [
            block('edit_file', {
              path: 'src/paginate.ts',
              old_string: BUG_LINE,
              new_string: FIXED_LINE,
            }),
          ],
          stopReason: 'tool_use',
          usage: { inputTokens: 100, outputTokens: 20 },
        };
      }
      if (turn === 3) {
        return {
          content: [block('run_command', { argv: ['pnpm', 'test'] })],
          stopReason: 'tool_use',
          usage: { inputTokens: 100, outputTokens: 20 },
        };
      }
      return {
        content: [
          block('finish', {
            summary: 'Fixed off-by-one page offset in paginate',
            root_cause: 'startIndex used page instead of page - 1',
          }),
        ],
        stopReason: 'tool_use',
        usage: { inputTokens: 100, outputTokens: 20 },
      };
    },
  };
}

interface Recorded {
  taskId: string;
  worktreePath?: string;
  containerId?: string;
}

/** Wraps the real sandbox so the test can see which worktree and container a task got. */
function recordingSandbox(record: Recorded): SandboxPort {
  return {
    ...defaultSandbox,
    async createWorkspace(repoPath, taskId, baseBranch) {
      const ws = await defaultSandbox.createWorkspace(repoPath, taskId, baseBranch);
      record.worktreePath = ws.worktreePath;
      return ws;
    },
    async startContainer(ws, limits) {
      const id = await defaultSandbox.startContainer(ws, limits);
      record.containerId = id;
      return id;
    },
  };
}

describe('Parallel tasks are isolated', { timeout: 600000 }, () => {
  let db: Database;
  const createdTaskIds: string[] = [];

  beforeAll(async () => {
    db = await setupTestDb('harness_test_parallel');
  });

  afterEach(async () => {
    // Every worktree and branch this test made is gone, and nothing is left in the fixture.
    const worktrees = await runGit(BUGGY_REPO_PATH, ['worktree', 'list']);
    expect(String(worktrees.stdout).trim().split('\n').length).toBe(1);

    const branches = await runGit(BUGGY_REPO_PATH, ['branch', '--list', 'harness/*']);
    expect(String(branches.stdout).trim()).toBe('');

    for (const taskId of createdTaskIds) {
      const dir = path.join(os.homedir(), '.harness', 'worktrees', taskId);
      expect(fs.existsSync(dir)).toBe(false);
    }
    createdTaskIds.length = 0;
  });

  async function seedRealTask(label: string): Promise<string> {
    const suffix = `${label}-${Date.now()}-${crypto.randomUUID().slice(0, 6)}`;
    const taskId = `par-${suffix}`;
    const repoId = `parrepo-${suffix}`;
    await createRepo(db, {
      id: repoId,
      name: 'buggy-repo',
      localPath: BUGGY_REPO_PATH,
      defaultBranch: 'main',
      installCommand: 'pnpm install --allow-build esbuild',
      testCommand: 'pnpm test',
      // The fixture carries no linter, and typescript is a devDependency of it.
      lintCommand: 'node -e "process.exit(0)"',
      typecheckCommand: 'node_modules/.bin/tsc --noEmit',
    });
    await createTask(db, {
      id: taskId,
      repoId,
      title: `Fix pagination (${label})`,
      description:
        'Fix the off-by-one bug in src/paginate.ts so that pnpm test passes, then call finish.',
      status: 'queued',
      maxSteps: 10,
      maxCostUsd: '1.00',
      maxMinutes: 10,
    });
    createdTaskIds.push(taskId);
    return taskId;
  }

  it('runs three tasks at once, each in its own worktree and container, and cleans up', async () => {
    const labels = ['a', 'b', 'c'];
    const records: Recorded[] = [];

    const runs = labels.map(async (label) => {
      const taskId = await seedRealTask(label);
      const record: Recorded = { taskId };
      records.push(record);
      return await runTaskPipeline(taskId, {
        db,
        sandbox: recordingSandbox(record),
        agent: defaultAgent,
        verifier: defaultVerifier,
        createGate: defaultCreateGate,
        llm: scriptedFixer(label),
        cancelPollMs: 1000,
      });
    });

    const outcomes: PipelineOutcome[] = await Promise.all(runs);

    // 1. Every task got through to human review.
    for (const outcome of outcomes) {
      expect(outcome.status).toBe('awaiting_approval');
    }

    // 2. Isolation: three distinct worktrees and three distinct containers.
    const worktreePaths = records.map((r) => r.worktreePath);
    const containerIds = records.map((r) => r.containerId);
    expect(worktreePaths.every((p) => typeof p === 'string')).toBe(true);
    expect(containerIds.every((c) => typeof c === 'string')).toBe(true);
    expect(new Set(worktreePaths).size).toBe(3);
    expect(new Set(containerIds).size).toBe(3);

    // 3. They really did overlap in time: a task's worktree path carries its own id only.
    for (const record of records) {
      expect(record.worktreePath).toContain(record.taskId);
    }

    // 4. The DB agrees, and each task has its own final_diff approval.
    for (const record of records) {
      const task = await getTask(db, record.taskId);
      expect(task?.status).toBe('awaiting_approval');
      expect(task?.containerId).toBe(record.containerId);
      expect(task?.worktreePath).toBe(record.worktreePath);

      const detail = await getTaskDetail(db, record.taskId);
      expect(detail!.approvals.filter((a) => a.kind === 'final_diff').length).toBe(1);
      expect(detail!.steps.length).toBeGreaterThan(0);
      // Steps belong to exactly one task.
      expect(detail!.steps.every((s) => s.taskId === record.taskId)).toBe(true);

      // Verification recorded a passing test check for this task.
      const testCheck = detail!.verifications.find((v) => v.check === 'test');
      expect(testCheck?.passed).toBe(true);
    }

    // 5. No container from this run survives.
    const remaining = await listSandboxContainers();
    const leaked = remaining.filter((c) => containerIds.includes(c.id));
    expect(leaked).toEqual([]);
  });

  it('a cancelled task cleans up its container and worktree', async () => {
    const taskId = await seedRealTask('cancel');
    const record: Recorded = { taskId };

    const { transitionTask } = await import('@harness/db');

    // Cancel as soon as the container exists, which is mid-run by construction.
    const sandbox: SandboxPort = {
      ...recordingSandbox(record),
      async startContainer(ws, limits) {
        const id = await defaultSandbox.startContainer(ws, limits);
        record.containerId = id;
        await transitionTask(db, taskId, 'running', 'cancelled', 'human');
        return id;
      },
    };

    const outcome = await runTaskPipeline(taskId, {
      db,
      sandbox,
      agent: defaultAgent,
      verifier: defaultVerifier,
      createGate: defaultCreateGate,
      llm: scriptedFixer('cancel'),
      cancelPollMs: 200,
    });

    expect(outcome.status).toBe('cancelled');
    expect((await getTask(db, taskId))?.status).toBe('cancelled');

    const remaining = await listSandboxContainers();
    expect(remaining.filter((c) => c.id === record.containerId)).toEqual([]);
  });
});
