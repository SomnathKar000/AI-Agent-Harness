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

export interface PathProtectionResult extends EvaluationResult {
  protected: boolean;
}

export function isInside(root: string, target: string): boolean {
  let realRoot: string;
  try {
    realRoot = fs.realpathSync(root);
  } catch {
    realRoot = path.resolve(root);
  }
  const cleanTarget = path.normalize(target);
  const absTarget = path.isAbsolute(cleanTarget)
    ? path.resolve(cleanTarget)
    : path.resolve(realRoot, cleanTarget);
  const rel = path.relative(realRoot, absTarget);
  const outside = rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel);
  return !outside;
}

export function resolveReal(root: string, targetPath: string): string {
  let realRoot: string;
  try {
    realRoot = fs.realpathSync(root);
  } catch {
    realRoot = path.resolve(root);
  }

  const cleanTarget = path.normalize(targetPath);
  const absTarget = path.isAbsolute(cleanTarget)
    ? path.resolve(cleanTarget)
    : path.resolve(realRoot, cleanTarget);

  let curr = absTarget;
  const segments: string[] = [];

  while (true) {
    try {
      fs.lstatSync(curr);
      break;
    } catch {
      const parent = path.dirname(curr);
      if (parent === curr) {
        break;
      }
      segments.unshift(path.basename(curr));
      curr = parent;
    }
  }

  const realCurr = fs.realpathSync(curr);
  return segments.length > 0 ? path.resolve(realCurr, ...segments) : realCurr;
}

function getNormalizedVariants(str: string): string[] {
  const nfc = str.normalize('NFC').toLowerCase();
  const nfd = str.normalize('NFD').toLowerCase();
  return Array.from(new Set([nfc, nfd]));
}

