import fs from 'node:fs';
import path from 'node:path';
import { runGit, collectSecretValues, type Workspace } from '@harness/sandbox';
import type { DiffPolicyResult, DiffStats, VerifyOptions } from './types.js';

export const DEFAULT_MAX_DIFF_LINES = 400;

const COMMON_SECRET_PATTERNS = [
  { name: 'PEM private key block', regex: /-----BEGIN (?:[A-Z0-9_-]+ )?PRIVATE KEY-----/ },
  { name: 'AWS Access Key ID (AKIA)', regex: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: 'GitHub PAT (ghp_)', regex: /\bghp_[A-Za-z0-9]{36}\b/ },
  { name: 'Anthropic API key (sk-ant-)', regex: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/ },
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

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (line.startsWith('diff --git ')) {
      if (current) {
        chunks.push(current);
      }
      const match = line.match(/^diff --git a\/(.+) b\/(.+)$/);
      const oldPath = match ? match[1] : '';
      const newPath = match ? match[2] : '';
      current = {
        oldPath,
        newPath,
        status: 'M',
        addedLines: [],
        deletedLines: [],
      };
      continue;
    }

    if (!current) continue;

    if (line.startsWith('new file mode ')) {
      current.status = 'A';
    } else if (line.startsWith('deleted file mode ')) {
      current.status = 'D';
    } else if (line.startsWith('similarity index ')) {
      current.status = 'R';
    } else if (line.startsWith('+++ ') || line.startsWith('--- ')) {
      // Diff header lines, skip
      continue;
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

  // 1. Get raw diff against baseBranch
  const { stdout: rawDiff } = await runGit(workspaceOrRepo, ['diff', baseBranch]);
  const chunks = parseUnifiedDiff(String(rawDiff ?? ''));

  // 2. Get name-status list to accurately track deleted, added, modified files
  const { stdout: nameStatusOut } = await runGit(workspaceOrRepo, ['diff', '--name-status', baseBranch]);
  const nameStatusLines = String(nameStatusOut ?? '').trim().split('\n').filter(Boolean);

  const touchedFiles: Array<{ status: string; path: string; oldPath?: string }> = [];
  for (const nsLine of nameStatusLines) {
    const parts = nsLine.split('\t');
    const statusCode = parts[0] ? parts[0][0] : 'M';
    if (statusCode === 'R' || statusCode === 'C') {
      touchedFiles.push({ status: statusCode, oldPath: parts[1], path: parts[2] });
    } else {
      touchedFiles.push({ status: statusCode, path: parts[1] });
    }
  }

  let totalInsertions = 0;
  let totalDeletions = 0;
  let hasLockfileEdit = false;

  for (const chunk of chunks) {
    totalInsertions += chunk.addedLines.length;
    totalDeletions += chunk.deletedLines.length;
  }

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

  // Rule 1: Deletes any test file
  for (const tf of touchedFiles) {
    if (tf.status === 'D') {
      if (isTestFile(tf.path)) {
        violations.push(`Diff deletes test file: ${tf.path}`);
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
  const approvedSet = new Set(options?.approvedAsks ?? []);
  for (const tf of touchedFiles) {
    if (isGithubPath(tf.path) || isPolicyFile(tf.path)) {
      const isApproved =
        approvedSet.has(tf.path) ||
        Array.from(approvedSet).some((approved) => tf.path.startsWith(approved) || approved.includes(tf.path));
      if (!isApproved) {
        violations.push(`Diff touches protected file without an approved ask: ${tf.path}`);
      }
    }
  }

  // Rule 6: Modifies the "scripts" field of any package.json
  for (const tf of touchedFiles) {
    if (path.basename(tf.path) === 'package.json') {
      try {
        let baseScripts: Record<string, unknown> = {};
        try {
          const { stdout: basePkgJson } = await runGit(workspaceOrRepo, ['show', `${baseBranch}:${tf.path}`]);
          baseScripts = JSON.parse(String(basePkgJson ?? '')).scripts ?? {};
        } catch {
          // File did not exist on base branch
        }

        let currScripts: Record<string, unknown> = {};
        const fullCurrPath = path.join(worktreePath, tf.path);
        if (fs.existsSync(fullCurrPath)) {
          const currPkgJson = fs.readFileSync(fullCurrPath, 'utf8');
          currScripts = JSON.parse(currPkgJson).scripts ?? {};
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
  if (secretValues.length === 0 && options?.collectSecrets !== false) {
    try {
      if (fs.existsSync(worktreePath)) {
        secretValues = await collectSecretValues(worktreePath);
      }
    } catch {
      // best-effort
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
  };
}
