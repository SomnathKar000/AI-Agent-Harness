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

export async function readFile(
  workspaceRoot: string,
  userPath: string,
  encoding: BufferEncoding = 'utf8'
): Promise<string> {
  const safePath = resolveSafePath(workspaceRoot, userPath);
  return fs.promises.readFile(safePath, encoding);
}

export async function writeFile(
  workspaceRoot: string,
  userPath: string,
  content: string | Uint8Array,
  encoding: BufferEncoding = 'utf8'
): Promise<void> {
  const safePath = resolveSafePath(workspaceRoot, userPath);
  await fs.promises.mkdir(path.dirname(safePath), { recursive: true });
  await fs.promises.writeFile(safePath, content, encoding);
}

export async function listDir(
  workspaceRoot: string,
  userPath: string = '.'
): Promise<string[]> {
  const safePath = resolveSafePath(workspaceRoot, userPath);
  return fs.promises.readdir(safePath);
}
