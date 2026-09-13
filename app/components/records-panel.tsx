"use client";

import { useCallback, useState } from "react";

import { apiCall } from "../lib/api.ts";
import type { Async, OnboardingRecord, RecordsResponse } from "../lib/types.ts";
import { AsyncBody, Panel } from "./panel.tsx";

/**
 * Read back what the enclave recorded.
 *
 * Note the asymmetry this UI has to be honest about: a dry run writes nothing,
 * so "not found" after a dry run is correct behaviour rather than a bug.
 * Recording plans alongside facts would make the log unable to tell the two
 * apart, which is worse than the surprise.
 *
 * This panel manages its own state instead of using `useAsync`, because the call
 * is parameterised by a URL the user controls. A one-argument hook would be
 * doing the same job with more indirection.
 */
export function RecordsPanel() {
  const [employee, setEmployee] = useState("emp-2041");
  const [value, setValue] = useState<Async<RecordsResponse>>({ state: "idle" });

  const load = useCallback(async (url: string): Promise<void> => {
    setValue({ state: "loading" });
    try {
      const data = await apiCall<RecordsResponse>(url);
      setValue({ state: "ready", data });
    } catch (error) {
      setValue({
        state: "error",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }, []);

  const busy = value.state === "loading";

  return (
    <Panel
      title="Onboarding records"
      subtitle="What the contract wrote into the onboarding-log map. No PII by construction."
    >
      <form
        className="form inline-form"
        onSubmit={(event) => {
          event.preventDefault();
          void load(`/api/records?employee=${encodeURIComponent(employee.trim())}`);
        }}
      >
        <label>
          <span>Employee ref</span>
          <input value={employee} onChange={(event) => setEmployee(event.target.value)} />
        </label>
        <button type="submit" className="ghost" disabled={busy}>
          Look up
        </button>
        <button
          type="button"
          className="ghost"
          onClick={() => void load("/api/records?limit=50")}
          disabled={busy}
        >
          List recent
        </button>
      </form>

      <AsyncBody value={value} idle="Look up a single record, or list recent ones.">
        {(records) => {
          if (records.kind === "record") {
            if (!records.found || records.record === null) {
              return (
                <p className="muted">
                  No record for <span className="mono">{employee}</span>. A dry run does not write
                  one.
                </p>
              );
            }
            return <RecordTable records={[records.record]} />;
          }

          if (records.count === 0) {
            return <p className="muted">No records yet.</p>;
          }

          return (
            <>
              <RecordTable records={records.records} />
              {records.truncated && (
                <p className="muted small">More records exist: the page size was hit.</p>
              )}
            </>
          );
        }}
      </AsyncBody>
    </Panel>
  );
}

function RecordTable({ records }: { records: OnboardingRecord[] }) {
  return (
    <table className="data">
      <thead>
        <tr>
          <th>employee_ref</th>
          <th>status</th>
          <th>steps</th>
          <th>dry_run</th>
          <th>recorded_at</th>
        </tr>
      </thead>
      <tbody>
        {records.map((record) => (
          <tr key={record.employee_ref}>
            <td className="mono">{record.employee_ref}</td>
            <td>{record.status}</td>
            <td className="mono small">
              {record.steps.map((step) => `${step.name}:${step.status}`).join(" ")}
            </td>
            <td>{String(record.dry_run)}</td>
            <td className="small">{new Date(record.recorded_at_secs * 1000).toISOString()}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
