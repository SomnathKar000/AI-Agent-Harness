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
 * Requires exitCode === 0 && !timedOut for every check.
 * Missing or empty testCommand and typecheckCommand are failed checks.
 * Lint may stay optional but must be recorded as an explicit skipped check.
 * Reruns testCommand once if it fails; if rerun passes, marks check passed with flaky=true.
 */
export async function runContainerChecks(
  sandbox: VerifierSandbox,
  repo: Repo
): Promise<{ passed: boolean; checks: VerificationCheck[]; flaky: boolean }> {
  const checks: VerificationCheck[] = [];
  let isFlaky = false;
  let allPassed = true;

  // 1. Lint (optional, recorded as explicit skipped check if missing)
  if (repo.lintCommand && repo.lintCommand.trim()) {
    const res = await executeInContainer(sandbox, repo.lintCommand);
    const passed = res.exitCode === 0 && !res.timedOut;
    if (!passed) allPassed = false;
    checks.push({
      name: 'lint',
      passed,
      output: res.timedOut
        ? `Lint timed out:\n${(res.stdout + '\n' + res.stderr).trim()}`
        : (res.stdout + '\n' + res.stderr).trim(),
    });
  } else {
    checks.push({
      name: 'lint',
      passed: true,
      output: 'Skipped: no lintCommand configured',
    });
  }

  // 2. Typecheck (required: missing or empty is a failed check)
  if (repo.typecheckCommand && repo.typecheckCommand.trim()) {
    const res = await executeInContainer(sandbox, repo.typecheckCommand);
    const passed = res.exitCode === 0 && !res.timedOut;
    if (!passed) allPassed = false;
    checks.push({
      name: 'typecheck',
      passed,
      output: res.timedOut
        ? `Typecheck timed out:\n${(res.stdout + '\n' + res.stderr).trim()}`
        : (res.stdout + '\n' + res.stderr).trim(),
    });
  } else {
    allPassed = false;
    checks.push({
      name: 'typecheck',
      passed: false,
      output: 'Failed: missing or empty typecheckCommand',
    });
  }

  // 3. Tests (required: missing or empty is a failed check)
  if (repo.testCommand && repo.testCommand.trim()) {
    const firstRes = await executeInContainer(sandbox, repo.testCommand);
    if (firstRes.exitCode === 0 && !firstRes.timedOut) {
      checks.push({
        name: 'test',
        passed: true,
        output: (firstRes.stdout + '\n' + firstRes.stderr).trim(),
        flaky: false,
      });
    } else {
      // If tests fail or time out, rerun that run once
      const secondRes = await executeInContainer(sandbox, repo.testCommand);
      if (secondRes.exitCode === 0 && !secondRes.timedOut) {
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
          output: `Initial failure${firstRes.timedOut ? ' (timed out)' : ''}:\n${(firstRes.stdout + '\n' + firstRes.stderr).trim()}\n\nRerun failure${secondRes.timedOut ? ' (timed out)' : ''}:\n${(secondRes.stdout + '\n' + secondRes.stderr).trim()}`,
          flaky: false,
        });
      }
    }
  } else {
    allPassed = false;
    checks.push({
      name: 'test',
      passed: false,
      output: 'Failed: missing or empty testCommand',
    });
  }

  return {
    passed: allPassed,
    checks,
    flaky: isFlaky,
  };
}
