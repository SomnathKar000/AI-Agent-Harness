import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { PolicyGate } from '../src/gate.js';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

describe('Item 5: PEM masking verification', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pem-test-'));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('masks base64 body lines in *.pem files, but does NOT mask BEGIN/END header lines', () => {
    const bodySecret = 'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA';
    const gate = new PolicyGate({
      ctx: {
        workspaceRoot: tempDir,
        taskId: 'pem-task',
        callCount: 0,
      },
      secretValues: [bodySecret],
    });

    const pemContent = [
      '-----BEGIN CERTIFICATE-----',
      bodySecret,
      '-----END CERTIFICATE-----',
    ].join('\n');

    const masked = gate.maskSecrets(pemContent);

    // BEGIN/END lines must NOT be masked
    expect(masked).toContain('-----BEGIN CERTIFICATE-----');
    expect(masked).toContain('-----END CERTIFICATE-----');
    expect(masked).not.toContain('-----BEGIN [REDACTED]-----');
    expect(masked).not.toContain('-----END [REDACTED]-----');

    // Base64 body line MUST be masked
    expect(masked).toContain('[REDACTED]');
    expect(masked).not.toContain(bodySecret);

    expect(masked).toBe(
      '-----BEGIN CERTIFICATE-----\n[REDACTED]\n-----END CERTIFICATE-----'
    );
  });
});
