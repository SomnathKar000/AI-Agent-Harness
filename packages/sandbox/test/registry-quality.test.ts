import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { collectSecretValues } from '../src/index.js';

describe('Item 7: Secret registry quality', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'registry-quality-ws-'));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('skips line-based collection for binary keystore files (.p12, .pfx, .jks, .keystore)', async () => {
    // Create dummy binary files with arbitrary bytes that could produce lines >= 8 chars
    const binaryData = Buffer.from([
      0x30, 0x82, 0x03, 0x4a, 0x02, 0x01, 0x03, 0x30, 0x82, 0x03, 0x0d, 0x06, 0x09,
      0x61, 0x62, 0x63, 0x64, 0x65, 0x66, 0x67, 0x68, 0x69, 0x6a, 0x6b, 0x6c, 0x6d,
      0x0a, // newline
      0x78, 0x79, 0x7a, 0x31, 0x32, 0x33, 0x34, 0x35, 0x36, 0x37, 0x38, 0x39, 0x30,
    ]);

    fs.writeFileSync(path.join(tempDir, 'cert.p12'), binaryData);
    fs.writeFileSync(path.join(tempDir, 'cert.pfx'), binaryData);
    fs.writeFileSync(path.join(tempDir, 'keystore.jks'), binaryData);
    fs.writeFileSync(path.join(tempDir, 'app.keystore'), binaryData);

    const secrets = await collectSecretValues(tempDir);

    // Binary files should not have lines extracted as secrets
    expect(secrets.length).toBe(0);
  });

  it('strips unquoted trailing comments from .env entries ("API_KEY=abc12345 # prod")', async () => {
    fs.writeFileSync(
      path.join(tempDir, '.env'),
      [
        'UNQUOTED_KEY=my_clean_secret_123 # production comment',
        'QUOTED_KEY="my_quoted_secret_456" # trailing comment',
        'COMMENT_INSIDE="secret_with_#_inside" # outer comment',
      ].join('\n')
    );

    const secrets = await collectSecretValues(tempDir);

    // Unquoted: comment is stripped
    expect(secrets).toContain('my_clean_secret_123');
    expect(secrets).not.toContain('my_clean_secret_123 # production comment');

    // Quoted: trailing comment stripped
    expect(secrets).toContain('my_quoted_secret_456');
    expect(secrets).not.toContain('my_quoted_secret_456" # trailing comment');

    // Inside quotes preserved
    expect(secrets).toContain('secret_with_#_inside');
  });
});
