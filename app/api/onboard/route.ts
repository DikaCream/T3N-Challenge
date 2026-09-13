import type { OnboardingRequest } from "../../../src/agent/planner.ts";
import { ArgError } from "../../../src/lib/args.ts";
import { runOnboarding } from "../../../src/services/onboard.ts";
import { handler, ok, readJson } from "../_lib/route.ts";
import { liveRunsAllowed, operatorContext } from "../_lib/session.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Plan, preflight, then run: dry unless `live` is explicitly true.
 *
 * Three independent gates stand between a click and an outbound request:
 *  1. `live` must be present in the body and true (this UI never infers it)
 *  2. `ONBOARD_ALLOW_LIVE=true` must be set on the deployment
 *  3. the contract's own `dry_run` defaults to true
 *
 * Field validation happens in the contract, which is the authority; the checks
 * here only exist to turn an obviously malformed request into a 400 instead of a
 * round trip into the enclave.
 */
export const POST = handler(async (request: Request) => {
  const body = await readJson(request);

  const onboardRequest: OnboardingRequest = {
    employee_ref: requiredBody(body, "employee_ref"),
    role: requiredBody(body, "role"),
    department: requiredBody(body, "department"),
    start_date: requiredBody(body, "start_date"),
  };
  const currency = body["currency"];
  if (typeof currency === "string" && currency.trim() !== "") {
    onboardRequest.currency = currency.trim();
  }

  const live = body["live"] === true;
  if (live && !liveRunsAllowed()) {
    throw new ArgError(
      "This deployment does not allow live runs. It is a demo, so it is dry-run only. " +
        "Set ONBOARD_ALLOW_LIVE=true to enable real outbound onboarding.",
    );
  }

  const context = await operatorContext();
  const outcome = await runOnboarding(context.tenant, context.config, context.log, {
    request: onboardRequest,
    live,
    force: body["force"] === true,
  });

  return ok({
    plan: outcome.plan,
    preflight: outcome.report,
    record: outcome.record,
    blocked: outcome.blocked,
    blockedReason: outcome.blockedReason,
    live,
  });
});

function requiredBody(body: Record<string, unknown>, key: string): string {
  const value = body[key];
  if (typeof value !== "string" || value.trim() === "") {
    throw new ArgError(`'${key}' is required and must be a non-empty string.`);
  }
  return value.trim();
}
