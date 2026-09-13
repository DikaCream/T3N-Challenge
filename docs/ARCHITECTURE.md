# Architecture

Why the pieces are shaped the way they are. The README covers *what* runs; this
covers *why*, and where the trust boundaries sit.

## The one design constraint

Everything follows from a single requirement: **the employee's sensitive values
must not exist in the application's process.**

That rules out the obvious architecture (agent calls HRIS directly) and forces a
split:

```
        decides                        acts                        holds the values
┌───────────────────────┐    ┌───────────────────────┐    ┌────────────────────────┐
│ agent (src/agent)     │    │ TEE contract          │    │ host, inside the       │
│                       │    │ (contracts/…)         │    │ enclave                │
│ employee_ref, role,   │───►│ builds bodies with    │───►│ substitutes            │
│ department,           │    │ {{profile.*}} markers │    │ {{profile.*}} and      │
│ start_date            │    │                       │    │ performs the egress    │
│                       │◄───│ status, host, codes   │    │                        │
└───────────────────────┘    └───────────────────────┘    └────────────────────────┘
        never has PII             never has PII               the only place PII exists
```

Each column is a separate trust boundary, and each has a different failure mode.

## Trust boundary 1 — agent → contract

**What crosses:** `employee_ref`, `role`, `department`, `start_date`, `currency`,
`dry_run`, `steps`.

**What cannot cross:** anything about the person. `employee_ref` is an HR-internal
identifier like `emp-2041`; the contract validates it is at most 64 characters of
ASCII letters, digits, `-`, `_`, `.` or `/`, and explicitly rejects `:` and `;`
because those are structural in the map key (`onboard:<ref>`) and the scan range
end.

**Enforcement:** the contract's input types (`StartInput` in
`src/onboarding.rs`) have no field for a name, an email or an account number. This
is the strongest enforcement available at this boundary — not a policy, a type. A
caller wanting to send PII has nowhere to put it.

**Why the planning happens on the agent side:** deciding *which steps to run* is a
judgement call, and a judgement call is exactly what you want a model for. It only
needs non-sensitive context, so the model gets exactly that and nothing more. This
is why `src/agent/planner.ts` can safely be an LLM and still keep the privacy
property.

## Trust boundary 2 — contract → host

This is the boundary that does the work, and it is the one most worth
understanding.

The contract builds its request body as JSON containing literal markers:

```json
{
  "external_ref": "emp-2041",
  "given_name": "{{profile.first_name}}",
  "family_name": "{{profile.last_name}}",
  "tax_id": "{{profile.ssn}}"
}
```

Those bytes are what the contract holds in WASM memory. The contract then calls
`http-with-placeholders`, and the **host** substitutes real values as the request
is built, inside the enclave, after the bytes have left the guest. The contract
sees the response status; it never sees the request as sent, and it never sees the
response body — which matters, because an upstream can echo what it received.

**Consequence worth stating plainly:** the markers in the request body are not a
redaction applied for display. They are the actual payload. A dry run printing
`{{profile.first_name}}` is not hiding anything — that string is genuinely all the
contract ever has.

### Why each step declares its own placeholders

`StepSpec.placeholders` lists the fields a step's body references, and that list
is load-bearing in three places:

1. `contract-info` publishes it, so an operator can see what data a step needs
   *before* running it.
2. `preflight` returns the union, so a caller knows which profile fields must
   exist or the call fails with `placeholder-unknown`.
3. `build_body` produces the markers, and a unit test asserts every declared step
   has a template.

The alternative — discovering missing profile fields from a mid-run
`PlaceholderUnknown` — turns a predictable configuration problem into a partial
failure, half-way through writing an HRIS record.

## Trust boundary 3 — host → upstream

Outbound egress is authorised **per caller**, not per contract: the contract
declaring `http-with-placeholders` in its WIT world grants it the *capability*,
but whether a given call is allowed depends on the calling user's grant,
specifically the `allowed_hosts` list on their delegation edge.

The design intent was for `preflight` to ask `authorisation.check-authorized(host)`
and return the typed refusal (`denied-no-allowlist`, `denied-scope`,
`denied-revoked`) *before* acting, so an agent would never learn it lacks authority
by crossing the boundary it was trying to respect.

**That is not possible, and the reason is the single most important finding of
this build.** `host:interfaces/authorisation@2.1.0` is declared in the host's
`world interfaces`, but importing it makes the component un-instantiable: every
dispatch then fails with a bare `RPC Error: Internal error` and no further detail.
Removing that one import — nothing else changed — makes the same crate dispatch
normally. See [`BUGS.md`](BUGS.md) #1 for the bisection.

So egress authorisation is discovered at dispatch, from
`http-with-placeholders`'s typed `egress-denied` variant, and mapped to
`StepError::Denied`. `StepError` keeps `Denied` separate from `Failed` because the
operator's response differs: one is resolved with a grant, the other with a bug
hunt. `preflight` therefore reports what it can genuinely verify — endpoint,
credential, required profile fields — and sets `egress_authorised: null` with an
explicit note, rather than showing a green tick it cannot justify.

A fresh tenant is deny-all, so the first live run is refused until a grant names
the hosts. For an individual tenant that grant is bound to the caller's own DID:

```bash
hr-onboard grant --agent did:t3n:<your own did> --hosts api.your-hris.example
```

`deploy` also publishes the **contract descriptor**. This is a hard requirement,
not metadata: a registered contract with no descriptor reports `status: active`
and fails every call with that same unactionable error. See [`BUGS.md`](BUGS.md) #2.

## The map access model

Three maps, three different access stories, chosen deliberately rather than
defaulted:

| Map | Readers | Writers | Reasoning |
|---|---|---|---|
| `config` | `all` | `{ only: [] }` | Holds endpoints and header *names* — not secret. Operators need to read it to debug. Only the control plane writes it, so a stray contract cannot retarget a step. |
| `secrets` | `{ only: [contractId] }` | `{ only: [] }` | Upstream credentials. The enclave reads them; nothing else can, **including the process that wrote them**. |
| `onboarding-log` | `all` | `{ only: [contractId] }` | The business record. Written only by the contract so a record cannot be back-dated by whoever holds the tenant key; readable widely because it contains no PII by construction. |

Two consequences of this table are worth calling out:

- **The write path for `secrets` is the control plane, and its readers gate the enclave.**
  That asymmetry is the point: `entrySet` writes a value its own caller cannot
  read back.
- **`onboarding-log` is not a compliance-grade audit.** Readable-and-writable
  checks in this table bound what a contract may do; they do not make the record
  tamper-evident against the tenant owner. The tamper-evident trail is the
  network's own ledger, surfaced by `hr-onboard audit`, where `actor`,
  `on_behalf_of` and `outcome` are host-stamped and a contract cannot forge who
  acted. Both exist because they answer different questions: the map says *what
  the application believes happened*, the ledger says *what the network recorded*.

### Why `deploy` rewrites every ACL

A contract-scoped ACL is keyed on the **numeric contract id**, which is assigned
at registration time and differs on each registration. So deployment order is not
cosmetic:

1. `init` creates the maps. The two contract-scoped ACLs resolve to
   `{ only: [] }` — deny-all — because no contract id exists yet.
2. `deploy` registers the contract, learns its id, and re-points both ACLs at it.
3. `seed` writes credentials into `secrets`, which only the contract can now read.

Run `seed` before `deploy` and the secret is written into a map nobody can read.
This ordering is enforced by documentation and by `deploy` being idempotent — it
re-applies every ACL on each run, so a re-deploy re-points rather than orphaning.

## Why two planners

`src/agent/planner.ts` has a deterministic planner and an optional LLM, behind one
interface, with the deterministic one as the fallback. That is not hedging:

- The LLM's job is narrow — pick steps, assess review risk — on four non-sensitive
  fields. A model that is unavailable should not stop a hire from being onboarded.
- The model's output is untrusted input. `validateSteps` filters it against the
  steps actually compiled into the contract, so a hallucinated step name is dropped
  with a warning instead of becoming a round-trip failure.
- Every plan reports which planner produced it, so a decision is never silently
  attributable to a model.

## Function-by-function rationale

| Function | Why it exists as its own entry point |
|---|---|
| `contract-info` | Pure — no host calls, so it answers *before* `init` has run. "What do you need from me?" is the first question an operator asks, and it should not require a configured tenant to answer. |
| `preflight` | Separates *can I* from *do it*. No side effects, no writes, no outbound calls. It reports configuration, not permission — permission is the host's call at dispatch, and the interface that would expose it is unusable (`BUGS.md` #1). |
| `start-onboarding` | `dry_run` defaults to `true`; the safe path is the default path. |
| `get-onboarding-status` | A dry run leaves no record — so `found: false` after a dry run is correct behaviour, not a bug. The alternative (writing plans into the log) would make the log unable to distinguish a plan from a fact. |
| `list-onboardings` | Keys are `onboard:<ref>`, so the prefix range `["onboard:", "onboard;")` enumerates the map with one bounded scan. A record that fails to decode is skipped rather than failing the page — one bad row must not hide the other 99. |

## Failure modes, and what each looks like

| Failure | Surfaced as | Why it is surfaced that way |
|---|---|---|
| Egress not authorised | `status: denied`, host named, per step | A denial is discovered at dispatch — the host holds the allow-list and no import lets a contract ask first. `Denied` stays distinct from `Failed` because the fix is a grant, not a bug hunt |
| Profile field missing | `placeholder not permitted` / `profile is missing field 'x'` | The host's typed errors are forwarded verbatim; they name the field, never a value |
| Upstream returned 4xx/5xx | `status: failed`, `http_status: N` | The response **body is discarded** — an upstream can echo the PII it received |
| Upstream unreachable | `status: failed`, reason from the host | Same reason; no partial record is written |
| Config key absent | Error naming the key and the `init` command | The most likely first-run failure deserves a fix, not a stack trace |
| Partial success | Record `status: partial` | `summarise` distinguishes all-failed from some-failed, because "the payroll step failed but the seat exists" needs different handling from a total failure |

## What is intentionally *not* built

- **No PII field beyond what the platform documents as resolvable.** The contract
  uses `first_name`, `last_name`, `ssn`, `address` and `country_of_residence` from
  the SDK's `UserInputProfile`, plus the email at its real path,
  **`verified_contacts.email.value`** — nested, and deliberately so. A bank-account
  placeholder would have been more impressive on a slide and would have been
  guesswork: no such field is documented anywhere, and a wrong guess fails at runtime
  inside the enclave.

  An earlier revision of this contract used a flat `{{profile.email_address}}` and
  avoided the nested path, because the WIT spec's own wording calls nested markers
  *malformed*. That was wrong, and it is what kept `provision-identity` failing with
  *"the calling profile is missing field 'email_address'"* — an error that reads like
  absent data rather than a wrong field name. Both directions were tested; see
  [`BUGS.md`](BUGS.md) #6.
- **No web UI.** The task is an enterprise integration, and a CLI is the surface
  that can actually run unattended after the challenge. A UI would have been
  screenshots without a deployment story.
- **No retry or queueing.** A failed step leaves a `partial` record and stops.
  Automatic retries against payroll are exactly the kind of thing that should
  require a human, and pretending otherwise would make the record harder to trust.
