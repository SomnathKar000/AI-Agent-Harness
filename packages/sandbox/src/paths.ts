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

type SecretFileType =
  | 'env'
  | 'key'
  | 'npmrc'
  | 'netrc'
  | 'pypirc'
  | 'git-credentials'
  | 'json'
  | 'none';

function classifySecretFile(relPath: string, fileName: string): SecretFileType {
  const normRel = relPath.split(path.sep).join('/').toLowerCase();
  const lowerFile = fileName.toLowerCase();

  if (lowerFile === '.env' || lowerFile.startsWith('.env.') || lowerFile === '.envrc') {
    return 'env';
  }
  if (lowerFile.endsWith('.tfvars')) {
    return 'env';
  }
  if (normRel === '.aws/credentials' || normRel.endsWith('/.aws/credentials')) {
    return 'env';
  }
  if (lowerFile === '.npmrc') {
    return 'npmrc';
  }
  if (lowerFile === '.netrc') {
    return 'netrc';
  }
  if (lowerFile === '.pypirc') {
    return 'pypirc';
  }
  if (lowerFile === '.git-credentials') {
    return 'git-credentials';
  }
  if (
    normRel === '.docker/config.json' ||
    normRel.endsWith('/.docker/config.json') ||
    lowerFile === 'credentials.json'
  ) {
    return 'json';
  }
  if (
    lowerFile.endsWith('.pem') ||
    lowerFile.endsWith('.key') ||
    lowerFile.startsWith('id_rsa') ||
    lowerFile.startsWith('id_ed25519') ||
    lowerFile.endsWith('.p12') ||
    lowerFile.endsWith('.pfx')
  ) {
    return 'key';
  }
  return 'none';
}

