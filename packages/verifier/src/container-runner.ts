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

function combineOutput(res: { stdout: string; stderr: string }): string {
  return `${res.stdout}\n${res.stderr}`.trim();
}

/**
 * Runs lint, typecheck and tests inside the container only.
 *
 * Every check requires exitCode === 0 && !timedOut. A missing or empty command is a FAILED
 * check with rule `command_not_configured` — never a skip, for lint as much as for the
 * others: an unconfigured command is an unverified repo, not a passing one.
 *
 * The test command is rerun once if the first run fails; a passing rerun is flaky=true.
 */
export async function runContainerChecks(
  sandbox: VerifierSandbox,
  repo: Repo
): Promise<{ passed: boolean; checks: VerificationCheck[]; flaky: boolean }> {
  const checks: VerificationCheck[] = [];
  let isFlaky = false;
  let allPassed = true;

  const runSimpleCheck = async (name: string, command: string | null | undefined) => {
    if (!command || !command.trim()) {
      allPassed = false;
      checks.push({
        name,
        passed: false,
        rule: 'command_not_configured',
        output: `Failed: no ${name} command is configured for this repo`,
      });
      return;
    }
    const res = await executeInContainer(sandbox, command);
    const passed = res.exitCode === 0 && !res.timedOut;
    if (!passed) allPassed = false;
    checks.push({
      name,
      passed,
      rule: passed ? undefined : res.timedOut ? 'command_timed_out' : 'command_failed',
      output: res.timedOut ? `${name} timed out:\n${combineOutput(res)}` : combineOutput(res),
    });
  };

  await runSimpleCheck('lint', repo.lintCommand);
  await runSimpleCheck('typecheck', repo.typecheckCommand);

  // Tests, with a single rerun on failure.
  if (repo.testCommand && repo.testCommand.trim()) {
    const firstRes = await executeInContainer(sandbox, repo.testCommand);
    if (firstRes.exitCode === 0 && !firstRes.timedOut) {
      checks.push({ name: 'test', passed: true, output: combineOutput(firstRes), flaky: false });
    } else {
      const secondRes = await executeInContainer(sandbox, repo.testCommand);
      if (secondRes.exitCode === 0 && !secondRes.timedOut) {
        isFlaky = true;
        checks.push({
          name: 'test',
          passed: true,
          output: `Passed on rerun (flaky=true):\n${combineOutput(secondRes)}`,
          flaky: true,
        });
      } else {
        allPassed = false;
        checks.push({
          name: 'test',
          passed: false,
          rule: firstRes.timedOut || secondRes.timedOut ? 'command_timed_out' : 'command_failed',
          output: `Initial failure${firstRes.timedOut ? ' (timed out)' : ''}:\n${combineOutput(
            firstRes
          )}\n\nRerun failure${secondRes.timedOut ? ' (timed out)' : ''}:\n${combineOutput(
            secondRes
          )}`,
          flaky: false,
        });
      }
    }
  } else {
    allPassed = false;
    checks.push({
      name: 'test',
      passed: false,
      rule: 'command_not_configured',
      output: 'Failed: no test command is configured for this repo',
    });
  }

  return { passed: allPassed, checks, flaky: isFlaky };
}
