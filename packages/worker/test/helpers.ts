import crypto from 'node:crypto';
import postgres from 'postgres';
import {
  createDb,
  runMigrations,
  createRepo,
  createTask,
  auditLog,
  eq,
  asc,
  type Database,
} from '@harness/db';
import type { Workspace, ExecResult, ContainerLimits } from '@harness/sandbox';
import type {
  AgentTask,
  AgentDeps,
  AgentResult,
  LLMClient,
  CompleteOptions,
  CompletionResponse,
  PolicyGate as AgentPolicyGate,
} from '@harness/agent';
import type { VerifyResult } from '@harness/verifier';
import type { SandboxPort, AgentPort, VerifierPort, GateFactory } from '../src/ports.js';

const ROOT_ADMIN_URL =
  process.env.DATABASE_ADMIN_URL ||
  'postgres://harness:harness_password@127.0.0.1:5433/harness';
const TEST_DB_NAME = 'harness_test';
const APP_URL_BASE =
  process.env.DATABASE_URL ||
  'postgres://harness_app:harness_app_password@127.0.0.1:5433/harness';

const adminUrlFor = (dbName: string): string =>
  ROOT_ADMIN_URL.replace(/\/[^/]+$/, `/${dbName}`);
const appUrlFor = (dbName: string): string =>
  APP_URL_BASE.replace(/\/[^/]+$/, `/${dbName}`);

export const TEST_ADMIN_URL = adminUrlFor(TEST_DB_NAME);
export const TEST_APP_URL = appUrlFor(TEST_DB_NAME);

/**
 * Migrates harness_test and returns an app-role Database. Does not drop the database.
 *
 * Vitest runs each test file in its own process, so several `beforeAll` hooks reach
 * `runMigrations` at the same time and Postgres answers "tuple concurrently updated" on the
 * shared catalog writes. A session-level advisory lock on the root connection serialises
 * create-then-migrate across processes.
 */
const SETUP_LOCK_KEY = 728341;

/**
 * `dbName` exists for reconcileOrphans, which by design fails every task sitting in
 * running/verifying. Pointed at the shared harness_test it would also fail the tasks that
 * other test files are running at that moment, so it gets a database of its own.
 */
export async function setupTestDb(dbName: string = TEST_DB_NAME): Promise<Database> {
  const rootClient = postgres(ROOT_ADMIN_URL, { max: 1 });
  try {
    await rootClient`SELECT pg_advisory_lock(${SETUP_LOCK_KEY})`;
    const exists = await rootClient`SELECT 1 FROM pg_database WHERE datname = ${dbName}`;
    if (exists.length === 0) {
      await rootClient.unsafe(`CREATE DATABASE "${dbName}"`);
    }
    await runMigrations(adminUrlFor(dbName));
  } finally {
    try {
      await rootClient`SELECT pg_advisory_unlock(${SETUP_LOCK_KEY})`;
    } catch {
      // The lock is released with the session either way.
    }
    await rootClient.end();
  }
  return createDb(appUrlFor(dbName));
}

export interface SeededTask {
  taskId: string;
  repoId: string;
}

