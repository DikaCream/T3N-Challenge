import { CONTRACT_TAIL } from "../../../src/contract/types.ts";
import { resolveContract } from "../../../src/services/contract.ts";
import { getRecord, listRecords } from "../../../src/services/onboard.ts";
import { handler, ok } from "../_lib/route.ts";
import { operatorContext } from "../_lib/session.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Read onboarding records out of the contract's `onboarding-log` map.
 *
 * `?employee=<ref>` returns one record; without it, a page of records.
 *
 * Reminder that shapes the UI: a dry run writes nothing, so `found: false` after
 * a dry run is correct behaviour rather than a bug. The alternative — recording
 * plans alongside facts — would make the log unable to tell the two apart.
 */
export const GET = handler(async (request: Request) => {
  const context = await operatorContext();
  const contract = await resolveContract(context.tenant, CONTRACT_TAIL, context.log);
  const params = new URL(request.url).searchParams;

  const employee = params.get("employee");
  if (employee !== null && employee.trim() !== "") {
    return ok({ kind: "record" as const, ...(await getRecord(contract, employee.trim())) });
  }

  const options: { status?: string; limit?: number } = {};
  const status = params.get("status");
  if (status !== null && status.trim() !== "") options.status = status.trim();

  const limit = Number(params.get("limit"));
  if (Number.isFinite(limit) && limit > 0) options.limit = Math.min(Math.trunc(limit), 100);

  return ok({ kind: "list" as const, ...(await listRecords(contract, options)) });
});
