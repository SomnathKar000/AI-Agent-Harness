import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import * as sandboxModule from '@harness/sandbox';
import { runGit } from '@harness/sandbox';
import { evaluateDiffPolicy } from '../src/index.js';

/**
 * Round 3 hardening tests for the diff policy.
 * Items 5 (no source text in violations), 6 (-M -C and odd paths), 7 (exact approval
 * matching only), 8 (secret-shape controls), 9 (secret_scan_not_run), 12 (hunk-header parser).
 *
 * New file: no existing test is modified.
 */
describe('Diff Policy round 3 hardening', () => {
  let tempRepoDir: string;

  beforeEach(async () => {
    tempRepoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-r3-diff-'));
    await runGit(tempRepoDir, ['init', '-b', 'main']);
    await runGit(tempRepoDir, ['config', 'user.name', 'Test Verifier']);
    await runGit(tempRepoDir, ['config', 'user.email', 'verifier@example.com']);

    fs.writeFileSync(
      path.join(tempRepoDir, 'package.json'),
      JSON.stringify({ name: 'r3-repo', version: '1.0.0', scripts: { test: 'vitest run' } }, null, 2)
    );
    fs.mkdirSync(path.join(tempRepoDir, 'src'), { recursive: true });
    fs.writeFileSync(path.join(tempRepoDir, 'src', 'index.ts'), 'export const x = 1;\n');
    fs.mkdirSync(path.join(tempRepoDir, 'test'), { recursive: true });
    fs.writeFileSync(
      path.join(tempRepoDir, 'test', 'index.test.ts'),
      "import { expect } from 'vitest';\nexpect(1).toBe(1);\n"
    );
    fs.writeFileSync(path.join(tempRepoDir, '.gitignore'), '.env\nnode_modules\n');

    await runGit(tempRepoDir, ['add', '.']);
    await runGit(tempRepoDir, ['commit', '-m', 'Initial commit']);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    try {
      const wtList = await runGit(tempRepoDir, ['worktree', 'list']);
      expect(wtList.stdout.trim().split('\n').length).toBe(1);
      const branchList = await runGit(tempRepoDir, ['branch', '--list', 'harness/*']);
      expect(branchList.stdout.trim()).toBe('');
    } catch {
      // repo already removed
    }
    try {
      fs.rmSync(tempRepoDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  // ---------------------------------------------------------------- item 5
  describe('Item 5: violations never echo source lines', () => {
    it('a diff line holding the canary and .skip produces violations that contain neither the canary nor the source line', async () => {
      await runGit(tempRepoDir, ['checkout', '-b', 'task-branch']);
      fs.appendFileSync(
        path.join(tempRepoDir, 'test', 'index.test.ts'),
        "it.skip('leaks', () => { const token = 'canary-7f3a9-do-not-echo'; });\n"
      );
      await runGit(tempRepoDir, ['add', '-A']);
      await runGit(tempRepoDir, ['commit', '-m', 'add skip with canary']);

      const result = await evaluateDiffPolicy(tempRepoDir, 'main');

      expect(result.passed).toBe(false);
      expect(result.violations.some((v) => v.includes('.skip'))).toBe(true);
      // The canary must never reach a violation string.
      for (const v of result.violations) {
        expect(v).not.toContain('canary-7f3a9');
        expect(v).not.toContain('do-not-echo');
        expect(v).not.toContain('const token');
      }
    });

    it('every violation that refers to a diff line carries a line number instead of the text', async () => {
      await runGit(tempRepoDir, ['checkout', '-b', 'task-branch']);
      fs.appendFileSync(
        path.join(tempRepoDir, 'test', 'index.test.ts'),
        "it.only('focused', () => {});\n"
      );
      await runGit(tempRepoDir, ['add', '-A']);
      await runGit(tempRepoDir, ['commit', '-m', 'add only']);

      const result = await evaluateDiffPolicy(tempRepoDir, 'main');

      const onlyViolation = result.violations.find((v) => v.includes('.only'));
      expect(onlyViolation).toBeDefined();
      expect(onlyViolation).toMatch(/line \d+/);
      expect(onlyViolation).toContain('test/index.test.ts');
    });
  });

  // ---------------------------------------------------------------- item 6
  describe('Item 6: rename and copy detection with -M -C', () => {
    it('FAIL: renaming a test file to a non-test file whose path contains spaces', async () => {
      // The test file must exist on the BASE branch, otherwise there is no rename to see
      // relative to the merge base.
      fs.mkdirSync(path.join(tempRepoDir, 'test suite'), { recursive: true });
      fs.writeFileSync(
        path.join(tempRepoDir, 'test suite', 'my calc.test.ts'),
        "import { expect } from 'vitest';\nexpect(2).toBe(2);\n"
      );
      await runGit(tempRepoDir, ['add', '-A']);
      await runGit(tempRepoDir, ['commit', '-m', 'add spaced test file on main']);

      await runGit(tempRepoDir, ['checkout', '-b', 'task-branch']);
      fs.renameSync(
        path.join(tempRepoDir, 'test suite', 'my calc.test.ts'),
        path.join(tempRepoDir, 'test suite', 'my calc.txt')
      );
      await runGit(tempRepoDir, ['add', '-A']);
      await runGit(tempRepoDir, ['commit', '-m', 'rename spaced test away']);

      const result = await evaluateDiffPolicy(tempRepoDir, 'main');

      expect(result.passed).toBe(false);
      expect(
        result.violations.some((v) => v.includes('my calc.txt') || v.includes('my calc.test.ts'))
      ).toBe(true);
    });

    it('FAIL: renaming a test file with a non-ASCII path to a non-test path (core.quotePath)', async () => {
      // git quotes and octal-escapes non-ASCII paths unless core.quotePath=false, which is
      // how "café" arrives as "caf\303\251" and slips past the test-file check.
      fs.mkdirSync(path.join(tempRepoDir, 'test'), { recursive: true });
      fs.writeFileSync(
        path.join(tempRepoDir, 'test', 'café.test.ts'),
        "import { expect } from 'vitest';\nexpect(3).toBe(3);\n"
      );
      await runGit(tempRepoDir, ['add', '-A']);
      await runGit(tempRepoDir, ['commit', '-m', 'add non-ascii test file on main']);

      await runGit(tempRepoDir, ['checkout', '-b', 'task-branch']);
      fs.renameSync(
        path.join(tempRepoDir, 'test', 'café.test.ts'),
        path.join(tempRepoDir, 'notes-café.txt')
      );
      await runGit(tempRepoDir, ['add', '-A']);
      await runGit(tempRepoDir, ['commit', '-m', 'rename non-ascii test away']);

      const result = await evaluateDiffPolicy(tempRepoDir, 'main');

      expect(result.passed).toBe(false);
      expect(
        result.violations.some(
          (v) => v.includes('test_file_renamed_away') || v.includes('test_file_deleted')
        )
      ).toBe(true);
      // The path must arrive unescaped, not as "caf\303\251".
      expect(result.violations.join('\n')).not.toContain('\\303');
    });

    it('PASS (control): renaming a test file to another test path is allowed', async () => {
      await runGit(tempRepoDir, ['checkout', '-b', 'task-branch']);
      fs.renameSync(
        path.join(tempRepoDir, 'test', 'index.test.ts'),
        path.join(tempRepoDir, 'test', 'renamed.test.ts')
      );
      await runGit(tempRepoDir, ['add', '-A']);
      await runGit(tempRepoDir, ['commit', '-m', 'rename test to test']);

      const result = await evaluateDiffPolicy(tempRepoDir, 'main');

      expect(result.violations.some((v) => v.toLowerCase().includes('rename'))).toBe(false);
    });

    it('FAIL: a copy of a test file to a non-test path is caught (status C)', async () => {
      await runGit(tempRepoDir, ['checkout', '-b', 'task-branch']);
      const body = fs.readFileSync(path.join(tempRepoDir, 'test', 'index.test.ts'), 'utf8');
      // A large identical body makes copy detection reliable.
      const padded = body + '// padding line\n'.repeat(60);
      fs.writeFileSync(path.join(tempRepoDir, 'test', 'index.test.ts'), padded);
      await runGit(tempRepoDir, ['add', '-A']);
      await runGit(tempRepoDir, ['commit', '-m', 'pad test body']);

      fs.writeFileSync(path.join(tempRepoDir, 'copied.txt'), padded);
      fs.rmSync(path.join(tempRepoDir, 'test', 'index.test.ts'));
      await runGit(tempRepoDir, ['add', '-A']);
      await runGit(tempRepoDir, ['commit', '-m', 'move test body to non-test path']);

      const result = await evaluateDiffPolicy(tempRepoDir, 'main');

      expect(result.passed).toBe(false);
      expect(
        result.violations.some((v) => v.includes('copied.txt') || v.includes('index.test.ts'))
      ).toBe(true);
    });
  });

  // ---------------------------------------------------------------- item 7
  describe('Item 7: approval matching is exact-normalized only', () => {
    it('FAIL: approving the directory prefix ".github/" does not approve .github/workflows/ci.yml', async () => {
      await runGit(tempRepoDir, ['checkout', '-b', 'task-branch']);
      fs.mkdirSync(path.join(tempRepoDir, '.github', 'workflows'), { recursive: true });
      fs.writeFileSync(path.join(tempRepoDir, '.github', 'workflows', 'ci.yml'), 'name: CI\n');
      await runGit(tempRepoDir, ['add', '-A']);
      await runGit(tempRepoDir, ['commit', '-m', 'add workflow']);

      const result = await evaluateDiffPolicy(tempRepoDir, 'main', {
        approvedAsks: ['.github/'],
      });

      expect(result.passed).toBe(false);
      expect(result.violations.some((v) => v.includes('.github'))).toBe(true);
    });

    it('FAIL: a whitespace-only approval entry fails the check with approval_list_invalid', async () => {
      await runGit(tempRepoDir, ['checkout', '-b', 'task-branch']);
      fs.mkdirSync(path.join(tempRepoDir, '.github', 'workflows'), { recursive: true });
      fs.writeFileSync(path.join(tempRepoDir, '.github', 'workflows', 'ci.yml'), 'name: CI\n');
      await runGit(tempRepoDir, ['add', '-A']);
      await runGit(tempRepoDir, ['commit', '-m', 'add workflow']);

      const result = await evaluateDiffPolicy(tempRepoDir, 'main', {
        approvedAsks: ['   ', '.github/workflows/ci.yml'],
      });

      expect(result.passed).toBe(false);
      expect(result.violations.some((v) => v.includes('approval_list_invalid'))).toBe(true);
    });

    it('PASS (control): approving "a/b" does not approve "a/bc", and the exact path is approved', async () => {
      await runGit(tempRepoDir, ['checkout', '-b', 'task-branch']);
      fs.mkdirSync(path.join(tempRepoDir, '.github'), { recursive: true });
      fs.writeFileSync(path.join(tempRepoDir, '.github', 'bc.yml'), 'name: BC\n');
      await runGit(tempRepoDir, ['add', '-A']);
      await runGit(tempRepoDir, ['commit', '-m', 'add bc']);

      const notApproved = await evaluateDiffPolicy(tempRepoDir, 'main', {
        approvedAsks: ['.github/b'],
      });
      expect(notApproved.passed).toBe(false);

      const approved = await evaluateDiffPolicy(tempRepoDir, 'main', {
        approvedAsks: ['.github/bc.yml'],
      });
      expect(approved.violations.some((v) => v.includes('.github/bc.yml'))).toBe(false);
    });
  });

  // ---------------------------------------------------------------- item 8
  describe('Item 8: secret-shape negative controls', () => {
    it('PASS (control): ordinary prose and base64-looking lockfile content are not flagged', async () => {
      await runGit(tempRepoDir, ['checkout', '-b', 'task-branch']);
      fs.writeFileSync(
        path.join(tempRepoDir, 'pnpm-lock.yaml'),
        [
          'lockfileVersion: "9.0"',
          'packages:',
          '  /left-pad@1.3.0:',
          '    resolution: {integrity: sha512-XI5MPzVNApjAyhQzphX8BkmKsKUxD4LdyK24iZeQGinBN9yTQT3bFlCBy/aVx2HrNcqQGsdot8ghrjyrvMCoEg==}',
          '  /ghost-writer@2.0.0:',
          '    resolution: {integrity: sha1-AKIAbutNotAKeyBecauseItIsLowercaseish=}',
          'comment: the gho_ prefix appears here as prose only',
        ].join('\n') + '\n'
      );
      await runGit(tempRepoDir, ['add', '-A']);
      await runGit(tempRepoDir, ['commit', '-m', 'add lockfile']);

      const result = await evaluateDiffPolicy(tempRepoDir, 'main');

      expect(result.violations.some((v) => v.includes('secret shape'))).toBe(false);
      expect(result.reviewItems.some((r) => r.includes('lockfile_edit'))).toBe(true);
    });
  });

  // ---------------------------------------------------------------- item 9
  describe('Item 9: secret collection failure is a named failed check', () => {
    it('FAIL: a rejecting collectSecretValues yields secret_scan_not_run', async () => {
      vi.spyOn(sandboxModule, 'collectSecretValues').mockRejectedValue(
        new Error('collection boom')
      );

      await runGit(tempRepoDir, ['checkout', '-b', 'task-branch']);
      fs.writeFileSync(path.join(tempRepoDir, 'src', 'index.ts'), 'export const x = 2;\n');
      await runGit(tempRepoDir, ['add', '-A']);
      await runGit(tempRepoDir, ['commit', '-m', 'change src']);

      const result = await evaluateDiffPolicy(tempRepoDir, 'main');

      expect(result.passed).toBe(false);
      expect(result.secretScanRan).toBe(false);
      expect(result.violations.some((v) => v.includes('secret_scan_not_run'))).toBe(true);
    });
  });

  // --------------------------------------------------------------- item 12
  describe('Item 12: hunk-header driven parser', () => {
    it('counts a removed line that begins with "-- " and matches git diff --numstat exactly', async () => {
      // Seed a file whose lines include one starting with "-- " and one with "++ ".
      fs.writeFileSync(
        path.join(tempRepoDir, 'notes.md'),
        ['alpha', '-- dashed line', 'beta', '++ plussed line', 'gamma', 'delta'].join('\n') + '\n'
      );
      await runGit(tempRepoDir, ['add', '-A']);
      await runGit(tempRepoDir, ['commit', '-m', 'add notes']);

      await runGit(tempRepoDir, ['checkout', '-b', 'task-branch']);
      fs.writeFileSync(
        path.join(tempRepoDir, 'notes.md'),
        ['alpha', 'beta', 'gamma', 'delta', 'epsilon'].join('\n') + '\n'
      );
      await runGit(tempRepoDir, ['add', '-A']);
      await runGit(tempRepoDir, ['commit', '-m', 'remove dashed and plussed lines']);

      const result = await evaluateDiffPolicy(tempRepoDir, 'main');

      const { stdout: numstat } = await runGit(tempRepoDir, [
        'diff',
        '--numstat',
        '--merge-base',
        'main',
        'HEAD',
      ]);
      let expectedIns = 0;
      let expectedDel = 0;
      for (const line of String(numstat).trim().split('\n')) {
        if (!line.trim()) continue;
        const [i, d] = line.split('\t');
        expectedIns += Number(i);
        expectedDel += Number(d);
      }

      expect(result.diffStats.deletions).toBe(expectedDel);
      expect(result.diffStats.insertions).toBe(expectedIns);
      expect(result.parsedLineCounts).toEqual({
        added: expectedIns,
        removed: expectedDel,
      });
    });

    it('parses a file whose path contains " b/" without losing the diff', async () => {
      await runGit(tempRepoDir, ['checkout', '-b', 'task-branch']);
      // The literal path "weird a/b/name.test.ts" makes the header read
      // "diff --git a/weird a/b/name.test.ts b/weird a/b/name.test.ts", which a greedy
      // or " b/"-splitting parser gets wrong.
      fs.mkdirSync(path.join(tempRepoDir, 'weird a', 'b'), { recursive: true });
      fs.writeFileSync(
        path.join(tempRepoDir, 'weird a', 'b', 'name.test.ts'),
        "import { expect } from 'vitest';\nit.skip('hidden', () => {});\n"
      );
      await runGit(tempRepoDir, ['add', '-A']);
      await runGit(tempRepoDir, ['commit', '-m', 'add tricky path']);

      const result = await evaluateDiffPolicy(tempRepoDir, 'main');

      expect(result.passed).toBe(false);
      expect(result.violations.some((v) => v.includes('.skip'))).toBe(true);
      expect(result.violations.some((v) => v.includes('weird a/b/name.test.ts'))).toBe(true);
    });
  });
});
