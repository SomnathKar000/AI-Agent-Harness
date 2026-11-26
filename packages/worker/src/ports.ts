import {
  createWorkspace as realCreateWorkspace,
  installDependencies as realInstallDependencies,
  startContainer as realStartContainer,
  exec as realExec,
  destroy as realDestroy,
  collectSecretValues as realCollectSecretValues,
  runGit,
  readFile as realReadFile,
  writeFile as realWriteFile,
  listDir as realListDir,
  type Workspace,
  type ExecResult,
  type ExecOptions,
  type ContainerLimits,
} from '@harness/sandbox';
import {
  runAgent as realRunAgent,
  type AgentTask,
  type AgentDeps,
  type AgentResult,
  type PolicyGate as AgentPolicyGate,
} from '@harness/agent';
import { PolicyGate } from '@harness/policy';
import { verifyTask as realVerifyTask, type VerifyResult } from '@harness/verifier';
import type { Database } from '@harness/db';

/**
 * The pipeline talks to the outside world only through these ports, so the unit tests can
 * run it without Docker. The default implementations below are the real packages, wired
 * once here rather than inline in the pipeline.
 */
export interface SandboxPort {
  createWorkspace(repoPath: string, taskId: string, baseBranch: string): Promise<Workspace>;
  installDependencies(
    workspace: Workspace,
    installCommand?: string | string[]
  ): Promise<ExecResult>;
  startContainer(workspace: Workspace, limits?: ContainerLimits): Promise<string>;
  exec(containerId: string, cmd: string[], options?: ExecOptions): Promise<ExecResult>;
  destroy(target: { containerId?: string; workspace?: Workspace }): Promise<void>;
  collectSecretValues(worktreePath: string): Promise<string[]>;
  readFile(worktreePath: string, filePath: string): Promise<string>;
  writeFile(worktreePath: string, filePath: string, content: string): Promise<void>;
  listDir(worktreePath: string, dirPath?: string): Promise<string[]>;
  /**
   * Commits everything currently in the worktree, returning false when there was nothing
   * to commit.
   *
   * The verifier reads the committed diff against a base ref and fails a dirty worktree,
   * and the agent has no git tool (the policy denies `git` outright), so something on the
   * host has to commit. That is this, through runGit, which is the only path host git may
   * take (hard rule 6).
   */
  commitWorktree(workspace: Workspace, message: string): Promise<boolean>;
  /** The worktree's current HEAD commit. */
  headSha(workspace: Workspace): Promise<string>;
  /** True when the worktree's HEAD differs from `baseRef`. */
  changedSince(workspace: Workspace, baseRef: string): Promise<boolean>;
}

export const defaultSandbox: SandboxPort = {
  createWorkspace: (repoPath, taskId, baseBranch) =>
    realCreateWorkspace(repoPath, taskId, baseBranch),
  installDependencies: (workspace, installCommand) =>
    installCommand === undefined
      ? realInstallDependencies(workspace)
      : realInstallDependencies(workspace, installCommand),
  startContainer: (workspace, limits) => realStartContainer(workspace, limits),
  exec: (containerId, cmd, options) => realExec(containerId, cmd, options),
  destroy: (target) => realDestroy(target),
  collectSecretValues: (worktreePath) => realCollectSecretValues(worktreePath),
  readFile: (worktreePath, filePath) => realReadFile(worktreePath, filePath),
  writeFile: (worktreePath, filePath, content) =>
    realWriteFile(worktreePath, filePath, content),
  listDir: (worktreePath, dirPath) => realListDir(worktreePath, dirPath),

  commitWorktree: async (workspace, message) => {
    const status = await runGit(workspace, ['status', '--porcelain']);
    if (String(status.stdout ?? '').trim().length === 0) {
      return false;
    }
    await runGit(workspace, ['add', '-A']);
    // The identity is supplied per invocation so a repo without user.name still commits.
    // The message is fixed text plus the task id: no agent or repo content goes into it,
    // so there is nothing in it to mask (hard rule 14).
    await runGit(workspace, [
      '-c',
      'user.name=harness',
      '-c',
      'user.email=harness@localhost',
      'commit',
      '--no-verify',
      '-m',
      message,
    ]);
    return true;
  },

  headSha: async (workspace) => {
    // `show` is worktree-scoped in runGit; `rev-parse` and `log` are NOT, and would
    // silently answer for the main repo — the Phase 5 F1 failure mode.
    const res = await runGit(workspace, ['show', '--no-patch', '--format=%H', 'HEAD']);
    const sha = String(res.stdout ?? '').trim();
    if (!/^[0-9a-f]{40}$/.test(sha)) {
      throw new Error(`headSha: unexpected git output for HEAD: ${JSON.stringify(sha)}`);
    }
    return sha;
  },

  changedSince: async (workspace, baseRef) => {
    const diff = await runGit(workspace, [
      'diff',
      '--merge-base',
      baseRef,
      'HEAD',
      '--name-only',
    ]);
    return String(diff.stdout ?? '').trim().length > 0;
  },
};

export interface AgentPort {
  runAgent(task: AgentTask, deps: AgentDeps): Promise<AgentResult>;
}

export const defaultAgent: AgentPort = {
  runAgent: (task, deps) => realRunAgent(task, deps),
};

export interface VerifierPort {
  verifyTask(
    task: Parameters<typeof realVerifyTask>[0],
    sandbox: Parameters<typeof realVerifyTask>[1],
    options?: Parameters<typeof realVerifyTask>[2]
  ): Promise<VerifyResult>;
}

export const defaultVerifier: VerifierPort = {
  verifyTask: (task, sandbox, options) => realVerifyTask(task, sandbox, options),
};

export interface GateFactoryArgs {
  workspaceRoot: string;
  taskId: string;
  db?: Database;
  secretValues: string[];
}

export type GateFactory = (args: GateFactoryArgs) => AgentPolicyGate;

/**
 * The Phase 6 wiring contract from packages/policy/README.md: the gate the agent runs
 * behind is a real PolicyGate carrying the values collected from the worktree.
 */
export const defaultCreateGate: GateFactory = (args) =>
  new PolicyGate({
    ctx: {
      workspaceRoot: args.workspaceRoot,
      taskId: args.taskId,
      callCount: 0,
    },
    db: args.db,
    secretValues: args.secretValues,
  });

/** Container limits for a task container. */
export const DEFAULT_CONTAINER_LIMITS: ContainerLimits = {
  memory: 2 * 1024 * 1024 * 1024,
  nanoCpus: 2_000_000_000,
  pidsLimit: 256,
};
