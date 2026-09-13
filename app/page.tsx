"use client";

import { useState } from "react";

import { AuditPanel } from "./components/audit-panel.tsx";
import { OnboardPanel } from "./components/onboard-panel.tsx";
import { PreflightPanel } from "./components/preflight-panel.tsx";
import { RecordsPanel } from "./components/records-panel.tsx";
import { SessionCard } from "./components/session-card.tsx";
import { SetupPanel } from "./components/setup-panel.tsx";

/**
 * The operator console.
 *
 * A client component because every panel is interactive and several share the
 * "something changed, re-read the session" signal. Nothing here imports the
 * SDK: all T3N work happens in the API routes, so no WASM and no credential can
 * reach the browser.
 */
export default function Console() {
  // Bumped whenever an action could change server-side state, so dependent
  // panels know to re-read rather than showing stale numbers.
  const [revision, setRevision] = useState(0);
  const invalidate = (): void => setRevision((current) => current + 1);

  return (
    <main className="shell">
      <header className="hero">
        <p className="eyebrow">Terminal 3 · T3N agent</p>
        <h1>Employee onboarding where the agent never sees the employee</h1>
        <p className="lede">
          The agent decides which steps to run using only an internal employee reference, a role, a
          department and a start date. A TEE contract then does the work, and the employee&rsquo;s
          name, national id, address and personal email are substituted{" "}
          <strong>inside the enclave</strong>, at the moment the outbound request is built.
        </p>
      </header>

      <div className="grid">
        <SessionCard key={`session-${String(revision)}`} />
        <SetupPanel onProvisioned={invalidate} />
        <PreflightPanel />
        <OnboardPanel />
        <RecordsPanel key={`records-${String(revision)}`} />
        <AuditPanel />
      </div>

      <section className="card why">
        <header className="card-head">
          <h2>Why the privacy claim holds</h2>
        </header>
        <ul className="claims">
          <li>
            <strong>The contract has nowhere to put PII.</strong> Its input type is{" "}
            <span className="mono">employee_ref</span>, role, department and start date. A caller
            wanting to send a name has no field to send it in.
          </li>
          <li>
            <strong>The markers are the payload.</strong> Request bodies contain literal{" "}
            <span className="mono">{"{{profile.first_name}}"}</span>. That is not a redaction applied
            for display — it is genuinely all the contract ever holds.
          </li>
          <li>
            <strong>The host substitutes, not the app.</strong> Resolution happens after the bytes
            leave WASM, inside the enclave, immediately before egress.
          </li>
          <li>
            <strong>Responses are never forwarded.</strong> Only the status code is read, because an
            upstream can echo the PII straight back.
          </li>
          <li>
            <strong>Secrets are enclave-only.</strong> The <span className="mono">secrets</span> map
            is readable only by the contract, so the process that writes a credential cannot read it
            back.
          </li>
        </ul>
      </section>

      <footer className="foot">
        <span className="muted">
          SDK pinned to <span className="mono">@terminal3/t3n-sdk@5.2.0</span>, server-side only. No
          credential ever reaches this page.
        </span>
      </footer>
    </main>
  );
}
