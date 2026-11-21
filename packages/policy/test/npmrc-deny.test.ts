import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  evaluate,
  loadPolicy,
  PolicyGate,
  type PolicyConfig,
  type PolicyContext,
} from '../src/index.js';

describe('Item 6: Deny reads and writes of .npmrc on all operations', () => {
  let tempDir: string;
  let policyFile: string;
  let policy: PolicyConfig;
  let ctx: PolicyContext;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'npmrc-deny-ws-'));
    fs.writeFileSync(
      path.join(tempDir, '.npmrc'),
      '//registry.npmjs.org/:_authToken=npm_secret_auth_token_12345\n'
    );
    fs.mkdirSync(path.join(tempDir, 'sub'), { recursive: true });
    fs.writeFileSync(
      path.join(tempDir, 'sub', '.npmrc'),
      '//registry.npmjs.org/:_authToken=sub_secret_token_12345\n'
    );

    policyFile = path.resolve(import.meta.dirname, '../../../policy/default.policy.yaml');
    policy = loadPolicy(policyFile);

    ctx = {
      workspaceRoot: tempDir,
      taskId: 'npmrc-deny-task',
      policyFile,
      auditLocations: [path.join(tempDir, 'audit_log.db')],
      callCount: 1,
    };
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('denies read_file on .npmrc at root and at depth', async () => {
    const resRoot = await evaluate(
      { id: 'r-npmrc', name: 'read_file', input: { path: '.npmrc' } },
      ctx,
      policy
    );
    expect(resRoot.decision).toBe('deny');
    expect(resRoot.rule).toBe('npmrc_deny');

    const resSub = await evaluate(
      { id: 'r-sub-npmrc', name: 'read_file', input: { path: 'sub/.npmrc' } },
      ctx,
      policy
    );
    expect(resSub.decision).toBe('deny');
    expect(resSub.rule).toBe('npmrc_deny');
  });

  it('denies write_file and edit_file on .npmrc (deny, not ask)', async () => {
    const resWrite = await evaluate(
      {
        id: 'w-npmrc',
        name: 'write_file',
        input: { path: '.npmrc', content: 'registry=https://registry.npmjs.org/' },
      },
      ctx,
      policy
    );
    expect(resWrite.decision).toBe('deny');
    expect(resWrite.rule).toBe('npmrc_deny');

    const resEdit = await evaluate(
      {
        id: 'e-npmrc',
        name: 'edit_file',
        input: { path: '.npmrc', old_string: 'auth', new_string: 'none' },
      },
      ctx,
      policy
    );
    expect(resEdit.decision).toBe('deny');
    expect(resEdit.rule).toBe('npmrc_deny');
  });

  it('gate.redact drops grep match lines from .npmrc', () => {
    const gate = new PolicyGate({
      ctx,
      policy,
    });

    const rawGrepOutput = [
      '.npmrc:1://registry.npmjs.org/:_authToken=npm_secret_auth_token_12345',
      'src/main.ts:1:console.log("hello");',
      'sub/.npmrc:1://registry.npmjs.org/:_authToken=sub_secret_token_12345',
    ].join('\n');

    const redacted = gate.redact(
      { id: 'call_grep', name: 'grep', input: { pattern: 'authToken' } },
      rawGrepOutput
    );

    expect(redacted).not.toContain('.npmrc');
    expect(redacted).not.toContain('npm_secret_auth_token_12345');
    expect(redacted).toContain('src/main.ts:1:console.log("hello");');
  });
});
