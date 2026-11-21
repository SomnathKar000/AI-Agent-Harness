import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  createWorkspace,
  destroy,
  installDependencies,
  runGit,
  type Workspace,
} from '../src/index.js';

describe('Item 4: installDependencies ignoreScripts', { timeout: 60000 }, () => {
  let tempRepo: string;
  let ws: Workspace | undefined;

  afterEach(async () => {
    if (ws) {
      try {
        await destroy({ workspace: ws });
      } catch {
        // ignore
      }
      ws = undefined;
    }
    if (tempRepo && fs.existsSync(tempRepo)) {
      const wtList = await runGit(tempRepo, ['worktree', 'list']);
      const wtLines = wtList.stdout.trim().split('\n');
      expect(wtLines.length).toBe(1);

      const branchList = await runGit(tempRepo, ['branch', '--list', 'harness/*']);
      expect(branchList.stdout.trim()).toBe('');

      fs.rmSync(tempRepo, { recursive: true, force: true });
    }
  });

  it('adds --ignore-scripts by default and allows explicit opt-out with { ignoreScripts: false }', async () => {
    tempRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-scripts-repo-'));
    await runGit(tempRepo, ['init', '-b', 'main']);
    await runGit(tempRepo, ['config', 'user.name', 'Harness Test']);
    await runGit(tempRepo, ['config', 'user.email', 'test@example.com']);

    const pkgJson = {
      name: 'test-scripts-repo',
      version: '1.0.0',
      scripts: {
        postinstall: 'node -e "require(\'fs\').writeFileSync(\'/workspace/POSTINSTALL_RAN\', \'yes\')"',
      },
    };

    fs.writeFileSync(path.join(tempRepo, 'package.json'), JSON.stringify(pkgJson, null, 2));
    await runGit(tempRepo, ['add', '.']);
    await runGit(tempRepo, ['commit', '-m', 'initial commit']);

    const taskId = `install-scripts-${Date.now()}`;
    ws = await createWorkspace(tempRepo, taskId, 'main');

    // 1. Default call: ignoreScripts is true by default
    await installDependencies(ws, ['npm', 'install']);
    const markerDefault = fs.existsSync(path.join(ws.worktreePath, 'POSTINSTALL_RAN'));
    expect(markerDefault).toBe(false);

    // 2. Explicit opt-out: { ignoreScripts: false }
    await installDependencies(ws, ['npm', 'install'], { ignoreScripts: false });
    const markerOptOut = fs.existsSync(path.join(ws.worktreePath, 'POSTINSTALL_RAN'));
    expect(markerOptOut).toBe(true);
  });
});
