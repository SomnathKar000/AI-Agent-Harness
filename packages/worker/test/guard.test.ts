import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const SRC_DIR = path.resolve(import.meta.dirname, '../src');

function srcFiles(): { file: string; content: string }[] {
  const out: { file: string; content: string }[] = [];
  const walk = (dir: string, prefix = ''): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        walk(full, rel);
      } else if (entry.name.endsWith('.ts')) {
        out.push({ file: rel, content: fs.readFileSync(full, 'utf8') });
      }
    }
  };
  walk(SRC_DIR);
  return out;
}

describe('Worker guard tests', () => {
  it('has source files to guard (an empty src would make every guard below vacuous)', () => {
    expect(srcFiles().length).toBeGreaterThan(0);
  });

  it('no raw git calls in packages/worker/src — all host git goes through runGit (hard rule 6)', () => {
    const rawGitCallRegex = /(execa|execFile|execFileSync|execSync|spawnSync|spawn|fork|exec)\s*\(\s*['"`]git['"`]/;
    const violations = srcFiles()
      .filter((f) => rawGitCallRegex.test(f.content))
      .map((f) => f.file);
    expect(violations).toEqual([]);
  });

  it('does not import node:child_process or execa anywhere in src (hard rule 7)', () => {
    const banned = /from\s+['"`](node:)?child_process['"`]|require\(\s*['"`](node:)?child_process['"`]\s*\)|from\s+['"`]execa['"`]/;
    const violations = srcFiles()
      .filter((f) => banned.test(f.content))
      .map((f) => f.file);
    expect(violations).toEqual([]);
  });

  it('does not import @harness/cli or @harness/api (hard rule 1: cli -> api over HTTP only)', () => {
    const banned = /from\s+['"`]@harness\/(cli|api)['"`]/;
    const violations = srcFiles()
      .filter((f) => banned.test(f.content))
      .map((f) => f.file);
    expect(violations).toEqual([]);
  });

  it('appendStep is called from exactly one file — one writer for task_steps (hard rule 15)', () => {
    const writers = srcFiles()
      .filter((f) => /\bappendStep\s*\(/.test(f.content))
      .map((f) => f.file);
    expect(writers).toEqual(['step-logger.ts']);
  });

  it('never writes tasks.status directly — status moves only through transitionTask (hard rule 9)', () => {
    const violations: string[] = [];
    for (const f of srcFiles()) {
      // Any update of the tasks table, or any object literal assigning `status:` to a db
      // update, is a direct status write. transitionTask is the only permitted path.
      if (/\.update\s*\(\s*(schema\.)?tasks\s*\)/.test(f.content)) {
        violations.push(`${f.file}: db.update(tasks)`);
      }
      if (/setTaskFields\s*\([^)]*status\s*:/s.test(f.content)) {
        violations.push(`${f.file}: setTaskFields with status`);
      }
    }
    expect(violations).toEqual([]);
  });
});