export async function seedQueuedTask(
  db: Database,
  overrides?: {
    repoPath?: string;
    defaultBranch?: string;
    testCommand?: string | null;
    lintCommand?: string | null;
    typecheckCommand?: string | null;
    description?: string;
    maxSteps?: number;
  }
): Promise<SeededTask> {
  const suffix = `${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
  const taskId = `wt-${suffix}`;
  const repoId = `wr-${suffix}`;
  await createRepo(db, {
    id: repoId,
    name: 'fake-repo',
    localPath: overrides?.repoPath ?? '/tmp/fake-repo',
    defaultBranch: overrides?.defaultBranch ?? 'main',
    testCommand: overrides?.testCommand ?? 'pnpm test',
    lintCommand: overrides?.lintCommand ?? 'pnpm lint',
    typecheckCommand: overrides?.typecheckCommand ?? 'pnpm typecheck',
    installCommand: 'pnpm install',
  });
  await createTask(db, {
    id: taskId,
    repoId,
    title: 'Fake task',
    description: overrides?.description ?? 'Fix the thing',
    status: 'queued',
    maxSteps: overrides?.maxSteps ?? 5,
    maxCostUsd: '1.00',
    maxMinutes: 5,
  });
  return { taskId, repoId };
}

/** The transition trail transitionTask writes, as `from->to` strings in order. */
export async function transitionTrail(db: Database, taskId: string): Promise<string[]> {
  const rows = await db
    .select()
    .from(auditLog)
    .where(eq(auditLog.taskId, taskId))
    .orderBy(asc(auditLog.id));
  return rows
    .filter((r) => r.action === 'task_transition')
    .map((r) => {
      const detail = (r.detail ?? {}) as Record<string, unknown>;
      return `${String(detail.from)}->${String(detail.to)}`;
    });
}

export interface SandboxCall {
  name: string;
  args: unknown[];
}

export interface FakeSandbox {
  sandbox: SandboxPort;
  calls: SandboxCall[];
  destroyCalls: { containerId?: string; workspace?: Workspace }[];
  workspace: Workspace;
}

export function makeFakeSandbox(options?: {
  secrets?: string[];
  collectThrows?: Error;
  startContainerThrows?: Error;
  installExitCode?: number;
  worktreePath?: string;
  commitCommitted?: boolean;
  changedFromBase?: boolean;
  headSha?: string;
}): FakeSandbox {
  const calls: SandboxCall[] = [];
  const destroyCalls: { containerId?: string; workspace?: Workspace }[] = [];
  const workspace: Workspace = {
    taskId: 'placeholder',
    repoPath: '/tmp/fake-repo',
    worktreePath: options?.worktreePath ?? '/tmp/fake-worktree',
    branch: 'harness/placeholder',
    baseBranch: 'main',
  };

  const okExec = (): ExecResult => ({
    exitCode: 0,
    stdout: '',
    stderr: '',
    timedOut: false,
  });

  const sandbox: SandboxPort = {
    async createWorkspace(repoPath: string, taskId: string, baseBranch: string) {
      calls.push({ name: 'createWorkspace', args: [repoPath, taskId, baseBranch] });
      workspace.taskId = taskId;
      workspace.repoPath = repoPath;
      workspace.branch = `harness/${taskId}`;
      workspace.baseBranch = baseBranch;
      return workspace;
    },
    async installDependencies(ws: Workspace, installCommand?: string | string[]) {
      calls.push({ name: 'installDependencies', args: [ws.worktreePath, installCommand] });
      return { ...okExec(), exitCode: options?.installExitCode ?? 0 };
    },
    async startContainer(ws: Workspace, limits?: ContainerLimits) {
      calls.push({ name: 'startContainer', args: [ws.worktreePath, limits] });
      if (options?.startContainerThrows) throw options.startContainerThrows;
      return 'fake-container-id';
    },
    async exec(containerId: string, cmd: string[]) {
      calls.push({ name: 'exec', args: [containerId, cmd] });
      return okExec();
    },
    async destroy(target) {
      calls.push({ name: 'destroy', args: [target] });
      destroyCalls.push(target);
    },
    async collectSecretValues(worktreePath: string) {
      calls.push({ name: 'collectSecretValues', args: [worktreePath] });
      if (options?.collectThrows) throw options.collectThrows;
      return options?.secrets ?? [];
    },
    async readFile(worktreePath: string, p: string) {
      calls.push({ name: 'readFile', args: [worktreePath, p] });
      return '';
    },
    async writeFile(worktreePath: string, p: string) {
      calls.push({ name: 'writeFile', args: [worktreePath, p] });
    },
    async listDir(worktreePath: string, p?: string) {
      calls.push({ name: 'listDir', args: [worktreePath, p] });
      return [];
    },
    async commitWorktree(ws: Workspace, message: string) {
      calls.push({ name: 'commitWorktree', args: [ws.worktreePath, message] });
      return options?.commitCommitted ?? true;
    },
    async headSha(ws: Workspace) {
      calls.push({ name: 'headSha', args: [ws.worktreePath] });
      return options?.headSha ?? 'a'.repeat(40);
    },
    async changedSince(ws: Workspace, baseRef: string) {
      calls.push({ name: 'changedSince', args: [ws.worktreePath, baseRef] });
      return options?.changedFromBase ?? true;
    },
  };

  return { sandbox, calls, destroyCalls, workspace };
}

export interface FakeAgent {
  agent: AgentPort;
  runs: { task: AgentTask; deps: AgentDeps }[];
}

/** results[i] is used for run i; a function throws instead of resolving. */
export function makeFakeAgent(
  results: (AgentResult | Error | (() => Promise<AgentResult>))[]
): FakeAgent {
  const runs: { task: AgentTask; deps: AgentDeps }[] = [];
  let i = 0;
  return {
    runs,
    agent: {
      async runAgent(task: AgentTask, deps: AgentDeps): Promise<AgentResult> {
        runs.push({ task, deps });
        const r = results[Math.min(i, results.length - 1)];
        i++;
        if (r instanceof Error) throw r;
        if (typeof r === 'function') return await r();
        return r;
      },
    },
  };
}

export function passingVerify(): VerifyResult {
  return {
    passed: true,
    checks: [{ name: 'test', passed: true, output: 'ok' }],
    diffStats: { insertions: 1, deletions: 1, filesChanged: 1, totalLines: 2 },
    flaky: false,
  };
}

export function failingVerify(output = 'test failed'): VerifyResult {
  return {
    passed: false,
    checks: [{ name: 'test', passed: false, rule: 'command_failed', output }],
    diffStats: { insertions: 1, deletions: 1, filesChanged: 1, totalLines: 2 },
    flaky: false,
  };
}

export interface FakeVerifier {
  verifier: VerifierPort;
  calls: number;
}

export function makeFakeVerifier(
  results: (VerifyResult | Error)[]
): { verifier: VerifierPort; calls: () => number } {
  let i = 0;
  return {
    calls: () => i,
    verifier: {
      async verifyTask(): Promise<VerifyResult> {
        const r = results[Math.min(i, results.length - 1)];
        i++;
        if (r instanceof Error) throw r;
        return r;
      },
    },
  };
}

/** An LLM that is never meant to be reached; calling it fails the test loudly. */
export const unusedLlm: LLMClient = {
  async complete(_options: CompleteOptions): Promise<CompletionResponse> {
    throw new Error('LLM must not be called in this test');
  },
};

export interface RecordedGate {
  createGate: GateFactory;
  built: { workspaceRoot: string; taskId: string; secretValues: string[] }[];
}

export function makeRecordingGate(): RecordedGate {
  const built: { workspaceRoot: string; taskId: string; secretValues: string[] }[] = [];
  const createGate: GateFactory = (args) => {
    built.push({
      workspaceRoot: args.workspaceRoot,
      taskId: args.taskId,
      secretValues: args.secretValues,
    });
    const gate: AgentPolicyGate = {
      evaluate: () => ({ action: 'allow' }),
      maskSecrets: (text: string) => text,
    };
    return gate;
  };
  return { createGate, built };
}
