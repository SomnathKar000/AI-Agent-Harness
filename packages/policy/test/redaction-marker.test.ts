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

describe('Item 3: Redaction Marker Safety', () => {
  let tempDir: string;
  let policyFile: string;
  let policy: PolicyConfig;
  let ctx: PolicyContext;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'policy-redaction-ws-'));
    fs.mkdirSync(path.join(tempDir, 'src'), { recursive: true });
    fs.writeFileSync(path.join(tempDir, 'src', 'app.ts'), 'export const x = 1;\n');

    policyFile = path.resolve(import.meta.dirname, '../../../policy/default.policy.yaml');
    policy = loadPolicy(policyFile);

    ctx = {
      workspaceRoot: tempDir,
      taskId: 'redaction-test-task',
      policyFile,
      auditLocations: [path.join(tempDir, 'audit_log.db')],
      callCount: 1,
    };
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('denies write_file when content contains "[REDACTED]" with rule redaction_marker_deny', async () => {
    const res = await evaluate(
      {
        id: 'w-redact',
        name: 'write_file',
        input: { path: 'src/output.txt', content: 'Here is the key: [REDACTED]' },
      },
      ctx,
      policy
    );

    expect(res.decision).toBe('deny');
    expect(res.rule).toBe('redaction_marker_deny');
    expect(res.reason).toMatch(/re-read the file via a path that is not masked or to ask for help/i);
  });

  it('denies edit_file when new_string contains "[REDACTED]" with rule redaction_marker_deny', async () => {
    const res = await evaluate(
      {
        id: 'e-redact-new',
        name: 'edit_file',
        input: {
          path: 'src/app.ts',
          old_string: 'export const x = 1;',
          new_string: 'export const x = "[REDACTED]";',
        },
      },
      ctx,
      policy
    );

    expect(res.decision).toBe('deny');
    expect(res.rule).toBe('redaction_marker_deny');
    expect(res.reason).toMatch(/re-read the file via a path that is not masked or to ask for help/i);
  });

  it('denies edit_file when old_string contains "[REDACTED]" with rule redaction_marker_deny', async () => {
    const res = await evaluate(
      {
        id: 'e-redact-old',
        name: 'edit_file',
        input: {
          path: 'src/app.ts',
          old_string: 'const secret = "[REDACTED]";',
          new_string: 'const secret = "fixed";',
        },
      },
      ctx,
      policy
    );

    expect(res.decision).toBe('deny');
    expect(res.rule).toBe('redaction_marker_deny');
    expect(res.reason).toMatch(/re-read the file via a path that is not masked or to ask for help/i);
  });

  it('allows write_file and edit_file without "[REDACTED]"', async () => {
    const writeRes = await evaluate(
      {
        id: 'w-ok',
        name: 'write_file',
        input: { path: 'src/valid.txt', content: 'Normal unredacted content' },
      },
      ctx,
      policy
    );
    expect(writeRes.decision).toBe('allow');

    const editRes = await evaluate(
      {
        id: 'e-ok',
        name: 'edit_file',
        input: {
          path: 'src/app.ts',
          old_string: 'export const x = 1;',
          new_string: 'export const x = 2;',
        },
      },
      ctx,
      policy
    );
    expect(editRes.decision).toBe('allow');
  });

  it('allows read_file on a file containing "[REDACTED]"', async () => {
    fs.writeFileSync(path.join(tempDir, 'src', 'redacted.txt'), 'Here is content: [REDACTED]\n');
    const readRes = await evaluate(
      {
        id: 'r-redacted',
        name: 'read_file',
        input: { path: 'src/redacted.txt' },
      },
      ctx,
      policy
    );
    expect(readRes.decision).toBe('allow');
    expect(readRes.rule).toBe('file_allow');
  });

  it('deny reason explicitly names the concrete next step for the model: "Re-read the file via a path that is not masked or to ask for help"', async () => {
    const res = await evaluate(
      {
        id: 'w-redact-step',
        name: 'write_file',
        input: { path: 'src/output.txt', content: 'Secret: [REDACTED]' },
      },
      ctx,
      policy
    );
    expect(res.decision).toBe('deny');
    expect(res.rule).toBe('redaction_marker_deny');
    expect(res.reason).toContain('Re-read the file via a path that is not masked or to ask for help');
  });
});
