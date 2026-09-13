# Google Doc draft: paste-ready

**How to use this file**

This is the paste-ready rendering of [`SUBMISSION.md`](SUBMISSION.md), which stays
canonical for the repository. The differences are deliberate: this version places
the screenshots inline as evidence, drops the repo-internal detail a judge does not
need, and ends with the form answers. If a fact changes, change it in
`SUBMISSION.md` first and mirror it here.

1. In Google Docs: **Tools → Preferences → enable "Automatically detect Markdown"**.
   Then paste this file's contents and headings, bold and tables come through. If
   you skip that setting the markdown arrives as literal text.
2. Insert the images where marked `INSERT IMAGE`. Markdown cannot carry them. Use
   **Insert → Image → Upload from computer** and pick the listed file from
   `screenshots/`.
3. One value is still blank, marked `TODO`: the email address. Everything else is
   filled in.
4. Then set the Doc's sharing to **Anyone with the link → Viewer**, and paste that
   link into the submission form.

---

## Employee onboarding where the agent never sees the employee

T3N Agent Build Challenge submission for Terminal 3 Network

| | |
|---|---|
| **Repository** | <https://github.com/DikaCream/T3N-Challenge> |
| **DID** | `did:t3n:50a04efc91641528919da135e31d8995fcd642b3` |
| **Network** | testnet (`cn-api.sg.testnet.t3n.terminal3.io`) |
| **SDK** | `@terminal3/t3n-sdk@5.2.0` (pinned) |
| **Contract** | `z:50a04efc91641528919da135e31d8995fcd642b3:employee-onboarding` v0.1.2 |
| **Date** | 2026-09-13 |
| **Intention** | **continue running it**; happy to hand over. See Section 7 |

---

## 1. What was built

`hr-onboard`: an enterprise employee-onboarding agent where **the AI never sees the
employee's data**.

The agent plans *which* onboarding steps to run using only an internal employee
reference, a role, a department and a start date. A T3N TEE contract then does the
work, creating the HRIS record and enrolling the hire with payroll, and the
employee's legal name, national id, address and personal email are substituted by
the host **inside the enclave**, at the moment the outbound request is built. They
are never function arguments, never local variables, and never bytes in the
application's process.

Three components, all in the repo:

| | |
|---|---|
| **TEE contract** | `contracts/employee-onboarding/`: Rust → `wasm32-wasip2`, five functions over WIT, 15 unit tests that run without a TEE |
| **Agent + CLI** | `src/`: TypeScript, zero build step (Node 24 native type stripping), 12 commands |
| **Web console** | `app/`: Next.js App Router. The SDK runs **only** in server route handlers |

The CLI and the console call the same `src/services/` functions, so the safety
rules are implemented once rather than re-derived per surface.

INSERT IMAGE: `screenshots/14a-web-console-above-fold.png`

### Why this use case

Onboarding is the moment an enterprise moves a new hire's most sensitive data
between systems, and it is the flow where "the app must hold the PII to do its job"
is normally taken as given. It also contains a genuinely useful agent decision:
*should this person go through payroll enrolment at all?* That needs no sensitive
data to answer. That combination makes it a fair test of the T3N privacy model
rather than a demo of it.

---

## 2. The privacy claim, enforced rather than asserted

| Path | What stops PII from travelling |
|---|---|
| Agent → contract | `StartInput` has **no field** to put it in. `employee_ref` is HR-internal and validated to 64 chars of `[A-Za-z0-9._/-]` |
| Contract body | Built with literal `{{profile.*}}` markers; those bytes *are* the payload, not a redaction applied for display |
| Outbound call | `http-with-placeholders` resolves markers host-side, after the bytes leave WASM |
| Upstream response | The body is discarded; only the status code is read, because an upstream can echo back what it received |
| Stored record | Holds status only, and carries `contains_pii: false` as a field rather than a promise |
| Credentials | `secrets` map readers are `{ only: [contractId] }`; the process that writes a key cannot read it back |

The strongest evidence is the dry run. `onboard` without `--live` prints the exact
bodies the enclave would send, with the markers still unresolved. If a name or an
account number appeared there, the design would have failed visibly.

INSERT IMAGE: `screenshots/15-04-onboard-an-employee.png`

Those two bodies are the entire payload. `{{profile.ssn}}` and `{{profile.address}}`
are substituted by the host inside the enclave, and I have never seen the values.

---

## 3. T3N features used

