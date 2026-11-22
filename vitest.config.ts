import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    passWithNoTests: true,
    // Docker teardown (destroy container + destroy worktree + the git assertions in each
    // afterEach) routinely needs more than vitest's 10s default under load. When the hook
    // expired mid-loop it left worktree directories in ~/.harness/worktrees, and worktrees
    // and harness/* branches in the fixture repos.
    //
    // hookTimeout is config-only: it is NOT a valid option in describe(name, options, fn),
    // where only `timeout` is honoured, so it cannot be set per suite.
    //
    // 120s, and deliberately not less. Teardown is bimodal, not bounded: on a quiet machine
    // it is 3305-6601ms (reports/r3-teardown-timing.txt), but under sustained container
    // churn a teardown blew a 30s budget outright (reports/r5-all-tests.txt). Docker is not
    // clogged when this happens — 5 containers, 7 images — but the Docker VM has only
    // ~3.9GiB (reports/r5-docker-state.txt), so `docker rm` grows a long tail under memory
    // pressure. A 30s ceiling sized on the quiet-machine sample turns that into a red suite
    // that has nothing to do with the code under test.
    //
    // The cost is honest: a genuine hang takes 120s to surface. Teardown has always
    // completed at this ceiling across full runs, so the slowness is latency, not a hang.
    hookTimeout: 120000,
    // Same reasoning for the per-test budget. vitest's default is 5s, but these suites do
    // real git and docker work: a container exec test was observed at 9222ms and the Rule 6
    // package.json test at >5000ms under load. Suites that knew this already declared
    // `{ timeout: 30000 }` or 60000 themselves; every file that did not was silently
    // running against 5s and failing by luck of the load. 30s makes the default coherent
    // with the work, and a suite needing more still overrides it locally.
    testTimeout: 30000,
  },
});
