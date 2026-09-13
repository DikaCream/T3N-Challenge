import { TenantClient, getNodeUrl } from "@terminal3/t3n-sdk";
import type {
  ActivityReport,
  BoundGrant,
  ContractRegisterResult,
  MapLifecycleStatus,
  ReaderSet,
  WriterSet,
} from "@terminal3/t3n-sdk";

import type { AppConfig } from "../lib/config.ts";
import type { Logger } from "../lib/log.ts";
import type { Session } from "./session.ts";

/**
 * The tenant control plane.
 *
 * `TenantClient` needs all four config fields to dispatch a control RPC
 * (`environment`, `t3n`, `tenantDid`, `baseUrl`). v5 validates the whole set up
 * front and names everything that is missing in one error, but building it in
 * one place is still the only way to be sure we never half-configure it.
 */
export function createTenantClient(config: AppConfig, session: Session): TenantClient {
  return new TenantClient({
    environment: config.env,
    t3n: session.client,
    tenantDid: session.did,
    baseUrl: getNodeUrl(),
    endpoint: getNodeUrl(),
  });
}

export interface MapSpec {
  tail: string;
  purpose: string;
  visibility: "private" | "public";
  writers: WriterSet;
  readers: ReaderSet;
}

export type MapOutcome = "created" | "updated";

/**
 * Create a map, or bring an existing one back to the declared ACLs.
 *
 * Idempotent on purpose: `deploy` re-runs it on every registration because a
 * contract-scoped ACL is keyed on the numeric contract id, and that id is
 * assigned fresh on each registration. Skipping this is how a working
 * deployment breaks on its second deploy.
 */
export async function ensureMap(
  tenant: TenantClient,
  spec: MapSpec,
  log: Logger,
): Promise<MapOutcome> {
  const status = await tenant.maps.getStatus(spec.tail);

  if (status === "deleting") {
    log.warn("map is still being drained by the host sweeper", {
      tail: spec.tail,
      purpose: spec.purpose,
    });
    await waitForAbsent(tenant, spec.tail, log);
  }

  if (status === "active") {
    await tenant.maps.update(spec.tail, {
      visibility: spec.visibility,
      writers: spec.writers,
      readers: spec.readers,
    });
    return "updated";
  }

  await tenant.maps.create({
    tail: spec.tail,
    visibility: spec.visibility,
    writers: spec.writers,
    readers: spec.readers,
  });
  return "created";
}

/**
 * A delete is asynchronous and the host offers no completion callback, so the
 * only correct move is to poll. Capped, because a map wedged in `deleting` is an
 * operator problem, not something to hide behind an infinite wait.
 */
async function waitForAbsent(
  tenant: TenantClient,
  tail: string,
  log: Logger,
  attempts = 10,
  delayMs = 3_000,
): Promise<void> {
  for (let i = 0; i < attempts; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    const status: MapLifecycleStatus = await tenant.maps.getStatus(tail);
    if (status !== "deleting") return;
    log.debug("waiting for map deletion to settle", { tail, attempt: i + 1 });
  }
  throw new Error(
    `Map '${tail}' is stuck in the 'deleting' state. Pick a different tail, or wait and retry.`,
  );
}

/** Write one entry through the tenant management surface. */
export async function setEntry(
  tenant: TenantClient,
  tail: string,
  key: string,
  value: string,
): Promise<void> {
  await tenant.maps.entrySet(tail, key, value);
}

export async function getEntry(
  tenant: TenantClient,
  tail: string,
  key: string,
): Promise<string | null> {
  return await tenant.maps.entryGet(tail, key);
}

export interface RegisterInput {
  tail: string;
  version: string;
  wasm: Uint8Array;
  /** Hex SHA-256 of the source bundle, when we are publishing source too. */
  sourceHash?: string;
}

export async function registerContract(
  tenant: TenantClient,
  input: RegisterInput,
): Promise<ContractRegisterResult> {
  const payload: { tail: string; version: string; wasm: Uint8Array; source_hash?: string } = {
    tail: input.tail,
    version: input.version,
    wasm: input.wasm,
  };
  if (input.sourceHash !== undefined) {
    payload.source_hash = input.sourceHash;
  }
  return await tenant.contracts.register(payload);
}

