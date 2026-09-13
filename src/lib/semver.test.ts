import assert from "node:assert/strict";
import { test } from "node:test";

import { compareSemver } from "./semver.ts";

test("orders patch, minor and major", () => {
  assert.ok(compareSemver("0.1.2", "0.1.1") > 0);
  assert.ok(compareSemver("0.1.1", "0.1.2") < 0);
  // Numeric, not lexical: "10" outranks "2".
  assert.ok(compareSemver("0.2.0", "0.10.0") < 0);
  assert.ok(compareSemver("1.0.0", "0.9.9") > 0);
});

test("equal triples compare equal", () => {
  assert.equal(compareSemver("0.1.2", "0.1.2"), 0);
});

test("missing components count as zero", () => {
  assert.equal(compareSemver("1.0", "1.0.0"), 0);
  assert.ok(compareSemver("1", "1.0.1") < 0);
});

test("a pre-release ranks below its release", () => {
  assert.ok(compareSemver("1.0.0-rc.1", "1.0.0") < 0);
  assert.ok(compareSemver("1.0.0", "1.0.0-rc.1") > 0);
  assert.ok(compareSemver("1.0.0-rc.1", "1.0.0-rc.2") < 0);
});

test("non-numeric components are treated as zero rather than throwing", () => {
  // The node enforces real SemVer; a wrong answer here only changes which
  // message an operator reads, so being lenient is intended.
  assert.equal(compareSemver("x.y.z", "0.0.0"), 0);
});
