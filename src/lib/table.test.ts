import assert from "node:assert/strict";
import { test } from "node:test";

import { renderPairs, renderTable } from "./table.ts";

test("renderTable pads each column to its widest cell", () => {
  const out = renderTable(
    ["step", "host"],
    [
      ["provision-identity", "httpbin.org"],
      ["payroll", ""],
    ],
  );
  const [header, rule, first, second] = out.split("\n");

  assert.ok(header !== undefined && rule !== undefined);
  // The rule line is the computed widths, so it is the honest assertion:
  // "provision-identity" is 18 wide, "httpbin.org" is 11.
  assert.deepEqual(rule.split("  ").map((part) => part.length), [18, 11]);
  assert.equal(header.trimEnd(), `${"step".padEnd(18)}  ${"host".padEnd(11)}`.trimEnd());
  // Every row starts its second column at the same offset as the header.
  assert.equal(first?.indexOf("httpbin.org"), 20);
  assert.equal(second, "payroll");
});

test("renderTable renders null and undefined as a dash", () => {
  const out = renderTable(["a", "b"], [[null, undefined]]);
  assert.match(out, /^-\s+-$/m);
});

test("renderTable stringifies numbers and booleans", () => {
  const out = renderTable(["n", "b"], [[3, true]]);
  assert.match(out, /^3\s+true$/m);
});

test("renderTable tolerates an empty row set", () => {
  const out = renderTable(["only"], []);
  assert.equal(out.split("\n").length, 2);
  assert.equal(out.split("\n")[1], "-".repeat(4));
});

test("renderPairs aligns keys and drops absent values", () => {
  const out = renderPairs([
    ["did", "did:t3n:abc"],
    ["contract", null],
    ["absent", undefined],
  ]);
  assert.equal(out, "did       did:t3n:abc\ncontract  -");
});
