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

describe('CLI secret hygiene', () => {
  it('never prints the token or the config object wholesale', () => {
    const violations: string[] = [];
    for (const f of srcFiles()) {
      if (/console\.(log|error|warn|info)\s*\([^)]*\btoken\b/i.test(f.content)) {
        violations.push(`${f.file}: logs something called token`);
      }
      if (/console\.(log|error|warn|info)\s*\(\s*(cfg|config)\s*\)/.test(f.content)) {
        violations.push(`${f.file}: logs the whole config`);
      }
    }
    expect(violations).toEqual([]);
  });

  it('never reads ANTHROPIC_API_KEY or GITHUB_TOKEN — those belong to the host process only (hard rule 4)', () => {
    const banned = /ANTHROPIC_API_KEY|GITHUB_TOKEN/;
    const violations = srcFiles().filter((f) => banned.test(f.content)).map((f) => f.file);
    expect(violations).toEqual([]);
  });

  it('sends the token only in an Authorization header, never in a url or query string', () => {
    const violations: string[] = [];
    for (const f of srcFiles()) {
      if (/[?&](token|access_token|api_key)=/i.test(f.content)) {
        violations.push(`${f.file}: token in a query string`);
      }
    }
    expect(violations).toEqual([]);
  });
});
