import type { BoundGrant } from "@terminal3/t3n-sdk";

import { CONTRACT_TAIL } from "../contract/artifacts.ts";
import { FUNCTIONS } from "../contract/types.ts";
import {
  ArgError,
  flagNumber,
  flagString,
  rejectPositionals,
  rejectUnknownFlags,
  requireFlag,
} from "../lib/args.ts";
import { emitResult } from "../lib/log.ts";
import { renderTable } from "../lib/table.ts";
import { hostsOf } from "../lib/url.ts";
import { activityLog, canonicalName, grantAgent } from "../t3n/tenant.ts";
import type { Context } from "./context.ts";

/** Every function an agent is allowed to call, unless `--functions` narrows it. */
const DEFAULT_AGENT_FUNCTIONS = [
  FUNCTIONS.info,
  FUNCTIONS.preflight,
  FUNCTIONS.start,
  FUNCTIONS.status,
  FUNCTIONS.list,
];

const GRANT_USAGE =
  "hr-onboard grant --agent did:t3n:<40hex> [--contract <name>] [--functions a,b] [--hosts a.com,b.com] [--json]";

/**
 * Delegate scoped authority to an agent.
 *
 * Three separate limits, and all three matter:
 *  - `functions`: which contract functions the agent may call
 *  - `contract_id`: which contract those functions live on
 *  - `allowed_hosts`: which hosts the contract may egress to *on the agent's
 *    behalf*. An empty list is deny-all, which is why it defaults to the hosts
 *    this deployment actually uses rather than to `[]`.
 */
export async function cmdGrant(context: Context): Promise<number> {
  rejectUnknownFlags(
    context.args,
    ["json", "quiet", "help", "agent", "contract", "functions", "hosts"],
    GRANT_USAGE,
  );
  rejectPositionals(context.args, GRANT_USAGE);

  const grantee = requireFlag(context.args, "agent", GRANT_USAGE);
  if (!/^did:t3n:[0-9a-fA-F]{40}$/.test(grantee)) {
    throw new ArgError(
      `--agent must be a full DID of the form did:t3n:<40 hex chars>, got '${grantee}'.`,
      GRANT_USAGE,
    );
  }

  const contractId =
    flagString(context.args, "contract") ?? canonicalName(context.tenant, CONTRACT_TAIL);

  const functions = splitList(flagString(context.args, "functions")) ?? DEFAULT_AGENT_FUNCTIONS;

  const hosts =
    splitList(flagString(context.args, "hosts")) ??
    hostsOf([context.config.identity.endpoint, context.config.payroll.endpoint]);

  if (hosts.length === 0) {
    throw new ArgError(
      "No egress hosts resolved. Pass --hosts explicitly; an empty allow-list denies every outbound call.",
      GRANT_USAGE,
    );
  }

  const grant: BoundGrant = {
    grantee,
    contract_id: contractId,
    functions,
    // This contract reads no org-data scopes; placeholders are gated by the
    // on-chain delegation grant, not by a scope list.
    scopes: [],
    allowed_hosts: hosts,
  };

  context.log.info("issuing delegation grant", { grantee, contract: contractId });
  await grantAgent(context.session, grant);

  const result = { granted: grant };
  emitResult(result, { json: context.config.json }, () =>
    [
      "Delegation granted.",
      "",
      renderTable(
        ["field", "value"],
        [
          ["grantee", grant.grantee],
          ["contract", grant.contract_id],
          ["functions", grant.functions.join(", ")],
          ["egress hosts", grant.allowed_hosts?.join(",") ?? ""],
        ],
      ),
      "",
      "Verify with: hr-onboard grants",
    ].join("\n"),
  );

  return 0;
}

function splitList(raw: string | undefined): string[] | undefined {
  if (raw === undefined) return undefined;
  const parts = raw
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part !== "");
  return parts.length > 0 ? parts : undefined;
}

const GRANTS_USAGE = "hr-onboard grants [--json]";

/** Read back this user's own delegation edges, the write in `grant`, verified. */
export async function cmdGrants(context: Context): Promise<number> {
  rejectUnknownFlags(context.args, ["json", "quiet", "help"], GRANTS_USAGE);
  rejectPositionals(context.args, GRANTS_USAGE);

  const document = await context.session.client.getMemberDelegation();

  const result = document;
  emitResult(result, { json: context.config.json }, () => {
    const grants = document.grants ?? [];
    if (grants.length === 0) {
      return "No delegation grants on this identity. No agent can act for you.";
    }
    return renderTable(
      ["grantee", "contract", "functions", "egress hosts"],
      grants.map((grant) => [
        grant.grantee,
        grant.contract_id,
        grant.functions.join(","),
        (grant.allowed_hosts ?? []).join(",") || "(deny-all)",
      ]),
    );
  });

  return 0;
}

const AUDIT_USAGE = "hr-onboard audit [--limit N] [--contract <substring>] [--json]";

/**
 * The ledger's own record of contract dispatches.
 *
 * Distinct from the contract's `onboarding-log` map, and deliberately so: the
 * map is what the application believes happened, this is what the network
 * recorded. The entry's `actor` / `on_behalf_of` are host-stamped from the
 * verified dispatch context, so a contract cannot forge who acted.
 */
export async function cmdAudit(context: Context): Promise<number> {
  rejectUnknownFlags(
    context.args,
    ["json", "quiet", "help", "limit", "contract", "outcome"],
    AUDIT_USAGE,
  );
  rejectPositionals(context.args, AUDIT_USAGE);

  const report = await activityLog(context.session, {
    contract: flagString(context.args, "contract") ?? CONTRACT_TAIL,
    limit: flagNumber(context.args, "limit") ?? 25,
  });

  const outcome = flagString(context.args, "outcome");
  const entries =
    outcome === undefined
      ? report.entries
      : report.entries.filter((entry) => entry.outcome === outcome);

  emitResult(
    { returned: entries.length, next_seq: report.next_seq, entries },
    { json: context.config.json },
    () =>
      entries.length === 0
        ? "No audited dispatches matched."
        : [
            renderTable(
              ["seq", "when", "caller", "on behalf of", "function", "outcome"],
              entries.map((entry) => [
                entry.seq_no,
                new Date(entry.timestamp_ms).toISOString(),
                `${entry.caller_type}:${short(entry.actor)}`,
                short(entry.on_behalf_of),
                entry.function,
                entry.outcome,
              ]),
            ),
            report.next_seq === null ? "" : `\nmore available: resume from seq ${report.next_seq}`,
          ]
            .filter((line) => line !== "")
            .join("\n"),
  );

  return 0;
}

/** DIDs are 48 characters; a table needs the tail that distinguishes them. */
function short(did: string): string {
  return did.length <= 14 ? did : `${did.slice(0, 6)}…${did.slice(-6)}`;
}
