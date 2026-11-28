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
      if (entry.isDirectory()) walk(full, rel);
      else if (entry.name.endsWith('.ts')) out.push({ file: rel, content: fs.readFileSync(full, 'utf8') });
    }
  };
  walk(SRC_DIR);
  return out;
}

describe('CLI guard tests', () => {
  it('has source files to guard (an empty src would make every guard below vacuous)', () => {
    expect(srcFiles().length).toBeGreaterThan(1);
  });

  it('never imports worker, sandbox, db, policy, verifier or agent (hard rule 1: cli -> api over HTTP only)', () => {
    const banned = /from\s+['"`]@harness\/(worker|sandbox|db|policy|verifier|agent|github)['"`]/;
    const violations = srcFiles().filter((f) => banned.test(f.content)).map((f) => f.file);
    expect(violations).toEqual([]);
  });

  it('no raw git calls (hard rule 6)', () => {
    const rawGit = /(execa|execFile|execFileSync|execSync|spawnSync|spawn|fork|exec)\s*\(\s*['"`]git['"`]/;
    const violations = srcFiles().filter((f) => rawGit.test(f.content)).map((f) => f.file);
    expect(violations).toEqual([]);
  });

  it('does not import node:child_process or execa (hard rule 7)', () => {
    const banned = /from\s+['"`](node:)?child_process['"`]|require\(\s*['"`](node:)?child_process['"`]\s*\)|from\s+['"`]execa['"`]/;
    const violations = srcFiles().filter((f) => banned.test(f.content)).map((f) => f.file);
    expect(violations).toEqual([]);
  });

  it('never touches the database or a queue directly', () => {
    const banned = /from\s+['"`](drizzle-orm|postgres|bullmq|ioredis|dockerode)['"`]/;
    const violations = srcFiles().filter((f) => banned.test(f.content)).map((f) => f.file);
    expect(violations).toEqual([]);
  });
});
