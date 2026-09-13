import { CONTRACT_TAIL } from "./types.ts";

/**
 * The contract's agent-facing **descriptor document**.
 *
 * ## Why this module exists
 *
 * Registering a contract is not enough to make it callable. `contracts.register`
 * returns success and `contracts list` reports `status: "active"`, but until a
 * descriptor is published every `execute` fails with a bare
 * `RPC Error: Internal error` and no further detail. A descriptor is therefore a
 * required part of deployment, not optional metadata — `deploy` publishes one on
 * every run.
 *
 * ## The wire shape the node enforces
 *
 * The node validates strictly and names the first offending field, so these are
 * the fields each entry must carry:
 *
 * | field | type | notes |
 * |---|---|---|
 * | `name` | string | must match an exported contract function |
 * | `summary` | non-empty string | |
 * | `mutates` | boolean | |
 * | `auth` | object | |
 * | `params_schema` | object | JSON-Schema-shaped |
 * | `returns` | object | JSON-Schema-shaped |
 * | `errors` | array | |
 * | `examples` | array | |
 *
 * All of them are required, and omitting any one is a hard failure. The schemas
 * are declared permissively on purpose: this contract takes a single
 * `generic-input` envelope whose real payload varies per function, so the
 * meaningful documentation lives in `contract-info` (which the contract returns
 * from its own compiled step table) rather than being restated here where it
 * could drift.
 */

/** Everything the node requires on one function entry. */
interface FunctionDescriptor {
  name: string;
  summary: string;
  mutates: boolean;
  auth: Record<string, unknown>;
  params_schema: Record<string, unknown>;
  returns: Record<string, unknown>;
  errors: { code: string; description: string }[];
  examples: { input: unknown; output?: unknown; note?: string }[];
  tags?: string[];
}

/** A caller may omit everything; the contract supplies its own defaults. */
const OPTIONAL_PAYLOAD: Record<string, unknown> = {
  type: "object",
  additionalProperties: true,
};

const ENVELOPE: Record<string, unknown> = {
  type: "object",
  description:
    "The node supplies a three-field envelope. Only `input` is used by this contract; " +
    "`user-profile` is null for tenant contracts and profile values are resolved host-side " +
    "inside the enclave at dispatch time.",
  properties: {
    input: { type: "object", additionalProperties: true },
  },
};

const PUBLIC_AUTH: Record<string, unknown> = {
  required: false,
  roles: [],
  scopes: [],
  description:
    "Callable by the tenant and by any member holding a delegation grant for this function.",
};

const FUNCTIONS: FunctionDescriptor[] = [
  {
    name: "contract-info",
    summary:
      "Describe this contract: version, exported functions, the config and secret keys an " +
      "operator must supply, and the profile fields each step needs. Reads no maps and makes " +
      "no outbound call.",
    mutates: false,
    auth: PUBLIC_AUTH,
    params_schema: ENVELOPE,
    returns: OPTIONAL_PAYLOAD,
    errors: [],
    examples: [{ input: {}, note: "Returns the full self-description." }],
    tags: ["read-only", "introspection"],
  },
  {
    name: "preflight",
    summary:
      "Report, per step, whether an endpoint and credential are configured, plus which config " +
      "keys, secret keys and profile fields are missing. Makes no outbound call and writes " +
      "nothing. Cannot report egress authorisation: the host evaluates the allow-list at " +
      "dispatch, so `egress_authorised` is always null.",
    mutates: false,
    auth: PUBLIC_AUTH,
    params_schema: ENVELOPE,
    returns: OPTIONAL_PAYLOAD,
    errors: [
      {
        code: "config_unreadable",
        description: "A required map could not be read; run `hr-onboard init` first.",
      },
    ],
    examples: [
      { input: {}, note: "Check every step." },
      { input: { steps: ["enroll-payroll"] }, note: "Check one step." },
    ],
    tags: ["read-only"],
  },
  {
    name: "start-onboarding",
    summary:
      "Run or simulate the onboarding for one employee. Carries no employee PII: the request " +
      "names the employee by an HR-internal reference, and the employee's name, national id, " +
      "address and personal email are substituted by the host inside the enclave when the " +
      "outbound request is built. Dry run by default — nothing is sent and no record is written " +
      "until the caller explicitly sets `dry_run: false`.",
    mutates: true,
    auth: PUBLIC_AUTH,
    params_schema: ENVELOPE,
    returns: OPTIONAL_PAYLOAD,
    errors: [
      { code: "invalid_input", description: "employee_ref, role, department or start_date is missing or malformed." },
      { code: "unknown_step", description: "A requested step is not compiled into this contract version." },
      { code: "config_unreadable", description: "A step endpoint was not found in the `config` map." },
    ],
    examples: [
      {
        input: {
          employee_ref: "emp-2041",
          role: "Backend Engineer",
          department: "Platform",
          start_date: "2026-10-01",
        },
        note: "Dry run. The response contains the request bodies with {{profile.*}} markers still unresolved.",
      },
      {
        input: {
          employee_ref: "emp-2041",
          role: "Backend Engineer",
          department: "Platform",
          start_date: "2026-10-01",
          dry_run: false,
        },
        note: "Sends for real and writes one record to the onboarding-log map.",
      },
    ],
    tags: ["write", "pii-safe"],
  },
  {
    name: "get-onboarding-status",
    summary: "Read back the stored onboarding record for one employee reference.",
    mutates: false,
    auth: PUBLIC_AUTH,
    params_schema: ENVELOPE,
    returns: OPTIONAL_PAYLOAD,
    errors: [
      { code: "invalid_input", description: "employee_ref is missing or malformed." },
      { code: "config_unreadable", description: "The onboarding-log map could not be read." },
    ],
    examples: [{ input: { employee_ref: "emp-2041" }, output: { found: true } }],
    tags: ["read-only"],
  },
  {
    name: "list-onboardings",
    summary: "List stored onboarding records, newest-state first, optionally filtered by status.",
    mutates: false,
    auth: PUBLIC_AUTH,
    params_schema: ENVELOPE,
    returns: OPTIONAL_PAYLOAD,
    errors: [
      { code: "invalid_input", description: "limit or status is malformed." },
      { code: "config_unreadable", description: "The onboarding-log map could not be read." },
    ],
    examples: [{ input: { status: "completed", limit: 20 } }],
    tags: ["read-only"],
  },
];

/** The document published by `deploy`, bound to the version being registered. */
export function descriptorDocument(version: string): Record<string, unknown> {
  return {
    name: CONTRACT_TAIL,
    version,
    summary:
      "Privacy-preserving employee onboarding. The agent plans on non-sensitive data; the " +
      "contract acts, and employee PII is resolved by the host inside the enclave so it never " +
      "enters application memory.",
    tags: ["hr", "onboarding", "privacy", "tee", "pii-safe"],
    functions: FUNCTIONS,
  };
}
