/**
 * Hand-mirrored view of the contract's JSON wire shapes.
 *
 * Kept as plain interfaces rather than generated types on purpose: the contract
 * is small, the wire format is documented in `wit/world.wit`, and a hand-written
 * mirror is far easier to review than a codegen step. The decoder below is the
 * only place the shapes are trusted, so a drift surfaces as one clear error.
 */

export type StepStatus = "planned" | "ok" | "failed" | "denied";
export type RecordStatus = "planned" | "completed" | "partial" | "failed";

export interface StepResult {
  name: string;
  status: StepStatus;
  host: string;
  http_status: number | null;
  request_body: string | null;
  detail: string | null;
}

export interface OnboardingRecord {
  employee_ref: string;
  role: string;
  department: string;
  start_date: string;
  status: RecordStatus;
  dry_run: boolean;
  steps: StepResult[];
  contract_version: string;
  recorded_at_secs: number;
  contains_pii: boolean;
}

export interface StatusResponse {
  found: boolean;
  record: OnboardingRecord | null;
}

export interface ListResponse {
  count: number;
  truncated: boolean;
  records: OnboardingRecord[];
}

export interface StepPreflight {
  name: string;
  host: string;
  endpoint_configured: boolean;
  /** Whether a credential is stored for this step. Optional, not required. */
  secret_present: boolean;
  /**
   * Always `null` from the deployed contract. `null` means **not knowable before
   * dispatch**, never "denied": the host evaluates the egress allow-list when the
   * request is sent and exposes no way to ask in advance. A refusal surfaces at
   * run time as status `denied`.
   */
  egress_authorised: boolean | null;
  /** Why egress authorisation is not reported here, or a denial from a run. */
  egress_note: string | null;
  placeholders: string[];
}

export interface PreflightReport {
  contract_version: string;
  /**
   * `true` when every step is configured. It is deliberately not a claim that
   * egress is authorised; see `egress_enforcement`.
   */
  ready: boolean;
  /** Where egress policy is actually enforced. */
  egress_enforcement: string;
  steps: StepPreflight[];
  missing_config: string[];
  missing_secrets: string[];
  required_profile_fields: string[];
}

export interface ContractInfo {
  contract: string;
  contract_version: string;
  functions: { name: string; purpose: string }[];
  steps: { name: string; purpose: string; placeholders: string[] }[];
  config_keys: string[];
  secret_keys: string[];
  profile_fields: string[];
  maps: string[];
  default_dry_run: boolean;
}

/**
 * Registry tail: the contract is registered as `z:<tid>:employee-onboarding`.
 *
 * Lives in this module, which has no filesystem or SDK imports, so both the
 * Node CLI and the Next.js server routes can name the contract. The web app
 * must not reach `src/contract/artifacts.ts`, which is filesystem-bound.
 */
export const CONTRACT_TAIL = "employee-onboarding";

/** The three tenant maps the contract expects to exist. */
export const MAP_TAILS = ["config", "secrets", "onboarding-log"] as const;

/** Function names, in one place so the CLI and docs cannot drift. */
export const FUNCTIONS = {
  info: "contract-info",
  preflight: "preflight",
  start: "start-onboarding",
  status: "get-onboarding-status",
  list: "list-onboardings",
} as const;

/**
 * Narrow an unknown RPC result.
 *
 * The SDK returns `unknown` for contract execution, which is correct: the
 * caller owns the schema. Checking the required keys at the boundary means a
 * wrong-shaped payload fails here with the actual keys it received, instead of
 * producing `undefined` five lines later.
 */
export function expectKeys<T>(
  value: unknown,
  where: string,
  keys: readonly string[],
): T {
  if (value === null || typeof value !== "object") {
    throw new Error(`${where}: expected an object response, got ${typeof value}`);
  }
  const present = value as Record<string, unknown>;
  const missing = keys.filter((key) => !(key in present));
  if (missing.length > 0) {
    throw new Error(
      `${where}: response is missing ${missing.join(", ")}. Got keys: ${Object.keys(present).join(", ") || "(none)"}`,
    );
  }
  return value as T;
}

/**
 * Normalise a contract result into the JSON value the contract returned.
 *
 * The SDK hands back `unknown` because it cannot know our schema, and different
 * execution paths return the payload at different depths (raw JSON object, a
 * JSON string, or wrapped in an envelope). Resolving that here keeps every
 * command able to assume it holds the contract's own output shape.
 */
export function decodeResult(value: unknown, where: string): unknown {
  if (typeof value === "string") {
    try {
      return JSON.parse(value) as unknown;
    } catch {
      throw new Error(`${where}: contract returned a non-JSON string: ${value.slice(0, 200)}`);
    }
  }
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    for (const key of ["response", "result"]) {
      const nested = record[key];
      // Our own responses never carry these keys, so unwrapping is safe and
      // avoids a `{response: {...}}` shape leaking into command output.
      if (nested !== undefined && typeof nested !== "string") {
        return nested;
      }
      if (typeof nested === "string" && nested.trimStart().startsWith("{")) {
        return JSON.parse(nested) as unknown;
      }
    }
  }
  return value;
}

export function assertRecord(value: unknown, where: string): OnboardingRecord {
  const record = expectKeys<OnboardingRecord>(value, where, [
    "employee_ref",
    "status",
    "steps",
  ]);
  if (!Array.isArray(record.steps)) {
    throw new Error(`${where}: 'steps' should be an array`);
  }
  return record;
}
