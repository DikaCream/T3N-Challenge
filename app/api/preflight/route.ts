import { preflight } from "../../../src/services/onboard.ts";
import { handler, ok } from "../_lib/route.ts";
import { operatorContext } from "../_lib/session.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Ask the enclave what each step still needs. No outbound call, no side effects.
 *
 * No side effects: no outbound call, no write. That is what makes it safe to run
 * before anything else, and it is the call an agent should make rather than
 * discovering a missing grant by attempting the action.
 */
export const GET = handler(async () => {
  const context = await operatorContext();
  const { context: contract, report } = await preflight(context.tenant, context.log);

  return ok({ contract: { name: contract.name, version: contract.version }, report });
});
