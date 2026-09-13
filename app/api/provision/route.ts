import { provisionTenant } from "../../../src/services/provision.ts";
import { handler, ok } from "../_lib/route.ts";
import { operatorContext } from "../_lib/session.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Create or reconcile the tenant maps, then write the step endpoints.
 *
 * Idempotent, and safe to press twice. It does not touch `secrets`: credentials come
 * from the server environment via the CLI's `seed`, and there is deliberately no
 * endpoint that accepts a secret from a browser.
 */
export const POST = handler(async () => {
  const context = await operatorContext();
  const provisioned = await provisionTenant(context.tenant, context.config, context.log);

  return ok({
    tenant: context.session.did,
    maps: provisioned.maps,
    configKeys: provisioned.configKeys,
  });
});
