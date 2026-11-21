import type { Repo } from '@harness/core';
import { exec as sandboxExec } from '@harness/sandbox';
import type { VerificationCheck, VerifierSandbox } from './types.js';

async function executeInContainer(
  sandbox: VerifierSandbox,
  commandStr: string
): Promise<{ exitCode: number; stdout: string; stderr: string; timedOut: boolean }> {
  const cmd = ['sh', '-c', commandStr];

  if (sandbox.exec) {
    return await sandbox.exec(cmd);
  }

  if (sandbox.containerId) {
    return await sandboxExec(sandbox.containerId, cmd);
  }

  throw new Error(
    'No container available for execution. Commands must run inside the container only.'
  );
}

/**
 * Runs lint, typecheck, and test commands inside the container only.
 * Reruns testCommand once if it fails; if rerun passes, marks check passed with flaky=true.
 */
export async function runContainerChecks(
  sandbox: VerifierSandbox,
  repo: Repo
): Promise<{ passed: boolean; checks: VerificationCheck[]; flaky: boolean }> {
  const checks: VerificationCheck[] = [];
  let isFlaky = false;
  let allPassed = true;

  // 1. Lint
  if (repo.lintCommand && repo.lintCommand.trim()) {
    const res = await executeInContainer(sandbox, repo.lintCommand);
    const passed = res.exitCode === 0;
    if (!passed) allPassed = false;
    checks.push({
      name: 'lint',
      passed,
      output: (res.stdout + '\n' + res.stderr).trim(),
    });
  }

  // 2. Typecheck
  if (repo.typecheckCommand && repo.typecheckCommand.trim()) {
    const res = await executeInContainer(sandbox, repo.typecheckCommand);
    const passed = res.exitCode === 0;
    if (!passed) allPassed = false;
    checks.push({
      name: 'typecheck',
      passed,
      output: (res.stdout + '\n' + res.stderr).trim(),
    });
  }

  // 3. Tests
  if (repo.testCommand && repo.testCommand.trim()) {
    const firstRes = await executeInContainer(sandbox, repo.testCommand);
    if (firstRes.exitCode === 0) {
      checks.push({
        name: 'test',
        passed: true,
        output: (firstRes.stdout + '\n' + firstRes.stderr).trim(),
        flaky: false,
      });
    } else {
      // If tests fail, rerun that run once
      const secondRes = await executeInContainer(sandbox, repo.testCommand);
      if (secondRes.exitCode === 0) {
        isFlaky = true;
        checks.push({
          name: 'test',
          passed: true,
          output: `Passed on rerun (flaky=true):\n${(secondRes.stdout + '\n' + secondRes.stderr).trim()}`,
          flaky: true,
        });
      } else {
        allPassed = false;
        checks.push({
          name: 'test',
          passed: false,
          output: `Initial failure:\n${(firstRes.stdout + '\n' + firstRes.stderr).trim()}\n\nRerun failure:\n${(secondRes.stdout + '\n' + secondRes.stderr).trim()}`,
          flaky: false,
        });
      }
    }
  }

  return {
    passed: allPassed,
    checks,
    flaky: isFlaky,
  };
}
