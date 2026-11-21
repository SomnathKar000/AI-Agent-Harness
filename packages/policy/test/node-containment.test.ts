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

describe('Item 2: Node script containment with resolveReal', () => {
  let tempDir: string;
  let policyFile: string;
  let policy: PolicyConfig;
  let ctx: PolicyContext;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'node-containment-ws-'));
    fs.mkdirSync(path.join(tempDir, 'src'), { recursive: true });
    fs.writeFileSync(path.join(tempDir, 'src', 'ok.js'), 'console.log("ok");\n');
    fs.writeFileSync(path.join(tempDir, 'src', 'inner.js'), 'console.log("inner");\n');

    // Create sub -> src symlink inside workspace
    fs.symlinkSync(path.join(tempDir, 'src'), path.join(tempDir, 'sub'));

    // Create link.js -> /etc/hosts (outside workspace)
    fs.symlinkSync('/etc/hosts', path.join(tempDir, 'link.js'));

    policyFile = path.resolve(import.meta.dirname, '../../../policy/default.policy.yaml');
    policy = loadPolicy(policyFile);

    ctx = {
      workspaceRoot: tempDir,
      taskId: 'node-containment-task',
      policyFile,
      auditLocations: [path.join(tempDir, 'audit_log.db')],
      callCount: 1,
    };
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('denies node running a symlink that points outside the workspace (link.js -> /etc/hosts)', async () => {
    const res = await evaluate(
      {
        id: 'node-symlink-escape',
        name: 'run_command',
        input: { argv: ['node', 'link.js'] },
      },
      ctx,
      policy
    );

    expect(res.decision).toBe('deny');
    expect(res.rule).toBe('node_script_outside_workspace');
  });

  it('allows node running a normal script inside the workspace (node src/ok.js)', async () => {
    const res = await evaluate(
      {
        id: 'node-control-ok',
        name: 'run_command',
        input: { argv: ['node', 'src/ok.js'] },
      },
      ctx,
      policy
    );

    expect(res.decision).toBe('allow');
    expect(res.rule).toBe('node_allow');
  });

  it('allows node running a script through an internal directory symlink (node sub/inner.js where sub -> src)', async () => {
    const res = await evaluate(
      {
        id: 'node-control-sub',
        name: 'run_command',
        input: { argv: ['node', 'sub/inner.js'] },
      },
      ctx,
      policy
    );

    expect(res.decision).toBe('allow');
    expect(res.rule).toBe('node_allow');
  });
});
