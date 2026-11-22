import fs from 'node:fs';
import path from 'node:path';
import { runGit, collectSecretValues, type Workspace } from '@harness/sandbox';
import type { DiffPolicyResult, DiffStats, VerifyOptions } from './types.js';

export const DEFAULT_MAX_DIFF_LINES = 400;

export const COMMON_SECRET_PATTERNS = [
  { name: 'PEM private key block', regex: /-----BEGIN (?:[A-Z0-9_-]+ )?PRIVATE KEY-----/ },
  { name: 'AWS Access Key ID (AKIA)', regex: /\bAKIA[0-9A-Z]{16,}/ },
  { name: 'GitHub PAT (ghp_)', regex: /\bghp_[A-Za-z0-9]{36,}/ },
  { name: 'GitHub Fine-Grained PAT (github_pat_)', regex: /\bgithub_pat_[A-Za-z0-9_]{36,}/ },
  { name: 'GitHub OAuth token (gho_)', regex: /\bgho_[A-Za-z0-9]{36,}/ },
  { name: 'GitHub Server-to-Server token (ghs_)', regex: /\bghs_[A-Za-z0-9]{36,}/ },
  { name: 'GitHub User-to-Server token (ghu_)', regex: /\bghu_[A-Za-z0-9]{36,}/ },
  { name: 'GitHub Refresh token (ghr_)', regex: /\bghr_[A-Za-z0-9]{36,}/ },
  { name: 'GitLab PAT (glpat-)', regex: /\bglpat-[A-Za-z0-9_-]{20,}/ },
  { name: 'Slack token (xox[baprs]-)', regex: /\bxox[baprs]-[A-Za-z0-9-]{10,}/ },
  { name: 'Google API key (AIza)', regex: /\bAIza[0-9A-Za-z_-]{30,}/ },
  { name: 'Anthropic API key (sk-ant-)', regex: /\bsk-ant-[A-Za-z0-9_-]{20,}/ },
];

const LOCKFILE_BASENAMES = new Set([
  'pnpm-lock.yaml',
  'package-lock.json',
  'yarn.lock',
  'bun.lockb',
  'bun.lock',
]);

function isTestFile(filePath: string): boolean {
  const norm = filePath.split(path.sep).join('/').toLowerCase();
  const base = path.basename(norm);
  if (base.includes('.test.') || base.includes('.spec.')) return true;
  if (
    norm.startsWith('test/') ||
    norm.includes('/test/') ||
    norm.startsWith('tests/') ||
    norm.includes('/tests/') ||
    norm.startsWith('__tests__/') ||
    norm.includes('/__tests__/')
  ) {
    return true;
  }
  return false;
}

function isTestConfigFile(filePath: string): boolean {
  const norm = filePath.split(path.sep).join('/').toLowerCase();
  const base = path.basename(norm);
  if (
    base.startsWith('vitest.config.') ||
    base.startsWith('jest.config.') ||
    base.startsWith('vite.config.') ||
    base === '.nycrc' ||
    base.startsWith('.nycrc.') ||
    base === 'karma.conf.js' ||
    base.startsWith('cypress.config.')
  ) {
    return true;
  }
  return false;
}

function isPolicyFile(filePath: string): boolean {
  const norm = filePath.split(path.sep).join('/').toLowerCase();
  if (
    norm.startsWith('policy/') ||
    norm.includes('/policy/') ||
    norm.endsWith('.policy.yaml') ||
    norm.endsWith('.policy.yml') ||
    norm.startsWith('packages/policy/') ||
    norm.includes('/packages/policy/')
  ) {
    return true;
  }
  return false;
}

function isGithubPath(filePath: string): boolean {
  const norm = filePath.split(path.sep).join('/').toLowerCase();
  return norm.startsWith('.github/') || norm.includes('/.github/');
}

interface FileDiffChunk {
  oldPath: string;
  newPath: string;
  status: string; // M, A, D, R, etc.
  addedLines: string[];
  deletedLines: string[];
}

