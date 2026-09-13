import assert from "node:assert/strict";
import { test } from "node:test";

import { descriptorDocument } from "./descriptor.ts";
import { CONTRACT_TAIL } from "./types.ts";

interface FunctionEntry {
  name: string;
  summary: string;
  mutates: boolean;
  auth: unknown;
  params_schema: unknown;
  returns: unknown;
  errors: unknown[];
  examples: unknown[];
}

const EXPECTED = [
  "contract-info",
  "preflight",
  "start-onboarding",
  "get-onboarding-status",
  "list-onboardings",
];

function entries(version = "0.1.2"): FunctionEntry[] {
  return descriptorDocument(version)["functions"] as FunctionEntry[];
}

test("the document is bound to the contract tail and the version being registered", () => {
  const doc = descriptorDocument("9.9.9");
  assert.equal(doc["name"], CONTRACT_TAIL);
  assert.equal(doc["version"], "9.9.9");
});

test("every exported function is described exactly once", () => {
  const functions = entries();
  assert.deepEqual(
    functions.map((fn) => fn.name).sort(),
    [...EXPECTED].sort(),
  );
  assert.equal(new Set(functions.map((fn) => fn.name)).size, functions.length);
});

test("every entry carries the fields the node requires", () => {
  // The node validates strictly and names the first offending field, so an
  // omission here is a failed deploy, not a warning.
  for (const fn of entries()) {
    assert.ok(fn.summary.trim().length > 0, `${fn.name} has an empty summary`);
    assert.equal(typeof fn.mutates, "boolean", `${fn.name}.mutates`);
    assert.equal(typeof fn.auth, "object", `${fn.name}.auth`);
    assert.equal(typeof fn.params_schema, "object", `${fn.name}.params_schema`);
    assert.equal(typeof fn.returns, "object", `${fn.name}.returns`);
    assert.ok(Array.isArray(fn.errors), `${fn.name}.errors`);
    assert.ok(Array.isArray(fn.examples) && fn.examples.length > 0, `${fn.name}.examples`);
  }
});

test("only start-onboarding is advertised as mutating", () => {
  assert.deepEqual(
    entries()
      .filter((fn) => fn.mutates)
      .map((fn) => fn.name),
    ["start-onboarding"],
  );
});

test("the descriptor carries no host, so publishing it cannot reach a network", () => {
  assert.doesNotMatch(JSON.stringify(descriptorDocument("0.1.2")), /https?:\/\//);
});
