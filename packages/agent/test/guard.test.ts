import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

describe('Agent Source Security Guard', () => {
  function getAllSourceFiles(dir: string): string[] {
    const results: string[] = [];
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        results.push(...getAllSourceFiles(fullPath));
      } else if (entry.isFile() && (entry.name.endsWith('.ts') || entry.name.endsWith('.js'))) {
        results.push(fullPath);
      }
    }
    return results;
  }

  it('fails if packages/agent/src imports node:fs, node:child_process or execa', () => {
    const srcDir = path.resolve(import.meta.dirname, '../src');
    const files = getAllSourceFiles(srcDir);

    expect(files.length).toBeGreaterThan(0);

    const disallowedPatterns = [
      /from\s+['"]node:fs(\/promises)?['"]/,
      /from\s+['"]fs(\/promises)?['"]/,
      /require\(['"]node:fs(\/promises)?['"]\)/,
      /require\(['"]fs(\/promises)?['"]\)/,
      /from\s+['"]node:child_process['"]/,
      /from\s+['"]child_process['"]/,
      /require\(['"]node:child_process['"]\)/,
      /require\(['"]child_process['"]\)/,
      /from\s+['"]execa['"]/,
      /require\(['"]execa['"]\)/,
    ];

    const violations: { file: string; pattern: string; line: string }[] = [];

    for (const file of files) {
      // container-scripts.ts is allowed because it only exports string constants
      // containing script code that runs INSIDE the container via node -e,
      // never directly on the host agent process.
      if (path.basename(file) === 'container-scripts.ts') {
        continue;
      }

      const content = fs.readFileSync(file, 'utf8');
      const lines = content.split('\n');
      lines.forEach((line, lineIdx) => {
        for (const pattern of disallowedPatterns) {
          if (pattern.test(line)) {
            violations.push({
              file: path.relative(srcDir, file),
              pattern: pattern.toString(),
              line: `L${lineIdx + 1}: ${line.trim()}`,
            });
          }
        }
      });
    }

    expect(
      violations,
      `Direct host filesystem or process execution imports found in packages/agent/src:\n${JSON.stringify(
        violations,
        null,
        2
      )}`
    ).toEqual([]);
  });
});
