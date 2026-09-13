import type { TenantClient } from "@terminal3/t3n-sdk";

import { decodeResult } from "../contract/types.ts";
import type { Logger } from "../lib/log.ts";
import { invokeContract, registeredVersion } from "../t3n/tenant.ts";

/**
 * The shared contract-dispatch layer, used unchanged by the CLI and by the
 * Next.js server routes.
 *
 * Lives here rather than in `src/commands/` because both surfaces need it and
 * neither should own it. Nothing in `src/services/` may import
 * `src/contract/artifacts.ts`: that module is filesystem-bound, and the web app
 * is deployed without a build tree.
 *
 * ## Why the version comes from the chain
 *
 * Dispatch targets the version **registered on-chain**, not the version in the
 * working copy's `Cargo.toml`. That is the difference between acting on what is
 * deployed and acting on what happens to be checked out, and on a deployed
 * server the `Cargo.toml` is not there at all. It also means the CLI stops being
 * a special case.
 */

export interface ContractContext {
  tenant: TenantClient;
  /** Registry tail, e.g. `employee-onboarding`. */
  tail: string;
  /** The version currently registered on-chain. */
  version: string;
  /** Canonical `z:<tid>:<tail>` name. */
  name: string;
  log: Logger;
}

/** Raised when the contract is not registered, with the fix attached. */
export class ContractNotDeployedError extends Error {
  override readonly name = "ContractNotDeployedError";
  constructor(tail: string) {
    super(
      `Contract '${tail}' is not registered on this tenant, so there is nothing to call. ` +
        "Deploy it from the CLI: `npm run build:contract && npm run cli -- deploy`.",
    );
  }
}

export async function resolveContract(
  tenant: TenantClient,
  tail: string,
  log: Logger,
): Promise<ContractContext> {
  const deployed = await registeredVersion(tenant, tail);
  if (deployed === null) {
    throw new ContractNotDeployedError(tail);
  }

  log.debug("resolved deployed contract", {
    name: deployed.name,
    version: deployed.version,
    status: deployed.status,
  });

  return {
    tenant,
    tail,
    version: deployed.version,
    name: deployed.name,
    log,
  };
}

/**
 * Invoke one exported contract function and normalise the result.
 *
 * `unknown` in, JSON out: the SDK cannot know our schema, so narrowing happens
 * once at this boundary via `decodeResult` and the caller asserts the shape it
 * needs.
 */
export async function callContract(
  context: ContractContext,
  functionName: string,
  payload: Record<string, unknown>,
): Promise<unknown> {
  context.log.debug("invoking contract", {
    contract: context.tail,
    version: context.version,
    functionName,
  });

  const raw = await invokeContract(context.tenant, {
    tail: context.tail,
    version: context.version,
    functionName,
    payload,
  });

  return decodeResult(raw, functionName);
}
