import type { AppConfig } from "../lib/config.ts";
import type { Logger } from "../lib/log.ts";

/**
 * The agent's decision layer, and the reason it is safe.
 *
 * Everything in this file runs on **non-sensitive** data only: an internal
 * employee reference, a role, a department and a start date. It never sees a
 * name, a national id, an address or a bank account, because it never needs to:
 * the plan says *which* steps to run, and the TEE contract resolves the human
 * values inside the enclave.
 *
 * Two planners behind one interface, so the model is an optimisation rather
 * than a dependency:
 *  - `deterministic`: rule-based, always available, fully unit-testable.
 *  - `llm`: used only when `LLM_API_KEY` is set, and only to pick
 *                      steps and assess risk. Any failure falls back to the
 *                      deterministic result instead of failing the run.
 */

export interface OnboardingRequest {
  employee_ref: string;
  role: string;
  department: string;
  /** `YYYY-MM-DD`. */
  start_date: string;
  currency?: string;
}

export type Risk = "low" | "medium" | "high";
export type PlannerKind = "deterministic" | "llm";

export interface Plan {
  planner: PlannerKind;
  /** Step names the contract understands. */
  steps: string[];
  risk: Risk;
  rationale: string;
  notes: string[];
}

/** Must stay in step with `STEPS` in the contract. */
export const KNOWN_STEPS = ["provision-identity", "enroll-payroll"] as const;

/**
 * Roles that should not go through standard payroll enrolment. A real
 * deployment would read this from the HRIS; keeping it as an explicit,
 * reviewable rule beats hiding it behind a model.
 */
const NON_EMPLOYEE_PATTERN = /contract|contractor|intern|temporary|\btemp\b|vendor|consultant/i;

/** Days from `from` to `start_date`; `null` when the date is unparseable. */
export function daysUntil(start_date: string, from: Date): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(start_date);
  if (match?.[1] === undefined || match[2] === undefined || match[3] === undefined) {
    return null;
  }
  const target = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  if (Number.isNaN(target)) return null;
  const today = Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate());
  return Math.round((target - today) / 86_400_000);
}

export function deterministicPlan(request: OnboardingRequest, now = new Date()): Plan {
  const notes: string[] = [];
  const steps: string[] = [];

  const haystack = `${request.role} ${request.department}`;
  const looksNonEmployee = NON_EMPLOYEE_PATTERN.test(haystack);

  // Identity always comes first: without a seat there is nothing to enrol.
  steps.push("provision-identity");

  if (looksNonEmployee) {
    notes.push(
      `'${request.role}' matches a non-employee pattern, so payroll enrolment is left to Finance.`,
    );
  } else {
    steps.push("enroll-payroll");
  }

  const days = daysUntil(request.start_date, now);
  let risk: Risk = "low";
  if (days === null) {
    risk = "medium";
    notes.push("start_date could not be parsed, so urgency could not be assessed.");
  } else if (days < 0) {
    risk = "high";
    notes.push(`start_date is ${Math.abs(days)} day(s) in the past; check this is a backfill.`);
  } else if (days <= 3) {
    risk = "high";
    notes.push(`Starts in ${days} day(s); no review window left.`);
  } else if (days <= 10) {
    risk = "medium";
  }

  if (request.currency === undefined) {
    notes.push("No currency supplied; the contract will default to USD.");
  }

  const rationale = looksNonEmployee
    ? `Provisioning a seat only: '${request.role}' is not a standard employment record, so payroll enrolment is withheld pending Finance review.`
    : `Standard hire: provisioning a seat, then enrolling with payroll for the first pay run starting ${request.start_date}.`;

  return { planner: "deterministic", steps, risk, rationale, notes };
}

interface LlmChoice {
  steps?: unknown;
  risk?: unknown;
  rationale?: unknown;
}

/**
 * Ask a model to choose steps. Returns `null` on any problem; the caller then
 * keeps the deterministic plan, so a model outage degrades the agent rather
 * than breaking it.
 */
