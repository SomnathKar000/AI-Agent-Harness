import fs from 'node:fs';
import path from 'node:path';

export const DEFAULT_MAX_WORKTREE_BYTES = 500 * 1024 * 1024; // 500MB

export interface WorktreeSizeResult {
  passed: boolean;
  /** When earlyExit is true this is a lower bound, not the full tree size. */
  sizeBytes: number;
  limitBytes: number;
  /** Filesystem entries stat'ed before the walk stopped. Lets tests prove the early exit. */
  entriesVisited: number;
  /** True when the walk aborted because the limit was already exceeded. */
  earlyExit: boolean;
}

export interface WorktreeSizeOptions {
  /** Called for every entry as it is visited; used by tests to observe the early exit. */
  onVisit?: (fullPath: string) => void;
}

/**
 * Totals the bytes under a worktree, including .git — a committed blob is what gets pushed,
 * so excluding .git would miss exactly the case this check exists for.
 *
 * The walk aborts as soon as the limit is exceeded, so a huge tree is not walked in full.
 */
export async function checkWorktreeSize(
  worktreePath: string,
  maxBytes: number = DEFAULT_MAX_WORKTREE_BYTES,
  options?: WorktreeSizeOptions
): Promise<WorktreeSizeResult> {
  let totalBytes = 0;
  let entriesVisited = 0;
  let exceeded = false;

  async function walk(currentPath: string): Promise<void> {
    if (exceeded) return;

    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(currentPath, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (exceeded) return;
      const fullPath = path.join(currentPath, entry.name);
      entriesVisited++;
      options?.onVisit?.(fullPath);
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
        // Skip inaccessible entries.
      }
    }
  }

  await walk(worktreePath);

  return {
    passed: !exceeded && totalBytes <= maxBytes,
    sizeBytes: totalBytes,
    limitBytes: maxBytes,
    entriesVisited,
    earlyExit: exceeded,
  };
}
