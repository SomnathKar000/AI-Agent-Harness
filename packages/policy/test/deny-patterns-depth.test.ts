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

describe('Item 5: Deny Patterns at Depth (Read and Write)', () => {
  let tempDir: string;
  let policyFile: string;
  let policy: PolicyConfig;
  let ctx: PolicyContext;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'policy-deny-depth-ws-'));

    // Create directories at depth
    fs.mkdirSync(path.join(tempDir, 'foo', 'bar'), { recursive: true });
    fs.mkdirSync(path.join(tempDir, 'a', 'b'), { recursive: true });
    fs.mkdirSync(path.join(tempDir, 'sub', 'dir'), { recursive: true });
    fs.mkdirSync(path.join(tempDir, 'infra', '.aws'), { recursive: true });
    fs.mkdirSync(path.join(tempDir, 'docker', '.docker'), { recursive: true });
    fs.mkdirSync(path.join(tempDir, 'envs'), { recursive: true });
    fs.mkdirSync(path.join(tempDir, 'certs'), { recursive: true });
    fs.mkdirSync(path.join(tempDir, 'sec'), { recursive: true });
    fs.mkdirSync(path.join(tempDir, 'auth'), { recursive: true });

    // Create files at depth
    fs.writeFileSync(path.join(tempDir, 'foo', 'bar', '.netrc'), 'machine gitlab.com\n');
    fs.writeFileSync(path.join(tempDir, 'a', 'b', '.git-credentials'), 'https://user:pass@github.com\n');
    fs.writeFileSync(path.join(tempDir, 'sub', 'dir', '.pypirc'), '[pypi]\npassword=secret\n');
    fs.writeFileSync(path.join(tempDir, 'infra', '.aws', 'credentials'), '[default]\naws_secret=abc\n');
    fs.writeFileSync(path.join(tempDir, 'docker', '.docker', 'config.json'), '{"auths":{}}\n');
    fs.writeFileSync(path.join(tempDir, 'envs', 'prod.tfvars'), 'secret_token="xyz"\n');
    fs.writeFileSync(path.join(tempDir, 'certs', 'keystore.jks'), 'binaryjks');
    fs.writeFileSync(path.join(tempDir, 'sec', 'app.keystore'), 'binarykeystore');
    fs.writeFileSync(path.join(tempDir, 'auth', 'auth.p8'), 'p8key');

    policyFile = path.resolve(import.meta.dirname, '../../../policy/default.policy.yaml');
    policy = loadPolicy(policyFile);

    ctx = {
      workspaceRoot: tempDir,
      taskId: 'deny-depth-test-task',
      policyFile,
      auditLocations: [path.join(tempDir, 'audit_log.db')],
      callCount: 1,
    };
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const targetsAtDepth = [
    'foo/bar/.netrc',
    'a/b/.git-credentials',
    'sub/dir/.pypirc',
    'infra/.aws/credentials',
    'docker/.docker/config.json',
    'envs/prod.tfvars',
    'certs/keystore.jks',
    'sec/app.keystore',
    'auth/auth.p8',
  ];

  for (const target of targetsAtDepth) {
    it(`denies read and write for "${target}" at depth`, async () => {
      const readRes = await evaluate(
        {
          id: `read-${target}`,
          name: 'read_file',
          input: { path: target },
        },
        ctx,
        policy
      );
      expect(readRes.decision).toBe('deny');
      expect(readRes.rule).toBe('file_pattern_deny');

      const writeRes = await evaluate(
        {
          id: `write-${target}`,
          name: 'write_file',
          input: { path: target, content: 'malicious write' },
        },
        ctx,
        policy
      );
      expect(writeRes.decision).toBe('deny');
      expect(writeRes.rule).toBe('file_pattern_deny');
    });
  }

  const rootTargets = [
    '.netrc',
    '.git-credentials',
    '.pypirc',
    '.aws/credentials',
    '.docker/config.json',
    'terraform.tfvars',
    'server.jks',
    'release.keystore',
    'AuthKey.p8',
  ];

  for (const target of rootTargets) {
    it(`denies read and write for "${target}" at root level`, async () => {
      const readRes = await evaluate(
        {
          id: `read-${target}`,
          name: 'read_file',
          input: { path: target },
        },
        ctx,
        policy
      );
      expect(readRes.decision).toBe('deny');
      expect(readRes.rule).toBe('file_pattern_deny');

      const writeRes = await evaluate(
        {
          id: `write-${target}`,
          name: 'write_file',
          input: { path: target, content: 'malicious write' },
        },
        ctx,
        policy
      );
      expect(writeRes.decision).toBe('deny');
      expect(writeRes.rule).toBe('file_pattern_deny');
    });
  }
});
