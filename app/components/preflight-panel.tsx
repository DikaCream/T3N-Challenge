"use client";

import { apiCall } from "../lib/api.ts";
import type { PreflightResponse } from "../lib/types.ts";
import { useAsync } from "../lib/use-async.ts";
import { AsyncBody, Banner, Panel } from "./panel.tsx";

/**
 * Preflight: what is configured, and what is still missing?
 *
 * One honest caveat is rendered rather than hidden: egress **authorisation** is
 * not reported here, because it cannot be. The host holds the per-contract
 * allow-list and evaluates it at dispatch; no import lets a contract ask in
 * advance. The candidate interface, `authorisation.check-authorized`, is
 * declared in the WIT package but is not provided to a tenant contract at
 * runtime: importing it makes the component un-instantiable. So a refused host
 * surfaces at run time as a `denied` step, and the panel says so instead of
 * showing a green tick it cannot justify.
 *
 * The call has no side effects, so pressing it is free.
 */
export function PreflightPanel({ onConfigChanged }: { onConfigChanged?: () => void }) {
  // Read-only and side-effect free, so loading it on mount is free and the
  // console shows the tenant's real state instead of an empty panel.
  const { value, run } = useAsync(() => apiCall<PreflightResponse>("/api/preflight"), {
    auto: true,
  });

  const check = async (): Promise<void> => {
    await run();
    onConfigChanged?.();
  };

  return (
    <Panel
      title="Preflight"
      subtitle="What is configured, and what is still missing? No side effects."
      action={
        <button
          type="button"
          className="ghost"
          onClick={() => void check()}
          disabled={value.state === "loading"}
        >
          {value.state === "loading" ? "Checking…" : "Check"}
        </button>
      }
    >
      <AsyncBody value={value} idle="Not checked yet: the contract must be deployed first.">
        {({ contract, report }) => (
          <>
            <dl className="pairs">
              <dt>Deployed</dt>
              <dd className="mono">
                {contract.name} v{contract.version}
              </dd>
            </dl>

            <Banner tone={report.ready ? "good" : "warn"}>
              {report.ready
                ? "CONFIGURED: every step has an endpoint"
                : "NOT CONFIGURED: see the rows and lists below"}
            </Banner>

            <table className="data">
              <thead>
                <tr>
                  <th>step</th>
                  <th>egress host</th>
                  <th>endpoint</th>
                  <th>credential</th>
                </tr>
              </thead>
              <tbody>
                {report.steps.map((step) => (
                  <tr key={step.name}>
                    <td className="mono">{step.name}</td>
                    <td className="mono">{step.host === "" ? "(unset)" : step.host}</td>
                    <td className={step.endpoint_configured ? "" : "warn"}>
                      {step.endpoint_configured ? "yes" : "no"}
                    </td>
                    <td className="muted">
                      {step.secret_present ? "yes" : "none"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>

            <h3>Egress</h3>
            <p className="muted small">{report.egress_enforcement}</p>

            {report.steps.some((step) => !step.endpoint_configured) && (
              <ul className="notes">
                {report.steps
                  .filter((step) => !step.endpoint_configured)
                  .map((step) => (
                    <li key={step.name}>
                      <span className="mono">{step.name}</span>:{" "}
                      {step.egress_note ?? "no endpoint configured"}
                    </li>
                  ))}
              </ul>
            )}

            <h3>Missing</h3>
            <dl className="pairs">
              <dt>config keys</dt>
              <dd>
                {report.missing_config.length === 0 ? (
                  <span className="good">none</span>
                ) : (
                  <span className="warn mono">{report.missing_config.join(", ")}</span>
                )}
              </dd>
              <dt>secret keys</dt>
              <dd>
                {report.missing_secrets.length === 0 ? (
                  <span className="good">none</span>
                ) : (
                  <span className="muted mono">
                    {report.missing_secrets.join(", ")}: only a problem if the upstream requires auth
                  </span>
                )}
              </dd>
            </dl>

            <h3>Resolved inside the enclave, never by the agent</h3>
            <p className="mono small chips">
              {report.required_profile_fields.map((field) => (
                <span key={field} className="chip">
                  {`{{profile.${field}}}`}
                </span>
              ))}
            </p>
          </>
        )}
      </AsyncBody>
    </Panel>
  );
}
