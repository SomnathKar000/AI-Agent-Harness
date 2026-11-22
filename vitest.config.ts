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
    hookTimeout: 120000,
  },
});