export function isPathProtected(
  relPath: string,
  policy: PolicyConfig,
  op: 'read' | 'write' | 'edit' | 'list' | 'grep',
  ctx?: PolicyContext
): PathProtectionResult {
  // 1. Check absolute policy file
  if (ctx?.policyFile) {
    const realPolicy = path.resolve(ctx.policyFile).toLowerCase();
    const absDirect = path.isAbsolute(relPath)
      ? path.resolve(relPath)
      : ctx.workspaceRoot
      ? path.resolve(ctx.workspaceRoot, relPath)
      : undefined;
    if (absDirect && path.resolve(absDirect).toLowerCase() === realPolicy) {
      return {
        protected: true,
        decision: 'deny',
        reason: 'Access to policy file is forbidden',
        rule: 'policy_access_deny',
      };
    }
  }

  // 2. Check absolute audit locations
  if (ctx?.auditLocations && ctx.auditLocations.length > 0) {
    const absDirect = path.isAbsolute(relPath)
      ? path.resolve(relPath)
      : ctx.workspaceRoot
      ? path.resolve(ctx.workspaceRoot, relPath)
      : undefined;
    if (absDirect) {
      const resolvedDirect = path.resolve(absDirect).toLowerCase();
      for (const loc of ctx.auditLocations) {
        const realLoc = path.resolve(loc).toLowerCase();
        if (resolvedDirect === realLoc || resolvedDirect.startsWith(realLoc + path.sep)) {
          return {
            protected: true,
            decision: 'deny',
            reason: 'Access to audit files is forbidden',
            rule: 'audit_access_deny',
          };
        }
      }
    }
  }

  // 3. Build path variants (lexical and real)
  const normRel = path.normalize(relPath).split(path.sep).join('/');
  const variants = new Set<string>(getNormalizedVariants(normRel));
  const filenameVariants = new Set<string>(getNormalizedVariants(path.basename(normRel)));

  if (ctx?.workspaceRoot) {
    try {
      const realTarget = resolveReal(ctx.workspaceRoot, relPath);
      let realRoot: string;
      try {
        realRoot = fs.realpathSync(ctx.workspaceRoot);
      } catch {
        realRoot = path.resolve(ctx.workspaceRoot);
      }
      const realRel = path.relative(realRoot, realTarget).split(path.sep).join('/');
      for (const v of getNormalizedVariants(realRel)) {
        variants.add(v);
      }
      for (const f of getNormalizedVariants(path.basename(realTarget))) {
        filenameVariants.add(f);
      }
    } catch {
      // ignore
    }
  }

  // 4. Deny .git/** and .git file
  const hasGit = Array.from(variants).some((v) => {
    const segments = v.split('/');
    return segments.includes('.git');
  });
  if (hasGit) {
    return {
      protected: true,
      decision: 'deny',
      reason: 'Access to .git metadata, file, or hooks is forbidden',
      rule: 'git_dir_deny',
    };
  }

  // 5. Deny .env*
  const hasEnv = Array.from(filenameVariants).some((f) => f === '.env' || f.startsWith('.env.'));
  if (hasEnv) {
    return {
      protected: true,
      decision: 'deny',
      reason: 'Access to .env environment files is forbidden',
      rule: 'env_file_deny',
    };
  }

  // 6. Deny *.pem and *.key
  const hasSecret = Array.from(filenameVariants).some((f) => f.endsWith('.pem') || f.endsWith('.key'));
  if (hasSecret) {
    return {
      protected: true,
      decision: 'deny',
      reason: 'Access to cryptographic keys or certificates (*.pem, *.key) is forbidden',
      rule: 'secret_file_deny',
    };
  }

  // 7. Configured denyPatterns
  for (const pattern of policy.files.denyPatterns) {
    const re = new RegExp(pattern, 'i');
    const matches =
      Array.from(variants).some((v) => re.test(v)) ||
      Array.from(filenameVariants).some((f) => re.test(f));
    if (matches) {
      return {
        protected: true,
        decision: 'deny',
        reason: `Path matched deny pattern: ${pattern}`,
        rule: 'file_pattern_deny',
      };
    }
  }

  // 8. Name-based policy and audit files inside workspace
  const hasPolicyName = Array.from(variants).some(
    (v) =>
      v === 'policy' ||
      v.startsWith('policy/') ||
      v.endsWith('policy.yaml') ||
      v.endsWith('policy.yml')
  );
  const hasAuditName = Array.from(variants).some(
    (v) =>
      v === 'audit' ||
      v.startsWith('audit/') ||
      v.includes('audit.log') ||
      v.includes('audit_log')
  );

  if (hasPolicyName || hasAuditName) {
    if (op === 'read' || op === 'grep' || op === 'list') {
      return {
        protected: false,
        decision: 'allow',
        rule: 'file_allow',
      };
    } else {
      return {
        protected: true,
        decision: 'ask',
        reason: hasPolicyName
          ? 'Modifying policy files or directory requires human approval'
          : 'Modifying audit files requires human approval',
        rule: 'policy_audit_ask',
      };
    }
  }

  // 9. Check .github/** and .npmrc
  const hasGitHub = Array.from(variants).some((v) => v === '.github' || v.startsWith('.github/'));
  const hasNpmrc = Array.from(filenameVariants).some((f) => f === '.npmrc');
  if (hasGitHub || hasNpmrc) {
    if (op === 'write' || op === 'edit') {
      return {
        protected: true,
        decision: 'ask',
        reason: hasGitHub
          ? 'Modifying CI workflows (.github/**) requires human approval'
          : 'Modifying package manager configuration (.npmrc) requires human approval',
        rule: hasGitHub ? 'github_ci_ask' : 'npmrc_ask',
      };
    } else {
      return {
        protected: false,
        decision: 'allow',
        rule: 'file_allow',
      };
    }
  }

  // 10. Configured askPatterns
  for (const askRule of policy.files.askPatterns) {
    const re = new RegExp(askRule.pattern, 'i');
    const matches =
      Array.from(variants).some((v) => re.test(v)) ||
      Array.from(filenameVariants).some((f) => re.test(f));
    if (matches && askRule.operations.includes(op)) {
      return {
        protected: true,
        decision: 'ask',
        reason: askRule.reason ?? 'File modification requires human approval',
        rule: 'file_ask_pattern',
      };
    }
  }

  return {
    protected: false,
    decision: 'allow',
    rule: 'file_allow',
  };
}

