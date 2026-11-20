import fs from 'node:fs';
import path from 'node:path';
import type { ToolCall } from '@harness/agent';
import { loadPolicy } from './loader.js';
import type { EvaluationResult, PolicyConfig, PolicyContext } from './types.js';

const SHELL_METACHARS = [';', '&&', '||', '|', '$(', '`'];
const SHELL_BINARIES = ['sh', 'bash', 'zsh', 'ksh', 'csh', 'tcsh', 'dash'];
const FORBIDDEN_NETWORK_BINARIES = ['curl', 'wget', 'ssh', 'scp', 'nc', 'docker', 'sudo', 'npx'];
const FORBIDDEN_PKG_FLAGS = ['-c', '--dir', '--prefix', '--registry', '--config'];
const LOCKFILES = ['pnpm-lock.yaml', 'package-lock.json', 'yarn.lock'];
const MAX_PATH_LENGTH = 1024;
const MAX_ARGV_LENGTH = 4096;
const MAX_FILE_SIZE = 1024 * 1024; // 1MB

export async function evaluate(
  call: ToolCall,
  ctx: PolicyContext,
  policyConfig?: PolicyConfig
): Promise<EvaluationResult> {
  const policy = policyConfig ?? loadPolicy(ctx.policyFile);

  // 1. Check Task Call Count Limit
  const maxCalls = ctx.maxCallsPerTask ?? policy.limits?.maxCallsPerTask ?? 100;
  if (ctx.callCount !== undefined && ctx.callCount > maxCalls) {
    return {
      decision: 'deny',
      reason: `Task call count limit exceeded (${ctx.callCount} > ${maxCalls})`,
      rule: 'limit_call_count',
    };
  }

  // 2. Control tools are always allowed
  if (call.name === 'finish' || call.name === 'needs_info') {
    return {
      decision: 'allow',
      rule: 'control_tool',
    };
  }

  // 3. File tools evaluation
  if (
    call.name === 'read_file' ||
    call.name === 'write_file' ||
    call.name === 'edit_file' ||
    call.name === 'list_dir' ||
    call.name === 'grep'
  ) {
    return evaluateFileTool(call, ctx, policy);
  }

  // 4. Command execution evaluation
  if (call.name === 'run_command') {
    return evaluateRunCommand(call, ctx);
  }

  // 5. Unknown tool -> default deny
  return {
    decision: 'deny',
    reason: `Tool "${call.name}" is not recognized`,
    rule: 'unknown_tool_deny',
  };
}

function getNormalizedVariants(str: string): string[] {
  const nfc = str.normalize('NFC').toLowerCase();
  const nfd = str.normalize('NFD').toLowerCase();
  return Array.from(new Set([nfc, nfd]));
}

