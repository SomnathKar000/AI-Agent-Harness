import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { execSync } from 'node:child_process';
import {
  readFile,
  writeFile,
  listDir,
  stat,
} from '../src/index.js';

describe('Host-Side File Operations Security & Robustness', { timeout: 15000 }, () => {
  let workspaceDir: string;

  beforeEach(() => {
    workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), `test-fileops-${Date.now()}-`));
  });

  afterEach(() => {
    fs.rmSync(workspaceDir, { recursive: true, force: true });
  });

  it('rejects a FIFO (mkfifo) without blocking or hanging for readFile, writeFile, and stat', async () => {
    const fifoPath = path.join(workspaceDir, 'test.fifo');
    execSync(`mkfifo "${fifoPath}"`);

    // readFile on FIFO must be rejected without hanging
    await expect(readFile(workspaceDir, 'test.fifo')).rejects.toThrow(/not a regular file|fifo/i);

    // writeFile on FIFO must be rejected without hanging
    await expect(writeFile(workspaceDir, 'test.fifo', 'data')).rejects.toThrow(/not a regular file|enxio|fifo/i);

    // stat on FIFO must be rejected without hanging
    await expect(stat(workspaceDir, 'test.fifo')).rejects.toThrow(/not a regular file|fifo/i);
  });

  it('rejects a device file (/dev/null or special device) for readFile, writeFile, and stat', async () => {
    // readFile on device file must be rejected
    await expect(readFile(workspaceDir, '/dev/null')).rejects.toThrow(/not a regular file|outside workspace|escape/i);

    // If symlinked to a device file inside workspace:
    const devSymlink = path.join(workspaceDir, 'devnull-link');
    try {
      fs.symlinkSync('/dev/null', devSymlink);
    } catch {
      // ignore
    }

    if (fs.existsSync(devSymlink)) {
      await expect(readFile(workspaceDir, 'devnull-link')).rejects.toThrow();
      await expect(writeFile(workspaceDir, 'devnull-link', 'hello')).rejects.toThrow();
      await expect(stat(workspaceDir, 'devnull-link')).rejects.toThrow();
    }
  });

  it('rejects a symlink swapped in after policy check (TOCTOU simulation) using O_NOFOLLOW', async () => {
    const targetFile = path.join(workspaceDir, 'victim.txt');
    fs.writeFileSync(targetFile, 'original safe content');

    // Simulate TOCTOU: right after check, target is replaced with a symlink pointing outside
    fs.unlinkSync(targetFile);
    fs.symlinkSync('/etc/passwd', targetFile);

    // Opening with O_NOFOLLOW must fail immediately and reject the swapped symlink
    await expect(readFile(workspaceDir, 'victim.txt')).rejects.toThrow(/eloop|symlink|not a regular file/i);
    await expect(writeFile(workspaceDir, 'victim.txt', 'evil data')).rejects.toThrow(/eloop|symlink|not a regular file/i);
    await expect(stat(workspaceDir, 'victim.txt')).rejects.toThrow(/eloop|symlink|not a regular file/i);
  });

  it('rejects a symlink to a huge file without reading or hanging', async () => {
    // Create a 6MB file inside workspace
    const hugeFilePath = path.join(workspaceDir, 'huge.dat');
    const fd = fs.openSync(hugeFilePath, 'w');
    fs.ftruncateSync(fd, 6 * 1024 * 1024); // 6MB sparse file
    fs.closeSync(fd);

    const symlinkToHuge = path.join(workspaceDir, 'huge-link.dat');
    fs.symlinkSync(hugeFilePath, symlinkToHuge);

    // readFile on symlink pointing to huge file or huge file itself must reject exceeding size
    await expect(readFile(workspaceDir, 'huge-link.dat')).rejects.toThrow(/too large|size limit|eloop|symlink/i);
  });
});
