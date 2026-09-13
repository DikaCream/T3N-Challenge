/**
 * The browser-facing API contract.
 *
 * ## Why re-export rather than redefine
 *
 * The shapes below already exist on the server side, and the ones that matter
 * come from modules with no filesystem or SDK imports, so a client component can
 * reference them without pulling anything into the bundle. `import type` and
 * `export type` are erased by `verbatimModuleSyntax`, so this costs the browser
 * zero bytes — while a hand-copied duplicate would be free to drift from the
 * contract's real output on any future change.
 *
 * `ApiEnvelope` and `Async` are genuinely browser-only concepts, so they are the
 * two that live here.
 */

export type {
  ContractInfo,
  ListResponse,
  OnboardingRecord,
  PreflightReport,
  StatusResponse,
  StepPreflight,
  StepResult,
} from "../../src/contract/types.ts";

export type { OnboardingRequest, Plan, Risk } from "../../src/agent/planner.ts";

export type { SessionStatus } from "./session-status.ts";

/** `{ ok: true, data }` | `{ ok: false, kind, error }` */
export type ApiEnvelope<T> =
  | { ok: true; data: T }
  | { ok: false; kind: "config" | "input" | "error"; error: string };

/** Shared shape for anything that talks to a route and renders three states. */
export type Async<T> =
  | { state: "idle" }
  | { state: "loading" }
  | { state: "error"; message: string }
  | { state: "ready"; data: T };

export interface PreflightResponse {
  contract: { name: string; version: string };
  report: import("../../src/contract/types.ts").PreflightReport;
}

export interface OnboardResponse {
  plan: import("../../src/agent/planner.ts").Plan;
  preflight: import("../../src/contract/types.ts").PreflightReport;
  record: import("../../src/contract/types.ts").OnboardingRecord | null;
  blocked: boolean;
  blockedReason: string | null;
  live: boolean;
}

export type RecordsResponse =
  | { kind: "record"; found: boolean; record: import("../../src/contract/types.ts").OnboardingRecord | null }
  | ({
      kind: "list";
    } & import("../../src/contract/types.ts").ListResponse);

export interface AuditEntry {
  seq_no: number;
  hash: string;
  timestamp_ms: number;
  caller_type: "agent" | "human";
  actor: string;
  on_behalf_of: string;
  org: string;
  contract: string;
  function: string;
  outcome: "success" | "denied" | "error";
  roles?: string[];
}

export interface AuditResponse {
  scope: string;
  next_seq: number | null;
  entries: AuditEntry[];
}

export interface ProvisionResponse {
  tenant: string;
  maps: { tail: string; outcome: string; purpose: string }[];
  configKeys: string[];
}
