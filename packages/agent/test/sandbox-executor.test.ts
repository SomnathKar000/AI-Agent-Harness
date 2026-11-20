import { describe, it, expect, vi } from 'vitest';
import { SandboxToolExecutor, type SandboxOperations } from '../src/sandbox-executor.js';

describe('SandboxToolExecutor unit tests', () => {
  it('confirms file tools route to sandbox readFile/writeFile/listDir and grep/run_command to exec', async () => {
    const mockReadFile = vi.fn().mockResolvedValue('line 1\nline 2\nline 3');
    const mockWriteFile = vi.fn().mockResolvedValue(undefined);
    const mockListDir = vi.fn().mockResolvedValue(['fileA.ts', 'fileB.ts']);
    const mockExec = vi.fn().mockResolvedValue({
      exitCode: 0,
      stdout: 'grep results',
      stderr: '',
      timedOut: false,
    });

    const sandboxOps: SandboxOperations = {
      readFile: mockReadFile,
      writeFile: mockWriteFile,
      listDir: mockListDir,
      exec: mockExec,
    };

    const executor = new SandboxToolExecutor(sandboxOps);

    // 1. listDir
    const listRes = await executor.listDir('src');
    expect(mockListDir).toHaveBeenCalledWith('src');
    expect(listRes).toEqual(['fileA.ts', 'fileB.ts']);

    // 2. readFile
    const readRes = await executor.readFile('src/index.ts', 2, 1);
    expect(mockReadFile).toHaveBeenCalledWith('src/index.ts');
    expect(readRes).toBe('line 2');

    // 3. writeFile
    await executor.writeFile('src/new.ts', 'const x = 1;');
    expect(mockWriteFile).toHaveBeenCalledWith('src/new.ts', 'const x = 1;');

    // 4. editFile (uses readFile + writeFile)
    mockReadFile.mockResolvedValueOnce('const a = 1;\nconst b = 2;');
    await executor.editFile('src/edit.ts', 'const a = 1;', 'const a = 10;');
    expect(mockReadFile).toHaveBeenCalledWith('src/edit.ts');
    expect(mockWriteFile).toHaveBeenCalledWith('src/edit.ts', 'const a = 10;\nconst b = 2;');

    // 5. grep (routes to container exec)
    const grepRes = await executor.grep('paginate', 'src');
    expect(mockExec).toHaveBeenCalledWith([
      'grep',
      '-rn',
      '--exclude-dir=.git',
      '--exclude-dir=node_modules',
      'paginate',
      'src',
    ]);
    expect(grepRes).toBe('grep results');

    // 6. runCommand (routes to container exec)
    const cmdRes = await executor.runCommand(['pnpm', 'test'], 5000);
    expect(mockExec).toHaveBeenCalledWith(['pnpm', 'test'], { timeoutMs: 5000 });
    expect(cmdRes.exitCode).toBe(0);
  });
});
