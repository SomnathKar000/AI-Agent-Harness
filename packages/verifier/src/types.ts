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
  /** Machine-readable reason for a failure, e.g. command_not_configured. */
  rule?: string;
  output?: string;
  flaky?: boolean;
  reviewItem?: boolean;
}

/**
 * A policy violation as structured data. The rendered string carries rule, path and line
 * only: a source line is never echoed, because that is exactly where a secret would be.
 */
export interface Violation {
  rule: string;
  detail: string;
  path?: string;
  line?: number;
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
  secretValues?: string[];
}

export interface DiffPolicyResult {
  passed: boolean;
  violations: string[];
  violationDetails: Violation[];
  reviewItems: string[];
  diffStats: DiffStats;
  effectiveSecrets: string[];
  /** false when `git status --porcelain` was non-empty or could not be read. */
  worktreeClean: boolean;
  /** false when secret collection failed; the diff was then NOT scanned for known secrets. */
  secretScanRan: boolean;
  /** Lines the parser accounted for; compared against --numstat in tests. */
  parsedLineCounts: { added: number; removed: number };
  /**
   * Diff chunks whose file could not be resolved from the header plus the --name-status
   * list. Non-empty means the policy refused to guess, and the run fails.
   */
  unresolvedChunks: string[];
}