- `T3nClient`: handshake + Ethereum auth → `did:t3n:…` tenant identity
- `fetchTrustedManifest`: attested trust anchor; the client refuses to construct without it
- `TenantClient` for the control plane: maps, contract registration, invocation
- **TEE contract**: Rust → `wasm32-wasip2`, WIT world, five exported functions
- `host:interfaces/http-with-placeholders`: the privacy mechanism
- Its typed errors (`egress-denied`, `placeholder-denied`, `placeholder-unknown`, `placeholder-no-user-context`) are surfaced verbatim rather than flattened
- `host:interfaces/kv-store`: `config`, `secrets`, `onboarding-log` maps
- Tenant KV maps with contract-scoped ACLs
- `getMemberDelegation` / `addMemberDelegationGrants` for scoped delegation with `allowed_hosts`
- `submitUserInput`: the calling user's profile that placeholders resolve against
- `setDescriptor`: publish the contract descriptor, without which a registered contract is not dispatchable
- `getActivityLog`: the ledger's host-stamped record of dispatches
- `serverExternalPackages` (Next.js): keeps the SDK's runtime `.wasm` load out of the bundler

Not used: `host:interfaces/authorisation`. It is the natural way to
ask "may this host be reached?" before acting, but importing it makes the contract
un-instantiable. See Section 6.

---

## 4. What actually happened on testnet

Run on 2026-09-13 against `testnet` with a real DID and key. Every step succeeded.

| Step | Result |
|---|---|
| `whoami` | `did:t3n:50a04efc…d642b3`, node `cn-api.sg.testnet` |
| `build:contract` | `hr_onboard.wasm`, **217 723 bytes**, target `wasm32-wasip2` |
| `npm test` | typecheck clean, **15/15** Rust unit tests |
| `init` | `config`, `secrets`, `onboarding-log` created |
| `deploy` | registered v0.1.2, **contract_id 1005**, descriptor published, ACLs re-pointed |
| `info` | full self-description returned **from inside the enclave** |
| `preflight` | both steps configured; egress explicitly reported as unknown-by-design |
| `onboard` (dry) | plan + both request bodies with `{{profile.*}}` **unresolved** |
| `grant` | self-bound delegation, `allowed_hosts: [httpbin.org]` |
| `onboard --live` | **`provision-identity` → HTTP 200** and **`enroll-payroll` → HTTP 200** |
| `status` | record **`completed`**, `contains_pii: false` |
| `audit` | 32 ledger entries: 9 `error` (all from the broken import), then 23 `success` |
| Web console | all six routes return live data; `T3N_API_KEY` absent from the client bundle |

Both steps are real HTTPS POSTs that left the enclave with the employee's name,
national id, address, country and personal email substituted by the host, after the
bytes left WASM. **Those values never existed in the application process**, and the
upstream response bodies are discarded rather than forwarded, because an upstream
can echo back what it received.

INSERT IMAGE: `screenshots/15-05-onboarding-records.png`

INSERT IMAGE: `screenshots/15-06-audit-trail.png`

The audit panel is not the application's log. These rows are what the *network*
recorded, host-stamped from the verified dispatch context, so a contract cannot
forge who acted. `start-onboarding` completing `success` while
`provision-identity` failed inside it is the correct distinction: the dispatch
succeeded, the business step did not.

---

## 5. Screenshots

All in the repository under `screenshots/`. The browser set is generated rather than
hand-taken: `node scripts/capture-console.mjs` drives Chrome over the DevTools
Protocol, measures the real content height, and clips each panel to its own box. It
also presses the buttons on the two panels that are idle until asked, so those two
images show a real run instead of an empty form, and writes `console-text.txt`, the
same content as text, so a reader can grep it rather than squint at a PNG.

| File | Shows |
|---|---|
| `15-01-operator-session.png` | live DID, node, credit balance, contract status |
| `15-02-tenant-setup.png` | the three maps and their access story |
| `15-03-preflight.png` | per-step configuration, egress stated as unknown-by-design |
| `15-04-onboard-an-employee.png` | plan, dry-run bodies with `{{profile.*}}` unresolved, `contains_pii: false` |
| `15-05-onboarding-records.png` | the stored record: `emp-2041`, `completed`, both steps `ok` |
| `15-06-audit-trail.png` | host-stamped dispatches from the ledger |
| `15-07-why-the-privacy-claim-holds.png` | the five claims, each tied to a mechanism |
| terminal captures | `whoami`, `build:contract`, `npm test`, `init`, `deploy`, `info`, `preflight`, dry run, grant, live run, `status`, `audit` |

The three that matter most are the dry run, the live run, and the audit trail: they
show the privacy mechanism, a real outbound call, and the failure-then-fix in the
network's own record.

---

## 6. Issues encountered

Fourteen items in `docs/BUGS.md`. The three critical ones were found by running the
thing, and each is reproducible.

1. Importing `host:interfaces/authorisation@2.1.0` makes a contract
un-instantiable, and the error says nothing. Every dispatch returns a bare
`RPC Error: Internal error` with no field, no component, no hint. The raw JSON-RPC
response is `{"code": -32603, "message": "Internal error"}` plus a correlation id,
and `contracts.logs()` is empty, so there is nothing to cross-check. Established by
bisection: the same crate, differing by that one import, goes from failing every call
to returning its full `contract-info`. The interface *is* declared in the host's
`world interfaces`, and it is the one interface that would let a contract ask "may I
egress?" before acting, so the design the docs encourage is the one that silently
bricks the build.

