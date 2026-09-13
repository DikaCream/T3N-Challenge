"use client";

import { useCallback, useEffect, useState } from "react";

import type { ApiEnvelope, Async, SessionStatus } from "../lib/types.ts";

/**
 * Operator session status.
 *
 * The browser never touches the SDK: it calls our own route, which holds the
 * T3N session server-side. That is the whole reason this app can be a dapp
 * without shipping a signing key to the client.
 */
export function SessionCard() {
  const [session, setSession] = useState<Async<SessionStatus>>({ state: "loading" });

  const load = useCallback(async () => {
    setSession({ state: "loading" });
    try {
      const response = await fetch("/api/session", { cache: "no-store" });
      const body = (await response.json()) as ApiEnvelope<SessionStatus>;
      setSession(
        body.ok
          ? { state: "ready", data: body.data }
          : { state: "error", message: body.error },
      );
    } catch (error) {
      setSession({ state: "error", message: String(error) });
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <section className="card">
      <header className="card-head">
        <h2>Operator session</h2>
        <button type="button" className="ghost" onClick={() => void load()}>
          Refresh
        </button>
      </header>

      {session.state === "loading" && <p className="muted">Authenticating against T3N…</p>}

      {session.state === "error" && (
        <>
          <p className="bad">Could not open a session</p>
          <pre className="mono wrap">{session.message}</pre>
        </>
      )}

      {session.state === "ready" && <SessionBody session={session.data} />}
    </section>
  );
}

function SessionBody({ session }: { session: SessionStatus }) {
  return (
    <>
      <dl className="pairs">
        <dt>DID</dt>
        <dd className="mono">{session.did}</dd>
        <dt>Environment</dt>
        <dd>{session.environment}</dd>
        <dt>Node</dt>
        <dd className="mono small">{session.nodeUrl}</dd>
        <dt>Credits</dt>
        <dd>
          {session.credits === null ? (
            <span className="muted">unavailable</span>
          ) : (
            <>
              {session.credits.available}
              {session.credits.creditExhausted && <span className="bad"> (exhausted)</span>}
            </>
          )}
        </dd>
      </dl>

      <div className={`banner ${session.contract.registered ? "good" : "warn"}`}>
        {session.contract.registered ? (
          <>
            Contract registered: <span className="mono">{session.contract.name}</span> v
            {session.contract.version} ({session.contract.status})
          </>
        ) : (
          <>
            Contract <span className="mono">{session.contract.tail}</span> is not registered on this
            tenant. Deploy it before running anything.
          </>
        )}
      </div>

      <h3>Onboarding targets</h3>
      <dl className="pairs">
        <dt>HRIS</dt>
        <dd className="mono">{session.targets.identity}</dd>
        <dt>Payroll</dt>
        <dd className="mono">{session.targets.payroll}</dd>
        <dt>Upstream tokens</dt>
        <dd>
          HRIS {session.targets.identityToken ? "set" : "none"} · payroll{" "}
          {session.targets.payrollToken ? "set" : "none"}
          <span className="muted">: held in the enclave-only secrets map</span>
        </dd>
      </dl>
    </>
  );
}