function evaluateFileTool(
  call: ToolCall,
  ctx: PolicyContext,
  policy: PolicyConfig
): EvaluationResult {
  const rawPath = typeof call.input.path === 'string' ? call.input.path : '.';

  // Check path length (max 1KB)
  if (rawPath.length > MAX_PATH_LENGTH) {
    return {
      decision: 'deny',
      reason: `Path length (${rawPath.length}) exceeds maximum limit of ${MAX_PATH_LENGTH} characters`,
      rule: 'path_length_limit',
    };
  }

  // Check for NUL character in path
  if (rawPath.includes('\0')) {
    return {
      decision: 'deny',
      reason: 'Path contains forbidden NUL character',
      rule: 'path_nul_deny',
    };
  }

  // Check write output size limit (1MB)
  if (call.name === 'write_file' && typeof call.input.content === 'string') {
    const size = Buffer.byteLength(call.input.content);
    if (size > MAX_FILE_SIZE) {
      return {
        decision: 'deny',
        reason: `Content size (${size} bytes) exceeds 1MB limit`,
        rule: 'limit_output_size',
      };
    }
  }

  // Check edit_file content size limit (1MB)
  if (call.name === 'edit_file') {
    if (typeof call.input.new_string === 'string') {
      const size = Buffer.byteLength(call.input.new_string);
      if (size > MAX_FILE_SIZE) {
        return {
          decision: 'deny',
          reason: `Replacement content size (${size} bytes) exceeds 1MB limit`,
          rule: 'limit_output_size',
        };
      }
    }
    if (typeof call.input.old_string === 'string') {
      const size = Buffer.byteLength(call.input.old_string);
      if (size > MAX_FILE_SIZE) {
        return {
          decision: 'deny',
          reason: `Target content size (${size} bytes) exceeds 1MB limit`,
          rule: 'limit_output_size',
        };
      }
    }
  }

  // Check read requested limit
  if (call.name === 'read_file' && typeof call.input.limit === 'number') {
    if (call.input.limit > MAX_FILE_SIZE) {
      return {
        decision: 'deny',
        reason: `Requested limit (${call.input.limit}) exceeds 1MB limit`,
        rule: 'limit_output_size',
      };
    }
  }

  let realWorkspaceRoot: string;
  try {
    realWorkspaceRoot = fs.realpathSync(ctx.workspaceRoot);
  } catch {
    realWorkspaceRoot = path.resolve(ctx.workspaceRoot);
  }

  const cleanRawPath = path.normalize(rawPath);
  const resolvedTarget = path.isAbsolute(cleanRawPath)
    ? path.resolve(cleanRawPath)
    : path.resolve(realWorkspaceRoot, cleanRawPath);

  // Check direct path escape (parent traversal or absolute path outside workspace)
  const relDirect = path.relative(realWorkspaceRoot, resolvedTarget);
  if (relDirect.startsWith('..') || path.isAbsolute(relDirect)) {
    return {
      decision: 'deny',
      reason: `Path "${rawPath}" resolves outside workspace root`,
      rule: 'workspace_escape',
    };
  }

  // Special files check (FIFO, device files, sockets) via lstat
  let lstat: fs.Stats | undefined;
  try {
    lstat = fs.lstatSync(resolvedTarget);
  } catch {
    // File may not exist yet
  }

  if (lstat && (lstat.isFIFO() || lstat.isCharacterDevice() || lstat.isBlockDevice() || lstat.isSocket())) {
    return {
      decision: 'deny',
      reason: `Path "${rawPath}" is a FIFO or special device file`,
      rule: 'special_file_deny',
    };
  }

  // Check symlinks
  let realTarget: string | undefined;
  if (lstat?.isSymbolicLink()) {
    try {
      realTarget = fs.realpathSync(resolvedTarget);
    } catch {
      return {
        decision: 'deny',
        reason: `Broken or unresolvable symlink "${rawPath}"`,
        rule: 'broken_symlink',
      };
    }

    const relReal = path.relative(realWorkspaceRoot, realTarget);
    if (relReal.startsWith('..') || path.isAbsolute(relReal)) {
      return {
        decision: 'deny',
        reason: `Symlink "${rawPath}" points outside workspace root (${realTarget})`,
        rule: 'symlink_escape',
      };
    }

    // Check if symlink target is a FIFO or special device
    try {
      const stat = fs.statSync(resolvedTarget);
      if (stat.isFIFO() || stat.isCharacterDevice() || stat.isBlockDevice() || stat.isSocket()) {
        return {
          decision: 'deny',
          reason: `Target of symlink "${rawPath}" is a FIFO or special device file`,
          rule: 'special_file_deny',
        };
      }
    } catch {
      // ignore
    }
  }

  // Check parent symlinks if file doesn't exist yet
  if (!lstat) {
    let curr = path.dirname(resolvedTarget);
    while (!fs.existsSync(curr) && curr !== path.dirname(curr)) {
      curr = path.dirname(curr);
    }
    let realCurr = curr;
    try {
      realCurr = fs.realpathSync(curr);
    } catch {
      // ignore
    }
    const relRemainder = path.relative(curr, resolvedTarget);
    const realFinal = path.resolve(realCurr, relRemainder);
    const relFromWs = path.relative(realWorkspaceRoot, realFinal);
    if (relFromWs.startsWith('..') || path.isAbsolute(relFromWs)) {
      return {
        decision: 'deny',
        reason: `Path "${rawPath}" resolves outside workspace root via parent symlink`,
        rule: 'symlink_escape',
      };
    }
  }

  // Build normalized relative path variants (NFC, NFD, case-insensitive)
  const normRel = path.relative(realWorkspaceRoot, resolvedTarget).split(path.sep).join('/');
  const normTarget = realTarget
    ? path.relative(realWorkspaceRoot, realTarget).split(path.sep).join('/')
    : undefined;
  const rawNorm = cleanRawPath.split(path.sep).join('/');

  const pathVariants = [
    ...getNormalizedVariants(normRel),
    ...(normTarget ? getNormalizedVariants(normTarget) : []),
    ...getNormalizedVariants(rawNorm),
  ];

  const filename = path.basename(resolvedTarget);
  const targetFilename = realTarget ? path.basename(realTarget) : '';
  const rawFilename = path.basename(cleanRawPath);
  const filenameVariants = [
    ...getNormalizedVariants(filename),
    ...(targetFilename ? getNormalizedVariants(targetFilename) : []),
    ...getNormalizedVariants(rawFilename),
  ];

  // Deny policy file access
  if (ctx.policyFile) {
    const realPolicy = path.resolve(ctx.policyFile);
    if (resolvedTarget === realPolicy || realTarget === realPolicy) {
      return {
        decision: 'deny',
        reason: 'Access to policy file is forbidden',
        rule: 'policy_access_deny',
      };
    }
  }
  const hasPolicy = pathVariants.some(
    (v) =>
      v === 'policy' ||
      v.startsWith('policy/') ||
      v.endsWith('policy.yaml') ||
      v.endsWith('policy.yml')
  );
  if (hasPolicy) {
    return {
      decision: 'deny',
      reason: 'Access to policy file or directory is forbidden',
      rule: 'policy_access_deny',
    };
  }

  // Deny audit files access
  if (ctx.auditLocations) {
    for (const loc of ctx.auditLocations) {
      const realLoc = path.resolve(loc);
      if (
        resolvedTarget === realLoc ||
        resolvedTarget.startsWith(realLoc + path.sep) ||
        (realTarget && (realTarget === realLoc || realTarget.startsWith(realLoc + path.sep)))
      ) {
        return {
          decision: 'deny',
          reason: 'Access to audit files is forbidden',
          rule: 'audit_access_deny',
        };
      }
    }
  }
  const hasAudit = pathVariants.some(
    (v) =>
      v === 'audit' ||
      v.startsWith('audit/') ||
      v.includes('audit.log') ||
      v.includes('audit_log')
  );
  if (hasAudit) {
    return {
      decision: 'deny',
      reason: 'Access to audit files is forbidden',
      rule: 'audit_access_deny',
    };
  }

  // Deny .git/** and .git file (case-insensitive and unicode normalized)
  const hasGit = pathVariants.some((v) => {
    const segments = v.split('/');
    return segments.includes('.git');
  });
  if (hasGit) {
    return {
      decision: 'deny',
      reason: 'Access to .git metadata, file, or hooks is forbidden',
      rule: 'git_dir_deny',
    };
  }

  // Deny .env* (case-insensitive and unicode normalized)
  const hasEnv = filenameVariants.some((f) => f === '.env' || f.startsWith('.env.'));
  if (hasEnv) {
    return {
      decision: 'deny',
      reason: 'Access to .env environment files is forbidden',
      rule: 'env_file_deny',
    };
  }

  // Deny *.pem and *.key (case-insensitive and unicode normalized)
  const hasSecret = filenameVariants.some((f) => f.endsWith('.pem') || f.endsWith('.key'));
  if (hasSecret) {
    return {
      decision: 'deny',
      reason: 'Access to cryptographic keys or certificates (*.pem, *.key) is forbidden',
      rule: 'secret_file_deny',
    };
  }

  // Configured file deny patterns
  for (const pattern of policy.files.denyPatterns) {
    const re = new RegExp(pattern, 'i');
    if (pathVariants.some((v) => re.test(v))) {
      return {
        decision: 'deny',
        reason: `Path matched deny pattern: ${pattern}`,
        rule: 'file_pattern_deny',
      };
    }
  }

  // ASK check for writes to CI (.github/**) and .npmrc
  const isWriteOp = call.name === 'write_file' || call.name === 'edit_file';
  if (isWriteOp) {
    const hasGitHub = pathVariants.some((v) => v === '.github' || v.startsWith('.github/'));
    if (hasGitHub) {
      return {
        decision: 'ask',
        reason: 'Modifying CI workflows (.github/**) requires human approval',
        rule: 'github_ci_ask',
      };
    }

    const hasNpmrc = filenameVariants.some((f) => f === '.npmrc');
    if (hasNpmrc) {
      return {
        decision: 'ask',
        reason: 'Modifying package manager configuration (.npmrc) requires human approval',
        rule: 'npmrc_ask',
      };
    }

    // Configured ask patterns
    for (const askRule of policy.files.askPatterns) {
      const re = new RegExp(askRule.pattern, 'i');
      if (pathVariants.some((v) => re.test(v))) {
        const op = call.name === 'write_file' ? 'write' : 'edit';
        if (askRule.operations.includes(op)) {
          return {
            decision: 'ask',
            reason: askRule.reason ?? 'File modification requires human approval',
            rule: 'file_ask_pattern',
          };
        }
      }
    }

    // Lockfile edit check (allowed, but flagged)
    const isLockfile = filenameVariants.some((f) => LOCKFILES.includes(f));
    if (isLockfile) {
      return {
        decision: 'allow',
        reason: 'Lockfile modification allowed with diff report flag',
        rule: 'lockfile_edit',
        flag: 'lockfile_edit',
      };
    }
  }

  return {
    decision: 'allow',
    rule: 'file_allow',
  };
}

