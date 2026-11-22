import fs from 'node:fs';
import path from 'node:path';

export const DEFAULT_MAX_WORKTREE_BYTES = 500 * 1024 * 1024; // 500MB

/**
 * Checks the total size of files inside a worktree directory.
 * Fails if the total size exceeds maxBytes (default 500MB).
 */
export async function checkWorktreeSize(
  worktreePath: string,
  maxBytes: number = DEFAULT_MAX_WORKTREE_BYTES
): Promise<{ passed: boolean; sizeBytes: number; limitBytes: number }> {
  let totalBytes = 0;
  let exceeded = false;

  async function walk(currentPath: string): Promise<void> {
    if (exceeded) {
      return;
    }
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(currentPath, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (exceeded) {
        return;
      }
      const fullPath = path.join(currentPath, entry.name);
      try {
        const stats = await fs.promises.lstat(fullPath);
        if (stats.isDirectory()) {
          await walk(fullPath);
        } else if (stats.isFile()) {
          totalBytes += stats.size;
          if (totalBytes > maxBytes) {
            exceeded = true;
            return;
          }
        }
      } catch {
        // Skip inaccessible entries
      }
    }
  }

  await walk(worktreePath);

  return {
    passed: !exceeded && totalBytes <= maxBytes,
    sizeBytes: totalBytes,
    limitBytes: maxBytes,
  };
}
