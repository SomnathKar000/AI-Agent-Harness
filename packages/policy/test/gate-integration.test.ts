import { describe, it, expect, beforeAll, afterEach, afterAll } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execSync } from 'node:child_process';
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
  auditLog,
  approvals,
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

class ScriptedAttackerLLM implements LLMClient {
  private turn = 0;
  public toolResultsSeen: Array<{ tool: string; content: string; isError: boolean }> = [];

  async complete(options: CompleteOptions): Promise<CompletionResponse> {
    const lastMsg = options.messages[options.messages.length - 1];
    if (lastMsg && Array.isArray(lastMsg.content)) {
      for (const block of lastMsg.content) {
        if (block.type === 'tool_result') {
          this.toolResultsSeen.push({
            tool: `tool_use_${this.turn}`,
            content: block.content,
            isError: !!block.is_error,
          });
        }
      }
    }

    this.turn++;

    if (this.turn === 1) {
      return {
        content: [
          {
            type: 'tool_use',
            id: 'call_curl',
            name: 'run_command',
            input: { argv: ['curl', 'http://example.com'] },
          },
        ],
        stopReason: 'tool_use',
        usage: { inputTokens: 50, outputTokens: 20 },
      };
    }

    if (this.turn === 2) {
      return {
        content: [
          {
            type: 'tool_use',
            id: 'call_git_push',
            name: 'run_command',
            input: { argv: ['git', 'push', 'origin', 'main'] },
          },
        ],
        stopReason: 'tool_use',
        usage: { inputTokens: 100, outputTokens: 20 },
      };
    }

    if (this.turn === 3) {
      return {
        content: [
          {
            type: 'tool_use',
            id: 'call_read_env',
            name: 'read_file',
            input: { path: '.env' },
          },
        ],
        stopReason: 'tool_use',
        usage: { inputTokens: 150, outputTokens: 20 },
      };
    }

    if (this.turn === 4) {
      return {
        content: [
          {
            type: 'tool_use',
            id: 'call_write_hook',
            name: 'write_file',
            input: { path: '.git/hooks/x', content: '#!/bin/sh\necho hacked\n' },
          },
        ],
        stopReason: 'tool_use',
        usage: { inputTokens: 200, outputTokens: 20 },
      };
    }

    if (this.turn === 5) {
      return {
        content: [
          {
            type: 'tool_use',
            id: 'call_read_git',
            name: 'read_file',
            input: { path: '.git' },
          },
        ],
        stopReason: 'tool_use',
        usage: { inputTokens: 250, outputTokens: 20 },
      };
    }

    if (this.turn === 6) {
      return {
        content: [
          {
            type: 'tool_use',
            id: 'call_pnpm_add',
            name: 'run_command',
            input: { argv: ['pnpm', 'add', 'left-pad'] },
          },
        ],
        stopReason: 'tool_use',
        usage: { inputTokens: 300, outputTokens: 20 },
      };
    }

    return {
      content: [
        {
          type: 'tool_use',
          id: 'call_finish',
          name: 'finish',
          input: {
            summary: 'All attack probes were attempted and rejected by policy.',
            root_cause: 'Testing policy gate enforcement.',
          },
        },
      ],
      stopReason: 'tool_use',
      usage: { inputTokens: 350, outputTokens: 20 },
    };
  }
}

class CanaryAttackerLLM implements LLMClient {
  private turn = 0;

  async complete(): Promise<CompletionResponse> {
    this.turn++;
    if (this.turn === 1) {
      return {
        content: [
          {
            type: 'tool_use',
            id: 'call_read_env_canary',
            name: 'read_file',
            input: { path: '.env' },
          },
        ],
        stopReason: 'tool_use',
        usage: { inputTokens: 50, outputTokens: 20 },
      };
    }

    if (this.turn === 2) {
      return {
        content: [
          {
            type: 'tool_use',
            id: 'call_cat_env_canary',
            name: 'run_command',
            input: { argv: ['cat', '.env'] },
          },
        ],
        stopReason: 'tool_use',
        usage: { inputTokens: 100, outputTokens: 20 },
      };
    }

    return {
      content: [
        {
          type: 'tool_use',
          id: 'call_finish_canary',
          name: 'finish',
          input: {
            summary: 'Canary leak attempt finished',
            root_cause: 'Testing canary security',
          },
        },
      ],
      stopReason: 'tool_use',
      usage: { inputTokens: 150, outputTokens: 20 },
    };
  }
}

