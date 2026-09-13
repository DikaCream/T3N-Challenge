import type { TenantClient } from "@terminal3/t3n-sdk";

import type { AppConfig } from "../../../src/lib/config.ts";
import { loadConfig } from "../../../src/lib/config.ts";
import { createLogger } from "../../../src/lib/log.ts";
import type { Logger } from "../../../src/lib/log.ts";
import { connect } from "../../../src/t3n/session.ts";
import type { Session } from "../../../src/t3n/session.ts";
import { createTenantClient } from "../../../src/t3n/tenant.ts";

export interface OperatorContext {
  config: AppConfig;
  log: Logger;
  session: Session;
  tenant: TenantClient;
}

/**
 * Build the operator context for a request.
 *
 * Every call authenticates afresh. That costs one handshake per request, and it
 * is the right trade for this deployment shape: a single-tenant console where
 * the alternative, a cached session in module scope, would have to reason
 * about expiry, concurrent re-auth, and what happens to in-flight requests when
 * the cached session dies. The SDK's session lifetime is its own concern, and a
 * console is not a high-request-rate surface.
 *
 * Nothing from `AppConfig` beyond what a route explicitly selects may be
 * returned to the client. `config.apiKey` and the upstream secrets live on this
 * object.
 */
export async function operatorContext(): Promise<OperatorContext> {
  const config = loadConfig({ quiet: true });
  const log = createLogger({ level: config.logLevel, quiet: true });
  const session = await connect(config, log);
  const tenant = createTenantClient(config, session);

  return { config, log, session, tenant };
}

/**
 * Whether this deployment permits real outbound onboarding runs.
 *
 * Off unless `ONBOARD_ALLOW_LIVE=true`. The contract's own default is already
 * dry, and the CLI needs `--live`; this is the third and outermost gate, and it
 * is the one that matters for a public URL. A hosted demo that can be made to
 * spend credits and send real HRIS traffic by anyone who finds the endpoint is a
 * liability, so the safe state is the default state.
 */
export function liveRunsAllowed(): boolean {
  return process.env["ONBOARD_ALLOW_LIVE"] === "true";
}
