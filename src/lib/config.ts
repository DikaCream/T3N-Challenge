import type { Environment } from "@terminal3/t3n-sdk";
import type { LogLevel } from "./log.ts";

const ENVIRONMENTS: readonly Environment[] = ["testnet", "sandbox", "production"];
const LOG_LEVELS: readonly LogLevel[] = ["debug", "info", "warn", "error"];

/** A missing or malformed variable, reported with the fix attached. */
export class ConfigError extends Error {
  override readonly name = "ConfigError";
}

export interface StepTargetConfig {
  /** `config` map key -> endpoint, as the contract reads them. */
  endpoint: string;
  headers?: string;
  secret?: string;
}

export interface AppConfig {
  apiKey: string;
  env: Environment;
  logLevel: LogLevel;
  json: boolean;
  quiet: boolean;
  /** Written into the tenant `config` map by `init`. */
  identity: StepTargetConfig;
  payroll: StepTargetConfig;
  /** Written into the tenant `secrets` map by `seed`. */
  agentDid?: string;
  llm?: { apiKey: string; baseUrl: string; model: string };
}

function required(name: string, hint: string): string {
  const value = process.env[name]?.trim();
  if (value === undefined || value === "") {
    throw new ConfigError(`Missing ${name}. ${hint}`);
  }
  return value;
}

function optional(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value === undefined || value === "" ? undefined : value;
}

function oneOf<T extends string>(
  name: string,
  allowed: readonly T[],
  fallback: T,
): T {
  const value = optional(name);
  if (value === undefined) return fallback;
  if (!allowed.includes(value as T)) {
    throw new ConfigError(
      `${name} must be one of ${allowed.join(" | ")}, got '${value}'`,
    );
  }
  return value as T;
}

export interface LoadOptions {
  json?: boolean;
  quiet?: boolean;
}

/**
 * Build the config for a command that talks to T3N.
 *
 * Called only by commands that need a session, so `whoami`-style help still
 * works on a machine with no `.env` at all.
 */
export function loadConfig(options: LoadOptions = {}): AppConfig {
  const config: AppConfig = {
    apiKey: required(
      "T3N_API_KEY",
      "Claim one at https://www.terminal3.io/claim-page (shown once, so copy it immediately), then put it in .env.",
    ),
    env: oneOf("T3N_ENV", ENVIRONMENTS, "testnet"),
    logLevel: oneOf("T3N_LOG_LEVEL", LOG_LEVELS, "info"),
    json: options.json === true,
    quiet: options.quiet === true,
    identity: {
      endpoint: required(
        "ONBOARD_IDENTITY_ENDPOINT",
        "Set it to any HTTPS endpoint you control (httpbin.org/post works for a demo).",
      ),
      ...optionalTarget("ONBOARD_IDENTITY_HEADERS", "HRIS_API_KEY"),
    },
    payroll: {
      endpoint: required(
        "ONBOARD_PAYROLL_ENDPOINT",
        "Set it to any HTTPS endpoint you control (httpbin.org/post works for a demo).",
      ),
      ...optionalTarget("ONBOARD_PAYROLL_HEADERS", "PAYROLL_API_KEY"),
    },
  };

  const agentDid = optional("AGENT_DID");
  if (agentDid !== undefined) {
    config.agentDid = agentDid;
  }

  const llmApiKey = optional("LLM_API_KEY");
  if (llmApiKey !== undefined) {
    config.llm = {
      apiKey: llmApiKey,
      baseUrl: optional("LLM_BASE_URL") ?? "https://api.openai.com/v1",
      model: optional("LLM_MODEL") ?? "gpt-4o-mini",
    };
  }

  return config;
}

/**
 * `exactOptionalPropertyTypes` is on, so an absent optional is represented by
 * omitting the key rather than setting it to `undefined`.
 */
function optionalTarget(
  headersName: string,
  secretName: string,
): { headers?: string; secret?: string } {
  const headers = optional(headersName);
  const secret = optional(secretName);
  const out: { headers?: string; secret?: string } = {};
  if (headers !== undefined) {
    // Validate here rather than letting the contract fail with a JSON parse
    // error from inside the enclave, where the message is much harder to act on.
    try {
      const parsed: unknown = JSON.parse(headers);
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("not a JSON object");
      }
    } catch (error) {
      throw new ConfigError(
        `${headersName} must be a JSON object string, e.g. {"X-Tenant":"acme"} (${String(error)})`,
      );
    }
    out.headers = headers;
  }
  if (secret !== undefined) {
    out.secret = secret;
  }
  return out;
}
