import type { OnboardingRequest, Plan } from "../agent/planner.ts";
import { CONTRACT_TAIL } from "../contract/types.ts";
import type { OnboardingRecord } from "../contract/types.ts";
import {
  flagBool,
  flagNumber,
  flagString,
  rejectPositionals,
  rejectUnknownFlags,
  requireFlag,
} from "../lib/args.ts";
import { emitResult } from "../lib/log.ts";
import { renderTable } from "../lib/table.ts";
import { resolveContract } from "../services/contract.ts";
import { getRecord, listRecords, runOnboarding } from "../services/onboard.ts";
import type { Context } from "./context.ts";

const ONBOARD_USAGE =
  "hr-onboard onboard --employee <ref> --role <role> --department <dept> --start YYYY-MM-DD " +
  "[--currency USD] [--live] [--force] [--json]";

export async function cmdOnboard(context: Context): Promise<number> {
  rejectUnknownFlags(
    context.args,
    [
      "json",
      "quiet",
      "help",
      "employee",
      "role",
      "department",
      "start",
      "start-date",
      "currency",
      "live",
      "force",
    ],
    ONBOARD_USAGE,
  );
  rejectPositionals(context.args, ONBOARD_USAGE);

  const request: OnboardingRequest = {
    employee_ref: requireFlag(context.args, "employee", ONBOARD_USAGE),
    role: requireFlag(context.args, "role", ONBOARD_USAGE),
    department: requireFlag(context.args, "department", ONBOARD_USAGE),
    start_date:
      flagString(context.args, "start") ?? requireFlag(context.args, "start-date", ONBOARD_USAGE),
  };
  const currency = flagString(context.args, "currency");
  if (currency !== undefined) request.currency = currency;

  const live = flagBool(context.args, "live");

  const outcome = await runOnboarding(context.tenant, context.config, context.log, {
    request,
    live,
    force: flagBool(context.args, "force"),
  });

  if (outcome.blocked) {
    context.log.error("Refusing to run.");
    context.log.error(outcome.blockedReason ?? "");
    emitResult(
      { ran: false, reason: outcome.blockedReason, plan: outcome.plan, preflight: outcome.report },
      { json: context.config.json },
      () => `\n${outcome.blockedReason ?? ""}\n\nPass --force to run anyway.`,
    );
    return 2;
  }

  const record = outcome.record;
  if (record === null) {
    // Unreachable: a non-blocked outcome always carries a record. Guarded so the
    // type checker holds us to it rather than a non-null assertion.
    throw new Error("runOnboarding returned neither a record nor a block reason");
  }

  emitResult(
    { plan: outcome.plan, preflight_ready: outcome.report.ready, record },
    { json: context.config.json },
    () => renderOnboard(outcome.plan, record, live),
  );

  return record.status === "failed" ? 1 : 0;
}

function renderOnboard(plan: Plan, record: OnboardingRecord, live: boolean): string {
  const lines: string[] = [];
  lines.push(`plan (${plan.planner}, risk ${plan.risk})`);
  lines.push(`  ${plan.rationale}`);
  for (const note of plan.notes) lines.push(`  note: ${note}`);
  lines.push("");
  lines.push(
    renderTable(
      ["step", "status", "host", "http"],
      record.steps.map((step) => [
        step.name,
        step.status,
        step.host === "" ? "-" : step.host,
        step.http_status ?? "-",
      ]),
    ),
  );

  for (const step of record.steps) {
    if (step.detail !== null && step.detail !== "") {
      lines.push(`  ${step.name}: ${step.detail}`);
    }
  }

  if (record.dry_run) {
    lines.push("");
    lines.push("request bodies as the enclave will send them (placeholders unresolved):");
    for (const step of record.steps) {
      lines.push(`  ${step.name}:`);
      lines.push(
        (step.request_body ?? "(none)")
          .split("\n")
          .map((line) => `    ${line}`)
          .join("\n"),
      );
    }
    lines.push("");
    lines.push("Every `{{profile.*}}` marker is substituted inside the enclave, after this");
    lines.push("output was produced. That is why no name, id or address appears above.");
  }

  lines.push("");
  lines.push(
    `status: ${record.status}${live ? "" : "  (dry run — nothing was sent and nothing was written)"}`,
  );
  lines.push(`contract v${record.contract_version}  contains_pii: ${String(record.contains_pii)}`);
  if (!live) lines.push("Re-run with --live to actually send these requests.");
  return lines.join("\n");
}

const STATUS_USAGE = "hr-onboard status --employee <ref> [--json]";

export async function cmdStatus(context: Context): Promise<number> {
  rejectUnknownFlags(context.args, ["json", "quiet", "help", "employee"], STATUS_USAGE);
  rejectPositionals(context.args, STATUS_USAGE);

  const employeeRef = requireFlag(context.args, "employee", STATUS_USAGE);
  const contract = await resolveContract(context.tenant, CONTRACT_TAIL, context.log);
  const response = await getRecord(contract, employeeRef);

  emitResult({ employee_ref: employeeRef, ...response }, { json: context.config.json }, () =>
    response.found && response.record !== null
      ? renderRecord(response.record)
      : `No onboarding record for '${employeeRef}'. A dry run does not write one.`,
  );

  return response.found ? 0 : 1;
}

function renderRecord(record: OnboardingRecord): string {
  return [
    `employee_ref  ${record.employee_ref}`,
    `status        ${record.status}${record.dry_run ? " (dry run)" : ""}`,
    `role          ${record.role}`,
    `department    ${record.department}`,
    `start_date    ${record.start_date}`,
    `recorded_at   ${new Date(record.recorded_at_secs * 1000).toISOString()}`,
    `contains_pii  ${String(record.contains_pii)}`,
    "",
    renderTable(
      ["step", "status", "host", "http"],
      record.steps.map((step) => [
        step.name,
        step.status,
        step.host === "" ? "-" : step.host,
        step.http_status ?? "-",
      ]),
    ),
  ].join("\n");
}

const LIST_USAGE =
  "hr-onboard list [--status completed|planned|partial|failed] [--limit N] [--json]";

export async function cmdList(context: Context): Promise<number> {
  rejectUnknownFlags(context.args, ["json", "quiet", "help", "status", "limit"], LIST_USAGE);
  rejectPositionals(context.args, LIST_USAGE);

  const contract = await resolveContract(context.tenant, CONTRACT_TAIL, context.log);

  const options: { status?: string; limit?: number } = {};
  const status = flagString(context.args, "status");
  if (status !== undefined) options.status = status;
  const limit = flagNumber(context.args, "limit");
  if (limit !== undefined) options.limit = limit;

  const response = await listRecords(contract, options);

  emitResult(response, { json: context.config.json }, () =>
    response.count === 0
      ? "No onboarding records yet."
      : [
          renderTable(
            ["employee_ref", "status", "steps", "dry_run", "recorded_at"],
            response.records.map((record) => [
              record.employee_ref,
              record.status,
              record.steps.map((step) => `${step.name}:${step.status}`).join(" "),
              record.dry_run,
              new Date(record.recorded_at_secs * 1000).toISOString(),
            ]),
          ),
          response.truncated ? "\n(more records exist — raise --limit)" : "",
        ]
          .filter((line) => line !== "")
          .join("\n"),
  );

  return 0;
}
