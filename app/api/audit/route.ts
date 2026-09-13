import { CONTRACT_TAIL } from "../../../src/contract/types.ts";
import { activityLog } from "../../../src/t3n/tenant.ts";
import { handler, ok } from "../_lib/route.ts";
import { operatorContext } from "../_lib/session.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The ledger's own record of contract dispatches.
 *
 * Distinct from the `onboarding-log` map the contract writes, and deliberately
 * so: that map is what the *application* believes happened, this is what the
 * *network* recorded. `actor` and `on_behalf_of` here are host-stamped from the
 * verified dispatch context, so a contract cannot forge who acted, which is
 * exactly the property a self-written log cannot provide.
 *
 * The read is scoped to the caller's own organisation; there is no scope
 * parameter to get wrong.
 */
export const GET = handler(async (request: Request) => {
  const context = await operatorContext();
  const params = new URL(request.url).searchParams;

  const requested = Number(params.get("limit"));
  const limit = Number.isFinite(requested) && requested > 0 ? Math.min(Math.trunc(requested), 200) : 25;

  const report = await activityLog(context.session, { contract: CONTRACT_TAIL, limit });

  return ok({ scope: CONTRACT_TAIL, next_seq: report.next_seq, entries: report.entries });
});
