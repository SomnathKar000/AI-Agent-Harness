import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { checkWorktreeSize } from '../src/index.js';

describe('Worktree Size Checks', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-wt-size-test-'));
  });

  afterEach(() => {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it('FAIL: when worktree exceeds configured size limit', async () => {
    // Write 200KB file, limit set to 100KB
    const buffer = Buffer.alloc(200 * 1024, 'a');
    fs.writeFileSync(path.join(tempDir, 'large.bin'), buffer);

    const result = await checkWorktreeSize(tempDir, 100 * 1024);
    expect(result.passed).toBe(false);
    expect(result.sizeBytes).toBeGreaterThanOrEqual(200 * 1024);
    expect(result.limitBytes).toBe(100 * 1024);
  });

  it('PASS (control): when worktree is within size limit', async () => {
    const buffer = Buffer.alloc(50 * 1024, 'a');
    fs.writeFileSync(path.join(tempDir, 'small.bin'), buffer);

    const result = await checkWorktreeSize(tempDir, 100 * 1024);
    expect(result.passed).toBe(true);
    expect(result.sizeBytes).toBeLessThan(100 * 1024);
  });

  it('FAIL: oversized content inside .git fails (does not exclude .git)', async () => {
    const gitDir = path.join(tempDir, '.git');
    fs.mkdirSync(gitDir, { recursive: true });
    const buffer = Buffer.alloc(200 * 1024, 'g');
    fs.writeFileSync(path.join(gitDir, 'large-blob.pack'), buffer);

    const result = await checkWorktreeSize(tempDir, 100 * 1024);
    expect(result.passed).toBe(false);
    expect(result.sizeBytes).toBeGreaterThanOrEqual(200 * 1024);
  });
});
