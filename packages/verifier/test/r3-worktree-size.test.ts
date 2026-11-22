import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { checkWorktreeSize } from '../src/index.js';

/**
 * Round 3, item 10: the limit is injectable, .git counts, and the early exit is proven by
 * the number of entries visited rather than by timing.
 *
 * New file: no existing test is modified.
 */
describe('Worktree size round 3', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-r3-size-'));
  });

  afterEach(() => {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it('a committed blob inside .git over the injected limit fails and is reported as a lower bound', async () => {
    const objects = path.join(tempDir, '.git', 'objects', 'pack');
    fs.mkdirSync(objects, { recursive: true });
    fs.writeFileSync(path.join(objects, 'pack-big.pack'), Buffer.alloc(80 * 1024, 'p'));
    fs.writeFileSync(path.join(tempDir, 'small.txt'), 'hello\n');

    const result = await checkWorktreeSize(tempDir, 40 * 1024);

    expect(result.passed).toBe(false);
    expect(result.earlyExit).toBe(true);
    expect(result.limitBytes).toBe(40 * 1024);
  });

  it('stops walking as soon as the limit is exceeded: entriesVisited stays far below the tree size', async () => {
    // One oversized file first, then 400 more entries that must never be visited.
    fs.writeFileSync(path.join(tempDir, '0000-big.bin'), Buffer.alloc(64 * 1024, 'b'));
    for (let i = 1; i <= 400; i++) {
      fs.writeFileSync(path.join(tempDir, `${String(i).padStart(4, '0')}-tiny.txt`), 'x');
    }

    const visited: string[] = [];
    const result = await checkWorktreeSize(tempDir, 32 * 1024, {
      onVisit: (p) => visited.push(p),
    });

    expect(result.passed).toBe(false);
    expect(result.earlyExit).toBe(true);
    expect(result.entriesVisited).toBe(visited.length);
    // readdir returns sorted names, so the oversized file is the first entry and the walk
    // must stop right there rather than stat'ing all 401.
    expect(result.entriesVisited).toBeLessThan(10);
  });

  it('a tree under the limit is walked in full and reports no early exit', async () => {
    for (let i = 0; i < 20; i++) {
      fs.writeFileSync(path.join(tempDir, `f${i}.txt`), 'x'.repeat(100));
    }

    const result = await checkWorktreeSize(tempDir, 1024 * 1024);

    expect(result.passed).toBe(true);
    expect(result.earlyExit).toBe(false);
    expect(result.entriesVisited).toBe(20);
  });
});
