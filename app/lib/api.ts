import type { ApiEnvelope } from "./types.ts";

/**
 * Call one of our own API routes and unwrap the envelope.
 *
 * Throws on a non-ok envelope so callers can use try/catch uniformly instead of
 * checking a discriminant at every site.
 */
export async function apiCall<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    cache: "no-store",
    ...init,
    headers: {
      ...(init?.body === undefined ? {} : { "Content-Type": "application/json" }),
      ...init?.headers,
    },
  });

  let body: ApiEnvelope<T>;
  try {
    body = (await response.json()) as ApiEnvelope<T>;
  } catch {
    throw new Error(`${path}: HTTP ${response.status} with a non-JSON body`);
  }

  if (!body.ok) throw new Error(body.error);
  return body.data;
}

export function postJson<T>(path: string, payload: unknown): Promise<T> {
  return apiCall<T>(path, { method: "POST", body: JSON.stringify(payload) });
}