2. `register` reports success but the contract is not dispatchable until
`setDescriptor` is called. `listDetailed` reports `status: "active"` with
`descriptor: null`, and every call fails with that same content-free error. Nothing
in the Quickstart or Walkthrough mentions the descriptor; the only pointer is a doc
comment about the "MCP dispatch funnel". A deployment that skips it looks completely
successful.

3. The descriptor schema is undocumented. Eight required fields per function,
recovered one validator error at a time, and two are counter-intuitive: `returns`
(the obvious guess, `returns_schema`, is rejected) and `examples`. The SDK type is
explicitly open-ended, so it offers no help either.

4. The WIT spec calls nested placeholders "malformed"; they are not, and the email
only resolves at a nested path. The spec defines `placeholder-denied` as covering a
*"malformed marker (nested / non-snake-case field)"*. But the email is not on the
top-level profile the way `first_name` is; the host keeps it under the
verified-contacts structure, so the resolvable marker is
`{{profile.verified_contacts.email.value}}`. Terminal 3's own reference contract
(`z-tenant-flight/src/booking.rs`) uses exactly that while using flat names for every
other field.

Both directions were tested against testnet with the same contract, differing only in
the marker:

| Marker | Result |
|---|---|
| `{{profile.email_address}}` | `placeholder-unknown`: *"the calling profile is missing field 'email_address'"* → step fails |
| `{{profile.verified_contacts.email.value}}` | resolves → **HTTP 200**, `status: completed` |

That combination is what makes it expensive: the spec's wording steers you to flat
names, `user-upsert` accepts the flat `email_address` without complaint (it is a
documented Level-1 field), and the failure arrives as a missing *field* rather than a
wrong *name*, so the natural next move is to bind the field harder rather than rename
it. This one wrong signal cost more wall-clock time than anything else in the build.

Also notable: **deny-all egress has no documented path for an individual tenant**.
The SDK's only egress API, `OrgDataClient.setAgentEgress`, requires an org and is
org-admin only, and what worked was a member-delegation grant bound to your own DID.
**`user-upsert` accepts fields that are not resolvable as placeholders**, so the
mismatch surfaces later as a step failure mid-run. And **a contract's numeric id
cannot be read back**: not from `list`, `listDetailed`, `maps`, or the ledger, even
though map ACLs are keyed on it, which meant a second `init` could resolve those
ACLs to deny-all and silently revoke the deployed contract's access to its own maps.

---

## 7. Post-challenge maintenance

The intention is to keep running it, and I am happy to hand it over.

This is a standalone integration on the public testnet. Nothing depends on a hosted
service, a private endpoint, or a machine that exists only during the challenge. It
runs from a checkout with one key in `.env`, and the contract is config-driven:
retargeting a step to a real HRIS or payroll provider is a `config` map write, not a
redeploy.

Running it in two ways is a hedge: the CLI suits a scheduled job or a
single operator, the web console suits an HR team that will not open a terminal.
Neither carries its own copy of the logic.

| Component | Ongoing cost |
|---|---|
| TEE contract | Low. 1 370 lines of Rust plus a 94-line WIT world, 15 unit tests with no network dependency. A new step is one `StepSpec` entry plus one `build_body` arm |
| Shared services + CLI | Low. Zero build step, no bundler, one runtime dependency |
| Web console | Low, because it holds no rules of its own: a panel calls a route, a route calls an existing service |
| Upstream integration | The real work, and it lives in configuration plus whichever HRIS/payroll schemas are targeted |
| SDK upgrades | Two isolated spots: the `register`/`publish` fallback in `deploy`, and the ACL rewiring in `mapSpecs` |

**Handover process**, if Terminal 3 would rather own it: this repository plus a
`.env`. The two seams above are where upstream work lands. There is no state outside
the tenant's own maps and the network ledger, so nothing needs migrating.

One caveat about hosting: the console is not deployed publicly, and there
is a reason beyond time: a public deployment holds `T3N_API_KEY` in its environment,
and any caller who finds the URL can spend the tenant's credits. Putting it online
should wait for a **separate sandbox key**, with
`ONBOARD_ALLOW_LIVE` left unset so the deployment can plan but not act. The code
supports that mode today.

---

## 8. Submission form answers

- **Email address:** `TODO`
- **DID generated from the page:** `did:t3n:50a04efc91641528919da135e31d8995fcd642b3`
- **Continue running this, or pass it to us to run it:** **Continue running it**, and
  equally happy to hand it over. It is a standalone testnet integration with no
  hosted dependencies; the handover process is Section 7.
