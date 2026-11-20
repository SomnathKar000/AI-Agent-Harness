import type { ToolExecutor } from './types.js';

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
}

export class SandboxToolExecutor implements ToolExecutor {
  constructor(private sandbox: SandboxOperations) {}

  async listDir(targetPath: string = '.'): Promise<string[]> {
    return await this.sandbox.listDir(targetPath);
  }

  async readFile(filePath: string, offset?: number, limit?: number): Promise<string> {
    const content = await this.sandbox.readFile(filePath);
    const totalBytes = Buffer.byteLength(content, 'utf8');

    if (offset === undefined && limit === undefined && totalBytes > 200 * 1024) {
      throw new Error(
        `File is too large (> 200KB: ${totalBytes} bytes). Use offset and limit to read lines.`
      );
    }

    if (offset !== undefined || limit !== undefined) {
      const lines = content.split('\n');
      const start = (offset ?? 1) - 1;
      const count = limit ?? (lines.length - start);
      const slice = lines.slice(start, start + count).join('\n');
      if (Buffer.byteLength(slice, 'utf8') > 200 * 1024) {
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
    while (pos !== -1) {
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

    const updated = content.replace(oldString, newString);
    await this.sandbox.writeFile(filePath, updated);
  }

  async grep(pattern: string, targetPath: string = '.'): Promise<string> {
    const result = await this.sandbox.exec([
      'grep',
      '-rn',
      '--exclude-dir=.git',
      '--exclude-dir=node_modules',
      pattern,
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
