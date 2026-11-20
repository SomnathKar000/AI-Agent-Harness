import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  evaluate,
  loadPolicy,
  type PolicyConfig,
  type PolicyContext,
} from '../src/index.js';
import * as policyModule from '../src/index.js';

describe('Phase 4 Hardening Round 4: Lockfile Ordering & Containment', () => {
  let tempDir: string;
  let policyFile: string;
  let policy: PolicyConfig;
  let ctx: PolicyContext;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'policy-r4-ws-'));

    fs.mkdirSync(path.join(tempDir, 'src'), { recursive: true });
    fs.mkdirSync(path.join(tempDir, '.github', 'workflows'), { recursive: true });
    fs.mkdirSync(path.join(tempDir, '.git'), { recursive: true });

    // d -> .github
    try {
      fs.symlinkSync('.github', path.join(tempDir, 'd'), 'dir');
    } catch {
      // ignore
    }

    // .env
    fs.writeFileSync(path.join(tempDir, '.env'), 'SECRET=canary-7f3a9\n');

    // symlink yarn.lock -> .env
    try {
      fs.symlinkSync('.env', path.join(tempDir, 'yarn.lock'));
    } catch {
      // ignore
    }

    policyFile = path.resolve(import.meta.dirname, '../../../policy/default.policy.yaml');
    policy = loadPolicy(policyFile);

    ctx = {
      workspaceRoot: tempDir,
      taskId: 'test-task-r4',
      policyFile,
      auditLocations: [path.join(tempDir, 'audit_log.db')],
      callCount: 1,
    };
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  describe('Item 1: Lockfile Ordering Bug', () => {
    it('write ".github/workflows/package-lock.json" -> ask', async () => {
      const res = await evaluate(
        {
          id: '1',
          name: 'write_file',
          input: { path: '.github/workflows/package-lock.json', content: '{}' },
        },
        ctx,
        policy
      );
      expect(res.decision).toBe('ask');
    });

    it('write ".git/yarn.lock" -> deny', async () => {
      const res = await evaluate(
        {
          id: '2',
          name: 'write_file',
          input: { path: '.git/yarn.lock', content: '' },
        },
        ctx,
        policy
      );
      expect(res.decision).toBe('deny');
    });

    it('symlink yarn.lock -> .env: write AND read both deny', async () => {
      const writeRes = await evaluate(
        {
          id: '3-w',
          name: 'write_file',
          input: { path: 'yarn.lock', content: 'hacked' },
        },
        ctx,
        policy
      );
      expect(writeRes.decision).toBe('deny');

      const readRes = await evaluate(
        {
          id: '3-r',
          name: 'read_file',
          input: { path: 'yarn.lock' },
        },
        ctx,
        policy
      );
      expect(readRes.decision).toBe('deny');
    });

    it('d -> .github, write "d/pnpm-lock.yaml" -> ask', async () => {
      const res = await evaluate(
        {
          id: '4',
          name: 'write_file',
          input: { path: 'd/pnpm-lock.yaml', content: 'lockfile data' },
        },
        ctx,
        policy
      );
      expect(res.decision).toBe('ask');
    });

    it('plain "pnpm-lock.yaml" write -> allow with flag lockfile_edit', async () => {
      const res = await evaluate(
        {
          id: '5',
          name: 'write_file',
          input: { path: 'pnpm-lock.yaml', content: 'lockfile data' },
        },
        ctx,
        policy
      );
      expect(res.decision).toBe('allow');
      expect((res as any).flag).toBe('lockfile_edit');
    });
  });

  describe('Item 2: Containment Helper isInside', () => {
    it('exports isInside helper', () => {
      const isInside = (policyModule as any).isInside;
      expect(typeof isInside).toBe('function');
    });

    it('write "..notes.md" inside the workspace is allowed', async () => {
      const res = await evaluate(
        {
          id: 'c-1',
          name: 'write_file',
          input: { path: '..notes.md', content: 'some notes' },
        },
        ctx,
        policy
      );
      expect(res.decision).toBe('allow');
    });

    it('"../x" and "a/../../x" are denied', async () => {
      const res1 = await evaluate(
        {
          id: 'c-2',
          name: 'write_file',
          input: { path: '../x', content: 'outside' },
        },
        ctx,
        policy
      );
      expect(res1.decision).toBe('deny');

      const res2 = await evaluate(
        {
          id: 'c-3',
          name: 'write_file',
          input: { path: 'src/../../x', content: 'outside' },
        },
        ctx,
        policy
      );
      expect(res2.decision).toBe('deny');
    });
  });
});
