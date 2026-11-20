import type { ToolExecutor } from './types.js';
import { STREAMED_READ_SCRIPT } from './container-scripts.js';

export interface SandboxOperations {
  readFile: (path: string) => Promise<string>;
  writeFile: (path: string, content: string) => Promise<void>;
  listDir: (path?: string) => Promise<string[]>;
  exec: (
    cmd: string[],
    options?: { timeoutMs?: number; cwd?: string }
  ) => Promise<{
    exitCode: number;
    stdout: string;
    stderr: string;
    timedOut: boolean;
  }>;
  stat?: (path: string) => Promise<{ size: number }>;
}

const MAX_WHOLE_FILE_READ_BYTES = 200 * 1024; // 200KB
const MAX_HOST_READ_SIZE = 5 * 1024 * 1024; // 5MB

export class SandboxToolExecutor implements ToolExecutor {
  constructor(private sandbox: SandboxOperations) {}

  async listDir(targetPath: string = '.'): Promise<string[]> {
    return await this.sandbox.listDir(targetPath);
  }

  private async getFileSize(filePath: string): Promise<number | undefined> {
    if (this.sandbox.stat) {
      try {
        const s = await this.sandbox.stat(filePath);
        return s.size;
      } catch {
        return undefined;
      }
    }

    try {
      const res = await this.sandbox.exec(['stat', '-c', '%s', filePath]);
      if (res.exitCode === 0) {
        const parsed = parseInt(res.stdout.trim(), 10);
        if (!isNaN(parsed)) return parsed;
      }
    } catch {
      // ignore
    }

    return undefined;
  }

  private async readStreamedLines(
    filePath: string,
    offset?: number,
    limit?: number
  ): Promise<string> {
    const start = offset ?? 1;
    const end = limit !== undefined ? start + limit - 1 : undefined;

    const res = await this.sandbox.exec([
      'node',
      '-e',
      STREAMED_READ_SCRIPT,
      filePath,
      String(start),
      end !== undefined ? String(end) : '',
    ]);

    if (res.exitCode !== 0) {
      throw new Error(res.stderr.trim() || `streamed read failed for ${filePath}`);
    }

    return res.stdout;
  }

  async readFile(filePath: string, offset?: number, limit?: number): Promise<string> {
    const size = await this.getFileSize(filePath);

    if (size === undefined) {
      if (offset === undefined && limit === undefined) {
        throw new Error(
          `Cannot determine file size for ${filePath}. Whole-file reads of unknown size are rejected.`
        );
      }
      return await this.readStreamedLines(filePath, offset, limit);
    }

    if (size > MAX_HOST_READ_SIZE) {
      if (offset === undefined && limit === undefined) {
        throw new Error(
          `File is too large (${size} bytes exceeds 5MB limit). Use offset and limit to read lines.`
        );
      }
      // Stream read for files over 5MB to avoid reading into host memory
      return await this.readStreamedLines(filePath, offset, limit);
    }

    const content = await this.sandbox.readFile(filePath);
    const totalBytes = Buffer.byteLength(content, 'utf8');

    if (offset === undefined && limit === undefined && totalBytes > MAX_WHOLE_FILE_READ_BYTES) {
      throw new Error(
        `File is too large (> 200KB: ${totalBytes} bytes). Use offset and limit to read lines.`
      );
    }

    if (offset !== undefined || limit !== undefined) {
      const lines = content.split('\n');
      const start = (offset ?? 1) - 1;
      const count = limit ?? (lines.length - start);
      const slice = lines.slice(start, start + count).join('\n');
      if (Buffer.byteLength(slice, 'utf8') > MAX_WHOLE_FILE_READ_BYTES) {
        throw new Error('Requested line slice exceeds 200KB limit.');
      }
      return slice;
    }

    return content;
  }

  async writeFile(filePath: string, content: string): Promise<void> {
    await this.sandbox.writeFile(filePath, content);
  }

  async editFile(filePath: string, oldString: string, newString: string): Promise<void> {
    const content = await this.sandbox.readFile(filePath);
    let count = 0;
    let pos = content.indexOf(oldString);
    let firstIdx = -1;

    while (pos !== -1) {
      if (count === 0) firstIdx = pos;
      count++;
      pos = content.indexOf(oldString, pos + oldString.length);
    }

    if (count === 0) {
      throw new Error(`Error: old_string not found in ${filePath}`);
    }
    if (count > 1) {
      throw new Error(
        `Error: old_string matches ${count} times in ${filePath}. Must match exactly once.`
      );
    }

    // Use string slicing instead of String.prototype.replace to preserve literal replacement
    const updated =
      content.slice(0, firstIdx) + newString + content.slice(firstIdx + oldString.length);

    await this.sandbox.writeFile(filePath, updated);
  }

  async grep(pattern: string, targetPath: string = '.'): Promise<string> {
    const result = await this.sandbox.exec([
      'grep',
      '-rn',
      '--exclude-dir=.git',
      '--exclude-dir=node_modules',
      '-e',
      pattern,
      '--',
      targetPath,
    ]);

    if (result.exitCode === 0) {
      return result.stdout;
    }
    if (result.exitCode === 1) {
      return 'No matches found.';
    }
    throw new Error(result.stderr.trim() || `grep failed for pattern ${pattern}`);
  }

  async runCommand(
    argv: string[],
    timeoutMs?: number
  ): Promise<{ exitCode: number; stdout: string; stderr: string; timedOut: boolean }> {
    return await this.sandbox.exec(argv, { timeoutMs });
  }
}
