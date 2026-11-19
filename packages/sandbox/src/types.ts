export interface Workspace {
  taskId: string;
  repoPath: string;
  worktreePath: string;
  branch: string;
  baseBranch: string;
}

export interface ContainerLimits {
  memory?: number;
  nanoCpus?: number;
  pidsLimit?: number;
}

export interface ExecOptions {
  timeoutMs?: number;
  maxOutputBytes?: number;
  cwd?: string;
}

export interface ExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export interface DestroyTarget {
  containerId?: string;
  workspace?: Workspace;
}
