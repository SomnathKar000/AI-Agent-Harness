import type { ToolParam, ToolExecutor } from '../types.js';
import {
  ListDirSchema,
  ReadFileSchema,
  WriteFileSchema,
  EditFileSchema,
  GrepSchema,
  RunCommandSchema,
  FinishSchema,
  NeedsInfoSchema,
} from './schemas.js';

export const MAX_TOOL_OUTPUT_BYTES = 20 * 1024; // 20KB

export function truncateToolOutput(output: string): string {
  const totalBytes = Buffer.byteLength(output, 'utf8');
  if (totalBytes <= MAX_TOOL_OUTPUT_BYTES) {
    return output;
  }
  const excessBytes = totalBytes - MAX_TOOL_OUTPUT_BYTES;
  const buf = Buffer.from(output, 'utf8');
  const slice = buf.subarray(0, MAX_TOOL_OUTPUT_BYTES).toString('utf8');
  return `${slice}\n[truncated ${excessBytes} bytes]`;
}

export const AGENT_TOOLS: ToolParam[] = [
  {
    name: 'list_dir',
    description: 'List contents of a directory in the workspace.',
    input_schema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Relative directory path to list. Defaults to "."',
        },
      },
    },
  },
  {
    name: 'read_file',
    description:
      'Read the contents of a file (up to 200KB). Supports line-based offset and limit.',
    input_schema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Relative path to the file to read.',
        },
        offset: {
          type: 'integer',
          description: '1-based line number to start reading from.',
        },
        limit: {
          type: 'integer',
          description: 'Maximum number of lines to read.',
        },
      },
      required: ['path'],
    },
  },
  {
    name: 'write_file',
    description: 'Create or overwrite a file with given content.',
    input_schema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Relative file path to write.',
        },
        content: {
          type: 'string',
          description: 'Full text content to write into the file.',
        },
      },
      required: ['path', 'content'],
    },
  },
  {
    name: 'edit_file',
    description:
      'Perform an exact unique string replacement in a file. Errors if old_string occurs 0 or >1 times.',
    input_schema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Relative file path to edit.',
        },
        old_string: {
          type: 'string',
          description: 'Exact text segment to replace (must appear exactly once).',
        },
        new_string: {
          type: 'string',
          description: 'Replacement text segment.',
        },
      },
      required: ['path', 'old_string', 'new_string'],
    },
  },
  {
    name: 'grep',
    description: 'Search for a string pattern across files in the workspace.',
    input_schema: {
      type: 'object',
      properties: {
        pattern: {
          type: 'string',
          description: 'The search pattern or regex.',
        },
        path: {
          type: 'string',
          description: 'Relative path or directory to search in. Defaults to "."',
        },
      },
      required: ['pattern'],
    },
  },
  {
    name: 'run_command',
    description:
      'Execute a command using an argv array (no shell string) inside the isolated container.',
    input_schema: {
      type: 'object',
      properties: {
        argv: {
          type: 'array',
          items: { type: 'string' },
          description: 'Command and arguments as an array of strings, e.g. ["pnpm", "test"].',
        },
        timeoutMs: {
          type: 'integer',
          description: 'Timeout in milliseconds.',
        },
      },
      required: ['argv'],
    },
  },
  {
    name: 'finish',
    description:
      'Call this when you have reproduced the bug, verified the fix, and passed all tests.',
    input_schema: {
      type: 'object',
      properties: {
        summary: {
          type: 'string',
          description: 'Summary of the bug fix and changes made.',
        },
        root_cause: {
          type: 'string',
          description: 'Explanation of the root cause of the bug.',
        },
      },
      required: ['summary', 'root_cause'],
    },
  },
  {
    name: 'needs_info',
    description:
      'Call this if the task description is too vague to act on, asking a clarifying question.',
    input_schema: {
      type: 'object',
      properties: {
        question: {
          type: 'string',
          description: 'Clarifying question for the user.',
        },
      },
      required: ['question'],
    },
  },
];

export interface ToolExecutionResult {
  content: string;
  isError: boolean;
  finishData?: { summary: string; root_cause: string };
  needsInfoData?: { question: string };
}

