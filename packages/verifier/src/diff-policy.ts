import path from 'node:path';
import { runGit, collectSecretValues, type Workspace } from '@harness/sandbox';
import type { DiffPolicyResult, DiffStats, VerifyOptions, Violation } from './types.js';

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

/**
 * Violation messages carry rule, path and line number only. A source line is never echoed:
 * the offending line is exactly where a secret would be, and these strings are written to the
 * verifications table and shown to a reviewer.
 */
function formatViolation(v: Violation): string {
  const parts = [`${v.rule}: ${v.detail}`];
  if (v.path) parts.push(v.path);
  if (typeof v.line === 'number') parts.push(`line ${v.line}`);
  return parts.join(' | ');
}

function normalizePath(filePath: string): string {
  return filePath.split(path.sep).join('/').normalize('NFC').replace(/^\.\//, '');
}

function isTestFile(filePath: string): boolean {
  const norm = normalizePath(filePath).toLowerCase();
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
  const base = path.basename(normalizePath(filePath).toLowerCase());
  return (
    base.startsWith('vitest.config.') ||
    base.startsWith('jest.config.') ||
    base.startsWith('vite.config.') ||
    base === '.nycrc' ||
    base.startsWith('.nycrc.') ||
    base === 'karma.conf.js' ||
    base.startsWith('cypress.config.')
  );
}

function isPolicyFile(filePath: string): boolean {
  const norm = normalizePath(filePath).toLowerCase();
  return (
    norm.startsWith('policy/') ||
    norm.includes('/policy/') ||
    norm.endsWith('.policy.yaml') ||
    norm.endsWith('.policy.yml') ||
    norm.startsWith('packages/policy/') ||
    norm.includes('/packages/policy/')
  );
}

function isGithubPath(filePath: string): boolean {
  const norm = normalizePath(filePath).toLowerCase();
  return norm.startsWith('.github/') || norm.includes('/.github/');
}

export interface DiffLine {
  /** Line number in the new file for added lines, in the old file for removed lines. */
  line: number;
  text: string;
}

export interface FileDiffChunk {
  oldPath: string;
  newPath: string;
  status: string;
  addedLines: DiffLine[];
  deletedLines: DiffLine[];
}

/**
 * Parses a unified diff using hunk headers and their declared line counts, not prefix
 * heuristics. Inside a hunk the counters say exactly how many old/new lines remain, so a
 * content line beginning "-- " or "++ " is counted as content and a header is never mistaken
 * for one. Paths come from --name-status -z, so no path parsing happens here.
 */
export function parseUnifiedDiff(rawDiff: string): FileDiffChunk[] {
  const chunks: FileDiffChunk[] = [];
  const lines = String(rawDiff ?? '').split('\n');

  let current: FileDiffChunk | null = null;
  let oldRemaining = 0;
  let newRemaining = 0;
  let oldLineNo = 0;
  let newLineNo = 0;
  let inHunk = false;

  const hunkHeader = /^@@+ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

  for (const line of lines) {
    if (!inHunk && line.startsWith('diff --git ')) {
      if (current) chunks.push(current);
      current = { oldPath: '', newPath: '', status: 'M', addedLines: [], deletedLines: [] };
      continue;
    }

    if (!current) continue;

    const header = line.match(hunkHeader);
    if (header && (!inHunk || (oldRemaining <= 0 && newRemaining <= 0))) {
      oldLineNo = parseInt(header[1], 10);
      oldRemaining = header[2] === undefined ? 1 : parseInt(header[2], 10);
      newLineNo = parseInt(header[3], 10);
      newRemaining = header[4] === undefined ? 1 : parseInt(header[4], 10);
      inHunk = true;
      continue;
    }

    if (!inHunk) {
      // File header territory. With core.quotePath=false these two lines carry one
      // unambiguous path each (or /dev/null), unlike the combined "diff --git a/X b/Y" line.
      if (line.startsWith('--- a/')) {
        current.oldPath = line.slice(6);
      } else if (line.startsWith('+++ b/')) {
        current.newPath = line.slice(6);
      }
      continue;
    }

    if (oldRemaining <= 0 && newRemaining <= 0) {
      inHunk = false;
      if (line.startsWith('diff --git ')) {
        chunks.push(current);
        current = { oldPath: '', newPath: '', status: 'M', addedLines: [], deletedLines: [] };
      }
      continue;
    }

    if (line.startsWith('+')) {
      current.addedLines.push({ line: newLineNo, text: line.slice(1) });
      newLineNo++;
      newRemaining--;
    } else if (line.startsWith('-')) {
      current.deletedLines.push({ line: oldLineNo, text: line.slice(1) });
      oldLineNo++;
      oldRemaining--;
    } else if (line.startsWith('\\')) {
      // "\ No newline at end of file" — belongs to the preceding line, consumes no count.
      continue;
    } else {
      // Context line (leading space, or an empty final line).
      oldLineNo++;
      newLineNo++;
      oldRemaining--;
      newRemaining--;
    }
  }

  if (current) chunks.push(current);
  return chunks;
}

function countAssertionCalls(lines: DiffLine[]): number {
  let count = 0;
  for (const { text } of lines) {
    const expectMatches = text.match(/\bexpect\s*\(/g);
    if (expectMatches) count += expectMatches.length;
    const assertMatches = text.match(/\bassert(?:\s*\(|\.\w+)/g);
    if (assertMatches) count += assertMatches.length;
  }
  return count;
}

export async function evaluateDiffPolicy(
  workspaceOrRepo: Workspace | string,
  baseBranch: string,
  options?: VerifyOptions
): Promise<DiffPolicyResult> {
  const violations: Violation[] = [];
  const reviewItems: string[] = [];
  const add = (v: Violation) => violations.push(v);

  // Fail closed on an unusable base branch rather than defaulting to something.
  if (typeof baseBranch !== 'string' || baseBranch.trim().length === 0) {
    add({ rule: 'base_branch_not_configured', detail: 'base branch is missing or empty' });
    return {
      passed: false,
      violations: violations.map(formatViolation),
      violationDetails: violations,
      reviewItems,
      diffStats: { insertions: 0, deletions: 0, filesChanged: 0, totalLines: 0 },
      effectiveSecrets: [],
      worktreeClean: false,
      secretScanRan: false,
      parsedLineCounts: { added: 0, removed: 0 },
    };
  }

  // git show/merge-base are worktree-scoped in runGit, so a Workspace is passed through as-is.
  const gitTarget = workspaceOrRepo;

  // Paths come from `--name-status -z` / `--numstat -z`, where git writes them verbatim:
  // no quoting and no octal escaping, so spaces and non-ASCII survive intact.
  //
  // Do NOT pass `-c core.quotePath=false` here. runGit picks the subcommand with
  // args.find(a => !a.startsWith('-')), so the VALUE of a `-c key=value` pair is read as the
  // subcommand, the command stops being worktree-scoped, and the diff silently runs against
  // the main repo instead of the task's worktree.

  // -- the working tree must be clean -------------------------------------------------
  let worktreeClean = false;
  try {
    const { stdout: statusOut } = await runGit(gitTarget, ['status', '--porcelain']);
    const dirty = String(statusOut ?? '').trim();
    if (dirty.length > 0) {
      const changed = dirty
        .split('\n')
        .map((l) => l.slice(3).trim())
        .filter(Boolean);
      add({
        rule: 'worktree_dirty',
        detail: `uncommitted changes in worktree (${changed.length} path(s))`,
        path: changed[0],
      });
    } else {
      worktreeClean = true;
    }
  } catch (err: unknown) {
    add({
      rule: 'worktree_status_failed',
      detail: `could not read worktree status: ${err instanceof Error ? err.message : String(err)}`,
    });
  }

  // -- resolve the merge base ----------------------------------------------------------
  let mergeBase: string;
  try {
    const { stdout } = await runGit(gitTarget, ['merge-base', baseBranch, 'HEAD']);
    mergeBase = String(stdout ?? '').trim();
    if (!/^[0-9a-f]{7,40}$/.test(mergeBase)) {
      throw new Error(`unusable merge base: ${mergeBase || '(empty)'}`);
    }
  } catch (err: unknown) {
    add({
      rule: 'merge_base_unresolved',
      detail: `could not resolve merge base against ${baseBranch}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    });
    return {
      passed: false,
      violations: violations.map(formatViolation),
      violationDetails: violations,
      reviewItems,
      diffStats: { insertions: 0, deletions: 0, filesChanged: 0, totalLines: 0 },
      effectiveSecrets: [],
      worktreeClean,
      secretScanRan: false,
      parsedLineCounts: { added: 0, removed: 0 },
    };
  }

  const range = `${mergeBase}..HEAD`;

  // -- the three views of the committed diff -------------------------------------------
  const { stdout: rawDiff } = await runGit(gitTarget, ['diff', range]);
  const chunks = parseUnifiedDiff(String(rawDiff ?? ''));

  const { stdout: nameStatusOut } = await runGit(gitTarget, [
    'diff',
    '--name-status',
    '-z',
    '-M',
    '-C',
    range,
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
        touchedFiles.push({
          status: statusCode,
          oldPath: normalizePath(oldPath),
          path: normalizePath(newPath),
        });
      }
    } else {
      const p = parts[++i];
      if (p) touchedFiles.push({ status: statusCode, path: normalizePath(p) });
    }
  }

  const { stdout: numstatOut } = await runGit(gitTarget, ['diff', '--numstat', '-z', range]);
  let totalInsertions = 0;
  let totalDeletions = 0;
  for (const line of String(numstatOut ?? '').split(/[\n\0]/)) {
    if (!line.trim()) continue;
    const [insStr, delStr] = line.split('\t');
    const ins = parseInt(insStr, 10);
    const del = parseInt(delStr, 10);
    if (!isNaN(ins)) totalInsertions += ins;
    if (!isNaN(del)) totalDeletions += del;
  }

  const diffStats: DiffStats = {
    insertions: totalInsertions,
    deletions: totalDeletions,
    filesChanged: touchedFiles.length,
    totalLines: totalInsertions + totalDeletions,
    lockfileEdit: false,
  };

  const parsedLineCounts = chunks.reduce(
    (acc, c) => ({
      added: acc.added + c.addedLines.length,
      removed: acc.removed + c.deletedLines.length,
    }),
    { added: 0, removed: 0 }
  );

  // -- lockfiles are a review item, not a failure ---------------------------------------
  for (const tf of touchedFiles) {
    if (LOCKFILE_BASENAMES.has(path.basename(tf.path))) {
      diffStats.lockfileEdit = true;
      reviewItems.push(`lockfile_edit: ${tf.path}`);
    }
  }

  // -- Rule 1: a test file is deleted, renamed or copied out of test-hood ----------------
  for (const tf of touchedFiles) {
    if (tf.status === 'D' && isTestFile(tf.path)) {
      add({ rule: 'test_file_deleted', detail: 'diff deletes a test file', path: tf.path });
    } else if ((tf.status === 'R' || tf.status === 'C') && tf.oldPath) {
      if (isTestFile(tf.oldPath) && !isTestFile(tf.path)) {
        add({
          rule: 'test_file_renamed_away',
          detail: `diff renames a test file to a non-test path (from ${tf.oldPath})`,
          path: tf.path,
        });
      }
    }
  }

  // -- Rule 4: test config edited --------------------------------------------------------
  for (const tf of touchedFiles) {
    if (isTestConfigFile(tf.path)) {
      add({ rule: 'test_config_edited', detail: 'diff edits a test config file', path: tf.path });
    }
  }

  // -- Rule 5: protected paths need an exact approved ask --------------------------------
  const rawApprovals = options?.approvedAsks ?? [];
  const hasInvalidApproval = rawApprovals.some(
    (a) => typeof a !== 'string' || a.trim().length === 0
  );
  if (hasInvalidApproval) {
    add({
      rule: 'approval_list_invalid',
      detail: 'approvedAsks contains an empty or non-string entry; approving nothing',
    });
  }
  const approvedSet = new Set(
    rawApprovals
      .filter((a): a is string => typeof a === 'string' && a.trim().length > 0)
      .map((a) => normalizePath(a.trim()))
  );
  for (const tf of touchedFiles) {
    if (isGithubPath(tf.path) || isPolicyFile(tf.path)) {
      // Exact normalized equality only. No prefix match, no substring match.
      if (!approvedSet.has(tf.path)) {
        add({
          rule: 'protected_path_unapproved',
          detail: 'diff touches a protected path without an approved ask',
          path: tf.path,
        });
      }
    }
  }

  // -- Rule 6: package.json "scripts" changed, read from commits not from disk -----------
  for (const tf of touchedFiles) {
    if (path.basename(tf.path) !== 'package.json') continue;

    const readScripts = async (rev: string): Promise<Record<string, unknown> | 'absent' | 'bad'> => {
      let raw: string;
      try {
        const { stdout } = await runGit(gitTarget, ['show', `${rev}:${tf.path}`]);
        raw = String(stdout ?? '');
      } catch {
        return 'absent';
      }
      try {
        const parsed = JSON.parse(raw);
        if (parsed === null || typeof parsed !== 'object') return 'bad';
        return (parsed as Record<string, unknown>).scripts as Record<string, unknown> ?? {};
      } catch {
        return 'bad';
      }
    };

    const baseScripts = await readScripts(mergeBase);
    const headScripts = await readScripts('HEAD');

    if (baseScripts === 'bad' || headScripts === 'bad') {
      add({
        rule: 'package_json_unparsable',
        detail: 'package.json could not be parsed; scripts change cannot be ruled out',
        path: tf.path,
      });
      continue;
    }

    const baseJson = JSON.stringify(baseScripts === 'absent' ? {} : baseScripts);
    const headJson = JSON.stringify(headScripts === 'absent' ? {} : headScripts);
    if (baseJson !== headJson) {
      add({
        rule: 'package_scripts_modified',
        detail: 'diff modifies the "scripts" field of package.json',
        path: tf.path,
      });
    }
  }

  // -- Rule 7: .npmrc ---------------------------------------------------------------------
  for (const tf of touchedFiles) {
    if (path.basename(tf.path) === '.npmrc') {
      add({ rule: 'npmrc_touched', detail: 'diff touches .npmrc', path: tf.path });
    }
  }

  // -- Rule 8: diff size ------------------------------------------------------------------
  const maxDiffLines = options?.maxDiffLines ?? DEFAULT_MAX_DIFF_LINES;
  if (diffStats.totalLines > maxDiffLines) {
    add({
      rule: 'diff_size_limit',
      detail: `diff exceeds the size limit: ${diffStats.totalLines} changed lines against a maximum of ${maxDiffLines}`,
    });
  }

  // -- secret collection: a failure is a named failed check, never an empty list ----------
  let secretValues: string[] = options?.secretValues ?? [];
  let secretScanRan = secretValues.length > 0;
  if (!secretScanRan) {
    const worktreePath =
      typeof workspaceOrRepo === 'object' &&
      workspaceOrRepo !== null &&
      'worktreePath' in workspaceOrRepo
        ? (workspaceOrRepo as Workspace).worktreePath
        : path.resolve(workspaceOrRepo as string);
    try {
      secretValues = await collectSecretValues(worktreePath);
      secretScanRan = true;
    } catch (err: unknown) {
      secretValues = [];
      secretScanRan = false;
      add({
        rule: 'secret_scan_not_run',
        detail: `secret collection failed, so the diff could not be scanned for known secrets: ${
          err instanceof Error ? err.message : String(err)
        }`,
      });
    }
  }
  const effectiveSecrets = secretValues.filter((s) => typeof s === 'string' && s.length >= 8);

  // -- per-line rules ----------------------------------------------------------------------
  let testAddedAssertions = 0;
  let testDeletedAssertions = 0;

  const byPath = new Map(touchedFiles.map((tf) => [tf.path, tf]));

  for (let c = 0; c < chunks.length; c++) {
    const chunk = chunks[c];
    // Prefer the path from the file header; fall back to positional order only if the
    // header was absent (a pure mode change, for instance).
    const headerPath = normalizePath(chunk.newPath || chunk.oldPath || '');
    const tf = byPath.get(headerPath) ?? touchedFiles[c];
    // Prefer the name-status path: it is verbatim, while a patch header can be escaped.
    const chunkPath = tf?.path || headerPath || '(unknown)';
    const isTest = isTestFile(chunkPath) || (tf?.oldPath ? isTestFile(tf.oldPath) : false);

    if (isTest) {
      testAddedAssertions += countAssertionCalls(chunk.addedLines);
      testDeletedAssertions += countAssertionCalls(chunk.deletedLines);
    }

    for (const { line, text } of chunk.addedLines) {
      if (isTest) {
        if (/\.skip\b/.test(text)) {
          add({ rule: 'test_disabled_marker', detail: 'diff adds .skip in a test file', path: chunkPath, line });
        }
        if (/\.only\b/.test(text)) {
          add({ rule: 'test_disabled_marker', detail: 'diff adds .only in a test file', path: chunkPath, line });
        }
        if (/\bxit\b/.test(text)) {
          add({ rule: 'test_disabled_marker', detail: 'diff adds xit in a test file', path: chunkPath, line });
        }
        if (/\bxdescribe\b/.test(text)) {
          add({ rule: 'test_disabled_marker', detail: 'diff adds xdescribe in a test file', path: chunkPath, line });
        }
        if (/\bit\.todo\b|\btest\.todo\b/.test(text)) {
          add({ rule: 'test_disabled_marker', detail: 'diff adds it.todo in a test file', path: chunkPath, line });
        }
      }

      if (text.includes('[REDACTED]')) {
        add({
          rule: 'redaction_marker',
          detail: 'diff adds the literal [REDACTED] marker',
          path: chunkPath,
          line,
        });
      }

      for (const secret of effectiveSecrets) {
        if (text.includes(secret)) {
          add({
            rule: 'secret_value_in_diff',
            detail: 'diff adds a secret value collected from the worktree',
            path: chunkPath,
            line,
          });
          break;
        }
      }

      for (const pattern of COMMON_SECRET_PATTERNS) {
        if (pattern.regex.test(text)) {
          add({
            rule: 'secret_shape_in_diff',
            detail: `diff adds a value matching a common secret shape (${pattern.name})`,
            path: chunkPath,
            line,
          });
          break;
        }
      }
    }
  }

  if (testAddedAssertions < testDeletedAssertions) {
    add({
      rule: 'assertions_net_negative',
      detail: `diff is net-negative on assertion calls in test files: ${testAddedAssertions} added against ${testDeletedAssertions} removed`,
    });
  }

  return {
    passed: violations.length === 0,
    violations: violations.map(formatViolation),
    violationDetails: violations,
    reviewItems,
    diffStats,
    effectiveSecrets,
    worktreeClean,
    secretScanRan,
    parsedLineCounts,
  };
}