export async function collectSecretValues(
  workspaceRoot: string,
  options?: { timeoutMs?: number }
): Promise<string[]> {
  const timeoutMs = options?.timeoutMs ?? DEFAULT_FILE_OP_TIMEOUT_MS;

  return withTimeout(
    (async () => {
      const realWorkspaceRoot = fs.realpathSync(workspaceRoot);
      const rootWithSep = realWorkspaceRoot.endsWith(path.sep)
        ? realWorkspaceRoot
        : realWorkspaceRoot + path.sep;

      const secrets = new Set<string>();
      const visitedDirs = new Set<string>();

      async function scanDir(currentDir: string): Promise<void> {
        let realCurrentDir: string;
        try {
          realCurrentDir = fs.realpathSync(currentDir);
        } catch {
          return;
        }

        if (
          realCurrentDir !== realWorkspaceRoot &&
          !realCurrentDir.startsWith(rootWithSep)
        ) {
          return;
        }

        if (visitedDirs.has(realCurrentDir)) {
          return;
        }
        visitedDirs.add(realCurrentDir);

        let entries: fs.Dirent[];
        try {
          entries = await fs.promises.readdir(currentDir, { withFileTypes: true });
        } catch {
          return;
        }

        for (const entry of entries) {
          if (entry.name === '.git' || entry.name === 'node_modules') {
            continue;
          }

          const fullPath = path.join(currentDir, entry.name);

          if (entry.isDirectory()) {
            await scanDir(fullPath);
          } else if (entry.isSymbolicLink()) {
            try {
              const realTarget = fs.realpathSync(fullPath);
              if (
                realTarget !== realWorkspaceRoot &&
                !realTarget.startsWith(rootWithSep)
              ) {
                continue;
              }
              const lstatTarget = fs.statSync(realTarget);
              if (lstatTarget.isDirectory()) {
                await scanDir(fullPath);
              } else if (lstatTarget.isFile()) {
                await processFile(fullPath, entry.name);
              }
            } catch {
              // Broken or looping symlink - skip
            }
          } else if (entry.isFile()) {
            await processFile(fullPath, entry.name);
          }
        }
      }

      async function processFile(filePath: string, fileName: string): Promise<void> {
        const relPath = path.relative(realWorkspaceRoot, filePath);
        const secretType = classifySecretFile(relPath, fileName);
        if (secretType === 'none') {
          return;
        }

        let handle: fs.promises.FileHandle | undefined;
        try {
          handle = await fs.promises.open(
            filePath,
            fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK
          );
          const stats = await handle.stat();
          if (!stats.isFile() || stats.size > MAX_HOST_READ_BYTES) {
            return;
          }

          const rawContent = await handle.readFile({ encoding: 'utf8' });

          if (secretType === 'json') {
            try {
              const parsed = JSON.parse(rawContent);
              function extractStrings(obj: any): void {
                if (typeof obj === 'string') {
                  const val = obj.trim();
                  if (val.length >= 8 && !val.includes('${')) {
                    secrets.add(val);
                  }
                } else if (Array.isArray(obj)) {
                  for (const item of obj) extractStrings(item);
                } else if (obj && typeof obj === 'object') {
                  for (const v of Object.values(obj)) extractStrings(v);
                }
              }
              extractStrings(parsed);
            } catch {
              for (const line of rawContent.split(/\r?\n/)) {
                const trimmed = line.trim();
                if (trimmed.length >= 8 && !trimmed.includes('${')) {
                  secrets.add(trimmed);
                }
              }
            }
            return;
          }

          const lines = rawContent.split(/\r?\n/);

          if (secretType === 'env') {
            for (const line of lines) {
              const trimmed = line.trim();
              if (!trimmed || trimmed.startsWith('#')) continue;
              const eqIdx = trimmed.indexOf('=');
              if (eqIdx !== -1) {
                let val = trimmed.slice(eqIdx + 1).trim();
                if (
                  (val.startsWith('"') && val.endsWith('"')) ||
                  (val.startsWith("'") && val.endsWith("'"))
                ) {
                  val = val.slice(1, -1);
                }
                if (val.length >= 8) {
                  secrets.add(val);
                }
              }
            }
          } else if (secretType === 'npmrc' || secretType === 'pypirc') {
            for (const line of lines) {
              const trimmed = line.trim();
              if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith(';')) continue;
              const eqIdx = trimmed.indexOf('=');
              if (eqIdx !== -1) {
                let val = trimmed.slice(eqIdx + 1).trim();
                if (
                  (val.startsWith('"') && val.endsWith('"')) ||
                  (val.startsWith("'") && val.endsWith("'"))
                ) {
                  val = val.slice(1, -1);
                }
                if (val.length >= 8 && !val.includes('${')) {
                  secrets.add(val);
                }
              }
            }
          } else if (secretType === 'netrc') {
            for (const line of lines) {
              const trimmed = line.trim();
              if (!trimmed || trimmed.startsWith('#')) continue;
              const tokens = trimmed.split(/\s+/);
              for (let i = 0; i < tokens.length; i++) {
                if (tokens[i] === 'password' && i + 1 < tokens.length) {
                  let val = tokens[i + 1].trim();
                  if (
                    (val.startsWith('"') && val.endsWith('"')) ||
                    (val.startsWith("'") && val.endsWith("'"))
                  ) {
                    val = val.slice(1, -1);
                  }
                  if (val.length >= 8 && !val.includes('${')) {
                    secrets.add(val);
                  }
                }
              }
            }
          } else if (secretType === 'git-credentials') {
            for (const line of lines) {
              const trimmed = line.trim();
              if (!trimmed || trimmed.startsWith('#')) continue;
              if (trimmed.length >= 8 && !trimmed.includes('${')) {
                secrets.add(trimmed);
              }
              const credMatch = trimmed.match(/https?:\/\/(?:[^:]+:)?([^@]+)@/);
              if (
                credMatch &&
                credMatch[1] &&
                credMatch[1].length >= 8 &&
                !credMatch[1].includes('${')
              ) {
                secrets.add(credMatch[1]);
              }
            }
          } else {
            for (const line of lines) {
              const trimmed = line.trim();
              if (trimmed.length >= 8) {
                secrets.add(trimmed);
              }
            }
          }
        } catch {
          // Ignore files that cannot be opened safely
        } finally {
          if (handle) {
            await handle.close();
          }
        }
      }

      await scanDir(workspaceRoot);
      return Array.from(secrets);
    })(),
    timeoutMs,
    'collectSecretValues'
  );
}

