import assert from "node:assert/strict";
import { test } from "node:test";

import {
  ArgError,
  flagBool,
  flagNumber,
  flagString,
  parseArgs,
  rejectPositionals,
  rejectUnknownFlags,
  requireFlag,
} from "./args.ts";

test("parses a command, value flags and boolean flags", () => {
  const args = parseArgs(["onboard", "--employee", "emp-2041", "--live"]);
  assert.equal(args.command, "onboard");
  assert.equal(flagString(args, "employee"), "emp-2041");
  assert.equal(flagBool(args, "live"), true);
  assert.deepEqual(args.positionals, []);
});

test("supports --key=value", () => {
  const args = parseArgs(["deploy", "--version=0.1.2"]);
  assert.equal(flagString(args, "version"), "0.1.2");
});

test("maps the -h and -v aliases to their long names", () => {
  assert.equal(parseArgs(["-h"]).flags["help"], true);
  assert.equal(parseArgs(["-v"]).flags["version"], true);
});

test("a flag with no value at the end of the line is boolean true", () => {
  assert.equal(parseArgs(["onboard", "--live"]).flags["live"], true);
});

test("stops parsing at -- and keeps the rest as positionals", () => {
  const args = parseArgs(["cmd", "--", "--not-a-flag", "-x"]);
  assert.deepEqual(args.positionals, ["--not-a-flag", "-x"]);
  assert.equal("not-a-flag" in args.flags, false);
});

test("flagBool also accepts the literal string true", () => {
  assert.equal(flagBool(parseArgs(["--live=true"]), "live"), true);
  // A value flag the caller meant as a boolean is not silently truthy.
  assert.equal(flagBool(parseArgs(["--live=maybe"]), "live"), false);
});

test("flagNumber parses and rejects non-numeric values", () => {
  assert.equal(flagNumber(parseArgs(["--limit", "25"]), "limit"), 25);
  assert.equal(flagNumber(parseArgs([]), "limit"), undefined);
  assert.throws(() => flagNumber(parseArgs(["--limit", "soon"]), "limit"), ArgError);
});

test("requireFlag rejects a missing or empty value with the usage attached", () => {
  assert.equal(requireFlag(parseArgs(["--employee=emp-1"]), "employee", "usage"), "emp-1");
  assert.throws(
    () => requireFlag(parseArgs([]), "employee", "usage"),
    (error: unknown) => error instanceof ArgError && error.usage === "usage",
  );
  assert.throws(() => requireFlag(parseArgs(["--employee="]), "employee", "usage"), ArgError);
});

test("rejectUnknownFlags names the offending flag", () => {
  assert.doesNotThrow(() => rejectUnknownFlags(parseArgs(["--json"]), ["json"], "usage"));
  assert.throws(
    () => rejectUnknownFlags(parseArgs(["--jsno"]), ["json"], "usage"),
    /Unknown flag: --jsno/,
  );
});

test("rejectPositionals fails loudly instead of ignoring a stray argument", () => {
  // The first bare token is the command, so the stray must follow one.
  assert.doesNotThrow(() => rejectPositionals(parseArgs(["onboard", "--json"]), "usage"));
  assert.throws(
    () => rejectPositionals(parseArgs(["onboard", "typo"]), "usage"),
    /Unexpected argument: typo/,
  );
});
