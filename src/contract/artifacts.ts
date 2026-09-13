import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { CONTRACT_TAIL } from "./types.ts";

/**
 * Filesystem-bound contract artifact lookup — build and deploy tooling only.
 *
 * The web app must never import this module: it reads `Cargo.toml` and the
 * `target/` directory, neither of which exists in a deployed serverless
 * environment, and which bundlers cannot trace. Runtime code dispatches against
 * the version registered on-chain instead (`registeredVersion` in
 * `src/t3n/tenant.ts`).
 */

export { CONTRACT_TAIL };

/** Crate name, which determines the artifact filename (`-` becomes `_`). */
const CRATE_NAME = "hr-onboard";

/**
 * Project root, derived by walking up from this file rather than via
 * `new URL("../../", import.meta.url)`.
 *
 * That literal form is a bundler directive, not plain path arithmetic: it tells
 * Turbopack/webpack to resolve the target as a build-time asset, and the build
 * fails with "Module not found: Can't resolve '../../'". `dirname` on the
 * resolved path does the same arithmetic without triggering asset resolution.
 */
export const PROJECT_ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const CONTRACT_DIR = join(PROJECT_ROOT, "contracts", CONTRACT_TAIL);

export const WASM_PATH = join(
  CONTRACT_DIR,
  "target",
  "wasm32-wasip2",
  "release",
  `${CRATE_NAME.replaceAll("-", "_")}.wasm`,
);

/**
 * Read the version straight out of `Cargo.toml` — the same file the Rust build
 * reads — so a version bump cannot half-apply.
 */
export function contractVersion(): string {
  const manifestPath = join(CONTRACT_DIR, "Cargo.toml");
  const manifest = readFileSync(manifestPath, "utf8");
  const match = /^version\s*=\s*"([^"]+)"/m.exec(manifest);
  if (match?.[1] === undefined) {
    throw new Error(`Could not read a version from ${manifestPath}`);
  }
  return match[1];
}

/**
 * Load the compiled component.
 *
 * A missing artifact is the single most likely failure for a fresh clone, so the
 * error names the exact command rather than leaking an ENOENT.
 */
export function loadWasm(): Uint8Array {
  if (!existsSync(WASM_PATH)) {
    throw new Error(
      [
        `Contract artifact not found: ${WASM_PATH}`,
        "",
        "Build it first:",
        "  rustup target add wasm32-wasip2",
        "  npm run build:contract",
      ].join("\n"),
    );
  }
  const bytes = readFileSync(WASM_PATH);
  if (bytes.byteLength === 0) {
    throw new Error(`Contract artifact at ${WASM_PATH} is empty; rebuild it.`);
  }
  return new Uint8Array(bytes);
}

export function describeArtifact(): {
  tail: string;
  version: string;
  wasmPath: string;
  sizeBytes: number;
} {
  const wasm = loadWasm();
  return {
    tail: CONTRACT_TAIL,
    version: contractVersion(),
    wasmPath: WASM_PATH,
    sizeBytes: wasm.byteLength,
  };
}
