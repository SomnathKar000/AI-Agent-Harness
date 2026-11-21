import type { Repo } from '@harness/core';
import type { Database } from '@harness/db';
import type { Workspace, ExecResult } from '@harness/sandbox';

export interface VerifierTask {
  id: string;
  repoId?: string;
  title?: string;
  description?: string;
  worktreePath?: string | null;
  baseBranch?: string | null;
  branchName?: string | null;
  containerId?: string | null;
  repo?: Repo | null;
}

export interface VerifierSandbox {
  workspace: Workspace;
  containerId?: string;
  exec?: (
    cmd: string[],
    options?: { timeoutMs?: number; cwd?: string }
  ) => Promise<ExecResult>;
}

export interface VerificationCheck {
  name: string;
  passed: boolean;
  output?: string;
  flaky?: boolean;
  reviewItem?: boolean;
}

export interface DiffStats {
  insertions: number;
  deletions: number;
  filesChanged: number;
  totalLines: number;
  lockfileEdit?: boolean;
}

export interface VerifyResult {
  passed: boolean;
  checks: VerificationCheck[];
  diffStats: DiffStats;
  flaky: boolean;
}

export interface VerifyOptions {
  db?: Database;
  repo?: Repo;
  maxDiffLines?: number;
  maxWorktreeBytes?: number;
  approvedAsks?: string[];
  collectSecrets?: boolean;
  secretValues?: string[];
}

export interface DiffPolicyResult {
  passed: boolean;
  violations: string[];
  reviewItems: string[];
  diffStats: DiffStats;
}