export async function evaluate(
  call: ToolCall,
  ctx: PolicyContext,
  policyConfig?: PolicyConfig
): Promise<EvaluationResult> {
  // Fail-closed: ctx.callCount is required
  if (typeof ctx?.callCount !== 'number') {
    return {
      decision: 'deny',
      reason: 'ctx.callCount is required and must be a number',
      rule: 'policy_context_error',
    };
  }

  const policy = policyConfig ?? loadPolicy(ctx.policyFile);

  // 1. Check Task Call Count Limit
  const maxCalls = ctx.maxCallsPerTask ?? policy.limits?.maxCallsPerTask ?? 100;
  if (ctx.callCount > maxCalls) {
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

function evaluateFileTool(
  call: ToolCall,
  ctx: PolicyContext,
  policy: PolicyConfig
): EvaluationResult {
  // Fail closed: if path is present but not a string, deny immediately
  if ('path' in call.input && typeof call.input.path !== 'string') {
    return {
      decision: 'deny',
      reason: 'input.path must be a string',
      rule: 'invalid_path',
    };
  }

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
    if (call.input.content.includes('[REDACTED]')) {
      return {
        decision: 'deny',
        reason: 'Attempt to write content containing "[REDACTED]". Re-read the file via a path that is not masked or to ask for help.',
        rule: 'redaction_marker_deny',
      };
    }
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
    if (
      (typeof call.input.new_string === 'string' && call.input.new_string.includes('[REDACTED]')) ||
      (typeof call.input.old_string === 'string' && call.input.old_string.includes('[REDACTED]'))
    ) {
      return {
        decision: 'deny',
        reason: 'Attempt to edit content containing "[REDACTED]". Re-read the file via a path that is not masked or to ask for help.',
        rule: 'redaction_marker_deny',
      };
    }
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
  const absLexical = path.isAbsolute(cleanRawPath)
    ? path.resolve(cleanRawPath)
    : path.resolve(realWorkspaceRoot, cleanRawPath);

  // Check lexical containment
  if (!isInside(realWorkspaceRoot, absLexical)) {
    return {
      decision: 'deny',
      reason: `Path "${rawPath}" resolves outside workspace root`,
      rule: 'workspace_escape',
    };
  }

  // Resolve REAL path using deepest existing ancestor
  let realTarget: string;
  try {
    realTarget = resolveReal(ctx.workspaceRoot, rawPath);
  } catch (err: any) {
    const msg = err?.message || String(err);
    if (msg.includes('ELOOP') || err?.code === 'ELOOP') {
      return {
        decision: 'deny',
        reason: `Symlink loop detected: "${rawPath}"`,
        rule: 'symlink_loop',
      };
    }
    return {
      decision: 'deny',
      reason: `Broken or unresolvable symlink or path: "${rawPath}"`,
      rule: 'broken_symlink',
    };
  }

  // Check REAL containment
  if (!isInside(realWorkspaceRoot, realTarget)) {
    return {
      decision: 'deny',
      reason: `Path "${rawPath}" resolves outside workspace root (${realTarget})`,
      rule: 'symlink_escape',
    };
  }

  // Special files check (FIFO, device files, sockets) via lstat
  for (const p of [absLexical, realTarget]) {
    try {
      const stat = fs.lstatSync(p);
      if (stat.isFIFO() || stat.isCharacterDevice() || stat.isBlockDevice() || stat.isSocket()) {
        return {
          decision: 'deny',
          reason: `Path "${rawPath}" is a FIFO or special device file`,
          rule: 'special_file_deny',
        };
      }
    } catch {
      // File may not exist yet
    }
  }

  // Check symlink target for FIFO / special device
  try {
    const stat = fs.statSync(realTarget);
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

  const op =
    call.name === 'write_file'
      ? 'write'
      : call.name === 'edit_file'
      ? 'edit'
      : call.name === 'list_dir'
      ? 'list'
      : call.name === 'grep'
      ? 'grep'
      : 'read';

  // Check protected names on BOTH lexical relative path and real relative path
  const relLexical = path.relative(realWorkspaceRoot, absLexical);
  const relReal = path.relative(realWorkspaceRoot, realTarget);

  const lexicalCheck = isPathProtected(relLexical, policy, op, ctx);
  if (lexicalCheck.decision !== 'allow') {
    return lexicalCheck;
  }

  const realCheck = isPathProtected(relReal, policy, op, ctx);
  if (realCheck.decision !== 'allow') {
    return realCheck;
  }

  // Lockfile edit check (allowed, but flagged): only if protected checks allowed and target is a lockfile
  const isWriteOp = call.name === 'write_file' || call.name === 'edit_file';
  if (isWriteOp) {
    const baseName = path.basename(realTarget).toLowerCase();
    const rawBase = path.basename(cleanRawPath).toLowerCase();
    if (LOCKFILES.includes(baseName) || LOCKFILES.includes(rawBase)) {
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

  // Command names bare name check (no / or \)
  const argv0 = argv[0];
  if (argv0.includes('/') || argv0.includes('\\')) {
    return {
      decision: 'deny',
      reason: `Command name "${argv0}" must be a bare name without path separators`,
      rule: 'command_path_separator_deny',
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

  const baseCmd = argv0.toLowerCase();

  // 2. Reject shell wrappers
  if (SHELL_BINARIES.includes(baseCmd)) {
    return {
      decision: 'deny',
      reason: `Shell wrapper command "${argv0}" is forbidden`,
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
    if (argv.some((a) => a === '~' || !isInside(ctx.workspaceRoot, a))) {
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
    const realScript = resolveReal(realWorkspaceRoot, cleanScriptPath);

    if (
      !isInside(realWorkspaceRoot, resolvedScript) ||
      !isInside(realWorkspaceRoot, realScript)
    ) {
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
        if (!isInside(realWorkspaceRoot, resolvedFlagPath)) {
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
