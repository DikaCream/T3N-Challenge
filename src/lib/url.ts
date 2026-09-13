/**
 * Host extraction, mirroring `host_of` in the contract byte for byte.
 *
 * The contract's egress allow-list is keyed on host, so the operator-facing
 * commands must derive the same string the enclave will ask the host to
 * authorise. Two different answers here would mean the CLI promises an
 * authorisation the runtime then refuses. The Rust side has the same table of
 * cases, asserted in `src/onboarding.rs`.
 */

export function hostOf(url: string): string {
  const schemeMatch = /^([a-zA-Z][a-zA-Z0-9+.-]*):\/\//.exec(url);
  let rest = url;
  if (schemeMatch !== null) {
    const scheme = (schemeMatch[1] ?? "").toLowerCase();
    // Only http(s) URLs are valid targets; anything else is returned unchanged
    // so authorisation fails loudly instead of matching the wrong host.
    if (scheme !== "http" && scheme !== "https") return url;
    rest = url.slice(schemeMatch[0].length);
  }

  const end = rest.search(/[/?#]/);
  return end === -1 ? rest : rest.slice(0, end);
}

/** Dedupe hosts, preserving order. */
export function hostsOf(urls: readonly string[]): string[] {
  const seen: string[] = [];
  for (const url of urls) {
    const host = hostOf(url);
    if (host !== "" && !seen.includes(host)) seen.push(host);
  }
  return seen;
}