function parseUnifiedDiff(rawDiff: string): FileDiffChunk[] {
  const chunks: FileDiffChunk[] = [];
  const lines = rawDiff.split('\n');
  let current: FileDiffChunk | null = null;
  let inHunk = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (line.startsWith('diff --git ')) {
      if (current) {
        chunks.push(current);
      }
      inHunk = false;
      current = {
        oldPath: '',
        newPath: '',
        status: 'M',
        addedLines: [],
        deletedLines: [],
      };
      continue;
    }

    if (!current) continue;

    if (!inHunk) {
      if (line.startsWith('--- a/')) {
        current.oldPath = line.slice(6);
      } else if (line.startsWith('+++ b/')) {
        current.newPath = line.slice(6);
      } else if (line.startsWith('@@ ')) {
        inHunk = true;
      }
      continue;
    }

    // Inside a hunk
    if (line.startsWith('@@ ')) {
      inHunk = true;
    } else if (line.startsWith('+')) {
      current.addedLines.push(line.slice(1));
    } else if (line.startsWith('-')) {
      current.deletedLines.push(line.slice(1));
    }
  }

  if (current) {
    chunks.push(current);
  }

  return chunks;
}

function countAssertionCalls(lines: string[]): number {
  let count = 0;
  const expectRegex = /\bexpect\s*\(/g;
  const assertRegex = /\bassert(?:\s*\(|\.\w+)/g;

  for (const line of lines) {
    const expectMatches = line.match(expectRegex);
    if (expectMatches) count += expectMatches.length;

    const assertMatches = line.match(assertRegex);
    if (assertMatches) count += assertMatches.length;
  }
  return count;
}

export async function evaluateDiffPolicy(
  workspaceOrRepo: Workspace | string,
  baseBranch: string,
  options?: VerifyOptions
): Promise<DiffPolicyResult> {
  const violations: string[] = [];
  const reviewItems: string[] = [];

  const repoPath =
    typeof workspaceOrRepo === 'object' && workspaceOrRepo !== null && 'repoPath' in workspaceOrRepo
      ? (workspaceOrRepo as Workspace).repoPath
      : path.resolve(workspaceOrRepo);

  const worktreePath =
    typeof workspaceOrRepo === 'object' && workspaceOrRepo !== null && 'worktreePath' in workspaceOrRepo
      ? (workspaceOrRepo as Workspace).worktreePath
      : repoPath;

  // New Check: Uncommitted changes in worktree (must never escape review)
  try {
    const { stdout: statusOut } = await runGit(workspaceOrRepo, ['status', '--porcelain']);
    if (String(statusOut ?? '').trim().length > 0) {
      violations.push(`Uncommitted changes in worktree:\n${String(statusOut).trim()}`);
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    violations.push(`Error checking worktree status: ${msg}`);
  }

  // 1. Get raw diff against baseBranch using --merge-base and HEAD
  const { stdout: rawDiff } = await runGit(workspaceOrRepo, [
    'diff',
    '--merge-base',
    baseBranch,
    'HEAD',
  ]);
  const chunks = parseUnifiedDiff(String(rawDiff ?? ''));

  // 2. Get name-status -z list to accurately track deleted, added, renamed, modified files
  const { stdout: nameStatusOut } = await runGit(workspaceOrRepo, [
    'diff',
    '--name-status',
    '-z',
    '--merge-base',
    baseBranch,
    'HEAD',
  ]);
  const touchedFiles: Array<{ status: string; path: string; oldPath?: string }> = [];
  const parts = String(nameStatusOut ?? '').split('\0');
  for (let i = 0; i < parts.length; i++) {
    const rawStatus = parts[i]?.trim();
    if (!rawStatus) continue;
    const statusCode = rawStatus[0];
    if (statusCode === 'R' || statusCode === 'C') {
      const oldPath = parts[++i];
      const newPath = parts[++i];
      if (oldPath && newPath) {
        touchedFiles.push({ status: statusCode, oldPath, path: newPath });
      }
    } else {
      const p = parts[++i];
      if (p) {
        touchedFiles.push({ status: statusCode, path: p });
      }
    }
  }

  // 3. Get accurate insertion and deletion counts from git diff --numstat
  const { stdout: numstatOut } = await runGit(workspaceOrRepo, [
    'diff',
    '--numstat',
    '--merge-base',
    baseBranch,
    'HEAD',
  ]);
  let totalInsertions = 0;
  let totalDeletions = 0;
  for (const line of String(numstatOut ?? '').trim().split('\n')) {
    if (!line.trim()) continue;
    const [insStr, delStr] = line.split('\t');
    const ins = parseInt(insStr, 10);
    const del = parseInt(delStr, 10);
    if (!isNaN(ins)) totalInsertions += ins;
    if (!isNaN(del)) totalDeletions += del;
  }

  let hasLockfileEdit = false;

  const diffStats: DiffStats = {
    insertions: totalInsertions,
    deletions: totalDeletions,
    filesChanged: touchedFiles.length,
    totalLines: totalInsertions + totalDeletions,
    lockfileEdit: false,
  };

  // Rule: Check lockfiles & report as review item
  for (const tf of touchedFiles) {
    const baseName = path.basename(tf.path);
    if (LOCKFILE_BASENAMES.has(baseName)) {
      hasLockfileEdit = true;
      reviewItems.push(`lockfile_edit: ${tf.path}`);
    }
  }
  diffStats.lockfileEdit = hasLockfileEdit;

  // Rule 1: Deletes any test file or renames a test file to a non-test file
  for (const tf of touchedFiles) {
    if (tf.status === 'D') {
      if (isTestFile(tf.path)) {
        violations.push(`Diff deletes test file: ${tf.path}`);
      }
    } else if (tf.status === 'R' || tf.status === 'C') {
      if (tf.oldPath && isTestFile(tf.oldPath) && !isTestFile(tf.path)) {
        violations.push(
          `Diff renames test file to non-test file: ${tf.oldPath} -> ${tf.path}`
        );
      }
    }
  }

  // Rule 4: Edits test config (vitest/jest config, coverage thresholds)
  for (const tf of touchedFiles) {
    if (isTestConfigFile(tf.path)) {
      violations.push(`Diff edits test config file: ${tf.path}`);
    }
  }

  // Rule 5: Touches .github/** or policy files without an approved ask
  // Exact match or prefix match requiring trailing '/'
  const approvedList = (options?.approvedAsks ?? []).filter(
    (a): a is string => typeof a === 'string' && a.trim().length > 0
  );
  for (const tf of touchedFiles) {
    if (isGithubPath(tf.path) || isPolicyFile(tf.path)) {
      const isApproved = approvedList.some((approved) => {
        if (tf.path === approved) return true;
        if (approved.endsWith('/') && tf.path.startsWith(approved)) return true;
        return false;
      });
      if (!isApproved) {
        violations.push(`Diff touches protected file without an approved ask: ${tf.path}`);
      }
    }
  }

  // Rule 6: Modifies the "scripts" field of any package.json (read HEAD:<path> via git show)
  for (const tf of touchedFiles) {
    if (path.basename(tf.path) === 'package.json') {
      try {
        let baseScripts: Record<string, unknown> = {};
        try {
          const { stdout: basePkgJson } = await runGit(worktreePath, ['show', `${baseBranch}:${tf.path}`]);
          baseScripts = JSON.parse(String(basePkgJson ?? '')).scripts ?? {};
        } catch {
          // File did not exist on base branch
        }

        let currScripts: Record<string, unknown> = {};
        try {
          const { stdout: currPkgJson } = await runGit(worktreePath, ['show', `HEAD:${tf.path}`]);
          currScripts = JSON.parse(String(currPkgJson ?? '')).scripts ?? {};
        } catch {
          // File does not exist on HEAD
        }

        if (JSON.stringify(baseScripts) !== JSON.stringify(currScripts)) {
          violations.push(`Diff modifies "scripts" field of package.json: ${tf.path}`);
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        violations.push(`Error checking scripts in ${tf.path}: ${msg}`);
      }
    }
  }

  // Rule 7: Touches .npmrc
  for (const tf of touchedFiles) {
    if (path.basename(tf.path) === '.npmrc') {
      violations.push(`Diff touches .npmrc: ${tf.path}`);
    }
  }

  // Rule 8: Exceeds a configurable size limit (default 400 changed lines)
  const maxDiffLines = options?.maxDiffLines ?? DEFAULT_MAX_DIFF_LINES;
  if (diffStats.totalLines > maxDiffLines) {
    violations.push(
      `Diff exceeds size limit: ${diffStats.totalLines} changed lines exceeds maximum of ${maxDiffLines}`
    );
  }

  // Collect secret values if needed for Rule 10
  let secretValues: string[] = options?.secretValues ?? [];
  if (secretValues.length === 0) {
    try {
      if (fs.existsSync(worktreePath)) {
        secretValues = await collectSecretValues(worktreePath);
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      violations.push(`Failed to collect secret values from worktree: ${msg}`);
    }
  }
  const effectiveSecrets = secretValues.filter((s) => typeof s === 'string' && s.length >= 8);

  // Checks across chunk added lines & assertions
  let testAddedAssertions = 0;
  let testDeletedAssertions = 0;

  for (const chunk of chunks) {
    const isTest = isTestFile(chunk.newPath || chunk.oldPath);

    // Rule 3: Assertion counting in test files
    if (isTest) {
      testAddedAssertions += countAssertionCalls(chunk.addedLines);
      testDeletedAssertions += countAssertionCalls(chunk.deletedLines);
    }

    for (const addedLine of chunk.addedLines) {
      // Rule 2: Adds .skip / .only / xit / xdescribe / it.todo
      if (isTest) {
        if (/\.skip\b/.test(addedLine)) {
          violations.push(`Diff adds .skip in test file ${chunk.newPath}: ${addedLine.trim()}`);
        }
        if (/\.only\b/.test(addedLine)) {
          violations.push(`Diff adds .only in test file ${chunk.newPath}: ${addedLine.trim()}`);
        }
        if (/\bxit\b/.test(addedLine)) {
          violations.push(`Diff adds xit in test file ${chunk.newPath}: ${addedLine.trim()}`);
        }
        if (/\bxdescribe\b/.test(addedLine)) {
          violations.push(`Diff adds xdescribe in test file ${chunk.newPath}: ${addedLine.trim()}`);
        }
        if (/\bit\.todo\b|\btest\.todo\b/.test(addedLine)) {
          violations.push(`Diff adds it.todo in test file ${chunk.newPath}: ${addedLine.trim()}`);
        }
      }

      // Rule 9: Contains "[REDACTED]" anywhere
      if (addedLine.includes('[REDACTED]')) {
        violations.push(`Diff contains [REDACTED] marker in ${chunk.newPath}: ${addedLine.trim()}`);
      }

      // Rule 10: Contains any value from collectSecretValues
      for (const secret of effectiveSecrets) {
        if (addedLine.includes(secret)) {
          violations.push(
            `Diff contains secret value from collectSecretValues in ${chunk.newPath}`
          );
          break;
        }
      }

      // Rule 11: Matches common secret shapes
      for (const pattern of COMMON_SECRET_PATTERNS) {
        if (pattern.regex.test(addedLine)) {
          violations.push(
            `Diff matches common secret shape (${pattern.name}) in ${chunk.newPath}`
          );
          break;
        }
      }
    }
  }

  // Check Rule 3 net assertion change
  if (testAddedAssertions < testDeletedAssertions) {
    violations.push(
      `Diff is net-negative on assertion calls (expect/assert) in test files: ${testAddedAssertions} added vs ${testDeletedAssertions} removed`
    );
  }

  return {
    passed: violations.length === 0,
    violations,
    reviewItems,
    diffStats,
    effectiveSecrets,
  };
}
