import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execSync } from 'node:child_process';
import {
  evaluate,
  loadPolicy,
  PolicyGate,
  type PolicyConfig,
  type PolicyContext,
} from '../src/index.js';
import type { createApproval } from '@harness/db';

describe('Policy Engine Security & Enforcement', () => {
  let tempDir: string;
  let outsideDir: string;
  let policyFile: string;
  let policy: PolicyConfig;
  let ctx: PolicyContext;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'policy-test-ws-'));
    outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'policy-test-out-'));

    // Create typical directory structure
    fs.mkdirSync(path.join(tempDir, 'src'), { recursive: true });
    fs.mkdirSync(path.join(tempDir, '.github', 'workflows'), { recursive: true });
    fs.mkdirSync(path.join(tempDir, 'audit'), { recursive: true });

    // Create dummy files
    fs.writeFileSync(path.join(tempDir, 'src', 'foo.ts'), 'export const foo = 1;\n');
    fs.writeFileSync(path.join(tempDir, 'src', 'bar.ts'), 'export const bar = 2;\n');
    fs.writeFileSync(path.join(tempDir, '.env'), 'SECRET=123\n');
    fs.writeFileSync(path.join(tempDir, '.env.local'), 'LOCAL_SECRET=456\n');
    fs.writeFileSync(path.join(tempDir, 'server.pem'), 'CERT\n');
    fs.writeFileSync(path.join(tempDir, 'id_rsa.key'), 'KEY\n');
    fs.writeFileSync(path.join(tempDir, '.npmrc'), 'registry=https://registry.npmjs.org/\n');
    fs.writeFileSync(path.join(tempDir, 'pnpm-lock.yaml'), 'lockfileVersion: 5.4\n');
    fs.writeFileSync(path.join(tempDir, '.github', 'workflows', 'ci.yml'), 'name: CI\n');
    fs.writeFileSync(path.join(tempDir, 'audit', 'audit.log'), 'audit log\n');

    // Create outside file
    fs.writeFileSync(path.join(outsideDir, 'outside-secret.txt'), 'SUPER_SECRET\n');

    policyFile = path.resolve(import.meta.dirname, '../../../policy/default.policy.yaml');
    policy = loadPolicy(policyFile);

    ctx = {
      workspaceRoot: tempDir,
      policyFile,
      auditLocations: [path.join(tempDir, 'audit'), path.join(tempDir, 'audit.log')],
      callCount: 1,
    };
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
    fs.rmSync(outsideDir, { recursive: true, force: true });
  });

  describe('Requirement 1: Default-deny', () => {
    it('denies unknown tools', async () => {
      const res = await evaluate(
        { id: 'unk-1', name: 'unknown_tool', input: { foo: 'bar' } },
        ctx,
        policy
      );
      expect(res.decision).toBe('deny');
      expect(res.rule).toBe('unknown_tool_deny');
      expect(res.reason).toMatch(/not recognized/i);
    });

    it('denies arbitrary shell commands', async () => {
      const res = await evaluate(
        { id: 'arb-1', name: 'run_command', input: { argv: ['arbitrary_binary', 'arg1'] } },
        ctx,
        policy
      );
      expect(res.decision).toBe('deny');
      expect(res.rule).toBe('default_deny');
      expect(res.reason).toMatch(/not allowlisted/i);
    });
  });

  describe('File Tools - Path Traversal & Escapes', () => {
    it('denies parent traversal ("../../etc/passwd")', async () => {
      const res = await evaluate(
        { id: '1', name: 'read_file', input: { path: '../../etc/passwd' } },
        ctx,
        policy
      );
      expect(res.decision).toBe('deny');
      expect(res.reason).toMatch(/escape|traversal|workspace/i);
    });

    it('denies absolute paths outside workspace ("/etc/passwd")', async () => {
      const res = await evaluate(
        { id: '2', name: 'read_file', input: { path: '/etc/passwd' } },
        ctx,
        policy
      );
      expect(res.decision).toBe('deny');
      expect(res.reason).toMatch(/escape|outside|workspace/i);
    });

    it('denies symlink escape pointing outside workspace for read, write, and edit', async () => {
      const symlinkPath = path.join(tempDir, 'symlink-outside.txt');
      fs.symlinkSync(path.join(outsideDir, 'outside-secret.txt'), symlinkPath);

      const readRes = await evaluate(
        { id: '3', name: 'read_file', input: { path: 'symlink-outside.txt' } },
        ctx,
        policy
      );
      expect(readRes.decision).toBe('deny');

      const writeRes = await evaluate(
        { id: '4', name: 'write_file', input: { path: 'symlink-outside.txt', content: 'hacked' } },
        ctx,
        policy
      );
      expect(writeRes.decision).toBe('deny');

      const editRes = await evaluate(
        {
          id: '5',
          name: 'edit_file',
          input: { path: 'symlink-outside.txt', old_string: 'SUPER', new_string: 'HACKED' },
        },
        ctx,
        policy
      );
      expect(editRes.decision).toBe('deny');
    });

    it('allows symlink inside workspace pointing to another file inside workspace for read, write, edit', async () => {
      const internalSymlink = path.join(tempDir, 'src', 'symlink-internal.ts');
      fs.symlinkSync(path.join(tempDir, 'src', 'foo.ts'), internalSymlink);

      const readRes = await evaluate(
        { id: '6', name: 'read_file', input: { path: 'src/symlink-internal.ts' } },
        ctx,
        policy
      );
      expect(readRes.decision).toBe('allow');

      const writeRes = await evaluate(
        {
          id: '7',
          name: 'write_file',
          input: { path: 'src/symlink-internal.ts', content: 'export const foo = 2;\n' },
        },
        ctx,
        policy
      );
      expect(writeRes.decision).toBe('allow');

      const editRes = await evaluate(
        {
          id: '8',
          name: 'edit_file',
          input: { path: 'src/symlink-internal.ts', old_string: 'foo = 1', new_string: 'foo = 3' },
        },
        ctx,
        policy
      );
      expect(editRes.decision).toBe('allow');
    });

    it('denies FIFO (mkfifo) and device files without blocking or hanging', async () => {
      const fifoPath = path.join(tempDir, 'test-fifo');
      try {
        execSync(`mkfifo "${fifoPath}"`);
      } catch {
        // Fallback if mkfifo fails on platform
        return;
      }

      const startTime = Date.now();
      const readRes = await evaluate(
        { id: '9', name: 'read_file', input: { path: 'test-fifo' } },
        ctx,
        policy
      );
      const elapsed = Date.now() - startTime;

      expect(elapsed).toBeLessThan(1000); // Must not hang or block
      expect(readRes.decision).toBe('deny');
      expect(readRes.reason).toMatch(/fifo|special|device/i);

      const writeRes = await evaluate(
        { id: '10', name: 'write_file', input: { path: 'test-fifo', content: 'data' } },
        ctx,
        policy
      );
      expect(writeRes.decision).toBe('deny');
    });

    it('denies reading the policy file', async () => {
      const res = await evaluate(
        { id: '11', name: 'read_file', input: { path: policyFile } },
        ctx,
        policy
      );
      expect(res.decision).toBe('deny');
      expect(res.reason).toMatch(/policy/i);
    });

    it('denies reading audit files', async () => {
      const res = await evaluate(
        { id: '12', name: 'read_file', input: { path: 'audit/audit.log' } },
        ctx,
        policy
      );
      expect(res.decision).toBe('deny');
      expect(res.reason).toMatch(/audit/i);
    });

    it('denies reading or writing .env and .env.* files', async () => {
      const envRes = await evaluate(
        { id: '13', name: 'read_file', input: { path: '.env' } },
        ctx,
        policy
      );
      expect(envRes.decision).toBe('deny');

      const envLocalRes = await evaluate(
        { id: '14', name: 'write_file', input: { path: '.env.local', content: 'HACK' } },
        ctx,
        policy
      );
      expect(envLocalRes.decision).toBe('deny');
    });

    it('denies *.pem and *.key secret files', async () => {
      const pemRes = await evaluate(
        { id: '15', name: 'read_file', input: { path: 'server.pem' } },
        ctx,
        policy
      );
      expect(pemRes.decision).toBe('deny');

      const keyRes = await evaluate(
        { id: '16', name: 'read_file', input: { path: 'id_rsa.key' } },
        ctx,
        policy
      );
      expect(keyRes.decision).toBe('deny');
    });

    it('returns ASK for writes to .github/** and DENY for .npmrc, but allows reading .github/**', async () => {
      const readGh = await evaluate(
        { id: '19', name: 'read_file', input: { path: '.github/workflows/ci.yml' } },
        ctx,
        policy
      );
      expect(readGh.decision).toBe('allow');

      const writeGh = await evaluate(
        {
          id: '20',
          name: 'write_file',
          input: { path: '.github/workflows/ci.yml', content: 'modified' },
        },
        ctx,
        policy
      );
      expect(writeGh.decision).toBe('ask');

      const writeNpmrc = await evaluate(
        { id: '21', name: 'write_file', input: { path: '.npmrc', content: 'registry=evil' } },
        ctx,
        policy
      );
      expect(writeNpmrc.decision).toBe('deny');
    });

    it('allows lockfile edits but flags them for diff report', async () => {
      const writeLock = await evaluate(
        {
          id: '22',
          name: 'write_file',
          input: { path: 'pnpm-lock.yaml', content: 'lockfileVersion: 5.4\nupdated: true\n' },
        },
        ctx,
        policy
      );
      expect(writeLock.decision).toBe('allow');
      expect(writeLock.flag).toBe('lockfile_edit');
    });

    it('allows editing normal files inside workspace (src/foo.ts)', async () => {
      const res = await evaluate(
        {
          id: '23',
          name: 'edit_file',
          input: { path: 'src/foo.ts', old_string: 'foo = 1', new_string: 'foo = 2' },
        },
        ctx,
        policy
      );
      expect(res.decision).toBe('allow');
    });
  });

  describe('Requirement 3: .git as a FILE in worktree and case variants', () => {
    beforeEach(() => {
      // In a git worktree, .git is a regular FILE
      fs.writeFileSync(path.join(tempDir, '.git'), 'gitdir: /path/to/main/.git/worktrees/task-1\n');
    });

    it('denies read, write, edit on ".git" file itself', async () => {
      const readGit = await evaluate(
        { id: 'git-f1', name: 'read_file', input: { path: '.git' } },
        ctx,
        policy
      );
      expect(readGit.decision).toBe('deny');

      const writeGit = await evaluate(
        { id: 'git-f2', name: 'write_file', input: { path: '.git', content: 'hacked' } },
        ctx,
        policy
      );
      expect(writeGit.decision).toBe('deny');

      const editGit = await evaluate(
        { id: 'git-f3', name: 'edit_file', input: { path: '.git', old_string: 'gitdir', new_string: 'evil' } },
        ctx,
        policy
      );
      expect(editGit.decision).toBe('deny');
    });

    it('denies read, write, edit on ".git/hooks/x"', async () => {
      const readHook = await evaluate(
        { id: 'git-h1', name: 'read_file', input: { path: '.git/hooks/x' } },
        ctx,
        policy
      );
      expect(readHook.decision).toBe('deny');

      const writeHook = await evaluate(
        { id: 'git-h2', name: 'write_file', input: { path: '.git/hooks/x', content: 'evil' } },
        ctx,
        policy
      );
      expect(writeHook.decision).toBe('deny');

      const editHook = await evaluate(
        { id: 'git-h3', name: 'edit_file', input: { path: '.git/hooks/x', old_string: 'a', new_string: 'b' } },
        ctx,
        policy
      );
      expect(editHook.decision).toBe('deny');
    });

    it('denies case variants ".GIT" and ".Git/hooks/x"', async () => {
      const readGitUpper = await evaluate(
        { id: 'git-u1', name: 'read_file', input: { path: '.GIT' } },
        ctx,
        policy
      );
      expect(readGitUpper.decision).toBe('deny');

      const writeGitUpper = await evaluate(
        { id: 'git-u2', name: 'write_file', input: { path: '.GIT', content: 'evil' } },
        ctx,
        policy
      );
      expect(writeGitUpper.decision).toBe('deny');

      const readGitMixed = await evaluate(
        { id: 'git-m1', name: 'read_file', input: { path: '.Git/hooks/x' } },
        ctx,
        policy
      );
      expect(readGitMixed.decision).toBe('deny');

      const writeGitMixed = await evaluate(
        { id: 'git-m2', name: 'write_file', input: { path: '.Git/hooks/x', content: 'evil' } },
        ctx,
        policy
      );
      expect(writeGitMixed.decision).toBe('deny');
    });
  });

  describe('Requirement 4: Case and Unicode normalization', () => {
    it('denies case-insensitive protected files (".ENV", ".Env.local", "KEY.PEM")', async () => {
      const envRes = await evaluate(
        { id: 'c-env1', name: 'read_file', input: { path: '.ENV' } },
        ctx,
        policy
      );
      expect(envRes.decision).toBe('deny');

      const envLocalRes = await evaluate(
        { id: 'c-env2', name: 'read_file', input: { path: '.Env.local' } },
        ctx,
        policy
      );
      expect(envLocalRes.decision).toBe('deny');

      const keyPemRes = await evaluate(
        { id: 'c-pem', name: 'read_file', input: { path: 'KEY.PEM' } },
        ctx,
        policy
      );
      expect(keyPemRes.decision).toBe('deny');
    });

    it('returns ASK for writes to case-insensitive ".GitHub/workflows/ci.yml" and ".NPMRC"', async () => {
      const ghRes = await evaluate(
        { id: 'c-gh', name: 'write_file', input: { path: '.GitHub/workflows/ci.yml', content: 'evil' } },
        ctx,
        policy
      );
      expect(ghRes.decision).toBe('ask');

      const npmrcRes = await evaluate(
        { id: 'c-npmrc', name: 'write_file', input: { path: '.NPMRC', content: 'evil' } },
        ctx,
        policy
      );
      expect(npmrcRes.decision).toBe('deny');
    });

    it('denies reading ctx.policyFile case-insensitively and returns ask for writing "policy/Default.Policy.yaml"', async () => {
      const polReadRes = await evaluate(
        { id: 'c-pol-read', name: 'read_file', input: { path: policyFile.replace('default.policy', 'Default.Policy') } },
        ctx,
        policy
      );
      expect(polReadRes.decision).toBe('deny');

      const polWriteRes = await evaluate(
        { id: 'c-pol-write', name: 'write_file', input: { path: 'policy/Default.Policy.yaml', content: 'version: "1.0"' } },
        ctx,
        policy
      );
      expect(polWriteRes.decision).toBe('ask');
    });

    it('normalizes slashes ("./", "//", trailing slashes) and NFC/NFD unicode', async () => {
      const slashEnv = await evaluate(
        { id: 'u-sl1', name: 'read_file', input: { path: './/.ENV' } },
        ctx,
        policy
      );
      expect(slashEnv.decision).toBe('deny');

      const dotSlashEnv = await evaluate(
        { id: 'u-sl2', name: 'read_file', input: { path: './.Env.local' } },
        ctx,
        policy
      );
      expect(dotSlashEnv.decision).toBe('deny');

      // Unicode NFC vs NFD
      const nfcPath = '.ENV'.normalize('NFC');
      const nfdPath = '.ENV'.normalize('NFD');
      const nfcRes = await evaluate(
        { id: 'u-nfc', name: 'read_file', input: { path: nfcPath } },
        ctx,
        policy
      );
      expect(nfcRes.decision).toBe('deny');

      const nfdRes = await evaluate(
        { id: 'u-nfd', name: 'read_file', input: { path: nfdPath } },
        ctx,
        policy
      );
      expect(nfdRes.decision).toBe('deny');
    });
  });

  describe('Requirement 5: run_command hardening', () => {
    describe('node command', () => {
      it('allows "node <path inside workspace>"', async () => {
        const res = await evaluate(
          { id: 'node-ok', name: 'run_command', input: { argv: ['node', 'src/foo.ts'] } },
          ctx,
          policy
        );
        expect(res.decision).toBe('allow');
      });

      it('denies flags before script path (-e, --eval, -p, --print, --input-type, -r, --require, --import, etc.)', async () => {
        const flagTricks = [
          ['node', '-e', 'console.log(1)'],
          ['node', '--eval', 'console.log(1)'],
          ['node', '-p', '1+1'],
          ['node', '--print', '1+1'],
          ['node', '--input-type=module', '-e', 'console.log(1)'],
          ['node', '-r', './evil.js', 'src/foo.ts'],
          ['node', '--require', './evil.js', 'src/foo.ts'],
          ['node', '--import', './evil.js', 'src/foo.ts'],
          ['node', '--expose-internals', 'src/foo.ts'],
        ];

        for (const argv of flagTricks) {
          const res = await evaluate(
            { id: 'node-flag', name: 'run_command', input: { argv } },
            ctx,
            policy
          );
          expect(res.decision).toBe('deny');
        }
      });

      it('denies node running script pointing outside workspace', async () => {
        const res = await evaluate(
          { id: 'node-out', name: 'run_command', input: { argv: ['node', '/etc/passwd'] } },
          ctx,
          policy
        );
        expect(res.decision).toBe('deny');
      });
    });

    describe('git command removed entirely', () => {
      it('denies git status, git diff, git add, git commit, git log', async () => {
        const gitCmds = [
          ['git', 'status'],
          ['git', 'diff'],
          ['git', 'add', '.'],
          ['git', 'commit', '-m', 'test'],
          ['git', 'log'],
          ['git', 'checkout', '-b', 'feat'],
        ];

        for (const argv of gitCmds) {
          const res = await evaluate(
            { id: 'git-denied', name: 'run_command', input: { argv } },
            ctx,
            policy
          );
          expect(res.decision).toBe('deny');
        }
      });
    });

    describe('package managers strict allowlist', () => {
      it('allows exactly [pnpm|npm|yarn] test | run test | run lint | run typecheck | run build', async () => {
        const allowed = [
          ['pnpm', 'test'],
          ['npm', 'test'],
          ['yarn', 'test'],
          ['pnpm', 'run', 'test'],
          ['npm', 'run', 'test'],
          ['yarn', 'run', 'test'],
          ['pnpm', 'run', 'lint'],
          ['npm', 'run', 'lint'],
          ['yarn', 'run', 'lint'],
          ['pnpm', 'run', 'typecheck'],
          ['npm', 'run', 'typecheck'],
          ['yarn', 'run', 'typecheck'],
          ['pnpm', 'run', 'build'],
          ['npm', 'run', 'build'],
          ['yarn', 'run', 'build'],
        ];

        for (const argv of allowed) {
          const res = await evaluate(
            { id: 'pkg-ok', name: 'run_command', input: { argv } },
            ctx,
            policy
          );
          expect(res.decision).toBe('allow');
        }
      });

      it('denies pnpm exec, pnpm dlx, npx, and run <other>', async () => {
        const denied = [
          ['pnpm', 'exec', 'tsx', 'evil.ts'],
          ['pnpm', 'dlx', 'create-react-app'],
          ['npx', 'vitest'],
          ['pnpm', 'run', 'evil'],
          ['npm', 'run', 'deploy'],
          ['yarn', 'run', 'clean'],
        ];

        for (const argv of denied) {
          const res = await evaluate(
            { id: 'pkg-deny', name: 'run_command', input: { argv } },
            ctx,
            policy
          );
          expect(res.decision).toBe('deny');
        }
      });

      it('denies package manager flags (-C, --dir, --prefix, --registry, --config)', async () => {
        const flagCases = [
          ['pnpm', 'test', '-C', '/tmp'],
          ['pnpm', 'test', '--dir', '/tmp'],
          ['npm', 'test', '--prefix', '/tmp'],
          ['pnpm', 'test', '--registry', 'http://evil.com'],
          ['npm', 'test', '--config', '/tmp/npm.cfg'],
        ];

        for (const argv of flagCases) {
          const res = await evaluate(
            { id: 'pkg-flag-deny', name: 'run_command', input: { argv } },
            ctx,
            policy
          );
          expect(res.decision).toBe('deny');
        }
      });
    });

    describe('tsc/vitest/eslint config and out path boundaries', () => {
      it('denies --config, -c, -p, --outDir, --outFile pointing outside workspace', async () => {
        const outCases = [
          ['tsc', '-p', '/outside/tsconfig.json'],
          ['tsc', '--outDir', '/outside/dist'],
          ['tsc', '--outFile', '/outside/bundle.js'],
          ['vitest', '-c', '/outside/vitest.config.ts'],
          ['vitest', '--config', '/outside/vitest.config.ts'],
          ['eslint', '-c', '/outside/.eslintrc.json'],
          ['eslint', '--config', '/outside/.eslintrc.json'],
        ];

        for (const argv of outCases) {
          const res = await evaluate(
            { id: 'tool-out', name: 'run_command', input: { argv } },
            ctx,
            policy
          );
          expect(res.decision).toBe('deny');
        }
      });

      it('allows tsc/vitest/eslint with local/safe paths', async () => {
        const safeCases = [
          ['tsc', '--noEmit'],
          ['tsc', '-p', 'tsconfig.json'],
          ['vitest', 'run'],
          ['eslint', '.'],
        ];

        for (const argv of safeCases) {
          const res = await evaluate(
            { id: 'tool-safe', name: 'run_command', input: { argv } },
            ctx,
            policy
          );
          expect(res.decision).toBe('allow');
        }
      });
    });

    describe('argv character and length constraints', () => {
      it('denies argv elements containing NUL or newline', async () => {
        const badArgv = [
          ['node', 'src/foo\0.ts'],
          ['node', 'src/foo\n.ts'],
          ['node', 'src/foo\r.ts'],
        ];

        for (const argv of badArgv) {
          const res = await evaluate(
            { id: 'bad-char', name: 'run_command', input: { argv } },
            ctx,
            policy
          );
          expect(res.decision).toBe('deny');
        }
      });

      it('denies argv elements longer than 4KB', async () => {
        const longArg = 'a'.repeat(4097);
        const res = await evaluate(
          { id: 'long-arg', name: 'run_command', input: { argv: ['node', 'src/foo.ts', longArg] } },
          ctx,
          policy
        );
        expect(res.decision).toBe('deny');
      });
    });
  });

  describe('Requirement 6: File tools path and content size limits', () => {
    it('denies paths longer than 1KB (1024 chars)', async () => {
      const longPath = 'src/' + 'a'.repeat(1025) + '.ts';
      const res = await evaluate(
        { id: 'long-path', name: 'read_file', input: { path: longPath } },
        ctx,
        policy
      );
      expect(res.decision).toBe('deny');
      expect(res.reason).toMatch(/path.*length|limit|1024/i);
    });

    it('denies paths containing NUL character', async () => {
      const res = await evaluate(
        { id: 'nul-path', name: 'read_file', input: { path: 'src/foo\0.ts' } },
        ctx,
        policy
      );
      expect(res.decision).toBe('deny');
      expect(res.reason).toMatch(/null|nul/i);
    });

    it('denies write_file and edit_file content over 1MB', async () => {
      const hugeContent = 'x'.repeat(1024 * 1024 + 1);
      const writeRes = await evaluate(
        { id: 'huge-w', name: 'write_file', input: { path: 'src/huge.ts', content: hugeContent } },
        ctx,
        policy
      );
      expect(writeRes.decision).toBe('deny');

      const editRes = await evaluate(
        {
          id: 'huge-e',
          name: 'edit_file',
          input: { path: 'src/foo.ts', old_string: 'foo = 1', new_string: hugeContent },
        },
        ctx,
        policy
      );
      expect(editRes.decision).toBe('deny');
    });
  });

  describe('Limits & Policy Validation', () => {
    it('denies call when task call count limit is exceeded', async () => {
      const limitedCtx: PolicyContext = {
        ...ctx,
        callCount: 101,
        maxCallsPerTask: 100,
      };

      const res = await evaluate(
        { id: 'limit-test', name: 'read_file', input: { path: 'src/foo.ts' } },
        limitedCtx,
        policy
      );
      expect(res.decision).toBe('deny');
      expect(res.reason).toMatch(/call count|limit/i);
    });

    it('refuses to start / throws on invalid policy file', () => {
      const invalidPolicyPath = path.join(tempDir, 'invalid-policy.yaml');
      fs.writeFileSync(invalidPolicyPath, 'foo: bar\nversion: [not a valid policy]');

      expect(() => loadPolicy(invalidPolicyPath)).toThrow();
    });
  });

  describe('PolicyGate Wiring & Audit / Approval Logging', () => {
    it('creates approval row for ASK and logs ask/deny to auditLog and taskSteps', async () => {
      const mockAuditLog: unknown[] = [];
      const mockTaskSteps: unknown[] = [];
      const mockApprovals: Record<string, unknown>[] = [];

      const mockDb = {
        insert: (table: { [key: symbol]: unknown }) => ({
          values: (data: Record<string, unknown>) => {
            const tableName = table[Symbol.for('drizzle:Name')] as string | undefined;
            if (tableName === 'audit_log') {
              mockAuditLog.push(data);
            } else if (tableName === 'task_steps') {
              mockTaskSteps.push(data);
            } else if (tableName === 'approvals') {
              mockApprovals.push(data);
            }
            return {
              returning: async () => [data],
            };
          },
        }),
      } as unknown as Parameters<typeof createApproval>[0];

      const gate = new PolicyGate({
        policy,
        ctx: { ...ctx, taskId: 'task-123' },
        db: mockDb,
        recordTaskStep: true,
      });

      // 1. Evaluate an ASK command (dependency add)
      const askDecision = await gate.evaluate({
        id: 'c1',
        name: 'run_command',
        input: { argv: ['pnpm', 'add', 'axios'] },
      });
      expect(askDecision.action).toBe('ask');
      expect(mockApprovals.length).toBe(1);
      expect(mockApprovals[0].kind).toBe('tool_call');
      expect(mockApprovals[0].taskId).toBe('task-123');
      expect(mockAuditLog.length).toBe(1);
      // PolicyGate persistence is audit_log and approvals only; task_steps is written only by loop
      expect(mockTaskSteps.length).toBe(0);

      // 2. Evaluate a DENY command (curl)
      const denyDecision = await gate.evaluate({
        id: 'c2',
        name: 'run_command',
        input: { argv: ['curl', 'http://example.com'] },
      });
      expect(denyDecision.action).toBe('deny');
      expect(mockAuditLog.length).toBe(2);
      expect(mockTaskSteps.length).toBe(0);

      // 3. Evaluate an ALLOW command (pnpm test)
      const allowDecision = await gate.evaluate({
        id: 'c3',
        name: 'run_command',
        input: { argv: ['pnpm', 'test'] },
      });
      expect(allowDecision.action).toBe('allow');
    });
  });
});