/**
 * Publish the contract's agent-facing descriptor document.
 *
 * **Required for dispatchability, not optional metadata.** A registered contract
 * with no descriptor returns `status: "active"` from the inventory view yet
 * fails every `execute` with a bare `RPC Error: Internal error`, with no field name,
 * no hint that a descriptor is the missing piece. Publishing one is what makes
 * the contract callable, which is why `deploy` does it on every run.
 *
 * `name@version` must already be registered; the node refuses a descriptor for an
 * unknown version.
 */
export async function setContractDescriptor(
  tenant: TenantClient,
  input: { tail: string; version: string; descriptor: unknown },
): Promise<void> {
  await tenant.contracts.setDescriptor({
    tail: input.tail,
    version: input.version,
    descriptor: input.descriptor,
  });
}

export interface InvokeInput {
  tail: string;
  version: string;
  functionName: string;
  payload: Record<string, unknown>;
}

/**
 * Run one function of a registered tenant contract inside the enclave.
 *
 * Returns `unknown` deliberately: the SDK cannot know our schema, so the
 * caller narrows it (`assertRecord`) at the boundary.
 */
export async function invokeContract(
  tenant: TenantClient,
  input: InvokeInput,
): Promise<unknown> {
  return await tenant.contracts.execute(input.tail, {
    version: input.version,
    functionName: input.functionName,
    input: input.payload,
  });
}

export interface RegisteredContract {
  name: string;
  version: string;
  status: string;
  summary: string;
}

export async function registeredContracts(
  tenant: TenantClient,
): Promise<RegisteredContract[]> {
  const page = await tenant.contracts.listDetailed({ limit: 100 });
  return page.contracts.map((contract) => ({
    name: contract.name,
    version: contract.version,
    status: contract.status,
    summary: contract.descriptor?.summary ?? "",
  }));
}

export function canonicalName(tenant: TenantClient, tail: string): string {
  return tenant.canonicalName(tail);
}

/**
 * The version of a contract currently registered on-chain.
 *
 * Runtime code dispatches against *this*, not against the local `Cargo.toml`
 * version. A deployed server has no build tree, and even locally the two can
 * legitimately differ; the point of asking the chain is to act on what is
 * actually deployed rather than on what happens to be in the working copy.
 */
export async function registeredVersion(
  tenant: TenantClient,
  tail: string,
): Promise<{ name: string; version: string; status: string } | null> {
  const page = await tenant.contracts.listDetailed({ limit: 100 });
  const match = page.contracts.find((contract) => contract.name.endsWith(`:${tail}`));
  if (match === undefined) return null;
  return { name: match.name, version: match.version, status: match.status };
}

/** Ledger-level audit of contract dispatches, scoped to the caller's org. */
export async function activityLog(
  session: Session,
  options: { contract?: string; limit?: number } = {},
): Promise<ActivityReport> {
  const query: { limit?: number; contract?: string } = {};
  if (options.limit !== undefined) query.limit = options.limit;
  if (options.contract !== undefined) query.contract = options.contract;
  return await session.client.getActivityLog(query);
}

/**
 * Delegate scoped authority to an agent DID.
 *
 * This is the whole trust model in one call: the agent gets named functions on
 * one contract, and an explicit egress allow-list. No grant, no access: the
 * contract still runs, the outbound call is simply denied.
 */
export async function grantAgent(
  session: Session,
  grant: BoundGrant,
): Promise<void> {
  await session.client.addMemberDelegationGrants([grant]);
}

export function describeGrant(grant: BoundGrant): string {
  return [
    `grantee   ${grant.grantee}`,
    `contract  ${grant.contract_id}`,
    `functions ${grant.functions.join(", ")}`,
    `hosts     ${(grant.allowed_hosts ?? []).join(", ") || "(none, egress will be denied)"}`,
  ].join("\n");
}
