import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";

import { ConfigError, loadConfig } from "./config.ts";

/** Every variable `loadConfig` reads, so a test can neither inherit nor leak one. */
const MANAGED = [
  "T3N_API_KEY",
  "T3N_ENV",
  "T3N_LOG_LEVEL",
  "ONBOARD_IDENTITY_ENDPOINT",
  "ONBOARD_PAYROLL_ENDPOINT",
  "ONBOARD_IDENTITY_HEADERS",
  "ONBOARD_PAYROLL_HEADERS",
  "HRIS_API_KEY",
  "PAYROLL_API_KEY",
  "AGENT_DID",
  "LLM_API_KEY",
  "LLM_BASE_URL",
  "LLM_MODEL",
] as const;

let saved: Record<string, string | undefined> = {};

beforeEach(() => {
  saved = {};
  for (const name of MANAGED) {
    saved[name] = process.env[name];
    delete process.env[name];
  }
});

afterEach(() => {
  for (const name of MANAGED) {
    const value = saved[name];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

/** The minimum a real run needs; tests override from here. */
function minimal(): void {
  process.env["T3N_API_KEY"] = "0xdeadbeef";
  process.env["ONBOARD_IDENTITY_ENDPOINT"] = "https://httpbin.org/post";
  process.env["ONBOARD_PAYROLL_ENDPOINT"] = "https://httpbin.org/post";
}

test("a missing API key is named with the fix attached", () => {
  assert.throws(
    () => loadConfig(),
    (error: unknown) =>
      error instanceof ConfigError && /T3N_API_KEY/.test(error.message) && /claim/.test(error.message),
  );
});

test("defaults are testnet, info level, and not json or quiet", () => {
  minimal();
  const config = loadConfig();
  assert.equal(config.env, "testnet");
  assert.equal(config.logLevel, "info");
  assert.equal(config.json, false);
  assert.equal(config.quiet, false);
});

test("json and quiet come from the caller, not the environment", () => {
  minimal();
  const config = loadConfig({ json: true, quiet: true });
  assert.equal(config.json, true);
  assert.equal(config.quiet, true);
});

test("an out-of-range environment is rejected by name", () => {
  minimal();
  process.env["T3N_ENV"] = "staging";
  assert.throws(() => loadConfig(), /T3N_ENV must be one of testnet \| sandbox \| production/);
});

test("optional keys are omitted rather than set to undefined", () => {
  // `exactOptionalPropertyTypes` is on: an absent optional must not appear as a
  // key holding `undefined`, or later code cannot tell "unset" from "empty".
  minimal();
  const config = loadConfig();
  assert.equal("secret" in config.identity, false);
  assert.equal("headers" in config.identity, false);
  assert.equal("agentDid" in config, false);
  assert.equal("llm" in config, false);
});

test("headers must be a JSON object string, rejected before it reaches the enclave", () => {
  minimal();
  process.env["ONBOARD_IDENTITY_HEADERS"] = '["not","an","object"]';
  assert.throws(
    () => loadConfig(),
    (error: unknown) =>
      error instanceof ConfigError && /ONBOARD_IDENTITY_HEADERS/.test(error.message),
  );

  process.env["ONBOARD_IDENTITY_HEADERS"] = '{"X-Tenant":"acme"}';
  assert.equal(loadConfig().identity.headers, '{"X-Tenant":"acme"}');
});

test("secrets are read per step under their own names", () => {
  minimal();
  process.env["HRIS_API_KEY"] = "hris-token";
  const config = loadConfig();
  assert.equal(config.identity.secret, "hris-token");
  assert.equal("secret" in config.payroll, false);
});

test("an agent DID is carried through when set", () => {
  minimal();
  process.env["AGENT_DID"] = "did:t3n:agent";
  assert.equal(loadConfig().agentDid, "did:t3n:agent");
});

test("the LLM block defaults its base URL and model, and is absent without a key", () => {
  minimal();
  process.env["LLM_API_KEY"] = "sk-test";
  const config = loadConfig();
  assert.equal(config.llm?.baseUrl, "https://api.openai.com/v1");
  assert.equal(config.llm?.model, "gpt-4o-mini");

  delete process.env["LLM_API_KEY"];
  assert.equal("llm" in loadConfig(), false);
});
