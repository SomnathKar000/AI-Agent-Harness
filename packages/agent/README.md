# @harness/agent

A thin agent loop on the Anthropic Messages API for automated bug fixing in an isolated container sandbox.

## Features

- **Direct Messages API**: Thin loop on raw Anthropic Messages API with structured tool use and prompt caching.
- **Strict Policy Gate**: Default-deny security model. Every tool call evaluates through an injected `PolicyGate` before execution.
- **Sequential Execution**: Tool calls execute strictly sequentially, returning matching tool results.
- **Host Security**: API keys exist only in the host process and are redacted from all logged task steps.
- **Limits & Context Control**: Guardrails for max steps, max cost, and execution duration with automatic history elision.
- **Container Decoupling**: File and command operations run through a `ToolExecutor` interface inside locked-down sandboxes.

## Tools

- `list_dir`: Inspect files and folders in a directory.
- `read_file`: Read file contents (max 200KB, supports line offset and limit).
- `write_file`: Create or overwrite workspace files.
- `edit_file`: Exact unique string replacement (errors if 0 or >1 matches).
- `grep`: Fast pattern search across code files.
- `run_command`: Execute commands via argv array (no shell string) with timeout.
- `finish`: Complete task with root cause and fix summary.
- `needs_info`: Request human clarification for ambiguous instructions.
