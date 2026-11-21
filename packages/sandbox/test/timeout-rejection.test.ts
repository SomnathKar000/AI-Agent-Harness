import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { collectSecretValues, DEFAULT_SECRET_COLLECTION_TIMEOUT_MS } from '../src/index.js';

describe('Item 5: collectSecretValues timeout', () => {
  it('exports DEFAULT_SECRET_COLLECTION_TIMEOUT_MS = 30000', () => {
    expect(DEFAULT_SECRET_COLLECTION_TIMEOUT_MS).toBe(30000);
  });
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'timeout-ws-'));
    // Create nested dirs and files so scanning takes non-zero time
    for (let i = 0; i < 20; i++) {
      const sub = path.join(tempDir, `dir_${i}`);
      fs.mkdirSync(sub, { recursive: true });
      fs.writeFileSync(path.join(sub, `.env`), `KEY_${i}=val_${i}_secret_12345\n`);
    }
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('rejects on timeout instead of silently returning empty array []', async () => {
    // 0ms or 1ms timeout must reject with a timeout error
    await expect(collectSecretValues(tempDir, { timeoutMs: 0 })).rejects.toThrow(
      /timed out after 0ms/i
    );
  });

  it('collectSecretValues rejects on timeout so a caller cannot silently continue with []', async () => {
    async function startTaskWithSecrets(workspaceRoot: string, opts?: { timeoutMs?: number }) {
      // Must NOT do: const secrets = await collectSecretValues(...).catch(() => []);
      const secrets = await collectSecretValues(workspaceRoot, opts);
      return { status: 'running', secretCount: secrets.length };
    }

    // Must throw/fail task, not return { status: 'running', secretCount: 0 }
    await expect(startTaskWithSecrets(tempDir, { timeoutMs: 0 })).rejects.toThrow(
      /timed out/i
    );
  });
});
