import type { TenantClient } from "@terminal3/t3n-sdk";

import { flagBool } from "../lib/args.ts";
import type { ParsedArgs } from "../lib/args.ts";
import { loadConfig } from "../lib/config.ts";
import type { AppConfig } from "../lib/config.ts";
import { createLogger } from "../lib/log.ts";
import type { Logger } from "../lib/log.ts";
import { connect } from "../t3n/session.ts";
import type { Session } from "../t3n/session.ts";
import { createTenantClient } from "../t3n/tenant.ts";

export interface Context {
  args: ParsedArgs;
  config: AppConfig;
  log: Logger;
  session: Session;
  tenant: TenantClient;
}

/**
 * Everything a command needs, built once.
 *
 * Config, logger, session and tenant client are assembled in this order because
 * each depends on the previous one: the log level comes from config, and the
 * tenant client needs the authenticated session it dispatches through.
 * Commands receive a fully working context or an exception, never a half-built
 * one to check for nulls.
 */
export async function withContext(
  args: ParsedArgs,
  run: (context: Context) => Promise<number>,
): Promise<number> {
  const json = flagBool(args, "json");
  const quiet = flagBool(args, "quiet");

  const config = loadConfig({ json, quiet });
  const log = createLogger({ level: config.logLevel, quiet });

  log.info(`connecting to T3N ${config.env}`);
  const session = await connect(config, log);
  log.info(`authenticated as ${session.did}`);

  const tenant = createTenantClient(config, session);

  return await run({ args, config, log, session, tenant });
}
