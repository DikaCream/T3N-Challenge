import type { TenantClient } from "@terminal3/t3n-sdk";

import type { AppConfig } from "../lib/config.ts";
import type { Logger } from "../lib/log.ts";
import { ensureMap, getEntry, setEntry } from "../t3n/tenant.ts";
import type { MapSpec } from "../t3n/tenant.ts";

/**
 * Key in the `config` map holding the numeric id of the deployed contract.
 *
 * The SDK offers no way to read a contract's id back: neither `list` nor
 * `listDetailed` carries it, map ACLs are write-only (only `getStatus` is
 * exposed), and the ledger records the canonical *name* rather than the id. Since
 * both contract-scoped ACLs are keyed on the id, tenant state is the only place
 * it can live.
 */
export const CONTRACT_ID_KEY = "contract_id";

/**
 * Tenant provisioning: the maps and the config they hold.
 *
 * Extracted from the CLI's `init`/`seed` commands so the web app performs the
 * exact same steps rather than a parallel implementation. Nothing here reads
 * argv, prints, or touches the filesystem; that is the CLI's and the HTTP
 * layer's job respectively.
 */

/**
 * The three maps, and the access story for each.
 *
 * The split is the whole point of the design:
 *  - `config`: endpoints and header names. Not secret, so operators may read it.
 *  - `secrets`: upstream credentials, readable **only** by the contract, so
 *                even the process that wrote them cannot read them back.
 *  - `onboarding-log`: written **only** by the contract, so a record cannot be
 *                back-dated or edited by whoever holds the tenant key.
 *
 * `contractId` is `null` before the first deploy. Both contract-scoped ACLs then
 * resolve to an empty `only` list, deny-all until `deploy` points them at the
 * real numeric id. That ordering matters because the id is assigned at
 * registration time, so `deploy` must re-apply these.
 */
export function mapSpecs(contractId: number | null): MapSpec[] {
  const contractOnly = contractId === null ? { only: [] } : { only: [contractId] };

  return [
    {
      tail: "config",
      purpose: "Operator config: step endpoints and extra request headers.",
      visibility: "private",
      writers: { only: [] },
      readers: "all",
    },
    {
      tail: "secrets",
      purpose: "Upstream API credentials. Readable only inside the enclave.",
      visibility: "private",
      writers: { only: [] },
      readers: contractOnly,
    },
    {
      tail: "onboarding-log",
      purpose: "Non-PII onboarding records. Writable only by the contract.",
      visibility: "private",
      writers: contractOnly,
      readers: "all",
    },
  ];
}

export interface ProvisionResult {
  maps: { tail: string; outcome: string; purpose: string }[];
  /** Config keys written, in order. Values are never returned. */
  configKeys: string[];
}

/** Create or reconcile the tenant maps, then write the step endpoints. */
export async function provisionTenant(
  tenant: TenantClient,
  config: AppConfig,
  log: Logger,
): Promise<ProvisionResult> {
  // Re-point the contract-scoped ACLs at the contract that is actually deployed.
  //
  // `mapSpecs(null)` resolves those ACLs to `{ only: [] }`, deny-all. That is
  // right for a fresh tenant and catastrophic afterwards: `init` is a perfectly
  // reasonable thing to re-run, and doing so would silently revoke the deployed
  // contract's access to its own `secrets` and `onboarding-log` maps. So the
  // recorded id is read back and used, and `null` only when there is none.
  const recorded = await getEntry(tenant, "config", CONTRACT_ID_KEY);
  const parsed = recorded === null ? Number.NaN : Number.parseInt(recorded, 10);
  const contractId = Number.isFinite(parsed) ? parsed : null;

  if (contractId === null) {
    log.debug("no recorded contract id; contract-scoped ACLs resolve to deny-all", {
      key: CONTRACT_ID_KEY,
    });
  }

  const maps: ProvisionResult["maps"] = [];
  for (const spec of mapSpecs(contractId)) {
    const outcome = await ensureMap(tenant, spec, log);
    maps.push({ tail: spec.tail, outcome, purpose: spec.purpose });
  }

  // Endpoints live in the map, not in the code: the contract reads them from
  // inside the enclave, so retargeting a step is a config write, not a redeploy.
  const entries: { key: string; value: string }[] = [
    { key: "identity_endpoint", value: config.identity.endpoint },
    { key: "payroll_endpoint", value: config.payroll.endpoint },
  ];
  if (config.identity.headers !== undefined) {
    entries.push({ key: "identity_headers", value: config.identity.headers });
  }
  if (config.payroll.headers !== undefined) {
    entries.push({ key: "payroll_headers", value: config.payroll.headers });
  }

  for (const entry of entries) {
    await setEntry(tenant, "config", entry.key, entry.value);
  }

  return { maps, configKeys: entries.map((entry) => entry.key) };
}

export interface SeedResult {
  written: string[];
  skipped: boolean;
}

/**
 * Move upstream credentials into the `secrets` map.
 *
 * Returns only the key names. The values never leave this function; they would
 * otherwise land in terminals, CI logs and screenshots.
 */
export async function seedSecrets(
  tenant: TenantClient,
  config: AppConfig,
  log: Logger,
): Promise<SeedResult> {
  const writes: { key: string; value: string }[] = [];
  if (config.identity.secret !== undefined) {
    writes.push({ key: "hris_api_key", value: config.identity.secret });
  }
  if (config.payroll.secret !== undefined) {
    writes.push({ key: "payroll_api_key", value: config.payroll.secret });
  }

  if (writes.length === 0) {
    log.warn(
      "No HRIS_API_KEY or PAYROLL_API_KEY set, so nothing was written. That is fine if your endpoints need no bearer token.",
    );
    return { written: [], skipped: true };
  }

  for (const write of writes) {
    await setEntry(tenant, "secrets", write.key, write.value);
  }

  return { written: writes.map((write) => write.key), skipped: false };
}
