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

describe('Item 2: Mask and truncate every value written to task_steps', { timeout: 30000 }, () => {
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
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'task-steps-sanitization-ws-'));
    fs.mkdirSync(path.join(tempDir, 'src'), { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('masks secret values and truncates content > 2KB with "[truncated N bytes]" in task_steps', async () => {
    const SECRET_VALUE = 'super_secret_token_abc12345';
    const taskId = `task-step-sanit-${Date.now()}`;
    const repoId = `repo-${taskId}`;

    await createRepo(db, {
      id: repoId,
      name: 'sanit-repo',
      localPath: tempDir,
      defaultBranch: 'main',
    });
    await createTask(db, {
      id: taskId,
      repoId,
      title: 'Task Steps Sanitization Test',
      description: 'Testing mask and truncate in task_steps',
      status: 'running',
      maxSteps: 5,
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
    const hugeContent = 'a'.repeat(1024 * 1024); // 1MB

    const llm: LLMClient = {
      async complete(): Promise<CompletionResponse> {
        turn++;
        if (turn === 1) {
          // write_file whose content contains secret AND is huge (1MB)
          return {
            content: [
              {
                type: 'tool_use',
                id: 'call_write_secret',
                name: 'write_file',
                input: {
                  path: 'src/secret.ts',
                  content: `const secret = "${SECRET_VALUE}";\n${hugeContent}`,
                },
              },
            ],
            stopReason: 'tool_use',
            usage: { inputTokens: 50, outputTokens: 20 },
          };
        }
        return {
          content: [
            {
              type: 'tool_use',
              id: 'call_finish',
              name: 'finish',
              input: { summary: 'Done', root_cause: 'Testing' },
            },
          ],
          stopReason: 'tool_use',
          usage: { inputTokens: 50, outputTokens: 20 },
        };
      },
    };

    const gate = new PolicyGate({
      ctx: {
        workspaceRoot: tempDir,
        taskId,
        callCount: 0,
      },
      db,
      secretValues: [SECRET_VALUE],
    });

    const executor: ToolExecutor = {
      async listDir() { return []; },
      async readFile(p) { return fs.readFileSync(path.join(tempDir, p), 'utf8'); },
      async writeFile(p, c) { fs.writeFileSync(path.join(tempDir, p), c); },
      async editFile() {},
      async grep() { return ''; },
      async runCommand() { return { exitCode: 0, stdout: '', stderr: '', timedOut: false }; },
    };

    await runAgent(
      {
        id: taskId,
        description: 'Sanitization Test',
        maxSteps: 5,
        maxCostUsd: 1.0,
        maxMinutes: 2,
      },
      {
        llm,
        gate,
        executor,
        logger: dbLogger,
      }
    );

    const steps = await db
      .select()
      .from(taskSteps)
      .where(eq(taskSteps.taskId, taskId));

    const stepWrite = steps.find((s) => s.toolName === 'write_file');
    expect(stepWrite).toBeDefined();

    const inputContent = (stepWrite!.input as any).content as string;

    // 1. Must be masked: [REDACTED]
    expect(inputContent).toContain('[REDACTED]');
    expect(inputContent).not.toContain(SECRET_VALUE);

    // 2. Must be truncated with "[truncated N bytes]"
    expect(inputContent).toMatch(/\[truncated \d+ bytes\]/);
    expect(Buffer.byteLength(inputContent)).toBeLessThan(3000);
  });
});