export async function llmPlan(
  request: OnboardingRequest,
  config: AppConfig,
  log: Logger,
  fetchImpl: typeof fetch = fetch,
): Promise<Plan | null> {
  const llm = config.llm;
  if (llm === undefined) return null;

  const system = [
    "You plan employee onboarding for an enterprise HR system.",
    "You are given only non-sensitive fields. You must never ask for or infer",
    "a name, national id, address, email or bank account: those are resolved",
    "inside a trusted execution environment by a contract, not by you.",
    "",
    `Available steps: ${KNOWN_STEPS.join(", ")}.`,
    "provision-identity creates the HRIS record. enroll-payroll enrols the hire",
    "with the payroll provider; omit it for contractors, interns, temp staff and",
    "vendors.",
    "",
    'Reply with JSON only: {"steps": string[], "risk": "low"|"medium"|"high", "rationale": string}.',
    "`risk` is how much human review this run warrants.",
  ].join("\n");

  const user = JSON.stringify({
    employee_ref: request.employee_ref,
    role: request.role,
    department: request.department,
    start_date: request.start_date,
    currency: request.currency ?? null,
    today: new Date().toISOString().slice(0, 10),
  });

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 20_000);
    let response: Response;
    try {
      response = await fetchImpl(`${llm.baseUrl.replace(/\/$/, "")}/chat/completions`, {
        method: "POST",
        signal: controller.signal,
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${llm.apiKey}`,
        },
        body: JSON.stringify({
          model: llm.model,
          temperature: 0,
          response_format: { type: "json_object" },
          messages: [
            { role: "system", content: system },
            { role: "user", content: user },
          ],
        }),
      });
    } finally {
      clearTimeout(timeout);
    }

    if (!response.ok) {
      log.warn("llm planner unavailable; using the deterministic plan", {
        status: response.status,
      });
      return null;
    }

    const body = (await response.json()) as {
      choices?: { message?: { content?: string } }[];
    };
    const content = body.choices?.[0]?.message?.content;
    if (typeof content !== "string") return null;

    const choice = JSON.parse(content) as LlmChoice;
    const steps = validateSteps(choice.steps, log);
    if (steps === null) return null;

    const risk: Risk =
      choice.risk === "low" || choice.risk === "medium" || choice.risk === "high"
        ? choice.risk
        : "medium";

    return {
      planner: "llm",
      steps,
      risk,
      rationale:
        typeof choice.rationale === "string" && choice.rationale.trim() !== ""
          ? choice.rationale.trim()
          : "Model returned no rationale.",
      notes: [],
    };
  } catch (error) {
    log.warn("llm planner failed; using the deterministic plan", {
      error: String(error),
    });
    return null;
  }
}

/**
 * A model's step list is untrusted input. Anything not in `KNOWN_STEPS` is
 * dropped rather than passed to the contract, where it would fail with an
 * "unknown step" error after a round trip.
 */
export function validateSteps(
  value: unknown,
  log: Logger,
): string[] | null {
  if (!Array.isArray(value)) return null;
  const steps = value.filter(
    (step): step is string =>
      typeof step === "string" && (KNOWN_STEPS as readonly string[]).includes(step),
  );
  const rejected = value.filter((step) => !steps.includes(step as string));
  if (rejected.length > 0) {
    log.warn("dropped unknown steps suggested by the model", { rejected });
  }
  if (steps.length === 0) return null;
  return steps;
}

/**
 * The plan the agent actually runs: try the model when configured, otherwise
 * (or on any failure) use the rules.
 */
export async function planOnboarding(
  request: OnboardingRequest,
  config: AppConfig,
  log: Logger,
): Promise<Plan> {
  const fallback = deterministicPlan(request);

  if (config.llm === undefined) {
    return {
      ...fallback,
      notes: [...fallback.notes, "No LLM_API_KEY set, so the deterministic planner was used."],
    };
  }

  const llm = await llmPlan(request, config, log);
  if (llm === null) {
    return {
      ...fallback,
      notes: [...fallback.notes, "The model was unavailable, so the deterministic planner was used."],
    };
  }

  return llm;
}
