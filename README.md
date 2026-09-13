# hr-onboard: privacy-preserving employee onboarding on Terminal 3

An enterprise onboarding agent where **the AI never sees the employee's data**.

The agent decides *which* onboarding steps to run, using only an internal employee
reference, a role, a department and a start date. The actual work, creating the
HRIS record and enrolling the hire with payroll, runs inside a Terminal 3 TEE
contract, and the employee's name, national id, address and personal email are
substituted **by the host, inside the enclave, at the moment the outbound request
is built**. They are never arguments, never local variables, and never bytes in
this process's memory.

This repository is a submission to the
[T3N Agent Build Challenge](https://superteam.fun/earn/listing/t3n-agent-build-challenge).

## Two surfaces, one implementation

| Surface | Who it is for | How it runs |
|---|---|---|
| **Web console** | an HR operator, in a browser | `npm run dev`: Next.js App Router, SDK on the server only |
| **CLI** | an operator or a scheduled job | `npm run cli -- <command>`: no bundler involved |

Both call the same functions in [`src/services/`](src/services). That is the point:
the safety rules, the dry-run default, the contract-id ACL rewiring and the
planner's validation, exist in exactly one place, so a web request and a cron job
cannot drift apart. The web tier is a thin HTTP + UI shell over the code the CLI
already uses.

The T3N SDK loads a `.wasm` component from its own package directory at runtime.
The T3N docs flag this as breaking under Next.js/Turbopack, Vite and older
Webpack, and recommend keeping it out of a bundler. This app does exactly that:
`serverExternalPackages: ["@terminal3/t3n-sdk"]` in [`next.config.ts`](next.config.ts)
keeps the SDK on the Node runtime, and `T3N_API_KEY`, an Ethereum private key, is
read only inside server route handlers. No client component ever receives it.

---

## The problem this solves

Onboarding is the single moment an enterprise moves a new hire's most sensitive
data between systems. Every implementation of that flow has the same shape: the
data passes through application code, application logs, and whoever operates the
application. Compliance teams then try to bound the blast radius with access
reviews and retention policies. That is paperwork applied to a structural problem.

The structural fix is to stop the application from ever holding the data. That is
what a TEE with host-side placeholder resolution gives you, and it is what this
project demonstrates end to end.

## What it does

Two steps, both configurable without a redeploy:

| Step | Talks to | Fields it needs | Where those fields come from |
|---|---|---|---|
| `provision-identity` | your HRIS endpoint | first name, last name, personal email | `{{profile.*}}`, resolved in the enclave |
| `enroll-payroll` | your payroll endpoint | first name, last name, national id, address, country | `{{profile.*}}`, resolved in the enclave |

The contract carries no PII in either direction:

- **In**: `start-onboarding` takes `employee_ref`, `role`, `department`,
  `start_date`. No human values.
- **Out**: every response contains step status, host, HTTP status and (on a dry
  run) the *templated* request bodies. Upstream response bodies are dropped on
  purpose, because an upstream can echo the resolved PII straight back.

## How the privacy claim actually holds

Claims like this are worth exactly as much as the mechanism behind them, so here
is every place a value could travel, and why it does not:

| Path | What protects it |
|---|---|
| Agent → contract | The agent's inputs are non-sensitive by construction (`employee_ref` is HR-internal). |
| Contract body construction | Bodies are built with `{{profile.<field>}}` markers. The Rust unit tests assert the markers are present. |
| Outbound call | `http-with-placeholders` resolves markers host-side, after the bytes leave WASM. |
| Upstream response | Never forwarded to the caller; only `resp.code` is read. |
| Stored record | `contains_pii: false` is a field, not a promise. Records hold status only. |
| Credentials | Upstream API keys live in the `secrets` map, whose readers are `{ only: [contractId] }`. |

`hr-onboard onboard` (without `--live`) prints the exact request bodies with the
markers still unresolved. That output *is* the evidence: if a name or an account
number appeared there, the design would have failed visibly.

## Quickstart

**Prerequisites:** Node ≥ 22.9 (for native TypeScript execution), Rust with the
`wasm32-wasip2` target, and a T3N key.

```bash
# 0. Toolchain
rustup target add wasm32-wasip2

# 1. Dependencies
npm install

# 2. Your key: claim one at https://www.terminal3.io/claim-page (shown once)
cp .env.example .env
$EDITOR .env          # set T3N_API_KEY at minimum

# 3. Build the contract and check it before it ever reaches the network
npm run build:contract
npm test              # typecheck + 15 Rust unit tests

# 4. Tenant setup, in this order
npm run cli -- whoami     # confirm the session and the credit balance
npm run cli -- init       # create the three maps, write the step endpoints
npm run cli -- deploy     # register the contract, point the map ACLs at it
npm run cli -- seed       # move upstream credentials into the private map

# 5. See what each step still needs (no outbound call, no side effects)
npm run cli -- preflight

# 6. Plan and dry-run an onboarding (nothing is sent, nothing is written)
npm run cli -- onboard \
  --employee emp-2041 --role "Backend Engineer" --department Platform \
  --start 2026-10-01

# 7. Authorise egress, then send for real and read it back
#
# A fresh tenant has DENY-ALL egress, so a live run is refused until a grant
# names the hosts. For an individual tenant the grant must be bound to your own
# DID: `OrgDataClient.setAgentEgress` is the documented egress API but it
# requires an org. See docs/BUGS.md #4.
DID="$(npm run cli -- whoami --json | node -e 'process.stdin.once("data",d=>console.log(JSON.parse(d).did))')"
npm run cli -- grant --agent "$DID" --hosts httpbin.org

npm run cli -- onboard --employee emp-2041 --role "Backend Engineer" \
  --department Platform --start 2026-10-01 --live
npm run cli -- status --employee emp-2041
npm run cli -- audit
```

`deploy` must run before `seed`: the `secrets` map is readable only by the
contract, and a contract-scoped ACL is keyed on the numeric contract id, which
does not exist until registration.

`deploy` is safe to re-run, and the node's own rule is why it has to be: a version
that is not strictly higher than the registered one is refused outright
(`version 0.1.1 is not higher than current version 0.1.1`). So `deploy` compares
first: at the same version it reconciles the descriptor and the ACLs instead of
re-registering, on a downgrade it says so in one line, and only a genuinely newer
version registers.

The numeric contract id is written into the `config` map, because nothing in the
SDK can read it back: `list` and `listDetailed` do not carry it, map ACLs are
write-only, and the ledger records the canonical *name*. Both contract-scoped ACLs
are keyed on that id, so tenant state is the only place it can live. `init`
re-points those ACLs at the recorded id rather than at deny-all, which is what
makes re-running it safe on a tenant that already has a contract deployed.

`deploy` also **publishes the contract descriptor**, and that is not optional:
a registered contract with no descriptor reports `status: active` yet fails every
call with a bare `RPC Error: Internal error`. See [`docs/BUGS.md`](docs/BUGS.md) #2
and #3.

The two steps resolve different profile fields, and one of them is a **nested**
path: the email is `{{profile.verified_contacts.email.value}}`, not a flat
`email_address`. The flat name is a valid *input* field for `user-upsert`, and it
appears in the documented Level-1 set, but it is not a resolvable path, and using it
yields `placeholder-unknown` ("the calling profile is missing field"), which reads
like missing data rather than a wrong field name. See
[`docs/BUGS.md`](docs/BUGS.md) #6.

### The web console

```bash
npm run dev      # http://localhost:3000
```

The console exposes the same operations as the CLI, minus the ones that are
deliberately operator-only:

| Panel | Calls | Notes |
|---|---|---|
| Session | `GET /api/session` | DID, node, credits, whether the contract is registered |
| Provision | `POST /api/provision` | Reconciles the three maps and the step config |
| Preflight | `GET /api/preflight` | Per-step configuration status, and what is still missing |
| Onboard | `POST /api/onboard` | Dry run by default; the returned bodies still show `{{profile.*}}` |
| Records | `GET /api/records` | Stored onboarding records |
| Audit | `GET /api/audit` | The ledger's own record of dispatches |

**Contract registration stays CLI-only (`npm run cli -- deploy`).** It needs the
compiled `.wasm` artifact and rewrites map ACLs. It is a build-and-provision step,
not something a browser button should be able to trigger.

**`live` is off by default in the web tier** and must be enabled explicitly with
`ONBOARD_ALLOW_LIVE=true`. A publicly reachable deployment should not be able to
move money-shaped data because someone found the URL. Leave it unset on anything
that is not a private operator console.

## Verified against testnet

Every step below was run against `testnet` on 2026-09-13 with a real DID and key.
Nothing in this section is projected.

```
whoami      did:t3n:50a04efc…d642b3   testnet
init        config/created  secrets/created  onboarding-log/created
build       hr_onboard.wasm  217723 bytes  (wasm32-wasip2)
test        tsc clean, 15/15 Rust unit tests
register    z:<tid>:employee-onboarding v0.1.2  contract_id 1005
descriptor  published
info        full self-description returned from inside the enclave
preflight   provision-identity httpbin.org endpoint=yes credential=no
            enroll-payroll     httpbin.org endpoint=yes credential=no
            READY (configured)
```

The dry run returns the exact bodies the host would send, markers unresolved:

```json
{"external_ref":"emp-2041","given_name":"{{profile.first_name}}",
 "family_name":"{{profile.last_name}}","tax_id":"{{profile.ssn}}",
 "address":"{{profile.address}}","country":"{{profile.country_of_residence}}",
 "currency":"USD"}
```

And the live run, with the egress grant in place and a profile committed:

```
step                status  host         http
provision-identity  ok      httpbin.org  200
enroll-payroll      ok      httpbin.org  200

status: completed   contract v0.1.2   contains_pii: false
```

Both steps are real HTTPS POSTs that left the enclave with the employee's name,
national id, address, country and personal email substituted host-side. **Those
values never existed in this process**. The dry run above is what the contract
held. `hr-onboard audit` shows the whole history in the network's own ledger: 32
dispatches, 9 of them `error` (all from the unusable `authorisation` import), then
23 `success`.

## Commands

| Command | Purpose |
|---|---|
| `whoami` | DID, node, credit balance, whether the contract is registered |
| `init` | Create/reconcile the tenant maps; write step endpoints into `config` |
| `deploy` | Build+register the contract, then re-point map ACLs at its new id |
| `seed` | Write `HRIS_API_KEY` / `PAYROLL_API_KEY` into the private `secrets` map |
| `info` | Ask the deployed contract what it needs from an operator |
| `preflight` | Per-step configuration status plus everything still missing |
| `onboard` | Plan → preflight → run (dry by default; `--live` sends) |
| `status` | Read back one stored record |
| `list` | Enumerate stored records, optionally filtered by status |
| `grant` | Delegate scoped authority to an agent DID |
| `grants` | Show this identity's current delegation edges |
| `audit` | The ledger's own record of contract dispatches |

Every command supports `--json` for machine-readable output on stdout;
progress and diagnostics go to stderr.

## Architecture

```
┌──────────────────────┐   non-PII only    ┌──────────────────────────────┐
│  agent (this CLI)    │ ────────────────► │  z:<tid>:employee-onboarding │
│  plans which steps   │                   │  TEE contract (Rust → WASM)  │
│  never holds PII     │ ◄──────────────── │                              │
└──────────────────────┘  status only      └───────────┬──────────────────┘
                                                      │ {{profile.*}}
                       ┌──────────────────────────────┴──────────────┐
                       │ host resolves placeholders inside the enclave│
                       └──────────────────────┬──────────────────────┘
                                              ▼
                                  HRIS / payroll endpoints
```

Details, including trust boundaries, the map access model and why each decision
was made, are in [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

## Security model

- **No blanket trust.** An agent gets named functions on one contract plus an
  explicit egress allow-list. No grant means the contract still runs and the
  outbound call is denied.
- **Egress is deny-all until granted.** A fresh tenant can reach nothing. Until
  a delegation grant names the hosts, every outbound call is refused by the host.
- **Honest preflight.** `preflight` reports everything it can actually verify
  (endpoint configured, credential present, profile fields the steps need) and
  deliberately does **not** claim to know egress authorisation, because that is
  decided at dispatch. The one interface that would expose it, `authorisation`,
  is not provided to tenant contracts: importing it makes the component
  un-instantiable and every call fails with a content-free `Internal error`. So
  `egress_authorised` is `null` and the report says why, and a refusal surfaces as
  a `denied` step naming the host. See [`docs/BUGS.md`](docs/BUGS.md) #1.
- **Dry by default.** The contract's `dry_run` defaults to `true`; a caller who
  forgets the flag gets a plan, not a payroll enrolment. The CLI makes the
  `--live` decision at exactly one line.
- **Secrets are enclave-only.** `secrets` readers are `{ only: [contractId] }`.
  The process that writes a credential cannot read it back.
- **Logs are contract-only.** `onboarding-log` writers are `{ only: [contractId] }`,
  so a record cannot be back-dated by whoever holds the tenant key.
- **Nothing is echoed.** Upstream bodies are discarded; only the status code is
  reported, so an upstream cannot launder PII back through an error path.
- **The key never moves.** `T3N_API_KEY` is an Ethereum private key. It signs the
  login challenge locally and is never sent anywhere.
- **But `.next/` does hold it, so never ship it.** Measured: the key appears in
  **0** files under `.next/static/` and `.next/server/`, so no client bundle and no
  server output carries it, which is the property that actually matters. It *is*
  written into Turbopack's build cache (`.next/cache/turbopack/*.sst`, 11 files),
  because the value is read while Next collects page data. `.next/` is gitignored,
  but if you zip or archive the project for anyone, run `rm -rf .next` first.

## Layout

```
├── contracts/employee-onboarding/    Rust TEE contract
│   ├── wit/world.wit                 exported functions + host imports
│   ├── wit/deps/                     vendored host interfaces (from the
│   │                                 official Terminal-3/z-tenant-flight example)
│   └── src/
│       ├── lib.rs                    thin WIT boundary
│       └── onboarding.rs             behaviour, host calls, 15 unit tests
├── app/                              Next.js web console
│   ├── page.tsx                      operator dashboard
│   ├── components/                   one panel per operation
│   ├── lib/                          client fetch wrappers + view types
│   └── api/                          server routes: the only place the SDK runs
│       ├── session/  provision/      connect, then reconcile the tenant maps
│       ├── preflight/  onboard/      ask permission, then act
│       └── records/  audit/          read back stored records and dispatches
├── src/
│   ├── cli.ts                        dispatch, help, exit codes
│   ├── agent/planner.ts              deterministic planner + optional LLM
│   ├── commands/                     one module per command group
│   ├── contract/                     artifact lookup + mirrored wire types
│   ├── lib/                          args, config, logger, table, url
│   ├── services/                     shared by the CLI and the web routes
│   └── t3n/                          session, tenant client, invocation
├── scripts/
│   └── capture-console.mjs           screenshots the console via DevTools Protocol
├── screenshots/                      submission evidence: PNGs + console-text.txt
├── docs/
│   ├── ARCHITECTURE.md               trust boundaries and design decisions
│   ├── BUGS.md                       defects found in the T3N docs + SDK
│   └── SUBMISSION.md                 the challenge write-up
```

## Testing

```bash
npm test              # tsc --noEmit, then cargo test (15 tests)
npm run typecheck     # types only
npm run test:contract # contract logic only, no network
npm run build         # production build of the web console

# Screenshot the console, for the submission write-up.
# Captures the full page and one image per panel; no extra dependency.
# Two panels are idle until asked, so it presses their buttons first. Those
# images show a real run, not an empty form. Also writes console-text.txt,
# which is greppable where a PNG is not. Costs one dry-run invocation.
node scripts/capture-console.mjs http://localhost:3100/ screenshots
```

Host calls are isolated behind `#[cfg(target_arch = "wasm32")]`, so the contract's
decision logic (input validation, step selection, request-body construction,
status roll-up, the scan-range invariant) is unit-testable with a plain
`cargo test` and no TEE.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `Contract artifact not found` | Wasm not built | `rustup target add wasm32-wasip2 && npm run build:contract` |
| `Missing T3N_API_KEY` | No `.env` | `cp .env.example .env` and fill it in |
| `egress denied for host 'x'` | Deny-all default; no grant covers that host | `hr-onboard grant --agent <your own did> --hosts x` |
| `RPC Error: Internal error` on **every** call | No descriptor published, or the contract imports `authorisation` | Re-run `deploy` (it publishes the descriptor); check the imports in `wit/world.wit`. See `docs/BUGS.md` #1 and #2 |
| `descriptor malformed: field 'y' must be …` | Descriptor missing a required field | The validator names it; all eight are listed in `docs/BUGS.md` #3 |
| `the calling profile is missing field 'x'` | The profile lacks that field, **or the field name is wrong for how the host stores it** | Bind it via `submitUserInput`. Note the email is not `email_address` but the nested `verified_contacts.email.value`. See `docs/BUGS.md` #6 |
| `no user profile is bound to this call` | Invoked outside a user session | Run through `onboard`, not a direct dispatch |
| `SSN must be 9 digits, optionally grouped as 3-2-4` | Profile SSN is malformed | Use `123-45-6789` form |
| `map is stuck in the 'deleting' state` | Host sweeper still draining | Wait, or use a different tail |
| `preflight` exits non-zero | A step has no endpoint configured | The output names each missing config key |
| `unknown step 'x'` | The step is not compiled into the contract | `info` lists the steps the deployed build accepts |
| `response is missing 'employee_ref'` | Node returned an unexpected envelope | Re-run with `T3N_LOG_LEVEL=debug` to see the raw dispatch |

## Running it after the challenge

The contract is deliberately small and config-driven: retargeting a step is a
`config` map write, not a redeploy. Everything runs on the public testnet
against endpoints you choose.

The maintenance surface is three pieces, and each is small on purpose:

| Piece | Why it stays maintainable |
|---|---|
| TEE contract | 1 370 lines of Rust (1 258 behaviour + 112 WIT boundary) plus a 94-line WIT world, 15 unit tests that run without a TEE, no network in tests. A new step is one `StepSpec` entry plus a `build_body` arm. |
| Shared services + CLI | No build step, no bundler, one runtime dependency. |
| Web console | No business logic of its own. Panels call routes, and routes call the same services the CLI calls. |

See [`docs/SUBMISSION.md`](docs/SUBMISSION.md) for the handover notes.

## License

MIT
