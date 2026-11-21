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

describe('Item 4: File tools fail closed on missing or wrong-typed field', () => {
  let tempDir: string;
  let policyFile: string;
  let policy: PolicyConfig;
  let ctx: PolicyContext;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'input-val-ws-'));
    fs.mkdirSync(path.join(tempDir, 'src'), { recursive: true });
    fs.writeFileSync(path.join(tempDir, 'src', 'app.ts'), 'export const x = 1;\n');

    policyFile = path.resolve(import.meta.dirname, '../../../policy/default.policy.yaml');
    policy = loadPolicy(policyFile);

    ctx = {
      workspaceRoot: tempDir,
      taskId: 'val-test-task',
      policyFile,
      auditLocations: [path.join(tempDir, 'audit_log.db')],
      callCount: 1,
    };
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('write_file with no path at all is denied with rule invalid_input', async () => {
    const res = await evaluate(
      {
        id: 'w-no-path',
        name: 'write_file',
        input: { content: 'hello' },
      },
      ctx,
      policy
    );

    expect(res.decision).toBe('deny');
    expect(res.rule).toBe('invalid_input');
  });

  it('write_file with non-string content is denied with rule invalid_input', async () => {
    const res = await evaluate(
      {
        id: 'w-num-content',
        name: 'write_file',
        input: { path: 'src/out.txt', content: 12345 as any },
      },
      ctx,
      policy
    );

    expect(res.decision).toBe('deny');
    expect(res.rule).toBe('invalid_input');
  });

  it('read_file with missing path is denied with rule invalid_input', async () => {
    const res = await evaluate(
      {
        id: 'r-no-path',
        name: 'read_file',
        input: {},
      },
      ctx,
      policy
    );

    expect(res.decision).toBe('deny');
    expect(res.rule).toBe('invalid_input');
  });

  it('read_file with non-string path is denied with rule invalid_input', async () => {
    const res = await evaluate(
      {
        id: 'r-num-path',
        name: 'read_file',
        input: { path: 999 as any },
      },
      ctx,
      policy
    );

    expect(res.decision).toBe('deny');
    expect(res.rule).toBe('invalid_input');
  });

  it('edit_file with missing old_string or new_string is denied with rule invalid_input', async () => {
    const res = await evaluate(
      {
        id: 'e-missing-old',
        name: 'edit_file',
        input: { path: 'src/app.ts', new_string: 'const y = 2;' },
      },
      ctx,
      policy
    );

    expect(res.decision).toBe('deny');
    expect(res.rule).toBe('invalid_input');
  });

  it('edit_file with non-string new_string is denied with rule invalid_input', async () => {
    const res = await evaluate(
      {
        id: 'e-num-new',
        name: 'edit_file',
        input: { path: 'src/app.ts', old_string: 'export const x = 1;', new_string: 123 as any },
      },
      ctx,
      policy
    );

    expect(res.decision).toBe('deny');
    expect(res.rule).toBe('invalid_input');
  });

  it('list_dir with non-string path is denied with rule invalid_input', async () => {
    const res = await evaluate(
      {
        id: 'l-num-path',
        name: 'list_dir',
        input: { path: ['invalid'] as any },
      },
      ctx,
      policy
    );

    expect(res.decision).toBe('deny');
    expect(res.rule).toBe('invalid_input');
  });

  it('grep with missing pattern is denied with rule invalid_input', async () => {
    const res = await evaluate(
      {
        id: 'g-no-pattern',
        name: 'grep',
        input: { path: '.' },
      },
      ctx,
      policy
    );

    expect(res.decision).toBe('deny');
    expect(res.rule).toBe('invalid_input');
  });
});