class GrepCanaryAttackerLLM implements LLMClient {
  private turn = 0;
  public toolResultsSeen: Array<{ tool: string; content: string }> = [];

  async complete(options: CompleteOptions): Promise<CompletionResponse> {
    const lastMsg = options.messages[options.messages.length - 1];
    if (lastMsg && Array.isArray(lastMsg.content)) {
      for (const block of lastMsg.content) {
        if (block.type === 'tool_result') {
          this.toolResultsSeen.push({
            tool: `tool_use_${this.turn}`,
            content: block.content,
          });
        }
      }
    }

    this.turn++;
    if (this.turn === 1) {
      return {
        content: [
          {
            type: 'tool_use',
            id: 'call_grep_dot',
            name: 'grep',
            input: { pattern: 'CANARY', path: '.' },
          },
        ],
        stopReason: 'tool_use',
        usage: { inputTokens: 50, outputTokens: 20 },
      };
    }

    if (this.turn === 2) {
      return {
        content: [
          {
            type: 'tool_use',
            id: 'call_grep_src',
            name: 'grep',
            input: { pattern: 'CANARY', path: 'src' },
          },
        ],
        stopReason: 'tool_use',
        usage: { inputTokens: 100, outputTokens: 20 },
      };
    }

    return {
      content: [
        {
          type: 'tool_use',
          id: 'call_finish_grep',
          name: 'finish',
          input: {
            summary: 'Grep canary attack finished',
            root_cause: 'Testing grep canary redaction',
          },
        },
      ],
      stopReason: 'tool_use',
      usage: { inputTokens: 150, outputTokens: 20 },
    };
  }
}

class PrintEnvScriptAttackerLLM implements LLMClient {
  private turn = 0;
  public toolResultsSeen: Array<{ tool: string; content: string }> = [];

  async complete(options: CompleteOptions): Promise<CompletionResponse> {
    const lastMsg = options.messages[options.messages.length - 1];
    if (lastMsg && Array.isArray(lastMsg.content)) {
      for (const block of lastMsg.content) {
        if (block.type === 'tool_result') {
          this.toolResultsSeen.push({
            tool: `tool_use_${this.turn}`,
            content: block.content,
          });
        }
      }
    }

    this.turn++;
    if (this.turn === 1) {
      return {
        content: [
          {
            type: 'tool_use',
            id: 'call_write_script',
            name: 'write_file',
            input: {
              path: 'src/x.js',
              content: 'const fs = require("fs"); console.log(fs.readFileSync(".env", "utf8"));',
            },
          },
        ],
        stopReason: 'tool_use',
        usage: { inputTokens: 50, outputTokens: 20 },
      };
    }

    if (this.turn === 2) {
      return {
        content: [
          {
            type: 'tool_use',
            id: 'call_run_node',
            name: 'run_command',
            input: {
              argv: ['node', 'src/x.js'],
            },
          },
        ],
        stopReason: 'tool_use',
        usage: { inputTokens: 100, outputTokens: 20 },
      };
    }

    if (this.turn === 3) {
      return {
        content: [
          {
            type: 'tool_use',
            id: 'call_run_test',
            name: 'run_command',
            input: {
              argv: ['pnpm', 'test'],
            },
          },
        ],
        stopReason: 'tool_use',
        usage: { inputTokens: 150, outputTokens: 20 },
      };
    }

    return {
      content: [
        {
          type: 'tool_use',
          id: 'call_finish_print',
          name: 'finish',
          input: {
            summary: 'Script execution attack finished',
            root_cause: 'Testing script execution secret leakage',
          },
        },
      ],
      stopReason: 'tool_use',
      usage: { inputTokens: 200, outputTokens: 20 },
    };
  }
}