function evaluateRunCommand(call: ToolCall, ctx: PolicyContext): EvaluationResult {
  const argv = Array.isArray(call.input.argv) ? (call.input.argv as string[]) : [];

  if (argv.length === 0 || !argv.every((a) => typeof a === 'string')) {
    return {
      decision: 'deny',
      reason: 'run_command argv must be a non-empty array of strings',
      rule: 'invalid_argv',
    };
  }

  // 1. Check for NUL, newline, length limits, and shell metacharacters
  for (const arg of argv) {
    if (arg.length > MAX_ARGV_LENGTH) {
      return {
        decision: 'deny',
        reason: `Argv element exceeds maximum length of ${MAX_ARGV_LENGTH} characters (${arg.length} chars)`,
        rule: 'argv_length_limit',
      };
    }

    if (arg.includes('\0') || arg.includes('\n') || arg.includes('\r')) {
      return {
        decision: 'deny',
        reason: 'Argv element contains forbidden control characters (NUL, newline)',
        rule: 'argv_control_char_deny',
      };
    }

    for (const meta of SHELL_METACHARS) {
      if (arg.includes(meta)) {
        return {
          decision: 'deny',
          reason: `Shell metacharacter "${meta}" is forbidden in argv: "${arg}"`,
          rule: 'shell_metachar_deny',
        };
      }
    }
  }

  const baseCmd = path.basename(argv[0]).toLowerCase();

  // 2. Reject shell wrappers
  if (SHELL_BINARIES.includes(baseCmd)) {
    return {
      decision: 'deny',
      reason: `Shell wrapper command "${argv[0]}" is forbidden`,
      rule: 'shell_wrapper_deny',
    };
  }

  // 3. git command is removed entirely from agent allowlist
  if (baseCmd === 'git') {
    return {
      decision: 'deny',
      reason: 'git commands are not permitted for the agent (the harness uses runGit on the host)',
      rule: 'git_forbidden',
    };
  }

  // 4. Deny dangerous binaries
  if (FORBIDDEN_NETWORK_BINARIES.includes(baseCmd)) {
    return {
      decision: 'deny',
      reason: `Command "${baseCmd}" is forbidden`,
      rule: 'dangerous_binary_deny',
    };
  }

  if (baseCmd === 'chmod') {
    if (argv.some((a) => a === '777' || a === '0777' || a.includes('777'))) {
      return {
        decision: 'deny',
        reason: 'chmod 777 is forbidden',
        rule: 'chmod_777_deny',
      };
    }
  }

  if (baseCmd === 'rm') {
    if (argv.some((a) => a.startsWith('/') || a.startsWith('..') || a === '~')) {
      return {
        decision: 'deny',
        reason: 'rm with absolute or parent paths is forbidden',
        rule: 'rm_dangerous_deny',
      };
    }
  }

  // 5. Node hardening: only "node <path inside workspace>", no flags before script path
  if (baseCmd === 'node') {
    if (argv.length < 2) {
      return {
        decision: 'deny',
        reason: 'node requires a script path argument',
        rule: 'node_no_script',
      };
    }

    const scriptArg = argv[1];
    if (scriptArg.startsWith('-')) {
      return {
        decision: 'deny',
        reason: `Node flags before script path are forbidden: "${scriptArg}"`,
        rule: 'node_flag_deny',
      };
    }

    let realWorkspaceRoot: string;
    try {
      realWorkspaceRoot = fs.realpathSync(ctx.workspaceRoot);
    } catch {
      realWorkspaceRoot = path.resolve(ctx.workspaceRoot);
    }

    const cleanScriptPath = path.normalize(scriptArg);
    const resolvedScript = path.isAbsolute(cleanScriptPath)
      ? path.resolve(cleanScriptPath)
      : path.resolve(realWorkspaceRoot, cleanScriptPath);

    const relScript = path.relative(realWorkspaceRoot, resolvedScript);
    if (relScript.startsWith('..') || path.isAbsolute(relScript)) {
      return {
        decision: 'deny',
        reason: `Node script "${scriptArg}" resolves outside workspace root`,
        rule: 'node_script_outside_workspace',
      };
    }

    return {
      decision: 'allow',
      reason: `node script "${scriptArg}" is allowlisted`,
      rule: 'node_allow',
    };
  }

  // 6. Package manager hardening (pnpm, npm, yarn)
  if (baseCmd === 'pnpm' || baseCmd === 'npm' || baseCmd === 'yarn') {
    // Deny forbidden flags like -C, --dir, --prefix, --registry, --config, exec, dlx
    for (const arg of argv.slice(1)) {
      const lower = arg.toLowerCase();
      if (
        lower === 'exec' ||
        lower === 'dlx' ||
        FORBIDDEN_PKG_FLAGS.some(
          (flag) => lower === flag || lower.startsWith(flag + '=') || lower.startsWith('-c')
        )
      ) {
        return {
          decision: 'deny',
          reason: `Package manager flag or subcommand is forbidden in "${argv.join(' ')}"`,
          rule: 'pkg_flag_deny',
        };
      }
    }

    // ASK for dependency additions
    const isDependencyAdd =
      (baseCmd === 'pnpm' && argv[1] === 'add') ||
      (baseCmd === 'npm' && (argv[1] === 'install' || argv[1] === 'i' || argv[1] === 'add') && argv.length > 2) ||
      (baseCmd === 'yarn' && argv[1] === 'add');

    if (isDependencyAdd) {
      return {
        decision: 'ask',
        reason: `Adding dependencies via "${baseCmd} ${argv[1]}" requires human approval`,
        rule: 'dependency_add_ask',
      };
    }

    // Allow ONLY exactly: test | run test | run lint | run typecheck | run build
    const rest = argv.slice(1);
    const isExactTest = rest.length === 1 && rest[0] === 'test';
    const isExactRun =
      rest.length === 2 &&
      rest[0] === 'run' &&
      ['test', 'lint', 'typecheck', 'build'].includes(rest[1]);

    if (isExactTest || isExactRun) {
      return {
        decision: 'allow',
        reason: `Command "${argv.join(' ')}" is allowlisted`,
        rule: 'package_manager_allow',
      };
    }

    return {
      decision: 'deny',
      reason: `Command "${argv.join(' ')}" is not an allowed package manager command`,
      rule: 'pkg_cmd_deny',
    };
  }

  // 7. tsc / vitest / eslint hardening: deny configs/outputs pointing outside workspace
  if (baseCmd === 'tsc' || baseCmd === 'vitest' || baseCmd === 'eslint') {
    const pathFlags = ['--config', '-c', '-p', '--outdir', '--outfile'];
    let realWorkspaceRoot: string;
    try {
      realWorkspaceRoot = fs.realpathSync(ctx.workspaceRoot);
    } catch {
      realWorkspaceRoot = path.resolve(ctx.workspaceRoot);
    }

    for (let i = 1; i < argv.length; i++) {
      const arg = argv[i];
      const lowerArg = arg.toLowerCase();
      let targetPath: string | undefined;

      for (const flag of pathFlags) {
        if (lowerArg === flag && i + 1 < argv.length) {
          targetPath = argv[i + 1];
          break;
        } else if (lowerArg.startsWith(flag + '=')) {
          targetPath = arg.slice(flag.length + 1);
          break;
        }
      }

      if (targetPath) {
        const cleanPath = path.normalize(targetPath);
        const resolvedFlagPath = path.isAbsolute(cleanPath)
          ? path.resolve(cleanPath)
          : path.resolve(realWorkspaceRoot, cleanPath);
        const rel = path.relative(realWorkspaceRoot, resolvedFlagPath);
        if (rel.startsWith('..') || path.isAbsolute(rel)) {
          return {
            decision: 'deny',
            reason: `Flag "${arg}" target "${targetPath}" resolves outside workspace root`,
            rule: 'tool_path_escape_deny',
          };
        }
      }
    }

    return {
      decision: 'allow',
      reason: `Command "${baseCmd}" is allowlisted`,
      rule: 'dev_tool_allow',
    };
  }

  // 8. Default deny
  return {
    decision: 'deny',
    reason: `Command "${argv.join(' ')}" is not allowlisted`,
    rule: 'default_deny',
  };
}
