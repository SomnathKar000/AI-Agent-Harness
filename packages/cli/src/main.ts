import { loadCliConfig } from './config.js';
import { HarnessClient } from './client.js';
import { buildProgram } from './commands.js';

export interface MainOptions {
  env?: Record<string, string | undefined>;
  out?: (line: string) => void;
  err?: (line: string) => void;
}

/**
 * Entry point. Resolves config, builds the client, and hands both to the command layer
 * with the client's scrubber wired in so nothing printed can carry the token.
 *
 * Returns the process exit code rather than calling process.exit, so it is testable.
 */
export async function main(argv: string[], options: MainOptions = {}): Promise<number> {
  const out = options.out ?? ((line: string) => console.log(line));
  const err = options.err ?? ((line: string) => console.error(line));

  let client: HarnessClient;
  try {
    const config = loadCliConfig(options.env ?? process.env);
    client = new HarnessClient(config);
  } catch (e) {
    err(e instanceof Error ? e.message : String(e));
    return 2;
  }

  const program = buildProgram({
    client,
    out,
    err,
    scrub: (text) => client.scrub(text),
  });

  try {
    await program.parseAsync(argv);
    return 0;
  } catch (e) {
    // commander throws on --help and --version too; those are not failures.
    const code = (e as { code?: string }).code;
    if (code === 'commander.helpDisplayed' || code === 'commander.version' || code === 'commander.help') {
      return 0;
    }
    return 1;
  }
}
