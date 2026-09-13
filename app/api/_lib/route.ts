import { NextResponse } from "next/server";

import { ArgError } from "../../../src/lib/args.ts";
import { ConfigError } from "../../../src/lib/config.ts";
import { ContractNotDeployedError } from "../../../src/services/contract.ts";

/**
 * Every API route goes through these two helpers so the browser sees one
 * consistent envelope, and so a thrown error becomes a status code instead of a
 * 500 with a stack trace in the body.
 *
 * The envelope is intentionally flat:
 *   `{ ok: true, data }` | `{ ok: false, error, kind }`
 */

export function ok<T>(data: T, status = 200): NextResponse {
  return NextResponse.json({ ok: true, data }, { status });
}

export function fail(error: unknown): NextResponse {
  if (error instanceof ConfigError) {
    // A missing T3N_API_KEY is a deployment problem, and the message already
    // says which variable and where to get it.
    return NextResponse.json(
      { ok: false, kind: "config", error: error.message },
      { status: 503 },
    );
  }

  if (error instanceof ArgError) {
    return NextResponse.json(
      { ok: false, kind: "input", error: error.message },
      { status: 400 },
    );
  }

  if (error instanceof ContractNotDeployedError) {
    // Not a server fault and not a bad request: the request is fine, a
    // precondition is missing. 412 says exactly that, and a monitoring tool can
    // tell it apart from a genuine 500.
    return NextResponse.json(
      { ok: false, kind: "input", error: error.message },
      { status: 412 },
    );
  }

  const message = error instanceof Error ? error.message : String(error);
  return NextResponse.json({ ok: false, kind: "error", error: message }, { status: 500 });
}

/**
 * Wrap a handler so no route ever has to remember the try/catch.
 *
 * Errors are logged server-side at debug level only — the response body carries
 * the message, but a stack trace stays out of it.
 */
export function handler<T extends unknown[]>(
  fn: (...args: T) => Promise<NextResponse>,
): (...args: T) => Promise<NextResponse> {
  return async (...args: T): Promise<NextResponse> => {
    try {
      return await fn(...args);
    } catch (error) {
      if (process.env["NODE_ENV"] !== "production") {
        console.error("[api]", error);
      }
      return fail(error);
    }
  };
}

/** Read a JSON body, treating an absent or malformed body as `{}`. */
export async function readJson(request: Request): Promise<Record<string, unknown>> {
  try {
    const body: unknown = await request.json();
    if (body === null || typeof body !== "object" || Array.isArray(body)) return {};
    return body as Record<string, unknown>;
  } catch {
    return {};
  }
}
