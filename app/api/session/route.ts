import { CONTRACT_TAIL } from "../../../src/contract/types.ts";
import { loadConfig } from "../../../src/lib/config.ts";
import { createLogger } from "../../../src/lib/log.ts";
import { connect, snapshot } from "../../../src/t3n/session.ts";
import { createTenantClient, registeredVersion } from "../../../src/t3n/tenant.ts";
import { handler, ok } from "../_lib/route.ts";

/** The SDK needs Node APIs and buffers a WASM component; not Edge-compatible. */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Operator session status.
 *
 * This is the one route that authenticates on every call, so the UI reads it
 * once per page load rather than per panel. It deliberately returns a
 * hand-picked subset of the config: `AppConfig` carries `apiKey` and the
 * upstream secrets, and none of those may cross this boundary.
 *
 * Note what is *not* imported here: `src/contract/artifacts.ts`. That module is
 * filesystem-bound (it reads `Cargo.toml` and the `target/` directory) and would
 * pull a build tree requirement into the deployed server. Runtime code asks the
 * chain what is deployed instead.
 */
export const GET = handler(async () => {
  const config = loadConfig({ quiet: true });
  const log = createLogger({ level: config.logLevel, quiet: true });

  const session = await connect(config, log);
  const account = await snapshot(session, log);
  const tenant = createTenantClient(config, session);
  const deployed = await registeredVersion(tenant, CONTRACT_TAIL);

  return ok({
    did: account.did,
    environment: account.env,
    nodeUrl: account.nodeUrl,
    credits: account.credits,
    contract: {
      tail: CONTRACT_TAIL,
      registered: deployed !== null,
      name: deployed?.name ?? null,
      version: deployed?.version ?? null,
      status: deployed?.status ?? null,
    },
    // Hosts only — never credentials. The UI needs to show which endpoints the
    // tenant points at; it never needs the tokens themselves.
    targets: {
      identity: hostOnly(config.identity.endpoint),
      payroll: hostOnly(config.payroll.endpoint),
      identityToken: config.identity.secret !== undefined,
      payrollToken: config.payroll.secret !== undefined,
    },
  });
});

function hostOnly(url: string): string {
  const match = /^https?:\/\/([^/?#]+)/i.exec(url);
  return match?.[1] ?? url;
}
