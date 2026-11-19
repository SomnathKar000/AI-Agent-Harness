import Docker from 'dockerode';
import { Writable } from 'node:stream';
import type { Workspace, ContainerLimits, ExecOptions, ExecResult } from './types.js';

const docker = new Docker();

export async function startContainer(
  workspace: Workspace,
  limits?: ContainerLimits
): Promise<string> {
  const hostConfig: Docker.HostConfig = {
    NetworkMode: 'none',
    ReadonlyRootfs: true,
    CapDrop: ['ALL'],
    SecurityOpt: ['no-new-privileges'],
    Tmpfs: {
      '/tmp': 'rw,size=64m',
    },
    Binds: [`${workspace.worktreePath}:/workspace:rw`],
  };

  if (limits?.memory) {
    hostConfig.Memory = limits.memory;
  }
  if (limits?.nanoCpus) {
    hostConfig.NanoCpus = limits.nanoCpus;
  }
  if (limits?.pidsLimit) {
    hostConfig.PidsLimit = limits.pidsLimit;
  }

  const container = await docker.createContainer({
    Image: 'harness-sandbox:latest',
    User: 'agent',
    WorkingDir: '/workspace',
    Cmd: ['tail', '-f', '/dev/null'],
    HostConfig: hostConfig,
  });

  await container.start();
  return container.id;
}

export async function installDependencies(
  workspace: Workspace,
  installCommand: string | string[] = ['pnpm', 'install']
): Promise<ExecResult> {
  const cmd = typeof installCommand === 'string'
    ? ['sh', '-c', installCommand]
    : installCommand;

  const container = await docker.createContainer({
    Image: 'harness-sandbox:latest',
    User: 'agent',
    WorkingDir: '/workspace',
    Cmd: cmd,
    HostConfig: {
      NetworkMode: 'bridge',
      CapDrop: ['ALL'],
      SecurityOpt: ['no-new-privileges'],
      Binds: [`${workspace.worktreePath}:/workspace:rw`],
      Tmpfs: {
        '/tmp': 'rw,size=64m',
      },
    },
  });

  try {
    const stream = await container.attach({
      stream: true,
      stdout: true,
      stderr: true,
    });

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];

    const stdoutStream = new Writable({
      write(chunk: Buffer, _encoding, callback) {
        stdoutChunks.push(chunk);
        callback();
      },
    });

    const stderrStream = new Writable({
      write(chunk: Buffer, _encoding, callback) {
        stderrChunks.push(chunk);
        callback();
      },
    });

    container.modem.demuxStream(stream, stdoutStream, stderrStream);

    await container.start();
    const waitResult = await container.wait();

    return {
      exitCode: waitResult.StatusCode ?? 0,
      stdout: Buffer.concat(stdoutChunks).toString('utf8'),
      stderr: Buffer.concat(stderrChunks).toString('utf8'),
      timedOut: false,
    };
  } finally {
    try {
      await container.remove({ force: true });
    } catch {
      // ignore cleanup errors
    }
  }
}

export async function exec(
  containerId: string,
  cmd: string[],
  options?: ExecOptions
): Promise<ExecResult> {
  const container = docker.getContainer(containerId);
  const timeoutMs = options?.timeoutMs;
  const maxOutputBytes = options?.maxOutputBytes ?? 10 * 1024 * 1024;

  let timedOut = false;
  let finalCmd = cmd;

  if (timeoutMs && timeoutMs > 0) {
    const timeoutSec = (timeoutMs / 1000).toFixed(3);
    finalCmd = ['timeout', '--kill-after=1s', `${timeoutSec}s`, ...cmd];
  }

  const execInstance = await container.exec({
    Cmd: finalCmd,
    AttachStdout: true,
    AttachStderr: true,
    WorkingDir: options?.cwd ?? '/workspace',
  });

  const stream = await execInstance.start({ Tty: false });

  let stdoutBytes = 0;
  let stderrBytes = 0;
  const stdoutChunks: Buffer[] = [];
  const stderrChunks: Buffer[] = [];

  const stdoutStream = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      if (stdoutBytes < maxOutputBytes) {
        const remaining = maxOutputBytes - stdoutBytes;
        stdoutChunks.push(chunk.subarray(0, remaining));
        stdoutBytes += chunk.length;
      }
      callback();
    },
  });

  const stderrStream = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      if (stderrBytes < maxOutputBytes) {
        const remaining = maxOutputBytes - stderrBytes;
        stderrChunks.push(chunk.subarray(0, remaining));
        stderrBytes += chunk.length;
      }
      callback();
    },
  });

  container.modem.demuxStream(stream, stdoutStream, stderrStream);

  let hostTimer: NodeJS.Timeout | undefined;
  if (timeoutMs && timeoutMs > 0) {
    hostTimer = setTimeout(() => {
      timedOut = true;
      try {
        stream.destroy();
      } catch {
        // ignore
      }
    }, timeoutMs + 2000);
  }

  await new Promise<void>((resolve, reject) => {
    stream.on('end', () => resolve());
    stream.on('error', (err) => reject(err));
  });

  if (hostTimer) {
    clearTimeout(hostTimer);
  }

  const inspectResult = await execInstance.inspect();
  const exitCode = inspectResult.ExitCode ?? 0;

  // GNU timeout exits with 124 when timing out (or 137 if kill-after triggers SIGKILL)
  if (timeoutMs && (exitCode === 124 || exitCode === 137 || timedOut)) {
    timedOut = true;
  }

  return {
    exitCode,
    stdout: Buffer.concat(stdoutChunks).toString('utf8'),
    stderr: Buffer.concat(stderrChunks).toString('utf8'),
    timedOut,
  };
}
