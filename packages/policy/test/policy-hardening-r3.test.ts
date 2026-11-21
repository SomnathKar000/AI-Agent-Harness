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
import * as policyModule from '../src/index.js';

describe('Phase 4 Hardening Round 3 Unit Tests', () => {
  let tempDir: string;
  let policyFile: string;
  let policy: PolicyConfig;
  let ctx: PolicyContext;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'policy-r3-ws-'));

    fs.mkdirSync(path.join(tempDir, 'src'), { recursive: true });
    fs.mkdirSync(path.join(tempDir, '.ssh'), { recursive: true });
    fs.mkdirSync(path.join(tempDir, 'config'), { recursive: true });
    fs.mkdirSync(path.join(tempDir, 'packages', 'x'), { recursive: true });
    fs.mkdirSync(path.join(tempDir, 'a', 'b'), { recursive: true });

    fs.writeFileSync(path.join(tempDir, 'src', 'foo.ts'), 'export const foo = 1;\n');
    fs.writeFileSync(path.join(tempDir, '.environment-notes.md'), '# Notes\n');
    fs.writeFileSync(path.join(tempDir, '.ssh', 'id_rsa'), 'PRIVATE KEY\n');
    fs.writeFileSync(path.join(tempDir, 'config', 'credentials.json'), '{"secret": "xyz"}\n');
    fs.writeFileSync(path.join(tempDir, 'packages', 'x', '.envrc'), 'SECRET=abc\n');
    fs.writeFileSync(path.join(tempDir, 'a', 'b', '.env.local'), 'SECRET=def\n');

    policyFile = path.resolve(import.meta.dirname, '../../../policy/default.policy.yaml');
    policy = loadPolicy(policyFile);

    ctx = {
      workspaceRoot: tempDir,
      taskId: 'test-task-r3',
      policyFile,
      auditLocations: [path.join(tempDir, 'audit_log.db')],
      callCount: 1,
    };
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  describe('Item 1: Secret Registry & maskSecrets in PolicyGate', () => {
    it('accepts secretValues in PolicyGate and has maskSecrets method', () => {
      const gate = new PolicyGate({
        ctx,
        policy,
        secretValues: ['canary-7f3a9', 'super-secret-password-1234'],
      });

      expect(typeof (gate as any).maskSecrets).toBe('function');
      const masked = (gate as any).maskSecrets(
        'The password is super-secret-password-1234 and canary-7f3a9 was here'
      );
      expect(masked).toBe('The password is [REDACTED] and [REDACTED] was here');
    });

    it('redact() applies maskSecrets to results of ALL tools (not just grep)', () => {
      const gate = new PolicyGate({
        ctx,
        policy,
        secretValues: ['canary-7f3a9'],
      });

      // run_command tool result
      const runCmdResult = gate.redact(
        { id: '1', name: 'run_command', input: { argv: ['node', 'src/x.js'] } },
        'Output has secret: canary-7f3a9'
      );
      expect(runCmdResult).toBe('Output has secret: [REDACTED]');

      // read_file tool result
      const readFileResult = gate.redact(
        { id: '2', name: 'read_file', input: { path: 'src/foo.ts' } },
        'Contents: canary-7f3a9'
      );
      expect(readFileResult).toBe('Contents: [REDACTED]');
    });
  });

  describe('Item 2: Logging hygiene in gate.ts', () => {
    it('throws in PolicyGate constructor if taskId is missing', () => {
      const badCtx = { ...ctx } as any;
      delete badCtx.taskId;

      expect(() => {
        new PolicyGate({
          ctx: badCtx,
          policy,
        });
      }).toThrow(/taskId/i);
    });

    it('truncates any string over 2KB to first 2KB plus "[truncated N bytes]" and masks secrets before audit/approval logging', async () => {
      let insertedApproval: any;
      let insertedAudit: any;
      const mockValues = {
        returning: vi.fn().mockImplementation(() => {
          return Promise.resolve([{ id: '1' }]);
        }),
      };
      const mockDb: any = {
        insert: vi.fn().mockImplementation((table) => {
          return {
            values: vi.fn().mockImplementation((val) => {
              if (val.status === 'pending' && val.kind === 'tool_call') {
                insertedApproval = val;
              } else if (val.action === 'policy_ask' || val.action === 'policy_deny') {
                insertedAudit = val;
              }
              return mockValues;
            }),
          };
        }),
      };

      const largeContent = 'A'.repeat(5000) + ' canary-7f3a9';
      const gate = new PolicyGate({
        ctx,
        policy,
        db: mockDb,
        secretValues: ['canary-7f3a9'],
      });

      // Tool call that gets denied or asked
      const decision = await gate.evaluate({
        id: '1',
        name: 'write_file',
        input: { path: '.github/workflows/ci.yml', content: largeContent },
      });

      expect(decision.action).toBe('ask');
      expect(insertedApproval).toBeDefined();
      const content = insertedApproval.payload.toolCall.input.content;
      expect(content).toContain('[truncated');
      expect(content).not.toContain('canary-7f3a9');
      expect(content.length).toBeLessThan(2500);
    });

    it('writes secondary audit failure error to console.error if audit write fails in catch block', async () => {
      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      const failingDb: any = {
        insert: vi.fn().mockImplementation(() => {
          throw new Error('Database disk full');
        }),
      };

      const gate = new PolicyGate({
        ctx,
        policy,
        db: failingDb,
      });

      // Pass an invalid tool call to trigger catch block
      const decision = await gate.evaluate(null as any);
      expect(decision.action).toBe('deny');
      expect(consoleErrorSpy).toHaveBeenCalled();

      consoleErrorSpy.mockRestore();
    });
  });

  describe('Item 3: redact for grep must fail closed and handle edge cases', () => {
    it('drops every line that cannot be parsed into path + rest (line without colon or NUL)', () => {
      const gate = new PolicyGate({
        ctx,
        policy,
      });

      const badGrepOutput = [
        'src/foo.ts\x0010:normal line',
        'malformed line without any separator',
        'src/foo.ts:20:another line',
      ].join('\n');

      const redacted = gate.redact(
        { id: '1', name: 'grep', input: { pattern: 'test', path: '.' } },
        badGrepOutput
      );

      expect(redacted).not.toContain('malformed line');
      expect(redacted).toContain('src/foo.ts:10:normal line');
      expect(redacted).toContain('src/foo.ts:20:another line');
    });

    it('drops binary-file match line ("grep: ./cert.p12: binary file matches") so it never reaches the model', () => {
      const gate = new PolicyGate({
        ctx,
        policy,
      });

      const binaryMatchOutput = [
        'grep: ./cert.p12: binary file matches',
        'Binary file ./cert.p12 matches',
        'src/foo.ts\x001:valid hit',
      ].join('\n');

      const redacted = gate.redact(
        { id: '1', name: 'grep', input: { pattern: 'test', path: '.' } },
        binaryMatchOutput
      );

      expect(redacted).not.toContain('binary file matches');
      expect(redacted).not.toContain('cert.p12');
      expect(redacted).toContain('src/foo.ts:1:valid hit');
    });

    it('handles files whose name contains a colon when NUL-delimited', () => {
      const gate = new PolicyGate({
        ctx,
        policy,
      });

      const colonInNameOutput = 'src/foo:bar.ts\x0042:const answer = 42;';
      const redacted = gate.redact(
        { id: '1', name: 'grep', input: { pattern: 'answer', path: '.' } },
        colonInNameOutput
      );

      expect(redacted).toBe('src/foo:bar.ts:42:const answer = 42;');
    });

    it('handles absolute /workspace/... paths in grep output and tests containment & protected status', () => {
      const gate = new PolicyGate({
        ctx,
        policy,
      });

      const absOutput = [
        '/workspace/src/foo.ts\x001:good line',
        '/workspace/.env\x001:SECRET=secret_canary',
      ].join('\n');

      const redacted = gate.redact(
        { id: '1', name: 'grep', input: { pattern: 'line', path: '/workspace' } },
        absOutput
      );

      expect(redacted).not.toContain('.env');
      expect(redacted).not.toContain('secret_canary');
      expect(redacted).toContain('src/foo.ts:1:good line');
    });
  });

  describe('Item 4: YAML patterns at depth and segment anchoring', () => {
    it('denies .ssh/id_rsa, config/credentials.json, packages/x/.envrc, a/b/.env.local', async () => {
      const deniedTargets = [
        '.ssh/id_rsa',
        'config/credentials.json',
        'packages/x/.envrc',
        'a/b/.env.local',
      ];

      for (const target of deniedTargets) {
        const res = await evaluate(
          { id: `test-${target}`, name: 'read_file', input: { path: target } },
          ctx,
          policy
        );
        expect(res.decision).toBe('deny');
      }
    });

    it('allows ".environment-notes.md" and does not misclassify as .env', async () => {
      const res = await evaluate(
        { id: 'test-notes', name: 'read_file', input: { path: '.environment-notes.md' } },
        ctx,
        policy
      );
      expect(res.decision).toBe('allow');
    });
  });
});
