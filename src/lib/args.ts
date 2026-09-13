/**
 * A 60-line argument parser.
 *
 * The whole CLI takes about a dozen flags; a dependency here would cost more to
 * audit than it saves. Behaviour: `--flag`, `--key value`, `--key=value`,
 * `-h` aliases, and `--` to stop parsing.
 */

export interface ParsedArgs {
  command: string;
  positionals: string[];
  flags: Record<string, string | boolean>;
}

export class ArgError extends Error {
  readonly usage: string | undefined;
  constructor(message: string, usage?: string) {
    super(message);
    this.name = "ArgError";
    this.usage = usage;
  }
}

const ALIASES: Record<string, string> = {
  h: "help",
  v: "version",
};

export function parseArgs(argv: readonly string[]): ParsedArgs {
  const flags: Record<string, string | boolean> = {};
  const positionals: string[] = [];
  let command = "";

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === undefined) continue;

    if (token === "--") {
      positionals.push(...argv.slice(i + 1));
      break;
    }

    if (token.startsWith("--")) {
      const body = token.slice(2);
      const eq = body.indexOf("=");
      if (eq !== -1) {
        flags[body.slice(0, eq)] = body.slice(eq + 1);
        continue;
      }
      const next = argv[i + 1];
      // A following bare token is the value, unless it is itself a flag or we
      // are at the end — `--live employee-1` must not swallow the positional.
      if (next !== undefined && !next.startsWith("-")) {
        flags[body] = next;
        i += 1;
      } else {
        flags[body] = true;
      }
      continue;
    }

    if (token.startsWith("-") && token.length > 1) {
      const name = ALIASES[token.slice(1)] ?? token.slice(1);
      flags[name] = true;
      continue;
    }

    if (command === "") {
      command = token;
    } else {
      positionals.push(token);
    }
  }

  return { command, positionals, flags };
}

export function flagString(args: ParsedArgs, name: string): string | undefined {
  const value = args.flags[name];
  return typeof value === "string" ? value : undefined;
}

export function flagBool(args: ParsedArgs, name: string): boolean {
  return args.flags[name] === true || args.flags[name] === "true";
}

export function flagNumber(args: ParsedArgs, name: string): number | undefined {
  const raw = flagString(args, name);
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value)) {
    throw new ArgError(`--${name} must be a number, got '${raw}'`);
  }
  return value;
}

export function requireFlag(args: ParsedArgs, name: string, usage: string): string {
  const value = flagString(args, name);
  if (value === undefined || value === "") {
    throw new ArgError(`--${name} is required.`, usage);
  }
  return value;
}

/**
 * Reject leftover bare arguments. `hr-onboard deploy typo` should fail loudly
 * rather than quietly deploying and ignoring `typo`.
 */
export function rejectPositionals(args: ParsedArgs, usage: string): void {
  if (args.positionals.length > 0) {
    throw new ArgError(
      `Unexpected argument${args.positionals.length > 1 ? "s" : ""}: ${args.positionals.join(" ")}`,
      usage,
    );
  }
}

/** Reject unknown flags so a typo cannot silently do nothing. */
export function rejectUnknownFlags(
  args: ParsedArgs,
  allowed: readonly string[],
  usage: string,
): void {
  const unknown = Object.keys(args.flags).filter((name) => !allowed.includes(name));
  if (unknown.length > 0) {
    throw new ArgError(
      `Unknown flag${unknown.length > 1 ? "s" : ""}: ${unknown.map((f) => `--${f}`).join(", ")}`,
      usage,
    );
  }
}
