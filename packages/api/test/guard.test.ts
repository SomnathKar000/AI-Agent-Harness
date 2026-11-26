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

describe('API guard tests', () => {
  it('has source files to guard', () => {
    expect(srcFiles().length).toBeGreaterThan(0);
  });

  it('does not import worker, sandbox, agent, policy or verifier (hard rule 1)', () => {
    const banned = /from\s+['"`]@harness\/(worker|sandbox|agent|policy|verifier|github)['"`]/;
    const violations = srcFiles()
      .filter((f) => banned.test(f.content))
      .map((f) => f.file);
    expect(violations).toEqual([]);
  });

  it('contains no raw git and no child_process (hard rules 6 and 7)', () => {
    const banned =
      /(execa|execFile|execFileSync|execSync|spawnSync|spawn|fork|exec)\s*\(\s*['"`]git['"`]|from\s+['"`](node:)?child_process['"`]|from\s+['"`]execa['"`]/;
    const violations = srcFiles()
      .filter((f) => banned.test(f.content))
      .map((f) => f.file);
    expect(violations).toEqual([]);
  });

  it('never writes task_steps — the agent loop is the only writer (hard rule 15)', () => {
    const violations = srcFiles()
      .filter((f) => /\bappendStep\s*\(|\btaskSteps\s*\)/.test(f.content))
      .map((f) => f.file);
    expect(violations).toEqual([]);
  });

  it('never writes tasks.status directly — only transitionTask (hard rule 9)', () => {
    const violations = srcFiles()
      .filter((f) => /\.update\s*\(\s*(schema\.)?tasks\s*\)/.test(f.content))
      .map((f) => f.file);
    expect(violations).toEqual([]);
  });

  it('binds to loopback only and offers no way to configure a public host', () => {
    const configSource = srcFiles().find((f) => f.file === 'config.ts');
    expect(configSource).toBeDefined();
    expect(configSource!.content).toContain("'127.0.0.1'");
    // No host env var exists to override it.
    expect(/env\.[A-Z_]*HOST/.test(configSource!.content)).toBe(false);
  });
});
