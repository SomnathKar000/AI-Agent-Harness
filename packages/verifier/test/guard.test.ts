import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

describe('Verifier Guard Tests', () => {
  it('no raw git calls (execa, exec, spawn) in packages/verifier/src — all host git goes through runGit', () => {
    const srcDir = path.resolve(import.meta.dirname, '../src');
    const files = fs.readdirSync(srcDir).filter((f) => f.endsWith('.ts'));

    const violations: string[] = [];
    const rawGitCallRegex = /(execa|execFile|spawn|fork|exec)\s*\(\s*['"`]git['"`]/;

    for (const file of files) {
      const content = fs.readFileSync(path.join(srcDir, file), 'utf8');
      if (rawGitCallRegex.test(content)) {
        violations.push(file);
      }
    }

    expect(violations).toEqual([]);
  });
});
