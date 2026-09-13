import { CONTRACT_TAIL } from "../contract/types.ts";
import { contractVersion, describeArtifact, loadWasm } from "../contract/artifacts.ts";
import { descriptorDocument } from "../contract/descriptor.ts";
import { rejectPositionals, rejectUnknownFlags } from "../lib/args.ts";
import { emitResult } from "../lib/log.ts";
import { compareSemver } from "../lib/semver.ts";
import { renderTable } from "../lib/table.ts";
import {
  CONTRACT_ID_KEY,
  mapSpecs,
  provisionTenant,
  seedSecrets,
} from "../services/provision.ts";
import {
  ensureMap,
  getEntry,
  registerContract,
  registeredContracts,
  registeredVersion,
  setContractDescriptor,
  setEntry,
} from "../t3n/tenant.ts";
import type { Context } from "./context.ts";

const INIT_USAGE = "hr-onboard init";

export async function cmdInit(context: Context): Promise<number> {
  rejectUnknownFlags(context.args, ["json", "quiet", "help"], INIT_USAGE);
  rejectPositionals(context.args, INIT_USAGE);

  const { tenant, config, log } = context;
  const provisioned = await provisionTenant(tenant, config, log);

  const result = {
    tenant: context.session.did,
    maps: provisioned.maps,
    config_written: provisioned.configKeys,
    next: "Run `hr-onboard deploy` to register the contract, then `hr-onboard seed`.",
  };

  log.info("tenant maps ready", {
    maps: provisioned.maps.map((entry) => `${entry.tail}(${entry.outcome})`),
  });

  emitResult(result, { json: config.json }, () =>
    [
      renderTable(
        ["map", "action", "purpose"],
        provisioned.maps.map((entry) => [entry.tail, entry.outcome, entry.purpose]),
      ),
      "",
      `config keys written: ${provisioned.configKeys.join(", ")}`,
      "",
      "Next: hr-onboard deploy  →  hr-onboard seed",
    ].join("\n"),
  );

  return 0;
}

const SEED_USAGE = "hr-onboard seed";

export async function cmdSeed(context: Context): Promise<number> {
  rejectUnknownFlags(context.args, ["json", "quiet", "help"], SEED_USAGE);
  rejectPositionals(context.args, SEED_USAGE);

  const { tenant, config } = context;
  const seeded = await seedSecrets(tenant, config, context.log);

  if (seeded.skipped) return 0;

  // Values are deliberately absent from the result: this output lands in
  // terminals, CI logs and screenshots.
  emitResult(
    { written: seeded.written, values: "***" },
    { json: config.json },
    () => `Seeded secrets map with: ${seeded.written.join(", ")}`,
  );

  return 0;
}

const DEPLOY_USAGE = "hr-onboard deploy";

export async function cmdDeploy(context: Context): Promise<number> {
  rejectUnknownFlags(context.args, ["json", "quiet", "help"], DEPLOY_USAGE);
  rejectPositionals(context.args, DEPLOY_USAGE);

  const { tenant, config, log } = context;

  // Throws with the exact build commands when the artifact is missing.
  const artifact = describeArtifact();
  const version = contractVersion();

  // Decide before registering. The node refuses a version that is not strictly
  // higher than the registered one, and treating that refusal as a crash would
  // make `deploy` fail on a re-run, which is exactly when an operator reaches
  // for it, because it is the command that answers "what state is my tenant in?".
  const deployed = await registeredVersion(tenant, CONTRACT_TAIL);
  const relation = deployed === null ? 1 : compareSemver(version, deployed.version);

  if (relation < 0) {
    throw new Error(
      `Local contract version ${version} is older than the deployed ${deployed?.version ?? "?"}. ` +
        "The node refuses a downgrade. Bump past it in `Cargo.toml` and `src/lib.rs`.",
    );
  }

  const registering = relation > 0;
  let contractId: number | null = null;

  if (registering) {
    log.info("registering contract", {
      tail: CONTRACT_TAIL,
      version,
      sizeBytes: artifact.sizeBytes,
    });

    const registration = await registerOrPublish(context, {
      tail: CONTRACT_TAIL,
      version,
      wasm: loadWasm(),
    });
    contractId = registration.contract_id;

    // Record it, so the next deploy can reconcile without re-registering.
    await setEntry(tenant, "config", CONTRACT_ID_KEY, String(contractId));
  } else {
    const recorded = await getEntry(tenant, "config", CONTRACT_ID_KEY);
    const parsed = recorded === null ? Number.NaN : Number.parseInt(recorded, 10);
    contractId = Number.isFinite(parsed) ? parsed : null;
    log.info("already registered at this version; reconciling instead of re-registering", {
      version,
      contractId: contractId ?? "(not recorded)",
    });
  }

  // Publishing the descriptor is what makes the contract dispatchable. Without
  // it `register` still reports success and the inventory still says `active`,
  // but every `execute` fails with an unactionable internal error. Not optional
  // metadata, and cheap enough to refresh on every run.
  await setContractDescriptor(tenant, {
    tail: CONTRACT_TAIL,
    version,
    descriptor: descriptorDocument(version),
  });
  log.debug("published contract descriptor", { tail: CONTRACT_TAIL, version });

  // A fresh registration assigns a fresh numeric contract id, and both
  // contract-scoped map ACLs are keyed on it. Re-pointing them is what makes a
  // second deploy work instead of silently locking the enclave out of its own
  // maps.
  const acls: { tail: string; outcome: string }[] = [];
  if (contractId !== null) {
    for (const spec of mapSpecs(contractId)) {
      const outcome = await ensureMap(tenant, spec, log);
      acls.push({ tail: spec.tail, outcome });
    }
  }

  const contracts = await registeredContracts(tenant);

  const result = {
    name: deployed?.name ?? CONTRACT_TAIL,
    outcome: registering ? "registered" : "reconciled",
    contract_id: contractId,
    version,
    wasm_bytes: artifact.sizeBytes,
    wasm_path: artifact.wasmPath,
    descriptor: "published",
    acls,
    registered: contracts,
    next: "Run `hr-onboard preflight` to see what the enclave still needs.",
  };

  emitResult(result, { json: config.json }, () =>
    [
      registering
        ? `Registered ${CONTRACT_TAIL} v${version} (contract_id ${contractId})`
        : `Already registered v${version}. Nothing to register; reconciled state instead.`,
      `Artifact  ${artifact.sizeBytes} bytes  ${artifact.wasmPath}`,
      "descriptor published (required for dispatch)",
      "",
      acls.length > 0
        ? renderTable(
            ["map", "action"],
            acls.map((acl) => [acl.tail, acl.outcome]),
          )
        : "map ACLs unchanged (contract id not recorded, so they were left as they are)",
      "",
      registering
        ? "Next: hr-onboard preflight"
        : "To ship a change, bump the version in contracts/employee-onboarding/Cargo.toml and src/lib.rs.",
    ].join("\n"),
  );

  return 0;
}

/**
 * `register` and `publish` take the same input and return the same shape; the
 * docs describe the step as "register" while the SDK exposes both. Try the
 * documented one first and fall back, rather than making the operator guess.
 */
async function registerOrPublish(
  context: Context,
  payload: { tail: string; version: string; wasm: Uint8Array },
): Promise<{ name: string; contract_id: number }> {
  try {
    return await registerContract(context.tenant, payload);
  } catch (error) {
    context.log.debug("register failed; retrying as publish", { error: String(error) });
    try {
      return await context.tenant.contracts.publish(payload);
    } catch {
      throw error;
    }
  }
}