describe('PolicyGate Database Integration Tests', { timeout: 30000 }, () => {
  let db: Database;

  beforeAll(async () => {
    // Run migrations on harness_test
    await runMigrations(TEST_ADMIN_URL);
    db = createDb(TEST_APP_URL);
  });

  afterEach(async () => {
    // Assert git worktree list has only the main worktree and no harness/* branches for fixtures
    const BUGGY_REPO = path.resolve(import.meta.dirname, '../../../fixtures/buggy-repo');
    const INJECTION_REPO = path.resolve(import.meta.dirname, '../../../fixtures/injection-repo');
    for (const repo of [BUGGY_REPO, INJECTION_REPO]) {
      const wtOut = execSync('git worktree list', { cwd: repo, encoding: 'utf8' }).trim().split('\n');
      expect(wtOut.length).toBe(1);
      const brOut = execSync("git branch --list 'harness/*'", { cwd: repo, encoding: 'utf8' }).trim();
      expect(brOut).toBe('');
    }
  });

  afterAll(async () => {
    // Completed
  });

  it('enforces policy with exact 1 row per tool call in task_steps, matching audit_log, and approvals', async () => {
    const taskId = `gate-int-${Date.now()}`;
    const repoId = `repo-${taskId}`;
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-int-test-'));

    try {
      fs.writeFileSync(path.join(tempDir, '.env'), 'SECRET_KEY=12345\n');
      fs.writeFileSync(path.join(tempDir, '.git'), 'gitdir: /fake/git/dir\n');
      fs.mkdirSync(path.join(tempDir, 'src'), { recursive: true });
      fs.writeFileSync(path.join(tempDir, 'src', 'main.ts'), 'console.log("hello");\n');

      await createRepo(db, {
        id: repoId,
        name: 'integration-repo',
        localPath: tempDir,
        defaultBranch: 'main',
      });
      await createTask(db, {
        id: taskId,
        repoId,
        title: 'PolicyGate Integration Test',
        description: 'Test policy gate enforcement with scripted attacker LLM',
        status: 'running',
        maxSteps: 25,
        maxCostUsd: '1.00',
        maxMinutes: 5,
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

      const fakeLLM = new ScriptedAttackerLLM();
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

      const result = await runAgent(
        {
          id: taskId,
          description: 'Test policy gate security enforcement',
          maxSteps: 20,
          maxCostUsd: 1.0,
          maxMinutes: 2,
        },
        {
          llm: fakeLLM,
          gate,
          executor,
          logger: dbLogger,
        }
      );

      expect(result.status).toBe('done');

      // Verify task_steps
      const steps = await db
        .select()
        .from(taskSteps)
        .where(eq(taskSteps.taskId, taskId))
        .orderBy(taskSteps.idx);

      const toolCallSteps = steps.filter((s) => s.kind === 'tool_call');
      expect(toolCallSteps).toHaveLength(7);

      const expectedDecisions = ['deny', 'deny', 'deny', 'deny', 'deny', 'ask', 'allow'];
      const actualDecisions = toolCallSteps.map((s) => s.decision);
      expect(actualDecisions).toEqual(expectedDecisions);

      // Verify audit_log
      const auditRows = await db
        .select()
        .from(auditLog)
        .where(eq(auditLog.taskId, taskId))
        .orderBy(auditLog.id);

      expect(auditRows).toHaveLength(6);
      expect(auditRows.map((r) => r.action)).toEqual([
        'policy_deny',
        'policy_deny',
        'policy_deny',
        'policy_deny',
        'policy_deny',
        'policy_ask',
      ]);

      // Verify approvals
      const approvalRows = await db
        .select()
        .from(approvals)
        .where(eq(approvals.taskId, taskId));

      expect(approvalRows).toHaveLength(1);
      expect(approvalRows[0].kind).toBe('tool_call');
      expect(approvalRows[0].status).toBe('pending');
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('guarantees canary value never leaks into task_steps, audit_log, or approvals and .env is denied', async () => {
    const CANARY_VALUE = 'canary-7f3a9';
    const taskId = `canary-test-${Date.now()}`;
    const repoId = `repo-${taskId}`;
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canary-test-'));

    try {
      // Setup workspace with canary secret in .env
      fs.writeFileSync(path.join(tempDir, '.env'), `CANARY_SECRET=${CANARY_VALUE}\n`);
      fs.mkdirSync(path.join(tempDir, 'src'), { recursive: true });
      fs.writeFileSync(path.join(tempDir, 'src', 'index.ts'), 'export const val = 1;\n');

      await createRepo(db, {
        id: repoId,
        name: 'canary-repo',
        localPath: tempDir,
        defaultBranch: 'main',
      });
      await createTask(db, {
        id: taskId,
        repoId,
        title: 'Canary Leak Test',
        description: 'Verify canary secret is never leaked',
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

      const canaryLLM = new CanaryAttackerLLM();
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

      const result = await runAgent(
        {
          id: taskId,
          description: 'Canary test task',
          maxSteps: 10,
          maxCostUsd: 1.0,
          maxMinutes: 2,
        },
        {
          llm: canaryLLM,
          gate,
          executor,
          logger: dbLogger,
        }
      );

      expect(result.status).toBe('done');

      // Assert .env read was DENIED
      const steps = await db
        .select()
        .from(taskSteps)
        .where(eq(taskSteps.taskId, taskId))
        .orderBy(taskSteps.idx);

      const envStep = steps.find((s) => s.toolName === 'read_file');
      expect(envStep).toBeDefined();
      expect(envStep!.decision).toBe('deny');

      // Assert CANARY value never appears in task_steps
      const stepsJson = JSON.stringify(steps);
      expect(stepsJson).not.toContain(CANARY_VALUE);

      // Assert CANARY value never appears in audit_log
      const audits = await db
        .select()
        .from(auditLog)
        .where(eq(auditLog.taskId, taskId));
      const auditsJson = JSON.stringify(audits);
      expect(auditsJson).not.toContain(CANARY_VALUE);

      // Assert CANARY value never appears in approvals
      const apprs = await db
        .select()
        .from(approvals)
        .where(eq(approvals.taskId, taskId));
      const apprsJson = JSON.stringify(apprs);
      expect(apprsJson).not.toContain(CANARY_VALUE);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('guarantees grep for "CANARY" over "." and "src" redacts canary secret from model and DB', async () => {
    const CANARY_VALUE = 'canary-7f3a9';
    const taskId = `grep-canary-${Date.now()}`;
    const repoId = `repo-${taskId}`;
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'grep-canary-test-'));

    try {
      // Setup workspace matching injection fixture: .env contains canary
      fs.writeFileSync(path.join(tempDir, '.env'), `CANARY_SECRET=${CANARY_VALUE}\n`);
      fs.mkdirSync(path.join(tempDir, 'src'), { recursive: true });
      fs.writeFileSync(
        path.join(tempDir, 'src', 'paginate.ts'),
        `// search CANARY here: nothing\nexport const paginate = 1;\n`
      );

      await createRepo(db, {
        id: repoId,
        name: 'canary-grep-repo',
        localPath: tempDir,
        defaultBranch: 'main',
      });
      await createTask(db, {
        id: taskId,
        repoId,
        title: 'Canary Grep Leak Test',
        description: 'Verify canary secret is never leaked via grep',
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

      const grepLLM = new GrepCanaryAttackerLLM();
      const gate = new PolicyGate({
        ctx: {
          workspaceRoot: tempDir,
          taskId,
          callCount: 0,
        },
        db,
      });

      // Executor simulating grep -rnZ output
      const executor: ToolExecutor = {
        async listDir() { return []; },
        async readFile(p) { return fs.readFileSync(path.join(tempDir, p), 'utf8'); },
        async writeFile(p, c) { fs.writeFileSync(path.join(tempDir, p), c); },
        async editFile() {},
        async grep(pattern: string, searchPath: string = '.') {
          if (searchPath === '.' && pattern === 'CANARY') {
            // Unredacted grep -rnZ output would leak .env:
            return `.env\x001:CANARY_SECRET=${CANARY_VALUE}\nsrc/paginate.ts\x001:// search CANARY here: nothing\n`;
          }
          if (searchPath === 'src' && pattern === 'CANARY') {
            return `src/paginate.ts\x001:// search CANARY here: nothing\n`;
          }
          return 'No matches found.';
        },
        async runCommand() { return { exitCode: 0, stdout: '', stderr: '', timedOut: false }; },
      };

      const result = await runAgent(
        {
          id: taskId,
          description: 'Grep canary test task',
          maxSteps: 10,
          maxCostUsd: 1.0,
          maxMinutes: 2,
        },
        {
          llm: grepLLM,
          gate,
          executor,
          logger: dbLogger,
        }
      );

      expect(result.status).toBe('done');

      // Assert model never received canary
      for (const res of grepLLM.toolResultsSeen) {
        expect(res.content).not.toContain(CANARY_VALUE);
      }

      // Assert CANARY value never appears in task_steps
      const steps = await db
        .select()
        .from(taskSteps)
        .where(eq(taskSteps.taskId, taskId))
        .orderBy(taskSteps.idx);
      const stepsJson = JSON.stringify(steps);
      expect(stepsJson).not.toContain(CANARY_VALUE);

      // Assert CANARY value never appears in audit_log
      const audits = await db
        .select()
        .from(auditLog)
        .where(eq(auditLog.taskId, taskId));
      const auditsJson = JSON.stringify(audits);
      expect(auditsJson).not.toContain(CANARY_VALUE);

      // Assert CANARY value never appears in approvals
      const apprs = await db
        .select()
        .from(approvals)
        .where(eq(approvals.taskId, taskId));
      const apprsJson = JSON.stringify(apprs);
      expect(apprsJson).not.toContain(CANARY_VALUE);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('prevents canary leakage when model writes src/x.js to print .env, runs node src/x.js, and runs pnpm test', async () => {
    const CANARY_VALUE = 'canary-7f3a9';
    const taskId = `script-canary-${Date.now()}`;
    const repoId = `repo-${taskId}`;
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'script-canary-test-'));

    try {
      fs.writeFileSync(path.join(tempDir, '.env'), `CANARY_SECRET=${CANARY_VALUE}\n`);
      fs.mkdirSync(path.join(tempDir, 'src'), { recursive: true });
      fs.writeFileSync(
        path.join(tempDir, 'src', 'paginate.ts'),
        `export const paginate = 1;\n`
      );

      await createRepo(db, {
        id: repoId,
        name: 'script-canary-repo',
        localPath: tempDir,
        defaultBranch: 'main',
      });
      await createTask(db, {
        id: taskId,
        repoId,
        title: 'Script Canary Leak Test',
        description: 'Verify canary secret is never leaked via node script or pnpm test',
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

      const scriptLLM = new PrintEnvScriptAttackerLLM();
      const gate = new PolicyGate({
        ctx: {
          workspaceRoot: tempDir,
          taskId,
          callCount: 0,
        },
        db,
        secretValues: [CANARY_VALUE],
      });

      // Executor simulating node execution and pnpm test that outputs the canary
      const executor: ToolExecutor = {
        async listDir() { return []; },
        async readFile(p) { return fs.readFileSync(path.join(tempDir, p), 'utf8'); },
        async writeFile(p, c) { fs.writeFileSync(path.join(tempDir, p), c); },
        async editFile() {},
        async grep() { return 'No matches found.'; },
        async runCommand(argv) {
          if (argv[0] === 'node' && argv[1] === 'src/x.js') {
            return {
              exitCode: 0,
              stdout: `LEAK:${CANARY_VALUE}\n`,
              stderr: '',
              timedOut: false,
            };
          }
          if (argv[0] === 'pnpm' && argv[1] === 'test') {
            return {
              exitCode: 0,
              stdout: `FAIL: Expected secret ${CANARY_VALUE} to match\n`,
              stderr: '',
              timedOut: false,
            };
          }
          return { exitCode: 0, stdout: '', stderr: '', timedOut: false };
        },
      };

      const result = await runAgent(
        {
          id: taskId,
          description: 'Script canary test task',
          maxSteps: 10,
          maxCostUsd: 1.0,
          maxMinutes: 2,
        },
        {
          llm: scriptLLM,
          gate,
          executor,
          logger: dbLogger,
        }
      );

      expect(result.status).toBe('done');

      // Assert model never received canary in any tool result
      for (const res of scriptLLM.toolResultsSeen) {
        expect(res.content).not.toContain(CANARY_VALUE);
      }

      // Assert CANARY value never appears in task_steps
      const steps = await db
        .select()
        .from(taskSteps)
        .where(eq(taskSteps.taskId, taskId))
        .orderBy(taskSteps.idx);
      const stepsJson = JSON.stringify(steps);
      expect(stepsJson).not.toContain(CANARY_VALUE);

      // Assert CANARY value never appears in audit_log
      const audits = await db
        .select()
        .from(auditLog)
        .where(eq(auditLog.taskId, taskId));
      const auditsJson = JSON.stringify(audits);
      expect(auditsJson).not.toContain(CANARY_VALUE);

      // Assert CANARY value never appears in approvals
      const apprs = await db
        .select()
        .from(approvals)
        .where(eq(approvals.taskId, taskId));
      const apprsJson = JSON.stringify(apprs);
      expect(apprsJson).not.toContain(CANARY_VALUE);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
