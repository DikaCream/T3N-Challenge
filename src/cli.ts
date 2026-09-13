#!/usr/bin/env node
import { contractVersion } from "./contract/artifacts.ts";
import { ArgError, flagBool, parseArgs } from "./lib/args.ts";
import type { ParsedArgs } from "./lib/args.ts";
import { ConfigError } from "./lib/config.ts";
import { withContext } from "./commands/context.ts";
import { cmdDeploy, cmdInit, cmdSeed } from "./commands/setup.ts";
import { cmdInfo, cmdPreflight, cmdWhoami } from "./commands/inspect.ts";
import { cmdList, cmdOnboard, cmdStatus } from "./commands/run.ts";
import { cmdAudit, cmdGrant, cmdGrants } from "./commands/trust.ts";

const HELP = `
hr-onboard: privacy-preserving employee onboarding on Terminal 3.

The agent decides which steps to run using only non-sensitive fields. A TEE
contract then performs them, and the employee's name, national id, address and
email are substituted inside the enclave by the host; they are never arguments,
never local variables, and never in this process's memory.

SETUP
  whoami                     your DID, node, credits, registration status
  init                       create the tenant maps and write step endpoints
  deploy                     build+register the contract and wire its map ACLs
  seed                       move upstream credentials into the private map

INSPECT
  info                       what the deployed contract asks an operator for
  preflight                  what each step still needs; makes no outbound call

RUN
  onboard --employee <ref> --role <r> --department <d> --start YYYY-MM-DD
      [--currency USD] [--live] [--force]
                             plan, preflight, then dry-run (add --live to send)
  status --employee <ref>    read back a stored record
  list [--status <s>] [--limit N]

TRUST
  grant --agent <did>        delegate scoped authority to an agent
  grants                     show this identity's current delegation grants
  audit [--limit N]          the ledger's record of contract dispatches

GLOBAL
  --json                     machine-readable result on stdout
  --quiet                    suppress progress on stderr
  --help, --version

ENVIRONMENT
  T3N_API_KEY                required. Your key from terminal3.io/claim-page
  T3N_ENV                    testnet | sandbox | production   (default: testnet)
  T3N_LOG_LEVEL              debug | info | warn | error      (default: info)
  ONBOARD_IDENTITY_ENDPOINT  HRIS endpoint for the provisioning step
  ONBOARD_PAYROLL_ENDPOINT   payroll endpoint for the enrolment step
  HRIS_API_KEY               optional bearer token, goes into the secrets map
  PAYROLL_API_KEY            optional bearer token, goes to the secrets map
  LLM_API_KEY                optional; without it a deterministic planner runs

Run \`hr-onboard <command> --help\` for command specifics. Start with:
  npm run cli -- whoami
`;

interface Command {
  /** Needs an authenticated session (and therefore T3N_API_KEY). */
  session: boolean;
  run: (args: ParsedArgs) => Promise<number>;
  runWithContext: (context: Parameters<Parameters<typeof withContext>[1]>[0]) => Promise<number>;
  usage: string;
}

/**
 * Commands that build their own context.
 *
 * `withContext` does config load, connect, and tenant client construction, so
 * every command listed here is guaranteed a working session, and a
 * configuration problem is reported before any network call is attempted.
 */
const COMMANDS: Record<string, Command> = {
  whoami: wrap(cmdWhoami, "hr-onboard whoami"),
  init: wrap(cmdInit, "hr-onboard init"),
  deploy: wrap(cmdDeploy, "hr-onboard deploy"),
  seed: wrap(cmdSeed, "hr-onboard seed"),
  info: wrap(cmdInfo, "hr-onboard info"),
  preflight: wrap(cmdPreflight, "hr-onboard preflight [--steps a,b]"),
  onboard: wrap(
    cmdOnboard,
    "hr-onboard onboard --employee <ref> --role <r> --department <d> --start YYYY-MM-DD",
  ),
  status: wrap(cmdStatus, "hr-onboard status --employee <ref>"),
  list: wrap(cmdList, "hr-onboard list [--status <s>] [--limit N]"),
  grant: wrap(cmdGrant, "hr-onboard grant --agent <did:t3n:...>"),
  grants: wrap(cmdGrants, "hr-onboard grants"),
  audit: wrap(cmdAudit, "hr-onboard audit [--limit N]"),
};

function wrap(
  handler: Command["runWithContext"],
  usage: string,
): Command {
  return {
    session: true,
    runWithContext: handler,
    usage,
    run: async (args: ParsedArgs) => await withContext(args, handler),
  };
}

async function main(argv: readonly string[]): Promise<number> {
  const args = parseArgs(argv);

  if (flagBool(args, "version")) {
    process.stdout.write(`${contractVersion()}\n`);
    return 0;
  }

  if (args.command === "" || args.command === "help" || flagBool(args, "help")) {
    process.stdout.write(HELP);
    // Bare invocation is a usage error; an explicit help request is not.
    return args.command === "" && !flagBool(args, "help") ? 1 : 0;
  }

  if (args.command === "version") {
    process.stdout.write(`${contractVersion()}\n`);
    return 0;
  }

  const command = COMMANDS[args.command];
  if (command === undefined) {
    process.stderr.write(`Unknown command '${args.command}'.\n`);
    process.stderr.write(HELP);
    return 1;
  }

  return await command.run(args);
}

function report(error: unknown): number {
  if (error instanceof ArgError) {
    process.stderr.write(`error: ${error.message}\n`);
    if (error.usage !== undefined) {
      process.stderr.write(`usage: ${error.usage}\n`);
    }
    return 1;
  }

  if (error instanceof ConfigError) {
    process.stderr.write(`configuration error: ${error.message}\n`);
    process.stderr.write("See .env.example for every variable.\n");
    return 1;
  }

  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`error: ${message}\n`);

  // A stack trace is noise in normal use and the only useful thing when the
  // failure is unexpected, so it is opt-in rather than opt-out.
  if (process.env["T3N_LOG_LEVEL"] === "debug" && error instanceof Error && error.stack) {
    process.stderr.write(`${error.stack}\n`);
  }
  return 1;
}

try {
  process.exitCode = await main(process.argv.slice(2));
} catch (error) {
  process.exitCode = report(error);
}
