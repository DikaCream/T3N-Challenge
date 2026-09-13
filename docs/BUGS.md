# Issues encountered

Friction hit while building this submission, kept short because the challenge asks
for "any bug faced" and this is the least weighted of its criteria.

Everything in the **Critical** section is reproduced from a real run against
testnet, not read out of the docs. The bug entries in the network ledger tell the
same story: 9 dispatches recorded as `error`, then `success` for all 23 after the
fix. `hr-onboard audit` prints exactly that — 32 entries, 9 `error`, 23 `success`.

Environment: `@terminal3/t3n-sdk@5.2.0`, Node 24.20.0, rustc/cargo 1.98.0,
target `wasm32-wasip2`, 2026-09-13.

---

## Critical

### 1. Importing `authorisation` makes a contract un-instantiable, and the error says nothing

**What happens.** A contract that imports `host:interfaces/authorisation@2.1.0`
registers successfully, is listed as `status: "active"`, and then fails *every*
dispatch with:

```
RPC Error: Internal error [7e0a2e41-836c-4143-ba22-a2bc2a545a63]
```

The raw JSON-RPC response adds nothing:

```json
{ "code": -32603, "message": "Internal error",
  "data": { "code": "internal_error", "request_id": "7e0a2e41-…" } }
```

No field name, no component, no hint. It is the same error for `contract-info`,
`preflight` and every other function, and `contracts.logs()` is empty (see #7), so
there is nothing to cross-check.

**Evidence that the import is the cause.** Two builds of the same crate, differing
by one line in `world.wit`:

| Build | Imports | Dispatch |
|---|---|---|
| A | `logging`, `kv-store`, `http-with-placeholders`, `tenant-context`, **`authorisation`** | every call → `Internal error` |
| B | the same four, **without `authorisation`** | returns its full `contract-info` immediately |

**Why it is a trap rather than an oversight.** `authorisation` is *declared* as
available — `host-interfaces-2.1.0/package.wit` ends with
`world interfaces { … export authorisation; … }`. And it is the one interface that
lets a contract answer "would egress to this host be allowed?" *before* acting,
which is precisely the pattern the docs recommend. So the interface that most
encourages the right design is the one that silently bricks the contract.

**Workaround used.** Not imported. Egress refusal is instead read from
`http-with-placeholders`'s typed `egress-denied` variant, which arrives at the
moment of dispatch. The cost is real: `preflight` can no longer report egress
authorisation, so `egress_authorised` is `null` and the report says why, rather
than showing a green tick it cannot justify.

### 2. `register` reports success, but the contract is not dispatchable until `setDescriptor`

**What happens.** `contracts.register({tail, version, wasm})` returns
`{name, contract_id}`. `contracts.listDetailed()` then reports
`status: "active"` — and `descriptor: null`. Every `execute` still fails with the
same unactionable `Internal error` from #1, for which the descriptor was in fact
the cause.

The only pointer anywhere is a doc comment on `setDescriptor`:

> The node serves the stored document as the sole descriptor source for the MCP
> dispatch funnel, so a contract without one is not dispatchable through it.

Nothing in the Quickstart or the Walkthrough says a descriptor is required, and no
step fails visibly when it is missing. A deployment that skipped it looks
completely successful.

**Workaround used.** `deploy` now publishes a descriptor on every run
(`src/contract/descriptor.ts`), and `docs/ARCHITECTURE.md` records why.

### 3. The descriptor schema is undocumented; the validator is the only specification

`setDescriptor` rejects a malformed document — with genuinely good, specific
errors. That is how the schema was recovered, one error at a time:

```
function `contract-info` field `auth` must be an object
function `contract-info` field `params_schema` must be an object
function `contract-info` field `returns` must be an object     ← not `returns_schema`
function `contract-info` field `summary` must be a non-empty string
function `contract-info` field `errors` must be an array
function `contract-info` field `examples` must be an array
```

All eight fields are required, and two are counter-intuitive: `returns` (the
obvious guess, `returns_schema`, is rejected) and `examples`. There is no published
descriptor schema, and `ContractDescriptorDocument` in the SDK types is explicitly
open-ended (`[key: string]: unknown`), so the type tells you nothing either. The
only way to learn the schema is to submit eight wrong documents.

---

## Notable

### 4. A fresh tenant has deny-all egress, and the documented fix does not apply to it

The first `--live` run is refused by the host — correctly, and with a clear reason:

```
provision-identity  denied  httpbin.org  -
  provision-identity: egress denied for host httpbin.org
```

That is the right default. The problem is what comes next. The only egress-granting
API in the SDK is `OrgDataClient.setAgentEgress`, which requires **both** `orgDid`
and `agentDid` and is org-admin only. An individual tenant (`did:t3n:<tid>`, created
through the claim page exactly as instructed) has no org, so there is no documented
path forward.

What worked: a **member-delegation grant bound to the caller's own DID**, carrying
`allowed_hosts`. That is a delegation to yourself, which is not an obvious reading of
the feature and is not suggested anywhere:

```bash
hr-onboard grant --agent did:t3n:<your own did> --hosts httpbin.org
```

### 5. `user-upsert` accepts profile fields that will never resolve as placeholders

Committing a profile containing `email_address` returned an unqualified success:

```json
{ "txHash": "tx:121:221804", "userFound": true }
```

But `email_address` is not a resolvable path (see #6), so the field is accepted and
then silently unusable as a placeholder. Nothing in the write response distinguishes
"stored and resolvable" from "stored, but not something a marker can reference".

The failure surfaces later and elsewhere — as a step failure inside a contract run,
which is the most expensive place to discover a field-name mismatch. A note in the
`UserInputProfile` doc listing which fields are resolvable via `{{profile.*}}`, and
which are stored-only, would remove the whole class of problem. So would rejecting
the unresolvable ones outright.

### 6. The WIT spec calls nested placeholders malformed; they are not, and the email only resolves at a nested path

`host-interfaces-2.1.0` defines `placeholder-denied` as: *"a marker referenced a
namespace other than `profile`, or used a malformed marker (**nested** / non-snake-case
field)"*. Read literally, `profile.verified_contacts.email.value` is malformed.

The official `Terminal-3/z-tenant-flight` uses exactly that, in `src/booking.rs`:

```rust
"email": "{{profile.verified_contacts.email.value}}",
```

**Measured, and the spec comment is wrong.** Both directions were tested against
testnet with the same contract, differing only in the marker:

| Marker | Result |
|---|---|
| `{{profile.email_address}}` | `placeholder-unknown` — *"the calling profile is missing field 'email_address'"* → step fails |
| `{{profile.verified_contacts.email.value}}` | resolves → **HTTP 200**, `status: completed` |

So nested markers are accepted, and the flat `email_address` is not a resolvable
path at all — even though it is a documented Level-1 `UserInputProfile` field and
`user-upsert` accepts it without complaint. That combination is the real trap: the
spec's own wording steers you to flat names, the write API accepts the flat name, and
the failure arrives as *"missing field"* — which reads like absent data, so the
natural next move is to bind the field harder rather than to rename it. I spent
significant time on the wrong problem because of it.

Following the reference implementation is what works. If the spec comment is
authoritative, then Terminal 3's own showcase contract is broken and the
implementation should refuse nested markers with `placeholder-denied` instead of
resolving them.

### 7. A contract's numeric id cannot be read back, and map ACLs are keyed on it

Contract-scoped map ACLs are written as `{ only: [contractId] }` — the **numeric**
id assigned at registration. Nothing in the SDK can read that id back afterwards:

- `contracts.list()` returns canonical names only
- `contracts.listDetailed()` returns `name`, `short_name`, `version`, `status`,
  `descriptor` — no id
- `maps` exposes `getStatus` only, so the ACLs themselves cannot be read
- `getActivityLog` entries carry `contract` as the canonical *name*

The id is returned exactly once, by `register`. So any tool that needs to re-point
the ACLs it owns has nowhere to learn the id from, and tenant state is the only
option. This project records it in the `config` map at registration.

The consequence is sharper than it first looks: `hr-onboard init` re-applies every
map ACL from scratch, so a second `init` on a tenant that already had a contract
deployed resolved both contract-scoped ACLs to `{ only: [] }` — deny-all — silently
revoking the deployed contract's access to its own `secrets` and `onboarding-log`
maps. Not a hypothetical: it is one re-run of a documented command away, and the
contract keeps registering as `active` the whole time. Fixed here by reading the
recorded id and falling back to deny-all only when there is none.

### 8. Contract logs are off by default, which removes the only debugging signal

`contracts.logs()` reads a ring buffer gated on the tenant's `log_max_entries`
quota, which is **zero by default** — so it returns `{entries: []}` whether the
contract logged nothing or never ran at all. During #1 that was indistinguishable
from a contract that was never invoked, on the one failure where a log line would
have shortened the diagnosis from hours to minutes.

---

## Minor

| # | What happened | Workaround used |
|---|---|---|
| 9 | `docs.terminal3.io` returned **403** to fetch after the first few requests — including `llms.txt` and the `.md` pages the docs tell AI assistants to read | Read the SDK's bundled `README.md` and `dist/index.d.ts` from `node_modules` instead |
| 10 | The `wasm32-wasip2` target is not mentioned on the setup page and is not installed by default; the build fails with `can't find crate for core` | Found it in the `z-tenant-flight` README |
| 11 | The Payroll Agent page in `llms.txt` renders empty | Used `Terminal-3/z-tenant-flight` as the reference |
| 12 | The OpenAPI spec URLs in `llms.txt` don't resolve | Reconstructed the surface from the `.d.ts` |
| 13 | The SDK README documents two environments; the package and docs describe three | Set `T3N_ENV=testnet` explicitly |
| 14 | The SDK README's first example passes a `baseUrl` that doesn't resolve | Used the "Ethereum Authentication" example below it |

---

## Not a T3N defect, but worth knowing

`next build` writes `T3N_API_KEY` into **Turbopack's build cache** — 11 files under
`.next/cache/turbopack/*.sst` — because the value is read while Next collects page
data. Measured on this project:

| Location | Files containing the key |
|---|---|
| `.next/static/` (client bundles) | **0** |
| `.next/server/` (server output) | **0** |
| `.next/cache/turbopack/` | 11 |

The property that matters holds: the credential never reaches anything a browser or
a deployed server can serve. But `.next/` is exactly the directory people tar up or
copy to a host, and it is a build cache rather than an output, so its presence in an
archive is easy to miss. `.next/` is gitignored here; `rm -rf .next` before sharing
a checkout.

Nothing about this is Terminal 3's doing — it is a Next.js/Turbopack behaviour. It is
recorded because anyone else building a T3N agent on Next.js will hit it, and because
"is my signing key in the build output?" deserves a measured answer rather than an
assumption.

## If only three are read

**#1** and **#2** are the ones worth fixing first: both make a correct deployment
look broken, both surface as the same content-free `Internal error`, and between
them they accounted for nearly all the time spent on this build. **#3** is the
cheapest to fix — publishing the eight required field names would have made the
descriptor recoverable in one attempt instead of eight.

**#6** is the one that cost the most wall-clock time, because every signal pointed
the wrong way: the spec called the correct marker malformed, the write API accepted
the incorrect one, and the resulting error named a missing *field* rather than a wrong
*name*. Correcting the doc comment is a one-line fix with an outsized effect.
