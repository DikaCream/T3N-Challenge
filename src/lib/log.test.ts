import assert from "node:assert/strict";
import { test } from "node:test";

import { createLogger, redact } from "./log.ts";

test("redact replaces credential-shaped keys at every depth", () => {
  const out = redact({
    apiKey: "0xsecret",
    nested: { authorization: "Bearer x", safe: "ok" },
    list: [{ token: "t" }],
  });
  assert.deepEqual(out, {
    apiKey: "***",
    nested: { authorization: "***", safe: "ok" },
    list: [{ token: "***" }],
  });
});

test("redact matches key names case-insensitively and on substrings", () => {
  assert.deepEqual(redact({ Password: "p", SECRET_KEY: "s", userCredential: "c" }), {
    Password: "***",
    SECRET_KEY: "***",
    userCredential: "***",
  });
});

test("redact leaves primitives untouched", () => {
  assert.equal(redact("plain"), "plain");
  assert.equal(redact(42), 42);
  assert.equal(redact(null), null);
});

test("redact truncates rather than recursing without bound", () => {
  const deep = { a: { b: { c: { d: { e: { f: "bottom" } } } } } };
  const out = redact(deep) as Record<string, unknown>;
  assert.equal(JSON.stringify(out).includes("bottom"), false);
});

/** Capture stderr for the duration of `run`. */
function captureStderr(run: () => void): string {
  const writes: string[] = [];
  const original = process.stderr.write;
  process.stderr.write = ((chunk: string | Uint8Array) => {
    writes.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  try {
    run();
  } finally {
    process.stderr.write = original;
  }
  return writes.join("");
}

test("createLogger routes progress to stderr, not stdout", () => {
  const text = captureStderr(() => {
    createLogger({ level: "debug" }).info("hello");
  });
  assert.match(text, /hello/);
});

test("createLogger honours the level threshold", () => {
  const text = captureStderr(() => {
    const log = createLogger({ level: "warn" });
    log.info("suppressed");
    log.warn("kept");
  });
  assert.doesNotMatch(text, /suppressed/);
  assert.match(text, /kept/);
});

test("quiet keeps warnings and errors and drops the rest", () => {
  const text = captureStderr(() => {
    const log = createLogger({ level: "debug", quiet: true });
    log.info("dropped");
    log.warn("kept-warn");
  });
  assert.doesNotMatch(text, /dropped/);
  assert.match(text, /kept-warn/);
});

test("createLogger redacts credential-shaped fields before printing", () => {
  const text = captureStderr(() => {
    createLogger({ level: "debug" }).error("boom", { apiKey: "0xsecret" });
  });
  assert.match(text, /"apiKey":"\*\*\*"/);
  assert.equal(text.includes("0xsecret"), false);
});
