# Submission — T3N Agent Build Challenge

> This file is the source for the public Google Doc that the challenge asks for.
> Copy it into a Google Doc, add the screenshots listed in Section 5, then paste the
> Doc link into the submission form.

**Challenge:** [Try out new docs to build a trusted agent with T3N](https://superteam.fun/earn/listing/t3n-agent-build-challenge) — Terminal 3 Network
**Repository:** <https://github.com/DikaCream/T3N-Challenge>
**Process to run:** `npm install && npm run build:contract && npm run dev` — the web console binds `localhost:3000`; the CLI is `npm run cli -- <command>`

---

## 1. What was built

**`hr-onboard`** — an enterprise employee-onboarding agent where the AI never sees
the employee's data.

The agent plans *which* onboarding steps to run using only an internal employee
reference, a role, a department and a start date. A T3N TEE contract then performs
the work — creating the HRIS record and enrolling the hire with payroll — and the
employee's name, national id, address and personal email are substituted by the
host **inside the enclave**, at the moment the outbound request is built. They are
never function arguments, never local variables, and never bytes in the
application's process.

Three components, all in the repo:

| | |
|---|---|
| **TEE contract** | `contracts/employee-onboarding/` — Rust → `wasm32-wasip2`, five exported functions over WIT, 15 unit tests that run without a TEE |
| **Agent + shared services** | `src/` — TypeScript, zero build step (Node 24 native type stripping), 12 CLI commands |
| **Web console** | `app/` — Next.js App Router. The SDK runs **only** in server route handlers; no client component ever holds `T3N_API_KEY` |

The CLI and the console call the same `src/services/` functions, so the safety
rules are implemented once rather than re-derived per surface — which is what
makes the second surface cheap to keep working.

### Why this use case

Onboarding is the moment an enterprise moves a new hire's most sensitive data
between systems, and it is the flow where "the app must hold the PII to do its
job" is normally taken as given. It also has a genuinely useful agent decision in
it — *should this person go through payroll enrolment at all?* — that needs no
sensitive data to answer. That combination is what makes it a fair test of the
T3N privacy model rather than a demo of it.

---

## 2. How the privacy claim is enforced, not asserted

| Path | What stops PII from travelling |
|---|---|
| Agent → contract | `StartInput` has **no field** to put it in. `employee_ref` is HR-internal and validated to 64 chars of `[A-Za-z0-9._/-]`. |
| Contract body | Built with literal `{{profile.*}}` markers — those bytes *are* the payload, not a redaction. |
| Outbound call | `http-with-placeholders` resolves markers host-side, after bytes leave WASM. |
| Upstream response | Body is discarded; only `resp.code` is read, because an upstream can echo what it received. |
| Stored record | Holds status only; carries `contains_pii: false` as a field, not a promise. |
| Credentials | `secrets` map readers are `{ only: [contractId] }` — the process that writes a key cannot read it back. |

The strongest evidence is the dry run: `onboard` without `--live` prints the exact
request bodies with markers unresolved. If a name or an account number appeared
there, the design would have failed visibly.

---

## 3. T3N features used

- `T3nClient` — handshake + Ethereum auth → `did:t3n:…` tenant identity
- `fetchTrustedManifest` — attested trust anchor (the client refuses to construct without it)
- `TenantClient` — control plane: maps, contract registration, invocation
- **TEE contract** (Rust → `wasm32-wasip2`, WIT world) — the enclave logic
- `host:interfaces/http-with-placeholders` — the privacy mechanism
- `host:interfaces/kv-store` — `config`, `secrets`, `onboarding-log` maps
- `host:tenant/tenant-context` — tenant DID, so the contract names its own `z:<tid>:*` maps
- `http-with-placeholders`'s typed errors — `egress-denied`, `placeholder-denied`, `placeholder-unknown`, `placeholder-no-user-context` are all surfaced verbatim rather than flattened
- Tenant KV maps with contract-scoped ACLs
- `getMemberDelegation` / `addMemberDelegationGrants` — scoped delegation with `allowed_hosts`; this is also the working path to authorise egress for an individual tenant
- `submitUserInput` — commit the calling user's profile that placeholders resolve against
- `setDescriptor` — publish the contract descriptor, without which a registered contract is not dispatchable
- `getActivityLog` — the ledger's host-stamped record of dispatches
- `serverExternalPackages` (Next.js) — the SDK's runtime `.wasm` load is kept out of the bundler, which the T3N docs name as the failure mode under Turbopack/Vite/Webpack

**Not used, deliberately:** `host:interfaces/authorisation`. It is the natural way to
ask "may this host be reached?" before acting, but importing it makes the contract
un-instantiable — every dispatch fails with `RPC Error: Internal error` and nothing
else. The same crate without that import dispatches correctly. See Section 6 and
[`BUGS.md`](BUGS.md) #1.

---

## 4. Reproducing it

```bash
rustup target add wasm32-wasip2
npm install
cp .env.example .env        # set T3N_API_KEY

npm run build:contract      # Rust → WASM
npm test                    # tsc + 15 contract unit tests

npm run cli -- whoami
npm run cli -- init
npm run cli -- deploy
npm run cli -- seed
npm run cli -- preflight
npm run cli -- onboard --employee emp-2041 --role "Backend Engineer" \
  --department Platform --start 2026-10-01          # dry run

# A fresh tenant has deny-all egress, so a live run is refused until a grant
# names the hosts. For an individual tenant the grant is bound to your own DID.
DID="$(npm run cli -- whoami --json | node -e 'process.stdin.once("data",d=>console.log(JSON.parse(d).did))')"
npm run cli -- grant --agent "$DID" --hosts httpbin.org

npm run cli -- onboard --employee emp-2041 --role "Backend Engineer" \
  --department Platform --start 2026-10-01 --live   # sends
npm run cli -- status --employee emp-2041
npm run cli -- audit

# Optional: the browser console over the same agent
npm run dev                 # http://localhost:3000
```

Actions completed from the challenge scope: SSO signup → DID + API key obtained →
Quickstart completed (`handshake` + `authenticate` against testnet) → Walkthrough
completed (TEE contract written, built, registered, invoked, tested).

### What actually happened on testnet

Run on 2026-09-13 against `testnet` with a real DID and key. Every step succeeded.

| Step | Result |
|---|---|
| `whoami` | `did:t3n:50a04efc…d642b3`, node `cn-api.sg.testnet` |
| `build:contract` | `hr_onboard.wasm`, 217 723 bytes, target `wasm32-wasip2` |
| `npm test` | typecheck clean, 15/15 Rust unit tests |
| `init` | `config`, `secrets`, `onboarding-log` created |
| `deploy` | registered `v0.1.2`, `contract_id 1005`, descriptor published, ACLs re-pointed |
| `info` | full self-description returned **from inside the enclave** |
| `preflight` | both steps configured; `ready`; egress explicitly reported as unknown-by-design |
| `onboard` (dry) | plan + both request bodies with `{{profile.*}}` **unresolved** |
| `grant` | self-bound delegation, `allowed_hosts: [httpbin.org]` |
| `onboard --live` | `provision-identity` **HTTP 200** and `enroll-payroll` **HTTP 200** |
| `status` | record **`completed`**, `contains_pii: false` |
| `audit` | 32 ledger entries: 9 `error` (all from the broken import), then 23 `success` |
| Web console | all six routes return live data; `T3N_API_KEY` absent from the client bundle |

Both steps are real HTTPS POSTs that left the enclave with the employee's name,
national id, address, country and personal email substituted by the host. **Those
values never existed in the application process** — the dry run in Section 2 is what the
contract held, and the upstream response bodies are discarded rather than forwarded.

The last fix, and the one that took longest: `provision-identity` was referencing
`{{profile.email_address}}`, which resolves to nothing. The email is stored at the
**nested** path `{{profile.verified_contacts.email.value}}`, which is what Terminal
3's own reference contract uses. The WIT package's doc comment calls a nested marker
*malformed* and says it is rejected — it is not, and following the spec's own words
produces `placeholder-unknown` ("the calling profile is missing field"), which reads
like missing data instead of a wrong field name. See [`BUGS.md`](BUGS.md) #6.

---

## 5. Screenshots

**Before capturing anything, close `.env`** — `T3N_API_KEY` is an Ethereum private
key and one stray screenshot exposes the tenant. Nothing below was taken with it
on screen.

### Already captured — `screenshots/`

The browser set is generated, not hand-taken. With the console running:

```bash
npm run dev                                        # or: npx next start -p 3100
node scripts/capture-console.mjs http://localhost:3100/ screenshots
```

That script drives Chrome over the DevTools Protocol, measures the real content
height, and clips each panel to its own box — so no crop at the bottom and no
white padding. It needs no dependency beyond Node's built-in `WebSocket`.

Two panels — `Onboard an employee` and `Onboarding records` — are idle until
asked, because neither can know what to plan or which employee to look up. The
script presses their buttons the way an operator would and captures the result;
screenshotting them idle would document an empty state instead. A capture run
therefore performs one real dry-run onboarding, which costs an RPC and a contract
invocation.

It also writes `console-text.txt`, the rendered text of every panel. A screenshot
cannot be grepped or diffed, so this is what makes it possible to check that a
capture shows data rather than an error state without opening the images.

| File | What it shows |
|---|---|
| `14-web-console-full.png` | the whole console, 1440×5387 |
| `14a-web-console-above-fold.png` | the landing view, for the first page of the Doc |
| `15-01-operator-session.png` | live DID, node, credit balance, contract status |
| `15-02-tenant-setup.png` | the three maps and their access story |
| `15-03-preflight.png` | per-step configuration, and egress stated as unknown-by-design |
| `15-04-onboard-an-employee.png` | the plan, the dry-run bodies with `{{profile.*}}` unresolved, `contains_pii: false` |
| `15-05-onboarding-records.png` | the stored record — `emp-2041`, `completed`, both steps `ok` |
| `15-06-audit-trail.png` | host-stamped dispatches from the ledger |
| `15-07-why-the-privacy-claim-holds.png` | the five claims, each tied to a mechanism |
| `console-text.txt` | the same panels as text, for grepping and diffing |

### To capture — terminal

Run these in order from a working checkout. Use `npm run cli --silent -- …` so the
npm banner stays out of the frame, and give the terminal height for `info`.

| # | Command | What it establishes |
|---|---|---|
| 1 | SSO claim page (browser) | Scope detail: signed up, DID + API key obtained |
| 2 | `npm run cli --silent -- whoami` | Quickstart: authenticated `did:t3n:…`, node, credits |
| 3 | `rustup target add wasm32-wasip2` then `npm run build:contract` | Walkthrough: Rust → WASM component |
| 4 | `npm test` | typecheck clean + 15/15 contract tests |
| 5 | `npm run cli --silent -- init` | three tenant maps created |
| 6 | `npm run cli --silent -- deploy` | registered `v0.1.2`, `contract_id`, **descriptor published**, ACLs re-pointed |
| 7 | `npm run cli --silent -- info` | the deployed contract describing itself from inside the enclave |
| 8 | `npm run cli --silent -- preflight` | per-step configuration; egress reported as unknown-by-design |
| 9 | **`onboard` (no `--live`)** | the request bodies with `{{profile.*}}` markers **unresolved** — the privacy evidence |
| 10 | `grant --agent <own did> --hosts httpbin.org` + `grants` | the egress grant, and the delegation read back |
| 11 | **`onboard … --live`** | both steps **HTTP 200**, `status: completed` |
| 12 | `status --employee emp-2041` | the stored record, `completed`, `contains_pii: false` |
| 13 | **`audit`** | the ledger showing `error` dispatches, then `success` — the bug and its fix, attested by the network |
| 14 | Browser devtools: search the bundle for `T3N_API_KEY` | the credential never reaches the client (0 hits) |

**9, 11 and 13 are the three that matter.** They show the privacy mechanism, a real
outbound call, and the failure-then-fix in the network's own record. If only three
screenshots make the Doc, make them those.

---

## 6. Issues encountered

Fourteen items in [`docs/BUGS.md`](BUGS.md), split into critical, notable and minor.
The three critical ones were found by running the thing, and each is reproducible:

1. **Importing `host:interfaces/authorisation@2.1.0` makes a contract
   un-instantiable, and the error says nothing.** Every dispatch returns a bare
   `RPC Error: Internal error` — no field, no component. Established by bisection:
the same crate, differing by that one import, goes from failing every call to
   returning its full `contract-info`. The interface *is* declared in the host's
   `world interfaces`, and it is the one interface that would let a contract ask
   "may I egress?" before acting — so the design the docs encourage is the one
   that silently bricks the build.
2. **`register` reports success but the contract is not dispatchable until
   `setDescriptor` is called.** `listDetailed` says `status: "active"` with
   `descriptor: null`, and every call fails with that same content-free error.
   Nothing in the Quickstart or Walkthrough mentions the descriptor; the only
   pointer is a doc comment about the "MCP dispatch funnel". Deploying without it
   looks completely successful.
3. **The descriptor schema is undocumented.** Eight required fields per function,
   recovered one validator error at a time — and two are counter-intuitive:
   `returns` (not `returns_schema`) and `examples`. The SDK type is explicitly
   open-ended, so it gives no help either.

Also notable: **deny-all egress has no documented path for an individual tenant**
(the SDK's only egress API, `OrgDataClient.setAgentEgress`, is org-admin only,
and what worked was a member-delegation grant bound to your own DID), and
**`submitUserInput` returns unqualified success for a field it did not bind**, so
the omission only surfaces later as a step failure mid-run.

A **fourth** finding earned its place alongside those three once it was settled by
testing rather than reading: the WIT package's doc comment calls a nested
`{{profile.a.b.c}}` marker *malformed*, but nested markers resolve — and the email
only resolves at a nested path. `{{profile.email_address}}`, which the docs list as a
Level-1 profile field and which `user-upsert` accepts without complaint, resolves to
nothing. Both directions were measured; the incorrect one fails with *"the calling
profile is missing field 'email_address'"*, which reads like absent data instead of a
wrong field name. That single wrong signal cost more wall-clock time than anything
else in this build. See [`BUGS.md`](BUGS.md) #6.

The remaining items (`docs.terminal3.io` returning 403 after a few fetches, contract
logs off by default, empty Payroll Agent page, dead OpenAPI links, undocumented
`wasm32-wasip2` prerequisite) are a line each.

---

## 7. Post-challenge maintenance

**Intention: continue running it.**

This is a standalone integration on the public testnet — nothing depends on a
hosted service, a private endpoint, or a machine that only exists during the
challenge. It runs from a checkout with one key in `.env`, and the contract is
config-driven: retargeting a step to a real HRIS or payroll provider is a `config`
map write, not a redeploy.

Running it in two ways is a deliberate hedge on maintenance: the CLI suits a
scheduled job or a single operator, and the web console suits an HR team that will
not open a terminal. Neither carries its own copy of the logic.

Maintenance surface, honestly stated:

| Component | Ongoing cost |
|---|---|
| TEE contract | Low. 1 370 lines of Rust plus a 94-line WIT world, 15 unit tests, no external network dependency in tests. Changes are additive: a new step is one `StepSpec` entry plus a `build_body` arm. |
| Shared services + CLI | Low. Zero build step, no bundler, one runtime dependency (`@terminal3/t3n-sdk`). |
| Web console | Low, because it holds no rules of its own: a panel calls a route, a route calls an existing service. A new operation is one route file plus one panel. |
| Upstream integration | The real work, and it lives in configuration plus whichever HRIS/payroll schemas are targeted. `identity_endpoint` / `payroll_endpoint` and their header maps are the seams. |
| SDK upgrades | The `register`/`publish` fallback in `deploy` and the contract-id ACL rewiring in `mapSpecs` are the two places a v5→v6 change would land. Both are isolated to one function each. |

**Hosting caveat, stated plainly.** The console is not deployed publicly right now,
and there is a reason beyond time: a public deployment holds `T3N_API_KEY` in its
environment, and any caller who finds the URL can spend the tenant's credits.
Putting it online should be a deliberate step taken with a **separate sandbox key**,
with `ONBOARD_ALLOW_LIVE` left unset so the deployment can plan but not act. The
code supports that mode today.

If Terminal 3 would rather own it, the handover is: this repo plus a `.env`, and
the two seams above. There is no state outside the tenant's own maps and the
network ledger, so nothing needs migrating.

**Happy to keep operating it, and equally happy to hand it over** — the code is
written to be maintainable by someone who has never met me, which is why the
decision does not change the design.

---

## 8. Submission form answers

- **Email address:** `<TODO>`
- **DID generated from the page:** `did:t3n:50a04efc91641528919da135e31d8995fcd642b3`
- **Continue running this / pass it to us to run it:** continue running it; happy
  to hand over. Handover process is Section 7.
