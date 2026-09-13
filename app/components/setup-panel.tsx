"use client";

import { postJson } from "../lib/api.ts";
import type { ProvisionResponse } from "../lib/types.ts";
import { useAsync } from "../lib/use-async.ts";
import { AsyncBody, Panel } from "./panel.tsx";

/**
 * Tenant provisioning.
 *
 * Idempotent, and safe to press twice — it reconciles the maps to the declared
 * ACLs and rewrites the endpoint config.
 *
 * ## Why deploying is not a button here
 *
 * `deploy` registers the compiled WASM component, which means it needs the build
 * artifact on disk. A deployed web server has no Rust `target` directory, and
 * shipping a 150 KB `.wasm` inside the app bundle to work around that would put
 * the build output in two places and let the two drift. Build and deploy stay in
 * the CLI, where the artifact actually lives:
 *
 *   `npm run build:contract` then `npm run cli -- deploy`
 *
 * This panel deliberately does not accept a secret either: upstream credentials
 * arrive through the server's environment (`hr-onboard seed`), never through a
 * browser form.
 */
export function SetupPanel({ onProvisioned }: { onProvisioned?: () => void }) {
  const { value, run } = useAsync(() => postJson<ProvisionResponse>("/api/provision", {}));

  const provision = async (): Promise<void> => {
    await run();
    onProvisioned?.();
  };

  return (
    <Panel
      title="Tenant setup"
      subtitle="Create the three maps and write the step endpoints into the config map."
      action={
        <button
          type="button"
          className="ghost"
          onClick={() => void provision()}
          disabled={value.state === "loading"}
        >
          {value.state === "loading" ? "Provisioning…" : "Provision"}
        </button>
      }
    >
      <ul className="notes tight">
        <li>
          <span className="mono">config</span> — endpoints and header names. Not secret.
        </li>
        <li>
          <span className="mono">secrets</span> — readable <strong>only</strong> by the contract, so
          the process that writes a credential cannot read it back.
        </li>
        <li>
          <span className="mono">onboarding-log</span> — writable <strong>only</strong> by the
          contract, so a record cannot be back-dated by whoever holds the tenant key.
        </li>
      </ul>

      <p className="muted small">
        Deploying the contract stays a CLI action (<span className="mono">hr-onboard deploy</span>) —
        it needs the compiled WASM artifact, which a deployed server does not have. Seeding
        credentials is CLI-only for the same reason: secrets come from the server environment, never
        from this page.
      </p>

      <AsyncBody value={value}>
        {(provisioned) => (
          <>
            <table className="data">
              <thead>
                <tr>
                  <th>map</th>
                  <th>action</th>
                  <th>purpose</th>
                </tr>
              </thead>
              <tbody>
                {provisioned.maps.map((map) => (
                  <tr key={map.tail}>
                    <td className="mono">{map.tail}</td>
                    <td className="good">{map.outcome}</td>
                    <td className="muted">{map.purpose}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="mono small muted">
              config keys written: {provisioned.configKeys.join(", ")}
            </p>
          </>
        )}
      </AsyncBody>
    </Panel>
  );
}
