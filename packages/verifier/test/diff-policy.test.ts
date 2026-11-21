import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { runGit, collectSecretValues } from '@harness/sandbox';
import { evaluateDiffPolicy } from '../src/index.js';

describe('Diff Policy Unit & Rule Tests', () => {
  let tempRepoDir: string;

  beforeEach(async () => {
    tempRepoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-verifier-test-'));
    // Initialize synthetic repo using runGit
    await runGit(tempRepoDir, ['init', '-b', 'main']);
    await runGit(tempRepoDir, ['config', 'user.name', 'Test Verifier']);
    await runGit(tempRepoDir, ['config', 'user.email', 'verifier@example.com']);

    // Create baseline files
    fs.writeFileSync(
      path.join(tempRepoDir, 'package.json'),
      JSON.stringify(
        {
          name: 'synthetic-repo',
          version: '1.0.0',
          scripts: {
            test: 'vitest run',
            build: 'tsc',
          },
        },
        null,
        2
      )
    );

    fs.mkdirSync(path.join(tempRepoDir, 'src'), { recursive: true });
    fs.writeFileSync(
      path.join(tempRepoDir, 'src', 'index.ts'),
      'export function add(a: number, b: number): number { return a + b; }\n'
    );

    fs.mkdirSync(path.join(tempRepoDir, 'test'), { recursive: true });
    fs.writeFileSync(
      path.join(tempRepoDir, 'test', 'index.test.ts'),
      `import { describe, it, expect } from 'vitest';
import { add } from '../src/index.js';

describe('add', () => {
  it('adds two numbers', () => {
    expect(add(1, 2)).toBe(3);
    expect(add(2, 2)).toBe(4);
  });
});
`
    );

    fs.writeFileSync(
      path.join(tempRepoDir, 'vitest.config.ts'),
      `import { defineConfig } from 'vitest/config';\nexport default defineConfig({});\n`
    );

    await runGit(tempRepoDir, ['add', '.']);
    await runGit(tempRepoDir, ['commit', '-m', 'Initial commit']);
  });

  afterEach(async () => {
    // Assert git worktree list has only the main worktree and no harness/* branches
    try {
      const wtList = await runGit(tempRepoDir, ['worktree', 'list']);
      const wtLines = wtList.stdout.trim().split('\n');
      expect(wtLines.length).toBe(1);

      const branchList = await runGit(tempRepoDir, ['branch', '--list', 'harness/*']);
      expect(branchList.stdout.trim()).toBe('');
    } catch {
      // ignore if repo was removed
    }

    try {
      fs.rmSync(tempRepoDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  // Rule 1: deletes any test file
  describe('Rule 1: deletes any test file', () => {
    it('FAIL: when a test file is deleted', async () => {
      await runGit(tempRepoDir, ['checkout', '-b', 'task-branch']);
      fs.unlinkSync(path.join(tempRepoDir, 'test', 'index.test.ts'));
      await runGit(tempRepoDir, ['add', '-A']);
      await runGit(tempRepoDir, ['commit', '-m', 'Delete test file']);

      const result = await evaluateDiffPolicy(tempRepoDir, 'main');
      expect(result.passed).toBe(false);
      expect(result.violations.some((v) => v.toLowerCase().includes('delete') && v.includes('test'))).toBe(true);
    });

    it('PASS (control): when non-test files are deleted or test files are not deleted', async () => {
      await runGit(tempRepoDir, ['checkout', '-b', 'task-branch']);
      fs.writeFileSync(path.join(tempRepoDir, 'src', 'index.ts'), 'export function add(a: number, b: number) { return a + b + 0; }\n');
      await runGit(tempRepoDir, ['add', '-A']);
      await runGit(tempRepoDir, ['commit', '-m', 'Update src file']);

      const result = await evaluateDiffPolicy(tempRepoDir, 'main');
      expect(result.passed).toBe(true);
      expect(result.violations).toHaveLength(0);
    });
  });

  // Rule 2: adds .skip / .only / xit / xdescribe / it.todo
  describe('Rule 2: adds .skip / .only / xit / xdescribe / it.todo', () => {
    it('FAIL: when .skip is added', async () => {
      await runGit(tempRepoDir, ['checkout', '-b', 'task-branch']);
      fs.appendFileSync(path.join(tempRepoDir, 'test', 'index.test.ts'), `\nit.skip('skipped test', () => {});\n`);
      await runGit(tempRepoDir, ['add', '-A']);
      await runGit(tempRepoDir, ['commit', '-m', 'Add skipped test']);

      const result = await evaluateDiffPolicy(tempRepoDir, 'main');
      expect(result.passed).toBe(false);
      expect(result.violations.some((v) => v.includes('.skip'))).toBe(true);
    });

    it('FAIL: when .only is added', async () => {
      await runGit(tempRepoDir, ['checkout', '-b', 'task-branch']);
      fs.appendFileSync(path.join(tempRepoDir, 'test', 'index.test.ts'), `\nit.only('only test', () => {});\n`);
      await runGit(tempRepoDir, ['add', '-A']);
      await runGit(tempRepoDir, ['commit', '-m', 'Add only test']);

      const result = await evaluateDiffPolicy(tempRepoDir, 'main');
      expect(result.passed).toBe(false);
      expect(result.violations.some((v) => v.includes('.only'))).toBe(true);
    });

    it('FAIL: when xit, xdescribe, or it.todo is added', async () => {
      await runGit(tempRepoDir, ['checkout', '-b', 'task-branch']);
      fs.appendFileSync(
        path.join(tempRepoDir, 'test', 'index.test.ts'),
        `\nxit('xit test', () => {});\nxdescribe('xdesc', () => {});\nit.todo('todo test');\n`
      );
      await runGit(tempRepoDir, ['add', '-A']);
      await runGit(tempRepoDir, ['commit', '-m', 'Add xit / xdescribe / it.todo']);

      const result = await evaluateDiffPolicy(tempRepoDir, 'main');
      expect(result.passed).toBe(false);
      expect(result.violations.some((v) => v.includes('xit') || v.includes('xdescribe') || v.includes('todo'))).toBe(true);
    });

    it('PASS (control): when tests are added without skip/only/xit/xdescribe/todo', async () => {
      await runGit(tempRepoDir, ['checkout', '-b', 'task-branch']);
      fs.appendFileSync(
        path.join(tempRepoDir, 'test', 'index.test.ts'),
        `\nit('new active test', () => {\n  expect(add(3, 4)).toBe(7);\n});\n`
      );
      await runGit(tempRepoDir, ['add', '-A']);
      await runGit(tempRepoDir, ['commit', '-m', 'Add normal test']);

      const result = await evaluateDiffPolicy(tempRepoDir, 'main');
      expect(result.passed).toBe(true);
      expect(result.violations).toHaveLength(0);
    });
  });

  // Rule 3: net-negative on assertion calls in test files
  describe('Rule 3: net-negative on assertion calls (expect/assert) in test files', () => {
    it('FAIL: when diff removes 2 expect assertions and adds only 1 expect assertion (net -1)', async () => {
      await runGit(tempRepoDir, ['checkout', '-b', 'task-branch']);
      fs.writeFileSync(
        path.join(tempRepoDir, 'test', 'index.test.ts'),
        `import { describe, it, expect } from 'vitest';
import { add } from '../src/index.js';

describe('add', () => {
  it('adds two numbers', () => {
    expect(add(1, 2)).toBe(3);
  });
});
`
      );
      await runGit(tempRepoDir, ['add', '-A']);
      await runGit(tempRepoDir, ['commit', '-m', 'Remove one assertion net negative']);

      const result = await evaluateDiffPolicy(tempRepoDir, 'main');
      expect(result.passed).toBe(false);
      expect(result.violations.some((v) => v.toLowerCase().includes('net-negative') || v.toLowerCase().includes('assertion'))).toBe(true);
    });

    it('PASS (control): when diff adds equal or more assertions (net >= 0)', async () => {
      await runGit(tempRepoDir, ['checkout', '-b', 'task-branch']);
      fs.writeFileSync(
        path.join(tempRepoDir, 'test', 'index.test.ts'),
        `import { describe, it, expect } from 'vitest';
import { add } from '../src/index.js';

describe('add', () => {
  it('adds two numbers', () => {
    expect(add(1, 2)).toBe(3);
    expect(add(2, 2)).toBe(4);
    expect(add(3, 3)).toBe(6);
  });
});
`
      );
      await runGit(tempRepoDir, ['add', '-A']);
      await runGit(tempRepoDir, ['commit', '-m', 'Add more assertions']);

      const result = await evaluateDiffPolicy(tempRepoDir, 'main');
      expect(result.passed).toBe(true);
      expect(result.violations).toHaveLength(0);
    });
  });

  // Rule 4: edits test config (vitest/jest config, coverage thresholds)
  describe('Rule 4: edits test config (vitest/jest config, coverage thresholds)', () => {
    it('FAIL: when vitest.config.ts is edited', async () => {
      await runGit(tempRepoDir, ['checkout', '-b', 'task-branch']);
      fs.appendFileSync(path.join(tempRepoDir, 'vitest.config.ts'), `// modified\n`);
      await runGit(tempRepoDir, ['add', '-A']);
      await runGit(tempRepoDir, ['commit', '-m', 'Modify vitest config']);

      const result = await evaluateDiffPolicy(tempRepoDir, 'main');
      expect(result.passed).toBe(false);
      expect(result.violations.some((v) => v.includes('test config') || v.includes('vitest.config'))).toBe(true);
    });

    it('PASS (control): when application code is edited without touching test config', async () => {
      await runGit(tempRepoDir, ['checkout', '-b', 'task-branch']);
      fs.writeFileSync(path.join(tempRepoDir, 'src', 'index.ts'), 'export function add(a: number, b: number) { return Number(a) + Number(b); }\n');
      await runGit(tempRepoDir, ['add', '-A']);
      await runGit(tempRepoDir, ['commit', '-m', 'Clean edit in src']);

      const result = await evaluateDiffPolicy(tempRepoDir, 'main');
      expect(result.passed).toBe(true);
      expect(result.violations).toHaveLength(0);
    });
  });

  // Rule 5: touches .github/** or policy files without an approved ask
  describe('Rule 5: touches .github/** or policy files without an approved ask', () => {
    it('FAIL: when .github workflow file is touched without approval', async () => {
      await runGit(tempRepoDir, ['checkout', '-b', 'task-branch']);
      fs.mkdirSync(path.join(tempRepoDir, '.github', 'workflows'), { recursive: true });
      fs.writeFileSync(path.join(tempRepoDir, '.github', 'workflows', 'ci.yml'), 'name: CI\n');
      await runGit(tempRepoDir, ['add', '-A']);
      await runGit(tempRepoDir, ['commit', '-m', 'Add CI workflow']);

      const result = await evaluateDiffPolicy(tempRepoDir, 'main');
      expect(result.passed).toBe(false);
      expect(result.violations.some((v) => v.includes('.github'))).toBe(true);
    });

    it('FAIL: when policy file is touched without approval', async () => {
      await runGit(tempRepoDir, ['checkout', '-b', 'task-branch']);
      fs.mkdirSync(path.join(tempRepoDir, 'policy'), { recursive: true });
      fs.writeFileSync(path.join(tempRepoDir, 'policy', 'harness.policy.yaml'), 'version: "1.0"\n');
      await runGit(tempRepoDir, ['add', '-A']);
      await runGit(tempRepoDir, ['commit', '-m', 'Add policy file']);

      const result = await evaluateDiffPolicy(tempRepoDir, 'main');
      expect(result.passed).toBe(false);
      expect(result.violations.some((v) => v.includes('policy'))).toBe(true);
    });

    it('PASS (control): when .github file is touched WITH an approved ask', async () => {
      await runGit(tempRepoDir, ['checkout', '-b', 'task-branch']);
      fs.mkdirSync(path.join(tempRepoDir, '.github', 'workflows'), { recursive: true });
      fs.writeFileSync(path.join(tempRepoDir, '.github', 'workflows', 'ci.yml'), 'name: CI\n');
      await runGit(tempRepoDir, ['add', '-A']);
      await runGit(tempRepoDir, ['commit', '-m', 'Add CI workflow with approval']);

      const result = await evaluateDiffPolicy(tempRepoDir, 'main', {
        approvedAsks: ['.github/workflows/ci.yml'],
      });
      expect(result.passed).toBe(true);
      expect(result.violations).toHaveLength(0);
    });
  });

  // Rule 6: modifies the "scripts" field of any package.json
  describe('Rule 6: modifies the "scripts" field of any package.json', () => {
    it('FAIL: when package.json scripts field is modified', async () => {
      await runGit(tempRepoDir, ['checkout', '-b', 'task-branch']);
      const pkg = JSON.parse(fs.readFileSync(path.join(tempRepoDir, 'package.json'), 'utf8'));
      pkg.scripts.test = 'echo bypass';
      fs.writeFileSync(path.join(tempRepoDir, 'package.json'), JSON.stringify(pkg, null, 2));
      await runGit(tempRepoDir, ['add', '-A']);
      await runGit(tempRepoDir, ['commit', '-m', 'Modify scripts']);

      const result = await evaluateDiffPolicy(tempRepoDir, 'main');
      expect(result.passed).toBe(false);
      expect(result.violations.some((v) => v.includes('scripts') && v.includes('package.json'))).toBe(true);
    });

    it('PASS (control): when package.json is modified without touching scripts', async () => {
      await runGit(tempRepoDir, ['checkout', '-b', 'task-branch']);
      const pkg = JSON.parse(fs.readFileSync(path.join(tempRepoDir, 'package.json'), 'utf8'));
      pkg.description = 'Updated description';
      fs.writeFileSync(path.join(tempRepoDir, 'package.json'), JSON.stringify(pkg, null, 2));
      await runGit(tempRepoDir, ['add', '-A']);
      await runGit(tempRepoDir, ['commit', '-m', 'Modify description only']);

      const result = await evaluateDiffPolicy(tempRepoDir, 'main');
      expect(result.passed).toBe(true);
      expect(result.violations).toHaveLength(0);
    });
  });

  // Rule 7: touches .npmrc
  describe('Rule 7: touches .npmrc', () => {
    it('FAIL: when .npmrc is touched in the diff', async () => {
      await runGit(tempRepoDir, ['checkout', '-b', 'task-branch']);
      fs.writeFileSync(path.join(tempRepoDir, '.npmrc'), 'registry=https://custom.registry\n');
      await runGit(tempRepoDir, ['add', '-A']);
      await runGit(tempRepoDir, ['commit', '-m', 'Add .npmrc']);

      const result = await evaluateDiffPolicy(tempRepoDir, 'main');
      expect(result.passed).toBe(false);
      expect(result.violations.some((v) => v.includes('.npmrc'))).toBe(true);
    });

    it('PASS (control): when other config files are modified without .npmrc', async () => {
      await runGit(tempRepoDir, ['checkout', '-b', 'task-branch']);
      fs.writeFileSync(path.join(tempRepoDir, 'tsconfig.json'), '{\n  "compilerOptions": {}\n}\n');
      await runGit(tempRepoDir, ['add', '-A']);
      await runGit(tempRepoDir, ['commit', '-m', 'Add tsconfig']);

      const result = await evaluateDiffPolicy(tempRepoDir, 'main');
      expect(result.passed).toBe(true);
      expect(result.violations).toHaveLength(0);
    });
  });

  // Rule 8: exceeds a configurable size limit (default 400 changed lines)
  describe('Rule 8: exceeds configurable size limit (default 400 changed lines)', () => {
    it('FAIL: when diff exceeds size limit', async () => {
      await runGit(tempRepoDir, ['checkout', '-b', 'task-branch']);
      const bigContent = Array.from({ length: 450 }, (_, i) => `export const x${i} = ${i};`).join('\n');
      fs.writeFileSync(path.join(tempRepoDir, 'src', 'big.ts'), bigContent);
      await runGit(tempRepoDir, ['add', '-A']);
      await runGit(tempRepoDir, ['commit', '-m', 'Add 450 lines']);

      const result = await evaluateDiffPolicy(tempRepoDir, 'main', { maxDiffLines: 400 });
      expect(result.passed).toBe(false);
      expect(result.violations.some((v) => v.includes('size limit') || v.includes('lines'))).toBe(true);
    });

    it('PASS (control): when diff is within the size limit', async () => {
      await runGit(tempRepoDir, ['checkout', '-b', 'task-branch']);
      const smallContent = Array.from({ length: 50 }, (_, i) => `export const y${i} = ${i};`).join('\n');
      fs.writeFileSync(path.join(tempRepoDir, 'src', 'small.ts'), smallContent);
      await runGit(tempRepoDir, ['add', '-A']);
      await runGit(tempRepoDir, ['commit', '-m', 'Add 50 lines']);

      const result = await evaluateDiffPolicy(tempRepoDir, 'main', { maxDiffLines: 400 });
      expect(result.passed).toBe(true);
      expect(result.violations).toHaveLength(0);
    });
  });

  // Rule 9: contains "[REDACTED]" anywhere
  describe('Rule 9: contains [REDACTED] anywhere', () => {
    it('FAIL: when diff contains [REDACTED]', async () => {
      await runGit(tempRepoDir, ['checkout', '-b', 'task-branch']);
      fs.appendFileSync(path.join(tempRepoDir, 'src', 'index.ts'), '// key = [REDACTED]\n');
      await runGit(tempRepoDir, ['add', '-A']);
      await runGit(tempRepoDir, ['commit', '-m', 'Add redacted marker']);

      const result = await evaluateDiffPolicy(tempRepoDir, 'main');
      expect(result.passed).toBe(false);
      expect(result.violations.some((v) => v.includes('[REDACTED]'))).toBe(true);
    });

    it('PASS (control): when diff has no [REDACTED]', async () => {
      await runGit(tempRepoDir, ['checkout', '-b', 'task-branch']);
      fs.appendFileSync(path.join(tempRepoDir, 'src', 'index.ts'), '// normal comment\n');
      await runGit(tempRepoDir, ['add', '-A']);
      await runGit(tempRepoDir, ['commit', '-m', 'Add normal comment']);

      const result = await evaluateDiffPolicy(tempRepoDir, 'main');
      expect(result.passed).toBe(true);
      expect(result.violations).toHaveLength(0);
    });
  });

  // Rule 10: contains any value from collectSecretValues(worktreePath)
  describe('Rule 10: contains any value from collectSecretValues(worktreePath)', () => {
    it('The secret checks must be proven with a real value from collectSecretValues: write .env, collect it, put in diff -> FAILS, remove it -> PASSES', async () => {
      // 1. Write a .env file into the fixture
      const SECRET_NAME = 'TEST_API_TOKEN_VALUE_XYZ_98765';
      fs.writeFileSync(path.join(tempRepoDir, '.env'), `API_TOKEN=${SECRET_NAME}\n`);

      // 2. Collect secrets with collectSecretValues
      const secrets = await collectSecretValues(tempRepoDir);
      expect(secrets).toContain(SECRET_NAME);

      // 3. Put that collected real secret value into the diff
      await runGit(tempRepoDir, ['checkout', '-b', 'task-branch']);
      fs.appendFileSync(path.join(tempRepoDir, 'src', 'index.ts'), `// api token: ${SECRET_NAME}\n`);
      await runGit(tempRepoDir, ['add', path.join(tempRepoDir, 'src', 'index.ts')]);
      await runGit(tempRepoDir, ['commit', '-m', 'Leak collected secret in src']);

      // 4. Show the verifier fails
      const failResult = await evaluateDiffPolicy(tempRepoDir, 'main', { secretValues: secrets });
      expect(failResult.passed).toBe(false);
      expect(failResult.violations.some((v) => v.includes('secret') || v.includes('collectSecretValues'))).toBe(true);

      // 5. Remove the secret and show it passes
      fs.writeFileSync(path.join(tempRepoDir, 'src', 'index.ts'), 'export function add(a: number, b: number) { return a + b; }\n');
      await runGit(tempRepoDir, ['add', path.join(tempRepoDir, 'src', 'index.ts')]);
      await runGit(tempRepoDir, ['commit', '-m', 'Clean src without secret']);

      const passResult = await evaluateDiffPolicy(tempRepoDir, 'main', { secretValues: secrets });
      expect(passResult.passed).toBe(true);
      expect(passResult.violations).toHaveLength(0);
    });
  });

  // Rule 11: matches common secret shapes
  describe('Rule 11: matches common secret shapes (PEM, AKIA, ghp_, sk-ant-)', () => {
    it('FAIL: when diff contains PEM private key block', async () => {
      await runGit(tempRepoDir, ['checkout', '-b', 'task-branch']);
      fs.appendFileSync(
        path.join(tempRepoDir, 'src', 'index.ts'),
        `const key = '-----BEGIN RSA PRIVATE KEY-----\\nMIIEowIBAAKCAQEAz...\\n-----END RSA PRIVATE KEY-----';\n`
      );
      await runGit(tempRepoDir, ['add', '-A']);
      await runGit(tempRepoDir, ['commit', '-m', 'Add PEM private key']);

      const result = await evaluateDiffPolicy(tempRepoDir, 'main');
      expect(result.passed).toBe(false);
      expect(result.violations.some((v) => v.includes('PEM') || v.includes('private key'))).toBe(true);
    });

    it('FAIL: when diff contains AKIA AWS key', async () => {
      await runGit(tempRepoDir, ['checkout', '-b', 'task-branch']);
      fs.appendFileSync(path.join(tempRepoDir, 'src', 'index.ts'), `const awsKey = 'AKIAIOSFODNN7EXAMPLE';\n`);
      await runGit(tempRepoDir, ['add', '-A']);
      await runGit(tempRepoDir, ['commit', '-m', 'Add AKIA key']);

      const result = await evaluateDiffPolicy(tempRepoDir, 'main');
      expect(result.passed).toBe(false);
      expect(result.violations.some((v) => v.includes('AKIA') || v.includes('secret shape'))).toBe(true);
    });

    it('FAIL: when diff contains GitHub ghp_ token', async () => {
      await runGit(tempRepoDir, ['checkout', '-b', 'task-branch']);
      fs.appendFileSync(path.join(tempRepoDir, 'src', 'index.ts'), `const token = 'ghp_0123456789abcdefghijklmnopqrstuvwxyz';\n`);
      await runGit(tempRepoDir, ['add', '-A']);
      await runGit(tempRepoDir, ['commit', '-m', 'Add ghp token']);

      const result = await evaluateDiffPolicy(tempRepoDir, 'main');
      expect(result.passed).toBe(false);
      expect(result.violations.some((v) => v.includes('ghp_') || v.includes('secret shape'))).toBe(true);
    });

    it('FAIL: when diff contains Anthropic sk-ant- token', async () => {
      await runGit(tempRepoDir, ['checkout', '-b', 'task-branch']);
      fs.appendFileSync(
        path.join(tempRepoDir, 'src', 'index.ts'),
        `const ant = 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz-12345678';\n`
      );
      await runGit(tempRepoDir, ['add', '-A']);
      await runGit(tempRepoDir, ['commit', '-m', 'Add sk-ant token']);

      const result = await evaluateDiffPolicy(tempRepoDir, 'main');
      expect(result.passed).toBe(false);
      expect(result.violations.some((v) => v.includes('sk-ant') || v.includes('secret shape'))).toBe(true);
    });

    it('PASS (control): when diff has regular code without secret shapes', async () => {
      await runGit(tempRepoDir, ['checkout', '-b', 'task-branch']);
      fs.appendFileSync(path.join(tempRepoDir, 'src', 'index.ts'), `export const PI = 3.14159;\n`);
      await runGit(tempRepoDir, ['add', '-A']);
      await runGit(tempRepoDir, ['commit', '-m', 'Add regular constant']);

      const result = await evaluateDiffPolicy(tempRepoDir, 'main');
      expect(result.passed).toBe(true);
      expect(result.violations).toHaveLength(0);
    });
  });

  // Rule 12: Report lockfile_edit as a review item rather than a failure
  describe('Rule 12: Report lockfile_edit as a review item rather than a failure', () => {
    it('PASS with review item: when pnpm-lock.yaml is edited', async () => {
      fs.writeFileSync(path.join(tempRepoDir, 'pnpm-lock.yaml'), 'lockfileVersion: "9.0"\n');
      await runGit(tempRepoDir, ['add', 'pnpm-lock.yaml']);
      await runGit(tempRepoDir, ['commit', '-m', 'Add pnpm lockfile']);

      await runGit(tempRepoDir, ['checkout', '-b', 'task-branch']);
      fs.appendFileSync(path.join(tempRepoDir, 'pnpm-lock.yaml'), '# modified\n');
      await runGit(tempRepoDir, ['add', 'pnpm-lock.yaml']);
      await runGit(tempRepoDir, ['commit', '-m', 'Modify lockfile']);

      const result = await evaluateDiffPolicy(tempRepoDir, 'main');
      expect(result.passed).toBe(true); // NOT a failure!
      expect(result.diffStats.lockfileEdit).toBe(true);
      expect(result.reviewItems.some((item) => item.includes('lockfile_edit'))).toBe(true);
    });
  });
});
