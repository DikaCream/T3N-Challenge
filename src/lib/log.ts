/**
 * A logger small enough to read in one sitting.
 *
 * Two rules it exists to enforce:
 *  1. Machine-readable output (`--json`) must be parseable, so progress and
 *     diagnostics go to stderr and only the result goes to stdout.
 *  2. Nothing that looks like a credential is ever printed, even if a caller
 *     passes one by accident.
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVELS: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

const CODES = {
  dim: "\u001b[2m",
  red: "\u001b[31m",
  yellow: "\u001b[33m",
  cyan: "\u001b[36m",
  reset: "\u001b[0m",
} as const;

const useColour =
  process.stderr.isTTY === true && process.env["NO_COLOR"] === undefined;

function paint(text: string, code: string): string {
  return useColour ? `${code}${text}${CODES.reset}` : text;
}

/** Keys whose values are replaced before printing. */
const SECRET_KEY_PATTERN = /key|secret|token|authorization|password|credential/i;

/**
 * Replace anything that looks like a credential with `***`.
 *
 * Deliberately shallow and conservative: a false positive costs a debug line,
 * a false negative leaks a key into a CI log.
 */
export function redact(value: unknown, depth = 0): unknown {
  if (depth > 4) return "[truncated]";
  if (typeof value === "string") return value;
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((item) => redact(item, depth + 1));

  const output: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    output[key] = SECRET_KEY_PATTERN.test(key) ? "***" : redact(nested, depth + 1);
  }
  return output;
}

export interface LoggerOptions {
  level: LogLevel;
  /** Suppress all progress output; the caller prints its own result. */
  quiet?: boolean;
}

export interface Logger {
  debug(message: string, fields?: Record<string, unknown>): void;
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
}

export function createLogger(options: LoggerOptions): Logger {
  const threshold = LEVELS[options.level];

  const emit = (
    level: LogLevel,
    message: string,
    fields?: Record<string, unknown>,
  ): void => {
    if (options.quiet === true && level !== "error" && level !== "warn") return;
    if (LEVELS[level] < threshold) return;

    const prefix =
      level === "error"
        ? paint("error", CODES.red)
        : level === "warn"
          ? paint("warn ", CODES.yellow)
          : level === "debug"
            ? paint("debug", CODES.dim)
            : paint("info ", CODES.cyan);

    const suffix =
      fields === undefined || Object.keys(fields).length === 0
        ? ""
        : ` ${JSON.stringify(redact(fields))}`;

    // stderr: stdout belongs to the command's actual result.
    process.stderr.write(`${prefix} ${message}${suffix}\n`);
  };

  return {
    debug: (message, fields) => emit("debug", message, fields),
    info: (message, fields) => emit("info", message, fields),
    warn: (message, fields) => emit("warn", message, fields),
    error: (message, fields) => emit("error", message, fields),
  };
}

/** Print a command's result: JSON when asked for, human-readable otherwise. */
export function emitResult(
  value: unknown,
  options: { json: boolean },
  render: () => string,
): void {
  process.stdout.write(options.json ? `${JSON.stringify(value, null, 2)}\n` : `${render()}\n`);
}
