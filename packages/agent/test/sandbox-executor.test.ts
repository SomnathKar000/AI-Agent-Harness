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
      stat: vi.fn().mockResolvedValue({ size: 100 }),
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

    // 5. grep (routes to container exec with -e and --)
    const grepRes = await executor.grep('paginate', 'src');
    expect(mockExec).toHaveBeenCalledWith([
      'grep',
      '-rn',
      '--exclude-dir=.git',
      '--exclude-dir=node_modules',
      '-e',
      'paginate',
      '--',
      'src',
    ]);
    expect(grepRes).toBe('grep results');

    // 6. runCommand (routes to container exec)
    const cmdRes = await executor.runCommand(['pnpm', 'test'], 5000);
    expect(mockExec).toHaveBeenCalledWith(['pnpm', 'test'], { timeoutMs: 5000 });
    expect(cmdRes.exitCode).toBe(0);
  });

  it('keeps replacement string literal with "$&$&", "$$", and "$\'" without String.replace expansion', async () => {
    const mockReadFile = vi.fn().mockResolvedValue('const target = "ORIGINAL_VALUE";');
    const mockWriteFile = vi.fn().mockResolvedValue(undefined);
    const mockListDir = vi.fn();
    const mockExec = vi.fn();

    const executor = new SandboxToolExecutor({
      readFile: mockReadFile,
      writeFile: mockWriteFile,
      listDir: mockListDir,
      exec: mockExec,
    });

    // Test with "$&$&"
    await executor.editFile('test.ts', 'ORIGINAL_VALUE', '&$&$&');
    expect(mockWriteFile).toHaveBeenLastCalledWith('test.ts', 'const target = "&$&$&";');

    // Test with "$$"
    await executor.editFile('test.ts', 'ORIGINAL_VALUE', '$$');
    expect(mockWriteFile).toHaveBeenLastCalledWith('test.ts', 'const target = "$$";');

    // Test with "$'"
    await executor.editFile('test.ts', 'ORIGINAL_VALUE', "$'");
    expect(mockWriteFile).toHaveBeenLastCalledWith('test.ts', 'const target = "$\'";');
  });

  it('errors when edit has 0 matches or 2 matches', async () => {
    const mockReadFile = vi.fn().mockResolvedValue('const a = 1;\nconst a = 1;\nconst c = 3;');
    const mockWriteFile = vi.fn().mockResolvedValue(undefined);
    const mockListDir = vi.fn();
    const mockExec = vi.fn();

    const executor = new SandboxToolExecutor({
      readFile: mockReadFile,
      writeFile: mockWriteFile,
      listDir: mockListDir,
      exec: mockExec,
    });

    // 0 matches
    await expect(executor.editFile('test.ts', 'nonexistent', 'replacement')).rejects.toThrow(
      /old_string not found/
    );

    // 2 matches
    await expect(executor.editFile('test.ts', 'const a = 1;', 'replacement')).rejects.toThrow(
      /matches 2 times/
    );
  });

  it('searches literally when grep pattern is "-rf" or "--help"', async () => {
    const mockReadFile = vi.fn();
    const mockWriteFile = vi.fn();
    const mockListDir = vi.fn();
    const mockExec = vi.fn().mockResolvedValue({
      exitCode: 0,
      stdout: 'literal match found',
      stderr: '',
      timedOut: false,
    });

    const executor = new SandboxToolExecutor({
      readFile: mockReadFile,
      writeFile: mockWriteFile,
      listDir: mockListDir,
      exec: mockExec,
    });

    // Grep with "-rf"
    await executor.grep('-rf', 'src');
    expect(mockExec).toHaveBeenLastCalledWith([
      'grep',
      '-rn',
      '--exclude-dir=.git',
      '--exclude-dir=node_modules',
      '-e',
      '-rf',
      '--',
      'src',
    ]);

    // Grep with "--help"
    await executor.grep('--help', 'packages');
    expect(mockExec).toHaveBeenLastCalledWith([
      'grep',
      '-rn',
      '--exclude-dir=.git',
      '--exclude-dir=node_modules',
      '-e',
      '--help',
      '--',
      'packages',
    ]);
  });

  it('rejects read of a very large file (> 5MB) before reading into host memory', async () => {
    const mockReadFile = vi.fn().mockResolvedValue('realistic file content');
    const mockWriteFile = vi.fn();
    const mockListDir = vi.fn();
    const mockExec = vi.fn();
    const mockStat = vi.fn().mockResolvedValue({ size: 10 * 1024 * 1024 }); // 10MB realistic size

    const executor = new SandboxToolExecutor({
      readFile: mockReadFile,
      writeFile: mockWriteFile,
      listDir: mockListDir,
      exec: mockExec,
      stat: mockStat,
    });

    await expect(executor.readFile('huge-file.bin')).rejects.toThrow(/too large|exceeds 5MB/i);
    // Crucially: sandbox.readFile MUST NOT have been called for arbitrarily large file!
    expect(mockReadFile).not.toHaveBeenCalled();
  });

  it('rejects whole-file read when file size is unknown without calling sandbox.readFile', async () => {
    const mockReadFile = vi.fn().mockResolvedValue('whole file content');
    const mockWriteFile = vi.fn();
    const mockListDir = vi.fn();
    const mockExec = vi.fn();
    const mockStat = vi.fn().mockRejectedValue(new Error('stat error'));

    const executor = new SandboxToolExecutor({
      readFile: mockReadFile,
      writeFile: mockWriteFile,
      listDir: mockListDir,
      exec: mockExec,
      stat: mockStat,
    });

    await expect(executor.readFile('unknown-file.txt')).rejects.toThrow(/cannot determine file size/i);
    expect(mockReadFile).not.toHaveBeenCalled();
  });

  it('uses streamed path when file size is unknown and offset/limit is given', async () => {
    const mockReadFile = vi.fn().mockResolvedValue('whole file content');
    const mockWriteFile = vi.fn();
    const mockListDir = vi.fn();
    const mockExec = vi.fn().mockResolvedValue({
      exitCode: 0,
      stdout: 'streamed slice line',
      stderr: '',
      timedOut: false,
    });
    const mockStat = vi.fn().mockRejectedValue(new Error('stat error'));

    const executor = new SandboxToolExecutor({
      readFile: mockReadFile,
      writeFile: mockWriteFile,
      listDir: mockListDir,
      exec: mockExec,
      stat: mockStat,
    });

    const result = await executor.readFile('unknown-file.txt', 1, 5);
    expect(result).toBe('streamed slice line');
    expect(mockReadFile).not.toHaveBeenCalled();
    expect(mockExec).toHaveBeenCalledWith(
      expect.arrayContaining(['node', '-e', expect.any(String), 'unknown-file.txt', '1', '5'])
    );
  });

  it('uses stat -L -c "%F %s" in exec to verify file type and size, rejecting non-regular files and huge symlinks', async () => {
    const mockReadFile = vi.fn().mockResolvedValue('file content');
    const mockWriteFile = vi.fn();
    const mockListDir = vi.fn();
    const mockExec = vi.fn().mockImplementation(async (cmd: string[]) => {
      if (cmd[0] === 'stat') {
        expect(cmd).toEqual(['stat', '-L', '-c', '%F %s', 'my-fifo']);
        return {
          exitCode: 0,
          stdout: 'fifo 0\n',
          stderr: '',
          timedOut: false,
        };
      }
      return { exitCode: 1, stdout: '', stderr: '', timedOut: false };
    });

    const executor = new SandboxToolExecutor({
      readFile: mockReadFile,
      writeFile: mockWriteFile,
      listDir: mockListDir,
      exec: mockExec,
    });

    // Whole file read of a FIFO must fail without calling sandbox.readFile
    await expect(executor.readFile('my-fifo')).rejects.toThrow(/cannot determine file size|not a regular file/i);
    expect(mockReadFile).not.toHaveBeenCalled();
  });
});
