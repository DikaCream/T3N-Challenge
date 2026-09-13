import type { TenantClient } from "@terminal3/t3n-sdk";

import { planOnboarding } from "../agent/planner.ts";
import type { OnboardingRequest, Plan } from "../agent/planner.ts";
import { CONTRACT_TAIL, FUNCTIONS, assertRecord, expectKeys } from "../contract/types.ts";
import type {
  ContractInfo,
  ListResponse,
  OnboardingRecord,
  PreflightReport,
  StatusResponse,
} from "../contract/types.ts";
import type { AppConfig } from "../lib/config.ts";
import type { Logger } from "../lib/log.ts";
import { callContract, resolveContract } from "./contract.ts";
import type { ContractContext } from "./contract.ts";

/**
 * The agent's flow, independent of who is driving it.
 *
 * Three phases, in this order and for a reason:
 *  1. plan      — decide steps from non-sensitive fields only
 *  2. preflight — check what each step still needs (no outbound call)
 *  3. run       — dry by default; only an explicit `live` sends anything
 *
 * Phase 2 is the interesting one. An agent that discovers it lacks authority by
 * attempting the action and reading the failure has already crossed the line it
 * was trying not to cross. `preflight` answers the same question with no side
 * effect, and both the CLI and the web app go through this module — so the
 * guarantee cannot drift between the two surfaces.
 */

export interface OnboardOutcome {
  plan: Plan;
  report: PreflightReport;
  record: OnboardingRecord | null;
  /** True when the run was refused rather than attempted. */
  blocked: boolean;
  blockedReason: string | null;
}

export interface RunOptions {
  request: OnboardingRequest;
  /** Send for real. Without this the contract plans and writes nothing. */
  live: boolean;
  /** Run despite a failed preflight. */
  force?: boolean;
}

/** Resolve the deployed contract and ask whether it may act. */
export async function preflight(
  tenant: TenantClient,
  log: Logger,
  steps?: string[],
): Promise<{ context: ContractContext; report: PreflightReport }> {
  const context = await resolveContract(tenant, CONTRACT_TAIL, log);
  const payload = steps === undefined ? {} : { steps };

  const report = expectKeys<PreflightReport>(
    await callContract(context, FUNCTIONS.preflight, payload),
    FUNCTIONS.preflight,
    ["ready", "steps"],
  );

  return { context, report };
}

export async function runOnboarding(
  tenant: TenantClient,
  config: AppConfig,
  log: Logger,
  options: RunOptions,
): Promise<OnboardOutcome> {
  const context = await resolveContract(tenant, CONTRACT_TAIL, log);
  const { request, live } = options;

  const plan = await planOnboarding(request, config, log);
  log.info(`plan (${plan.planner}): ${plan.steps.join(" -> ")}`, { risk: plan.risk });

  const report = expectKeys<PreflightReport>(
    await callContract(context, FUNCTIONS.preflight, { steps: plan.steps }),
    FUNCTIONS.preflight,
    ["ready", "steps"],
  );

  if (!report.ready && options.force !== true) {
    log.error("the enclave is not ready to run these steps, so nothing was sent");
    return {
      plan,
      report,
      record: null,
      blocked: true,
      blockedReason: describeBlockers(report),
    };
  }

  const payload: Record<string, unknown> = {
    employee_ref: request.employee_ref,
    role: request.role,
    department: request.department,
    start_date: request.start_date,
    // Explicit, never inferred: the contract's own default is dry, and this line
    // is the only place that decision is made.
    dry_run: !live,
    steps: plan.steps,
  };
  if (request.currency !== undefined) {
    payload["currency"] = request.currency;
  }

  const record = assertRecord(
    await callContract(context, FUNCTIONS.start, payload),
    FUNCTIONS.start,
  );

  return { plan, report, record, blocked: false, blockedReason: null };
}

/** Turn a failed preflight into something an operator can act on. */
export function describeBlockers(report: PreflightReport): string {
  const lines: string[] = [];
  for (const step of report.steps) {
    if (!step.endpoint_configured) {
      lines.push(`${step.name}: ${step.egress_note ?? "no endpoint configured"}`);
    }
  }
  for (const key of report.missing_config) {
    lines.push(`missing config: ${key}`);
  }
  return lines.length === 0 ? "The enclave is not ready to run these steps." : lines.join("\n");
}

export async function getContractInfo(context: ContractContext): Promise<ContractInfo> {
  return expectKeys<ContractInfo>(
    await callContract(context, FUNCTIONS.info, {}),
    FUNCTIONS.info,
    ["contract", "contract_version", "functions", "steps"],
  );
}

export async function getRecord(
  context: ContractContext,
  employeeRef: string,
): Promise<StatusResponse> {
  return expectKeys<StatusResponse>(
    await callContract(context, FUNCTIONS.status, { employee_ref: employeeRef }),
    FUNCTIONS.status,
    ["found"],
  );
}

export async function listRecords(
  context: ContractContext,
  options: { status?: string; limit?: number } = {},
): Promise<ListResponse> {
  const payload: Record<string, unknown> = {};
  if (options.status !== undefined) payload["status"] = options.status;
  if (options.limit !== undefined) payload["limit"] = options.limit;

  return expectKeys<ListResponse>(
    await callContract(context, FUNCTIONS.list, payload),
    FUNCTIONS.list,
    ["count", "records"],
  );
}
