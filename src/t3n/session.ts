import {
  T3nClient,
  createEthAuthInput,
  eth_get_address,
  fetchTrustedManifest,
  formatTokens,
  getNodeUrl,
  loadWasmComponent,
  metamask_sign,
  setEnvironment,
} from "@terminal3/t3n-sdk";
import type { Environment } from "@terminal3/t3n-sdk";

import type { AppConfig } from "../lib/config.ts";
import type { Logger } from "../lib/log.ts";

/**
 * An authenticated `did:t3n:...` session.
 *
 * `did` is the tenant identity the platform assigned this key the first time it
 * signed in. It is opaque and unrelated to the wallet address — never derived,
 * always read back from the authenticated session.
 */
export interface Session {
  client: T3nClient;
  did: string;
  env: Environment;
  nodeUrl: string;
}

/**
 * The five steps the docs' quickstart describes, in the order it requires:
 * environment, WASM, address, client, handshake, authenticate.
 *
 * `trustAnchor` is not optional and is not something we can fake: the client
 * refuses to construct without it, which is the point. `fetchTrustedManifest`
 * returns an anchor verified against a public key pinned inside the SDK, so a
 * forged attestation from an attacker-run TDX machine fails here rather than
 * silently decrypting the session.
 */
export async function connect(config: AppConfig, log: Logger): Promise<Session> {
  setEnvironment(config.env);

  const wasmComponent = await loadWasmComponent();
  const address = eth_get_address(config.apiKey);
  const nodeUrl = getNodeUrl();

  log.debug("t3n: preparing session", {
    env: config.env,
    nodeUrl,
    signingAddress: address,
  });

  const trustAnchor = await fetchTrustedManifest(config.env);
  const client = new T3nClient({
    trustAnchor,
    wasmComponent,
    handlers: {
      // Signs the login challenge locally. The key never leaves this process.
      EthSign: metamask_sign(address, undefined, config.apiKey),
    },
  });

  await client.handshake();
  const did = await client.authenticate(createEthAuthInput(address));

  log.debug("t3n: authenticated", { did: did.value, env: config.env });

  return { client, did: did.value, env: config.env, nodeUrl };
}

export interface AccountSnapshot {
  did: string;
  env: Environment;
  nodeUrl: string;
  credits: {
    availableBaseUnits: number;
    reservedBaseUnits: number;
    available: string;
    creditExhausted: boolean;
  } | null;
}

/** Best-effort account state. A balance read must never block the real work. */
export async function snapshot(
  session: Session,
  log: Logger,
): Promise<AccountSnapshot> {
  let credits: AccountSnapshot["credits"] = null;
  try {
    const usage = await session.client.getUsage();
    const balance = usage.balance;
    if (balance !== undefined && typeof balance.available === "number") {
      credits = {
        availableBaseUnits: balance.available,
        reservedBaseUnits: balance.reserved,
        // Balance is in base units; showing the raw number invites the reader to
        // compare it against the whole-token figure on the claim page and panic.
        available: formatTokens(balance.available),
        creditExhausted: balance.credit_exhausted,
      };
    }
  } catch (error) {
    log.debug("t3n: could not read credit balance", { error: String(error) });
  }

  return {
    did: session.did,
    env: session.env,
    nodeUrl: session.nodeUrl,
    credits,
  };
}
