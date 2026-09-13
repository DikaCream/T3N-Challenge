import assert from "node:assert/strict";
import { test } from "node:test";

import { createLogger } from "../lib/log.ts";
import { daysUntil, deterministicPlan, validateSteps } from "./planner.ts";
import type { OnboardingRequest } from "./planner.ts";

/** Warn-level noise is expected here; keep it off the test output. */
const quiet = createLogger({ level: "error", quiet: true });

/** 2026-09-13, the date used throughout the walkthrough. */
const NOW = new Date(Date.UTC(2026, 8, 13));

function request(overrides: Partial<OnboardingRequest> = {}): OnboardingRequest {
  return {
    employee_ref: "emp-2041",
    role: "Backend Engineer",
    department: "Platform",
    start_date: "2026-10-01",
    ...overrides,
  };
}

test("daysUntil counts whole days and rejects a malformed date", () => {
  assert.equal(daysUntil("2026-10-01", NOW), 18);
  assert.equal(daysUntil("2026-09-13", NOW), 0);
  assert.equal(daysUntil("2026-09-01", NOW), -12);
  assert.equal(daysUntil("2026-9-3", NOW), null);
  assert.equal(daysUntil("2026-09-13T00:00", NOW), null);
  assert.equal(daysUntil("next week", NOW), null);
});

test("a standard hire provisions a seat and enrols with payroll", () => {
  const plan = deterministicPlan(request(), NOW);
  assert.equal(plan.planner, "deterministic");
  assert.deepEqual(plan.steps, ["provision-identity", "enroll-payroll"]);
  assert.match(plan.rationale, /payroll/);
  assert.equal(plan.risk, "low");
});

test("a contractor gets a seat only, with the reason recorded", () => {
  const plan = deterministicPlan(request({ role: "Contractor" }), NOW);
  assert.deepEqual(plan.steps, ["provision-identity"]);
  assert.match(plan.rationale, /seat only/);
  assert.ok(plan.notes.some((note) => /Finance/.test(note)));
});

test("non-employee patterns are matched on role and department", () => {
  for (const role of ["Intern", "Temp Worker", "Vendor", "Consultant"]) {
    assert.deepEqual(
      deterministicPlan(request({ role }), NOW).steps,
      ["provision-identity"],
      `${role} should not be enrolled with payroll`,
    );
  }
  assert.deepEqual(
    deterministicPlan(request({ department: "Temporary Staffing" }), NOW).steps,
    ["provision-identity"],
  );
});

test("risk rises with urgency and past start dates", () => {
  assert.equal(deterministicPlan(request({ start_date: "2026-09-18" }), NOW).risk, "medium");
  assert.equal(deterministicPlan(request({ start_date: "2026-09-16" }), NOW).risk, "high");
  assert.equal(deterministicPlan(request({ start_date: "2026-09-01" }), NOW).risk, "high");
});

test("an unparseable start date is medium risk and says why", () => {
  const plan = deterministicPlan(request({ start_date: "whenever" }), NOW);
  assert.equal(plan.risk, "medium");
  assert.ok(plan.notes.some((note) => /could not be parsed/.test(note)));
});

test("a missing currency is flagged rather than assumed silently", () => {
  assert.ok(
    deterministicPlan(request(), NOW).notes.some((note) => /default to USD/.test(note)),
  );
  assert.equal(
    deterministicPlan(request({ currency: "EUR" }), NOW).notes.some((note) => /USD/.test(note)),
    false,
  );
});

test("validateSteps keeps known steps and drops the rest", () => {
  assert.deepEqual(validateSteps(["provision-identity"], quiet), ["provision-identity"]);
  assert.deepEqual(validateSteps(["provision-identity", "wire-transfer"], quiet), [
    "provision-identity",
  ]);
});

test("validateSteps returns null when nothing usable is left", () => {
  // Null is what makes the caller fall back to the deterministic plan instead
  // of dispatching a step the contract does not have.
  assert.equal(validateSteps(["wire-transfer"], quiet), null);
  assert.equal(validateSteps([], quiet), null);
  assert.equal(validateSteps("provision-identity", quiet), null);
  assert.equal(validateSteps([1, 2], quiet), null);
});