export async function executeTool(
  toolName: string,
  rawInput: unknown,
  executor: ToolExecutor
): Promise<ToolExecutionResult> {
  try {
    switch (toolName) {
      case 'list_dir': {
        const parsed = ListDirSchema.safeParse(rawInput);
        if (!parsed.success) {
          return {
            content: `Invalid input for tool list_dir: ${parsed.error.message}`,
            isError: true,
          };
        }
        const entries = await executor.listDir(parsed.data.path);
        const output = Array.isArray(entries) ? entries.join('\n') : entries;
        return {
          content: output || '(empty directory)',
          isError: false,
        };
      }

      case 'read_file': {
        const parsed = ReadFileSchema.safeParse(rawInput);
        if (!parsed.success) {
          return {
            content: `Invalid input for tool read_file: ${parsed.error.message}`,
            isError: true,
          };
        }
        const content = await executor.readFile(
          parsed.data.path,
          parsed.data.offset,
          parsed.data.limit
        );
        return {
          content: content,
          isError: false,
        };
      }

      case 'write_file': {
        const parsed = WriteFileSchema.safeParse(rawInput);
        if (!parsed.success) {
          return {
            content: `Invalid input for tool write_file: ${parsed.error.message}`,
            isError: true,
          };
        }
        await executor.writeFile(parsed.data.path, parsed.data.content);
        return {
          content: `File written successfully: ${parsed.data.path}`,
          isError: false,
        };
      }

      case 'edit_file': {
        const parsed = EditFileSchema.safeParse(rawInput);
        if (!parsed.success) {
          return {
            content: `Invalid input for tool edit_file: ${parsed.error.message}`,
            isError: true,
          };
        }
        await executor.editFile(
          parsed.data.path,
          parsed.data.old_string,
          parsed.data.new_string
        );
        return {
          content: `File edited successfully: ${parsed.data.path}`,
          isError: false,
        };
      }

      case 'grep': {
        const parsed = GrepSchema.safeParse(rawInput);
        if (!parsed.success) {
          return {
            content: `Invalid input for tool grep: ${parsed.error.message}`,
            isError: true,
          };
        }
        const output = await executor.grep(parsed.data.pattern, parsed.data.path);
        return {
          content: output,
          isError: false,
        };
      }

      case 'run_command': {
        const parsed = RunCommandSchema.safeParse(rawInput);
        if (!parsed.success) {
          return {
            content: `Invalid input for tool run_command: ${parsed.error.message}`,
            isError: true,
          };
        }
        const result = await executor.runCommand(
          parsed.data.argv,
          parsed.data.timeoutMs
        );
        const parts = [
          `Exit code: ${result.exitCode}${result.timedOut ? ' (timed out)' : ''}`,
        ];
        if (result.stdout.trim()) {
          parts.push(`STDOUT:\n${result.stdout}`);
        }
        if (result.stderr.trim()) {
          parts.push(`STDERR:\n${result.stderr}`);
        }
        const combined = parts.join('\n');
        return {
          content: combined,
          isError: result.exitCode !== 0 || result.timedOut,
        };
      }

      case 'finish': {
        const parsed = FinishSchema.safeParse(rawInput);
        if (!parsed.success) {
          return {
            content: `Invalid input for tool finish: ${parsed.error.message}`,
            isError: true,
          };
        }
        return {
          content: `Finished: ${parsed.data.summary}`,
          isError: false,
          finishData: parsed.data,
        };
      }

      case 'needs_info': {
        const parsed = NeedsInfoSchema.safeParse(rawInput);
        if (!parsed.success) {
          return {
            content: `Invalid input for tool needs_info: ${parsed.error.message}`,
            isError: true,
          };
        }
        return {
          content: `Needs info: ${parsed.data.question}`,
          isError: false,
          needsInfoData: parsed.data,
        };
      }

      default:
        return {
          content: `Unknown tool: ${toolName}`,
          isError: true,
        };
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      content: truncateToolOutput(message),
      isError: true,
    };
  }
}
