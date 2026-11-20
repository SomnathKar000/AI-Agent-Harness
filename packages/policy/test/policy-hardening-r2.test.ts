import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
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

// We import isPathProtected and resolveReal which must be exported from packages/policy
import * as policyModule from '../src/index.js';

describe('Phase 4 Hardening Round 2 Tests', () => {
  let tempDir: string;
  let policyFile: string;
  let policy: PolicyConfig;
  let ctx: PolicyContext;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'policy-r2-ws-'));

    fs.mkdirSync(path.join(tempDir, 'src'), { recursive: true });
    fs.mkdirSync(path.join(tempDir, '.github', 'workflows'), { recursive: true });
    fs.mkdirSync(path.join(tempDir, 'policy'), { recursive: true });

    fs.writeFileSync(path.join(tempDir, 'src', 'paginate.ts'), 'export const paginate = 1;\n');
    fs.writeFileSync(path.join(tempDir, '.env'), 'CANARY_SECRET=canary-7f3a9\n');
    fs.writeFileSync(path.join(tempDir, '.github', 'workflows', 'ci.yml'), 'name: CI\n');
    fs.writeFileSync(path.join(tempDir, 'policy', 'rules.yaml'), 'sample: rule\n');

    policyFile = path.resolve(import.meta.dirname, '../../../policy/default.policy.yaml');
    policy = loadPolicy(policyFile);

    ctx = {
      workspaceRoot: tempDir,
      taskId: 'r2-test-task',
      policyFile,
      auditLocations: [path.join(tempDir, 'audit_log.db')],
      callCount: 1,
    };
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  describe('Item 1: grep leaks protected files and isPathProtected export', () => {
    it('exports isPathProtected and correctly identifies protected files', () => {
      const isPathProtected = (policyModule as any).isPathProtected;
      expect(typeof isPathProtected).toBe('function');

      expect(isPathProtected('.env', policy, 'read', ctx).protected).toBe(true);
      expect(isPathProtected('sub/.env', policy, 'read', ctx).protected).toBe(true);
      expect(isPathProtected('a/KEY.PEM', policy, 'read', ctx).protected).toBe(true);
      expect(isPathProtected('.git/config', policy, 'read', ctx).protected).toBe(true);
      expect(isPathProtected('src/paginate.ts', policy, 'read', ctx).protected).toBe(false);
    });

    it('redact removes grep results from protected files (sub/.env, a/KEY.PEM) and keeps normal files', () => {
      const gate = new PolicyGate({
        ctx,
        policy,
      });

      expect(typeof gate.redact).toBe('function');

      // grep -rnZ format: <filepath>\0<lineno>:<lineContent>\n
      const rawGrepOutput = [
        'sub/.env\x001:SECRET=hidden_canary',
        'a/KEY.PEM\x001:PRIVATE KEY',
        'src/paginate.ts\x0010:export function paginate() {}',
      ].join('\n');

      const redacted = gate.redact!(
        { id: '1', name: 'grep', input: { pattern: 'test', path: '.' } },
        rawGrepOutput
      );

      expect(redacted).not.toContain('hidden_canary');
      expect(redacted).not.toContain('sub/.env');
      expect(redacted).not.toContain('KEY.PEM');
      expect(redacted).toContain('src/paginate.ts:10:export function paginate() {}');
    });
  });

  describe('Item 2: Directory-symlink bypass & resolveReal', () => {
    it('exports resolveReal helper and resolves deepest existing ancestor + remaining segments', () => {
      const resolveReal = (policyModule as any).resolveReal;
      expect(typeof resolveReal).toBe('function');
    });

    it('denies read "link/passwd" where link -> /etc', async () => {
      const linkPath = path.join(tempDir, 'link');
      fs.symlinkSync('/etc', linkPath);

      const res = await evaluate(
        { id: '1', name: 'read_file', input: { path: 'link/passwd' } },
        ctx,
        policy
      );
      expect(res.decision).toBe('deny');
    });

    it('denies write "link/new.txt" where link -> /etc (file does not exist)', async () => {
      const linkPath = path.join(tempDir, 'link');
      fs.symlinkSync('/etc', linkPath);

      const res = await evaluate(
        { id: '2', name: 'write_file', input: { path: 'link/new.txt', content: 'hello' } },
        ctx,
        policy
      );
      expect(res.decision).toBe('deny');
    });

    it('returns ask when writing "d/workflows/ci.yml" where d -> .github', async () => {
      const dPath = path.join(tempDir, 'd');
      fs.symlinkSync(path.join(tempDir, '.github'), dPath);

      const res = await evaluate(
        { id: '3', name: 'write_file', input: { path: 'd/workflows/ci.yml', content: 'ci' } },
        ctx,
        policy
      );
      expect(res.decision).toBe('ask');
    });

    it('denies "d/.env" where d -> .', async () => {
      const dPath = path.join(tempDir, 'd_dot');
      fs.symlinkSync(tempDir, dPath);

      const res = await evaluate(
        { id: '4', name: 'read_file', input: { path: 'd_dot/.env' } },
        ctx,
        policy
      );
      expect(res.decision).toBe('deny');
    });

    it('allows read "d/paginate.ts" where d -> src', async () => {
      const dPath = path.join(tempDir, 'd_src');
      fs.symlinkSync(path.join(tempDir, 'src'), dPath);

      const res = await evaluate(
        { id: '5', name: 'read_file', input: { path: 'd_src/paginate.ts' } },
        ctx,
        policy
      );
      expect(res.decision).toBe('allow');
    });

    it('denies dangling symlink without crashing or hanging', async () => {
      const danglingPath = path.join(tempDir, 'dangling');
      fs.symlinkSync(path.join(tempDir, 'nonexistent_target_dir'), danglingPath);

      const res = await evaluate(
        { id: '6', name: 'read_file', input: { path: 'dangling/file.txt' } },
        ctx,
        policy
      );
      expect(res.decision).toBe('deny');
    });

    it('denies symlink loop without hanging', async () => {
      const loopA = path.join(tempDir, 'loopA');
      const loopB = path.join(tempDir, 'loopB');
      fs.symlinkSync(loopB, loopA);
      fs.symlinkSync(loopA, loopB);

      const res = await evaluate(
        { id: '7', name: 'read_file', input: { path: 'loopA/foo.txt' } },
        ctx,
        policy
      );
      expect(res.decision).toBe('deny');
    });
  });

  describe('Item 3: Dead configuration & Old YAML schema rejection', () => {
    it('rejects an old policy YAML containing removed sections (commands, flagPatterns, perCallOutputSize)', () => {
      const oldYaml = `
version: "1.0"
limits:
  maxCallsPerTask: 100
  perCallOutputSize: 1048576
files:
  denyPatterns:
    - "^\\\\.env.*"
  flagPatterns:
    - pattern: "^pnpm-lock\\\\.yaml$"
      flag: "lockfile_edit"
commands:
  denyList:
    - name: "curl"
      argv0: "curl"
`;
      const oldFile = path.join(tempDir, 'old.policy.yaml');
      fs.writeFileSync(oldFile, oldYaml);

      expect(() => loadPolicy(oldFile)).toThrow(/invalid policy configuration|unrecognized/i);
    });
  });

  describe('Item 4: Fail closed', () => {
    it('denies call with rule "policy_context_error" when ctx.callCount is missing', async () => {
      const badCtx = { ...ctx } as any;
      delete badCtx.callCount;

      const res = await evaluate(
        { id: '1', name: 'read_file', input: { path: 'src/paginate.ts' } },
        badCtx,
        policy
      );
      expect(res.decision).toBe('deny');
      expect(res.rule).toBe('policy_context_error');
    });

    it('denies file tool when input.path is present but not a string (never defaults to .)', async () => {
      const res = await evaluate(
        { id: '2', name: 'read_file', input: { path: 123 as any } },
        ctx,
        policy
      );
      expect(res.decision).toBe('deny');
      expect(res.rule).toMatch(/invalid_path|input_error/);
    });

    it('denies run_command when argv elements are not strings', async () => {
      const res = await evaluate(
        { id: '3', name: 'run_command', input: { argv: ['pnpm', 123, 'test'] as any } },
        ctx,
        policy
      );
      expect(res.decision).toBe('deny');
      expect(res.rule).toMatch(/invalid_argv|input_error/);
    });

    it('PolicyGate wraps evaluate in try/catch and logs rule "policy_error" without throwing', async () => {
      const gate = new PolicyGate({
        ctx,
        policy,
      });

      // Pass an input that causes evaluate to throw an unexpected error
      const badCall: any = null;
      const decision = await gate.evaluate(badCall);
      expect(decision.action).toBe('deny');
      expect(decision.reason).toMatch(/policy error|internal/i);
    });
  });

  describe('Item 5: Command names bare name check (no /)', () => {
    it('denies allowlisted commands if argv[0] contains "/"', async () => {
      const resPnpm = await evaluate(
        { id: '1', name: 'run_command', input: { argv: ['./pnpm', 'test'] } },
        ctx,
        policy
      );
      expect(resPnpm.decision).toBe('deny');

      const resNode = await evaluate(
        { id: '2', name: 'run_command', input: { argv: ['/tmp/x/node', 'src/paginate.ts'] } },
        ctx,
        policy
      );
      expect(resNode.decision).toBe('deny');

      const resTsc = await evaluate(
        { id: '3', name: 'run_command', input: { argv: ['bin/tsc'] } },
        ctx,
        policy
      );
      expect(resTsc.decision).toBe('deny');
    });

    it('allows allowlisted commands when argv[0] is a bare name without "/"', async () => {
      const resPnpm = await evaluate(
        { id: '4', name: 'run_command', input: { argv: ['pnpm', 'test'] } },
        ctx,
        policy
      );
      expect(resPnpm.decision).toBe('allow');

      const resNode = await evaluate(
        { id: '5', name: 'run_command', input: { argv: ['node', 'src/paginate.ts'] } },
        ctx,
        policy
      );
      expect(resNode.decision).toBe('allow');
    });
  });

  describe('Item 6: Over-blocking (read allowed, write/edit ask for workspace policy/audit names)', () => {
    it('allows reading "policy/rules.yaml" inside workspace', async () => {
      const res = await evaluate(
        { id: '1', name: 'read_file', input: { path: 'policy/rules.yaml' } },
        ctx,
        policy
      );
      expect(res.decision).toBe('allow');
    });

    it('returns ask for writing "src/audit_log.ts"', async () => {
      const res = await evaluate(
        { id: '2', name: 'write_file', input: { path: 'src/audit_log.ts', content: 'code' } },
        ctx,
        policy
      );
      expect(res.decision).toBe('ask');
    });

    it('still denies reading the absolute ctx.policyFile location', async () => {
      const res = await evaluate(
        { id: '3', name: 'read_file', input: { path: policyFile } },
        ctx,
        policy
      );
      expect(res.decision).toBe('deny');
    });
  });

  describe('Item 7: New files.denyPatterns', () => {
    it('denies .envrc, id_rsa*, id_ed25519*, *.p12, *.pfx, credentials.json', async () => {
      const targets = [
        '.envrc',
        'id_rsa',
        'id_rsa.pub',
        'id_ed25519',
        'id_ed25519_key',
        'cert.p12',
        'backup.pfx',
        'credentials.json',
      ];

      for (const target of targets) {
        const res = await evaluate(
          { id: `deny-${target}`, name: 'read_file', input: { path: target } },
          ctx,
          policy
        );
        expect(res.decision).toBe('deny');
      }
    });
  });
});
