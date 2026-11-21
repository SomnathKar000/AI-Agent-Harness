import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  runAgent,
  type LLMClient,
  type CompleteOptions,
  type CompletionResponse,
  type ToolExecutor,
  type StepLogger,
  type LogStepParams,
} from '@harness/agent';
import { PolicyGate } from '../src/gate.js';
import {
  createDb,
  runMigrations,
  createRepo,
  createTask,
  appendStep,
  taskSteps,
  eq,
  asc,
  type Database,
} from '@harness/db';

const ROOT_ADMIN_URL =
  process.env.DATABASE_ADMIN_URL ||
  'postgres://harness:harness_password@127.0.0.1:5433/harness';
const TEST_DB_NAME = 'harness_test';
const TEST_ADMIN_URL = ROOT_ADMIN_URL.replace(/\/[^/]+$/, `/${TEST_DB_NAME}`);
const TEST_APP_URL = (
  process.env.DATABASE_URL ||
  'postgres://harness_app:harness_app_password@127.0.0.1:5433/harness'
).replace(/\/[^/]+$/, `/${TEST_DB_NAME}`);

describe('Item 1: One writer for task_steps', { timeout: 30000 }, () => {
  let db: Database;
  let tempDir: string;

  beforeAll(async () => {
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        await runMigrations(TEST_ADMIN_URL);
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 150 + Math.random() * 200));
      }
    }
    db = createDb(TEST_APP_URL);
  }, 30000);

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'one-writer-ws-'));
    fs.mkdirSync(path.join(tempDir, 'src'), { recursive: true });
    fs.writeFileSync(path.join(tempDir, 'src', 'main.ts'), 'export const a = 1;\n');
    fs.writeFileSync(path.join(tempDir, '.env'), 'SECRET=canary123\n');
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('asserts exactly one task_steps row per tool call with strictly increasing idx over allow, ask, deny', async () => {
    const taskId = `one-writer-${Date.now()}`;
    const repoId = `repo-${taskId}`;

    await createRepo(db, {
      id: repoId,
      name: 'one-writer-repo',
      localPath: tempDir,
      defaultBranch: 'main',
    });
    await createTask(db, {
      id: taskId,
      repoId,
      title: 'One Writer Test',
      description: 'Verify single writer for task_steps',
      status: 'running',
      maxSteps: 10,
      maxCostUsd: '1.00',
      maxMinutes: 2,
    });

    const dbLogger: StepLogger = {
      async logStep(params: LogStepParams): Promise<void> {
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

    let turn = 0;
    const scriptedLlm: LLMClient = {
      async complete(): Promise<CompletionResponse> {
        turn++;
        // 1. Allow: read_file src/main.ts
        if (turn === 1) {
          return {
            content: [
              {
                type: 'tool_use',
                id: 'call_allow',
                name: 'read_file',
                input: { path: 'src/main.ts' },
              },
            ],
            stopReason: 'tool_use',
            usage: { inputTokens: 50, outputTokens: 20 },
          };
        }
        // 2. Ask: write_file .github/workflows/ci.yml
        if (turn === 2) {
          return {
            content: [
              {
                type: 'tool_use',
                id: 'call_ask',
                name: 'write_file',
                input: { path: '.github/workflows/ci.yml', content: 'name: CI\n' },
              },
            ],
            stopReason: 'tool_use',
            usage: { inputTokens: 50, outputTokens: 20 },
          };
        }
        // 3. Deny: read_file .env
        if (turn === 3) {
          return {
            content: [
              {
                type: 'tool_use',
                id: 'call_deny',
                name: 'read_file',
                input: { path: '.env' },
              },
            ],
            stopReason: 'tool_use',
            usage: { inputTokens: 50, outputTokens: 20 },
          };
        }
        // 4. Finish
        return {
          content: [
            {
              type: 'tool_use',
              id: 'call_finish',
              name: 'finish',
              input: { summary: 'Completed', root_cause: 'Testing' },
            },
          ],
          stopReason: 'tool_use',
          usage: { inputTokens: 50, outputTokens: 20 },
        };
      },
    };

    // PolicyGate constructed with db (task_steps written only by agent loop)
    const gate = new PolicyGate({
      ctx: {
        workspaceRoot: tempDir,
        taskId,
        callCount: 0,
      },
      db,
    });

    const executor: ToolExecutor = {
      async listDir() { return []; },
      async readFile(p) { return fs.readFileSync(path.join(tempDir, p), 'utf8'); },
      async writeFile(p, c) { fs.writeFileSync(path.join(tempDir, p), c); },
      async editFile() {},
      async grep() { return ''; },
      async runCommand() { return { exitCode: 0, stdout: '', stderr: '', timedOut: false }; },
    };

    const res = await runAgent(
      {
        id: taskId,
        description: 'One Writer Test',
        maxSteps: 10,
        maxCostUsd: 1.0,
        maxMinutes: 2,
      },
      {
        llm: scriptedLlm,
        gate,
        executor,
        logger: dbLogger,
      }
    );

    expect(res.status).toBe('done');

    const steps = await db
      .select()
      .from(taskSteps)
      .where(eq(taskSteps.taskId, taskId))
      .orderBy(asc(taskSteps.idx));

    // Filter to tool_call steps
    const toolCallSteps = steps.filter((s) => s.kind === 'tool_call');

    // There should be exactly 4 tool calls: read_file (allow), write_file (ask), read_file (deny), finish (allow)
    // One row per tool call!
    expect(toolCallSteps.length).toBe(4);

    // Verify idx is strictly increasing with no duplicates
    const indices = toolCallSteps.map((s) => s.idx);
    expect(indices).toEqual([2, 4, 6, 8]);

    // Check decisions match the calls
    expect(toolCallSteps[0].decision).toBe('allow');
    expect(toolCallSteps[0].toolName).toBe('read_file');

    expect(toolCallSteps[1].decision).toBe('ask');
    expect(toolCallSteps[1].toolName).toBe('write_file');

    expect(toolCallSteps[2].decision).toBe('deny');
    expect(toolCallSteps[2].toolName).toBe('read_file');

    expect(toolCallSteps[3].decision).toBe('allow');
    expect(toolCallSteps[3].toolName).toBe('finish');
  });

  it('PolicyGateOptions interface and PolicyGate class do not declare or accept dead config', () => {
    const gateTs = fs.readFileSync(path.resolve(import.meta.dirname, '../src/gate.ts'), 'utf8');
    const targetProp = ['record', 'Task', 'Step'].join('');
    expect(gateTs).not.toContain(targetProp);
  });
});
