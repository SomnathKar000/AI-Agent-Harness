import fs from 'node:fs';
import path from 'node:path';

/**
 * Resolves a user-provided path within a workspace root.
 * Enforces that the resolved path and any symlinks stay strictly within the workspace root.
 * Throws an Error if a path escape or external symlink is detected.
 */
export function resolveSafePath(workspaceRoot: string, userPath: string): string {
  if (typeof userPath !== 'string' || userPath.includes('\0')) {
    throw new Error(`Invalid path: contains null bytes or is not a string`);
  }

  // Resolve canonical workspace root (handling e.g. /var vs /private/var on macOS)
  if (!fs.existsSync(workspaceRoot)) {
    throw new Error(`Workspace root does not exist: ${workspaceRoot}`);
  }
  const realWorkspaceRoot = fs.realpathSync(workspaceRoot);
  const rootWithSep = realWorkspaceRoot.endsWith(path.sep)
    ? realWorkspaceRoot
    : realWorkspaceRoot + path.sep;

  // Normalize candidate path
  let candidate: string;
  if (userPath === '/workspace') {
    candidate = realWorkspaceRoot;
  } else if (userPath.startsWith('/workspace/')) {
    const rel = userPath.slice('/workspace/'.length);
    candidate = path.resolve(realWorkspaceRoot, rel);
  } else if (path.isAbsolute(userPath)) {
    // If an absolute path is passed, ensure it is within workspace
    candidate = path.resolve(userPath);
  } else {
    candidate = path.resolve(realWorkspaceRoot, userPath);
  }

  // Initial lexical check
  if (candidate !== realWorkspaceRoot && !candidate.startsWith(rootWithSep)) {
    throw new Error(`Path escape detected: ${userPath} is outside workspace`);
  }

  // Check if target exists on filesystem
  const lstat = fs.lstatSync(candidate, { throwIfNoEntry: false });
  if (lstat) {
    const realCandidate = fs.realpathSync(candidate);
    if (realCandidate !== realWorkspaceRoot && !realCandidate.startsWith(rootWithSep)) {
      throw new Error(
        `Path escape detected: symlink ${userPath} points outside workspace to ${realCandidate}`
      );
    }
    return realCandidate;
  }

  // If target does not exist yet (e.g. for writeFile), verify all existing parent directories
  let current = path.dirname(candidate);
  while (current !== path.dirname(current)) {
    if (fs.existsSync(current)) {
      const realDir = fs.realpathSync(current);
      if (realDir !== realWorkspaceRoot && !realDir.startsWith(rootWithSep)) {
        throw new Error(
          `Path escape detected: parent directory symlink points outside workspace`
        );
      }
      break;
    }
    current = path.dirname(current);
  }

  return candidate;
}

export const DEFAULT_FILE_OP_TIMEOUT_MS = 5000;
export const MAX_HOST_READ_BYTES = 5 * 1024 * 1024; // 5MB

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number = DEFAULT_FILE_OP_TIMEOUT_MS,
  opName = 'File operation'
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`${opName} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });
  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export interface FileOpOptions {
  timeoutMs?: number;
  maxBytes?: number;
}

export async function readFile(
  workspaceRoot: string,
  userPath: string,
  encoding: BufferEncoding = 'utf8',
  options?: FileOpOptions
): Promise<string> {
  const timeoutMs = options?.timeoutMs ?? DEFAULT_FILE_OP_TIMEOUT_MS;
  const maxBytes = options?.maxBytes ?? MAX_HOST_READ_BYTES;

  return withTimeout(
    (async () => {
      const safePath = resolveSafePath(workspaceRoot, userPath);
      let handle: fs.promises.FileHandle | undefined;
      try {
        handle = await fs.promises.open(
          safePath,
          fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK
        );
        const stats = await handle.stat();
        if (!stats.isFile()) {
          throw new Error(`Not a regular file: ${userPath}`);
        }
        if (stats.size > maxBytes) {
          throw new Error(
            `File is too large (${stats.size} bytes exceeds limit of ${maxBytes} bytes)`
          );
        }
        const buffer = await handle.readFile({ encoding });
        return buffer;
      } finally {
        if (handle) {
          await handle.close();
        }
      }
    })(),
    timeoutMs,
    'readFile'
  );
}

export async function writeFile(
  workspaceRoot: string,
  userPath: string,
  content: string | Uint8Array,
  encoding: BufferEncoding = 'utf8',
  options?: { timeoutMs?: number }
): Promise<void> {
  const timeoutMs = options?.timeoutMs ?? DEFAULT_FILE_OP_TIMEOUT_MS;

  return withTimeout(
    (async () => {
      const safePath = resolveSafePath(workspaceRoot, userPath);
      await fs.promises.mkdir(path.dirname(safePath), { recursive: true });
      let handle: fs.promises.FileHandle | undefined;
      try {
        handle = await fs.promises.open(
          safePath,
          fs.constants.O_WRONLY |
            fs.constants.O_CREAT |
            fs.constants.O_TRUNC |
            fs.constants.O_NOFOLLOW |
            fs.constants.O_NONBLOCK
        );
        const stats = await handle.stat();
        if (!stats.isFile()) {
          throw new Error(`Not a regular file: ${userPath}`);
        }
        await handle.writeFile(content, { encoding });
      } finally {
        if (handle) {
          await handle.close();
        }
      }
    })(),
    timeoutMs,
    'writeFile'
  );
}

export async function listDir(
  workspaceRoot: string,
  userPath: string = '.',
  options?: { timeoutMs?: number }
): Promise<string[]> {
  const timeoutMs = options?.timeoutMs ?? DEFAULT_FILE_OP_TIMEOUT_MS;

  return withTimeout(
    (async () => {
      const safePath = resolveSafePath(workspaceRoot, userPath);
      let handle: fs.promises.FileHandle | undefined;
      try {
        handle = await fs.promises.open(
          safePath,
          fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK
        );
        const stats = await handle.stat();
        if (!stats.isDirectory()) {
          throw new Error(`Not a directory: ${userPath}`);
        }
      } finally {
        if (handle) {
          await handle.close();
        }
      }
      return fs.promises.readdir(safePath);
    })(),
    timeoutMs,
    'listDir'
  );
}

export async function stat(
  workspaceRoot: string,
  userPath: string,
  options?: { timeoutMs?: number }
): Promise<fs.Stats> {
  const timeoutMs = options?.timeoutMs ?? DEFAULT_FILE_OP_TIMEOUT_MS;

  return withTimeout(
    (async () => {
      const safePath = resolveSafePath(workspaceRoot, userPath);
      let handle: fs.promises.FileHandle | undefined;
      try {
        handle = await fs.promises.open(
          safePath,
          fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK
        );
        const stats = await handle.stat();
        if (!stats.isFile()) {
          throw new Error(`Not a regular file: ${userPath}`);
        }
        return stats;
      } finally {
        if (handle) {
          await handle.close();
        }
      }
    })(),
    timeoutMs,
    'stat'
  );
}

