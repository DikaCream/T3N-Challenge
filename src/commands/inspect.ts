import { CONTRACT_TAIL } from "../contract/types.ts";
import { rejectPositionals, rejectUnknownFlags } from "../lib/args.ts";
import { emitResult } from "../lib/log.ts";
import { renderPairs, renderTable } from "../lib/table.ts";
import { getContractInfo, preflight } from "../services/onboard.ts";
import { resolveContract } from "../services/contract.ts";
import { snapshot } from "../t3n/session.ts";
import { registeredContracts } from "../t3n/tenant.ts";
import type { Context } from "./context.ts";

const WHOAMI_USAGE = "hr-onboard whoami";

export async function cmdWhoami(context: Context): Promise<number> {
  rejectUnknownFlags(context.args, ["json", "quiet", "help"], WHOAMI_USAGE);
  rejectPositionals(context.args, WHOAMI_USAGE);

  const account = await snapshot(context.session, context.log);
  const contracts = await registeredContracts(context.tenant);
  const ours = contracts.filter((contract) => contract.name.endsWith(`:${CONTRACT_TAIL}`));

  const result = {
    did: account.did,
    environment: account.env,
    node_url: account.nodeUrl,
    credits: account.credits,
    contract_registered: ours.length > 0,
    registered_contracts: contracts.map((contract) => contract.name),
  };

  emitResult(result, { json: context.config.json }, () =>
    renderPairs([
      ["did", account.did],
      ["environment", account.env],
      ["node", account.nodeUrl],
      ["credits", account.credits === null ? "(unavailable)" : account.credits.available],
      [
        "contract",
        ours.length > 0
          ? ours.map((contract) => `${contract.name} v${contract.version}`).join(", ")
          : `${CONTRACT_TAIL}: not registered yet (run \`hr-onboard deploy\`)`,
      ],
    ]),
  );

  return 0;
}

const INFO_USAGE = "hr-onboard info";

export async function cmdInfo(context: Context): Promise<number> {
  rejectUnknownFlags(context.args, ["json", "quiet", "help"], INFO_USAGE);
  rejectPositionals(context.args, INFO_USAGE);

  const contract = await resolveContract(context.tenant, CONTRACT_TAIL, context.log);
  const info = await getContractInfo(contract);

  emitResult(
    { deployed: { name: contract.name, version: contract.version }, enclave: info },
    { json: context.config.json },
    () =>
      [
        `${info.contract} v${info.contract_version}  (deployed: ${contract.name} v${contract.version})`,
        "",
        "functions",
        renderTable(
          ["name", "purpose"],
          info.functions.map((fn) => [fn.name, fn.purpose]),
        ),
        "",
        "steps",
        renderTable(
          ["name", "purpose"],
          info.steps.map((step) => [step.name, step.purpose]),
        ),
        "",
        "operator must provide",
        `  config map keys  ${info.config_keys.join(", ")}`,
        `  secrets map keys ${info.secret_keys.join(", ")}`,
        "",
        "profile fields the enclave resolves host-side (never sent to the agent):",
        `  ${info.profile_fields.join(", ")}`,
        "",
        `default_dry_run: ${String(info.default_dry_run)}`,
      ].join("\n"),
  );

  return 0;
}

const PREFLIGHT_USAGE = "hr-onboard preflight [--steps a,b]";

export async function cmdPreflight(context: Context): Promise<number> {
  rejectUnknownFlags(context.args, ["json", "quiet", "help", "steps"], PREFLIGHT_USAGE);
  rejectPositionals(context.args, PREFLIGHT_USAGE);

  const steps = stepsPayload(context);
  const { report } = await preflight(
    context.tenant,
    context.log,
    Array.isArray(steps["steps"]) ? (steps["steps"] as string[]) : undefined,
  );

  emitResult({ ready: report.ready, enclave_report: report }, { json: context.config.json }, () =>
    [
      renderTable(
        ["step", "egress host", "endpoint", "credential", "egress auth"],
        report.steps.map((step) => [
          step.name,
          step.host === "" ? "(unset)" : step.host,
          step.endpoint_configured ? "yes" : "no",
          step.secret_present ? "yes" : "no",
          // `null` means not knowable before dispatch, which is not the same as
          // "denied". Printed rather than omitted so the column cannot be read as
          // a green tick the host never gave.
          step.egress_authorised === null ? "unknown" : step.egress_authorised ? "yes" : "no",
        ]),
      ),
      "",
      `egress policy:   ${report.egress_enforcement}`,
      "",
      report.missing_config.length > 0
        ? `missing config:  ${report.missing_config.join(", ")}`
        : "missing config:  none",
      report.missing_secrets.length > 0
        ? `missing secrets: ${report.missing_secrets.join(", ")} (only a problem if the upstream requires auth)`
        : "missing secrets: none",
      "",
      `profile fields resolved inside the enclave: ${report.required_profile_fields.join(", ")}`,
      "",
      report.ready ? "READY (configured)" : "NOT READY",
    ].join("\n"),
  );

  for (const step of report.steps) {
    if (!step.endpoint_configured) {
      context.log.warn(`${step.name}: ${step.egress_note ?? "no endpoint configured"}`);
    }
  }

  return report.ready ? 0 : 1;
}

/** `--steps a,b` becomes `{ steps: ["a", "b"] }`; absent means "all". */
export function stepsPayload(context: Context): Record<string, unknown> {
  const raw = context.args.flags["steps"];
  if (typeof raw !== "string" || raw.trim() === "") return {};
  return {
    steps: raw
      .split(",")
      .map((step) => step.trim())
      .filter((step) => step !== ""),
  };
}
