"use client";

import { useState } from "react";

import { postJson } from "../lib/api.ts";
import type { OnboardResponse } from "../lib/types.ts";
import { useAsync } from "../lib/use-async.ts";
import { AsyncBody, Banner, Panel } from "./panel.tsx";

/**
 * The agent's main surface.
 *
 * The form intentionally collects only non-sensitive fields, because that is all
 * the agent is given: an HR-internal reference, a role, a department and a start
 * date. There is no field for a name or an account number to type into.
 *
 * The dry run is the default, and its output is the evidence — the request
 * bodies below still contain `{{profile.*}}` markers, which is what proves the
 * sensitive values were never in this process.
 */
export function OnboardPanel() {
  const [form, setForm] = useState({
    employee_ref: "emp-2041",
    role: "Backend Engineer",
    department: "Platform",
    start_date: new Date(Date.now() + 14 * 86_400_000).toISOString().slice(0, 10),
    currency: "USD",
    live: false,
  });

  const { value, run } = useAsync(() =>
    postJson<OnboardResponse>("/api/onboard", {
      employee_ref: form.employee_ref.trim(),
      role: form.role.trim(),
      department: form.department.trim(),
      start_date: form.start_date.trim(),
      currency: form.currency.trim() === "" ? undefined : form.currency.trim(),
      live: form.live,
    }),
  );

  const set = (key: keyof typeof form) => (next: string | boolean) =>
    setForm((previous) => ({ ...previous, [key]: next }));

  return (
    <Panel
      title="Onboard an employee"
      subtitle="Plan → preflight → run. Dry unless you tick Live."
    >
      <form
        className="form"
        onSubmit={(event) => {
          event.preventDefault();
          void run();
        }}
      >
        <label>
          <span>Employee ref</span>
          <input
            value={form.employee_ref}
            onChange={(event) => set("employee_ref")(event.target.value)}
            placeholder="emp-2041"
            required
          />
        </label>

        <label>
          <span>Role</span>
          <input
            value={form.role}
            onChange={(event) => set("role")(event.target.value)}
            placeholder="Backend Engineer"
            required
          />
        </label>

        <label>
          <span>Department</span>
          <input
            value={form.department}
            onChange={(event) => set("department")(event.target.value)}
            placeholder="Platform"
            required
          />
        </label>

        <label>
          <span>Start date</span>
          <input
            type="date"
            value={form.start_date}
            onChange={(event) => set("start_date")(event.target.value)}
            required
          />
        </label>

        <label>
          <span>Currency</span>
          <input
            value={form.currency}
            onChange={(event) => set("currency")(event.target.value)}
            placeholder="USD"
          />
        </label>

        <div className="row">
          <label className="inline">
            <input
              type="checkbox"
              checked={form.live}
              onChange={(event) => set("live")(event.target.checked)}
            />
            <span>
              Live — actually send. Without this nothing leaves the enclave and no record is written.
            </span>
          </label>
        </div>

        <div className="row">
          <button type="submit" className="primary" disabled={value.state === "loading"}>
            {value.state === "loading"
              ? "Running…"
              : form.live
                ? "Run live onboarding"
                : "Run dry onboarding"}
          </button>
          <span className="muted small">
            No name, national id, address or email is sent from here — there is no field for one.
          </span>
        </div>
      </form>

      <AsyncBody value={value}>
        {(outcome) => (
          <>
            <h3>Plan</h3>
            <dl className="pairs">
              <dt>planner</dt>
              <dd>
                {outcome.plan.planner} · risk <span className={`risk-${outcome.plan.risk}`}>{outcome.plan.risk}</span>
              </dd>
              <dt>steps</dt>
              <dd className="mono">{outcome.plan.steps.join(" → ")}</dd>
              <dt>rationale</dt>
              <dd>{outcome.plan.rationale}</dd>
            </dl>
            {outcome.plan.notes.length > 0 && (
              <ul className="notes">
                {outcome.plan.notes.map((note) => (
                  <li key={note}>{note}</li>
                ))}
              </ul>
            )}

            {outcome.blocked && (
              <>
                <Banner tone="bad">Refused — nothing was sent</Banner>
                <pre className="mono wrap boxed">{outcome.blockedReason}</pre>
              </>
            )}

            {outcome.record !== null && (
              <>
                <h3>Result</h3>
                <Banner tone={outcome.record.status === "completed" ? "good" : "warn"}>
                  {outcome.record.status}
                  {outcome.record.dry_run ? " (dry run — nothing sent, nothing written)" : ""}
                </Banner>

                <table className="data">
                  <thead>
                    <tr>
                      <th>step</th>
                      <th>status</th>
                      <th>host</th>
                      <th>http</th>
                    </tr>
                  </thead>
                  <tbody>
                    {outcome.record.steps.map((step) => (
                      <tr key={step.name}>
                        <td className="mono">{step.name}</td>
                        <td>{step.status}</td>
                        <td className="mono">{step.host === "" ? "-" : step.host}</td>
                        <td>{step.http_status ?? "-"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>

                {outcome.record.steps.some((step) => step.detail !== null) && (
                  <ul className="notes">
                    {outcome.record.steps
                      .filter((step) => step.detail !== null)
                      .map((step) => (
                        <li key={step.name}>
                          <span className="mono">{step.name}</span>: {step.detail}
                        </li>
                      ))}
                  </ul>
                )}

                {outcome.record.dry_run && (
                  <>
                    <h3>The evidence</h3>
                    <p className="muted small">
                      The exact bytes the enclave would send. Every{" "}
                      <span className="mono">{"{{profile.*}}"}</span> marker is substituted by the
                      host inside the enclave, after this output was produced — if a real name or
                      account number appeared here, the design would have failed visibly.
                    </p>
                    {outcome.record.steps.map((step) => (
                      <details key={step.name} open>
                        <summary className="mono">{step.name}</summary>
                        <pre className="mono wrap boxed">{step.request_body ?? "(none)"}</pre>
                      </details>
                    ))}
                  </>
                )}

                <h3>Record</h3>
                <dl className="pairs">
                  <dt>contract</dt>
                  <dd className="mono">v{outcome.record.contract_version}</dd>
                  <dt>contains_pii</dt>
                  <dd className={outcome.record.contains_pii ? "bad" : "good"}>
                    {String(outcome.record.contains_pii)}
                  </dd>
                  <dt>recorded_at</dt>
                  <dd>{new Date(outcome.record.recorded_at_secs * 1000).toISOString()}</dd>
                </dl>
              </>
            )}
          </>
        )}
      </AsyncBody>
    </Panel>
  );
}
