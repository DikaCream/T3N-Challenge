"use client";

import { apiCall } from "../lib/api.ts";
import type { AuditEntry, AuditResponse } from "../lib/types.ts";
import { useAsync } from "../lib/use-async.ts";
import { AsyncBody, Panel } from "./panel.tsx";

/**
 * The ledger's record, not the contract's.
 *
 * The distinction is the point of showing both panels side by side:
 * `onboarding-log` is what the *application* believes happened, while these rows
 * are what the *network* recorded. `actor` and `on_behalf_of` are host-stamped
 * from the verified dispatch context, so a contract cannot forge who acted —
 * which is exactly the property a self-written log cannot provide.
 */
export function AuditPanel() {
  // Read-only, so it loads on mount rather than waiting for a click.
  const { value, run } = useAsync(() => apiCall<AuditResponse>("/api/audit?limit=25"), {
    auto: true,
  });

  return (
    <Panel
      title="Audit trail"
      subtitle="Host-stamped dispatches from the ledger. A contract cannot forge who acted."
      action={
        <button
          type="button"
          className="ghost"
          onClick={() => void run()}
          disabled={value.state === "loading"}
        >
          {value.state === "loading" ? "Loading…" : "Load"}
        </button>
      }
    >
      <AsyncBody value={value} idle="Not loaded yet.">
        {(audit) =>
          audit.entries.length === 0 ? (
            <p className="muted">No audited dispatches matched yet.</p>
          ) : (
            <>
              <table className="data">
                <thead>
                  <tr>
                    <th>seq</th>
                    <th>when</th>
                    <th>caller</th>
                    <th>on behalf of</th>
                    <th>function</th>
                    <th>outcome</th>
                  </tr>
                </thead>
                <tbody>
                  {audit.entries.map((entry) => (
                    <tr key={entry.seq_no}>
                      <td>{entry.seq_no}</td>
                      <td className="small">{new Date(entry.timestamp_ms).toISOString()}</td>
                      <td className="mono small">
                        {entry.caller_type}:{short(entry.actor)}
                      </td>
                      <td className="mono small">{short(entry.on_behalf_of)}</td>
                      <td className="mono small">{entry.function}</td>
                      <td className={outcomeClass(entry.outcome)}>{entry.outcome}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {audit.next_seq !== null && (
                <p className="muted small">More available — resume from seq {audit.next_seq}.</p>
              )}
            </>
          )
        }
      </AsyncBody>
    </Panel>
  );
}

function outcomeClass(outcome: AuditEntry["outcome"]): string {
  if (outcome === "success") return "good";
  if (outcome === "denied") return "warn";
  return "bad";
}

/** DIDs are 48 characters; a table needs the tail that distinguishes them. */
function short(did: string): string {
  return did.length <= 14 ? did : `${did.slice(0, 6)}…${did.slice(-6)}`;
}
