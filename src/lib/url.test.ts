import assert from "node:assert/strict";
import { test } from "node:test";

import { hostOf, hostsOf } from "./url.ts";

test("hostOf strips scheme, path, query and fragment", () => {
  assert.equal(hostOf("https://httpbin.org/post"), "httpbin.org");
  assert.equal(hostOf("http://example.com"), "example.com");
  assert.equal(hostOf("https://example.com?q=1"), "example.com");
  assert.equal(hostOf("https://example.com#frag"), "example.com");
  assert.equal(hostOf("https://example.com:8443/x?y=1#z"), "example.com:8443");
});

test("hostOf lowercases only the scheme, never the host", () => {
  // The host string must be compared byte for byte against the allow-list, so
  // changing its case here would make two spellings of one host diverge.
  assert.equal(hostOf("HTTPS://Example.COM/path"), "Example.COM");
});

test("hostOf does not launder userinfo into a matching host", () => {
  // `https://httpbin.org@evil.example/` is the shape an allow-list bypass takes.
  // The unparsed userinfo must survive into the returned string so it matches
  // neither the decoy nor the real host.
  const host = hostOf("https://httpbin.org@evil.example/");
  assert.notEqual(host, "evil.example");
  assert.notEqual(host, "httpbin.org");
});

test("hostOf returns non-http schemes unchanged so authorisation fails loudly", () => {
  assert.equal(hostOf("ftp://example.com/x"), "ftp://example.com/x");
  assert.equal(hostOf("ws://example.com/socket"), "ws://example.com/socket");
});

test("hostOf handles a scheme-less target and an empty string", () => {
  assert.equal(hostOf("httpbin.org/post"), "httpbin.org");
  assert.equal(hostOf(""), "");
});

test("hostsOf dedupes and preserves first-seen order", () => {
  assert.deepEqual(
    hostsOf([
      "https://httpbin.org/a",
      "https://example.com/b",
      "https://httpbin.org/c",
    ]),
    ["httpbin.org", "example.com"],
  );
});

test("hostsOf drops empty hosts rather than admitting an empty allow-list entry", () => {
  assert.deepEqual(hostsOf(["", "https://httpbin.org/post"]), ["httpbin.org"]);
});
