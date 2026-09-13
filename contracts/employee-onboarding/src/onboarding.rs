//! Every behaviour of the hr-onboard contract.
//!
//! Shape of this file:
//!   1. step definitions: the two outbound systems an onboarding touches
//!   2. wire types: request inputs and response outputs
//!   3. pure helpers: host-independent, covered by `cargo test` on the host
//!   4. host calls: `#[cfg(target_arch = "wasm32")]` only
//!   5. entry points: parse/validate, then dispatch to a wasm implementation

// Only the wasm-only HTTP path builds header maps; gating the import keeps a
// native `cargo test` warning-free.
#[cfg(target_arch = "wasm32")]
use alloc::collections::BTreeMap;
use alloc::format;
use alloc::string::{String, ToString};
use alloc::vec::Vec;

use serde::{Deserialize, Serialize};

use crate::CONTRACT_VERSION;

// ===========================================================================
// 1. Tenant maps
// ===========================================================================

/// Operator-owned config: endpoints, per-step headers. Read-only to this
/// contract, written by `hr-onboard init`.
pub const CONFIG_TAIL: &str = "config";
/// Operator-owned API credentials. The contract only ever reads this map; an
/// operator seeds it with `hr-onboard seed`.
pub const SECRETS_TAIL: &str = "secrets";
/// Business-level onboarding records written by this contract. Contains no PII.
pub const LOG_TAIL: &str = "onboarding-log";

/// Log keys are `onboard:<employee_ref>`. `;` is the byte immediately above
/// `:`, so `["onboard:", "onboard;")` is exactly the prefix range and the whole
/// map is enumerable with one bounded range scan, with no index map to keep in
/// sync.
pub const LOG_KEY_PREFIX: &str = "onboard:";
pub const LOG_SCAN_END: &str = "onboard;";

/// Server-side ceiling for a single `print-scan`; also our page cap.
pub const LOG_SCAN_LIMIT: u32 = 100;

// ===========================================================================
// 2. Steps
// ===========================================================================

/// A system an onboarding step talks to, and what it needs to do so.
///
/// Adding a step is a data change here plus a `build_body` arm, not a change
/// to the dispatch logic.
#[derive(Debug)]
pub struct StepSpec {
    /// Stable function-facing name, also what `steps: [...]` in the input
    /// selects and what `preflight` reports back.
    pub name: &'static str,
    pub purpose: &'static str,
    /// `config` map key holding the HTTPS endpoint.
    pub endpoint_key: &'static str,
    /// `config` map key holding a JSON object of extra request headers.
    pub headers_key: &'static str,
    /// `secrets` map key holding the bearer token.
    pub secret_key: &'static str,
    /// Profile fields this step's body references. Every one becomes a
    /// `{{profile.<field>}}` marker; none of them is ever a Rust value.
    pub placeholders: &'static [&'static str],
}

pub const STEPS: &[StepSpec] = &[
    StepSpec {
        name: "provision-identity",
        purpose: "Create the new hire's record in the HRIS so IT can issue a seat.",
        endpoint_key: "identity_endpoint",
        headers_key: "identity_headers",
        secret_key: "hris_api_key",
        placeholders: &[
            FIELD_FIRST_NAME,
            FIELD_LAST_NAME,
            FIELD_EMAIL,
        ],
    },
    StepSpec {
        name: "enroll-payroll",
        purpose: "Enrol the new hire with the payroll provider for the first pay run.",
        endpoint_key: "payroll_endpoint",
        headers_key: "payroll_headers",
        secret_key: "payroll_api_key",
        placeholders: &[
            FIELD_FIRST_NAME,
            FIELD_LAST_NAME,
            FIELD_TAX_ID,
            FIELD_ADDRESS,
            FIELD_COUNTRY,
        ],
    },
];

// The only place profile field names appear. `build_body` renders each as
// `{{profile.<field>}}`; nothing else in this crate names a person.
pub const FIELD_FIRST_NAME: &str = "first_name";
pub const FIELD_LAST_NAME: &str = "last_name";
/// A **nested** path, unlike every other field here, and that is not a typo.
///
/// The email is not on the top-level profile the way `first_name` is: the host
/// keeps it under the verified-contacts structure, so the resolvable marker is
/// `{{profile.verified_contacts.email.value}}`. The flat `email_address` is a
/// valid *input* field for `user-upsert` and is even listed in the documented
/// Level-1 set, but it is not a resolvable path, and referencing it yields
/// `placeholder-unknown` ("the calling profile is missing field"), which reads
/// like a data problem rather than a wrong field name.
///
/// Evidence that this is the right path rather than a guess: Terminal 3's own
/// reference contract does exactly this in `z-tenant-flight/src/booking.rs`
/// (`"email": "{{profile.verified_contacts.email.value}}"`) while using flat
/// names for every other field. See `docs/BUGS.md` #6.
///
/// Note this also contradicts a doc comment in `host-interfaces-2.1.0`, which
/// calls a nested marker "malformed". It is not: nested resolves, flat
/// `email_address` does not.
pub const FIELD_EMAIL: &str = "verified_contacts.email.value";
pub const FIELD_TAX_ID: &str = "ssn";
pub const FIELD_ADDRESS: &str = "address";
pub const FIELD_COUNTRY: &str = "country_of_residence";

// ===========================================================================
// 3. Wire types
// ===========================================================================

#[derive(Debug, Default, Deserialize)]
pub struct StepsInput {
    #[serde(default)]
    pub steps: Option<Vec<String>>,
}

#[derive(Debug, Deserialize)]
pub struct StartInput {
    /// HR-internal identifier (e.g. `emp-2041`). Deliberately not a name, an
    /// email, or a national id.
    pub employee_ref: String,
    pub role: String,
    pub department: String,
    /// `YYYY-MM-DD`.
    pub start_date: String,
    #[serde(default)]
    pub currency: Option<String>,
    /// Defaults to **true**: a call with no `dry_run` sends nothing and writes
    /// nothing.
    #[serde(default)]
    pub dry_run: Option<bool>,
    #[serde(default)]
    pub steps: Option<Vec<String>>,
}

#[derive(Debug, Deserialize)]
pub struct StatusInput {
    pub employee_ref: String,
}

#[derive(Debug, Default, Deserialize)]
pub struct ListInput {
    #[serde(default)]
    pub status: Option<String>,
    #[serde(default)]
    pub limit: Option<u32>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct StepResult {
    pub name: String,
    /// `planned` | `ok` | `failed` | `denied`.
    pub status: String,
    pub host: String,
    pub http_status: Option<u16>,
    /// The exact bytes sent, with `{{profile.*}}` markers intact. Present on a
    /// dry run: that is the evidence no PII entered the contract.
    pub request_body: Option<String>,
    /// Operator-facing explanation. Never contains an upstream response body,
    /// which could echo PII back.
    pub detail: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct OnboardingRecord {
    pub employee_ref: String,
    pub role: String,
    pub department: String,
    pub start_date: String,
    /// `planned` | `completed` | `partial` | `failed`.
    pub status: String,
    pub dry_run: bool,
    pub steps: Vec<StepResult>,
    pub contract_version: String,
    pub recorded_at_secs: u64,
    /// Always `false`. Present so a reader can assert on it rather than trust
    /// a README.
    pub contains_pii: bool,
}

#[derive(Debug, Serialize)]
pub struct StatusResponse {
    pub found: bool,
    pub record: Option<OnboardingRecord>,
}

#[derive(Debug, Serialize)]
pub struct ListResponse {
    pub count: u32,
    pub truncated: bool,
    pub records: Vec<OnboardingRecord>,
}

#[derive(Debug, Serialize)]
pub struct StepPreflight {
    pub name: String,
    pub host: String,
    pub endpoint_configured: bool,
    /// Whether a credential is present for this step. Reported, not required.
    pub secret_present: bool,
    /// Always `null` in this build, and `null` means "not knowable before
    /// dispatch" rather than "denied". The egress allow-list is enforced by the
    /// host at dispatch time and no import exposes it to a guest on demand.
    /// The obvious candidate, `authorisation.check-authorized`, is declared in
    /// the WIT package but is not provided to a tenant contract at runtime;
    /// importing it makes the component un-instantiable, so it cannot be used.
    pub egress_authorised: Option<bool>,
    /// Why egress authorisation is not reported here, or the denial reason
    /// observed during a run.
    pub egress_note: Option<String>,
    pub placeholders: Vec<String>,
}

#[derive(Debug, Serialize)]
pub struct PreflightReport {
    pub contract_version: String,
    /// `true` when every step has an endpoint configured. Egress authorisation
    /// deliberately cannot contribute: the host decides it at dispatch, so
    /// `ready: true` means "configured", never "will be allowed".
    pub ready: bool,
    /// One line naming where egress policy is actually enforced, so an operator
    /// does not read `ready: true` as a guarantee that the call will be sent.
    pub egress_enforcement: String,
    pub steps: Vec<StepPreflight>,
    pub missing_config: Vec<String>,
    pub missing_secrets: Vec<String>,
    pub required_profile_fields: Vec<String>,
}

/// Why a step could not be sent.
///
/// `Denied` and `Failed` are kept distinct because the operator response is
/// different: one is a policy decision to be resolved with a grant, the other is
/// a bug or an outage. Collapsing them would hide which one happened.
#[derive(Debug)]
pub enum StepError {
    Denied(String),
    Failed(String),
}

#[derive(Debug, Serialize)]
pub struct FunctionInfo {
    pub name: &'static str,
    pub purpose: &'static str,
}

#[derive(Debug, Serialize)]
pub struct ContractInfo {
    pub contract: &'static str,
    pub contract_version: &'static str,
    pub functions: Vec<FunctionInfo>,
    pub steps: Vec<StepSpec>,
    pub config_keys: Vec<String>,
    pub secret_keys: Vec<String>,
    pub profile_fields: Vec<String>,
    pub maps: [&'static str; 3],
    pub default_dry_run: bool,
}

/// `StepSpec` serialises as the contract's own documentation, so `contract-info`
/// and `preflight` cannot drift from the code that runs.
impl Serialize for StepSpec {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        use serde::ser::SerializeStruct;
        let mut st = s.serialize_struct("StepSpec", 3)?;
        st.serialize_field("name", self.name)?;
        st.serialize_field("purpose", self.purpose)?;
        st.serialize_field("placeholders", self.placeholders)?;
        st.end()
    }
}

/// The exported function names, in one list so `contract-info`, the README and
/// the CLI all read from the same source.
pub const FUNCTIONS: &[FunctionInfo] = &[
    FunctionInfo {
        name: "contract-info",
        purpose: "Describe this contract: version, functions, required config and secrets, profile fields.",
    },
    FunctionInfo {
        name: "preflight",
        purpose: "Report, per step, whether an endpoint and credential are configured, plus everything still missing. Makes no outbound call and cannot report egress authorisation, which is the host's decision at dispatch.",
    },
    FunctionInfo {
        name: "start-onboarding",
        purpose: "Run or simulate onboarding for one employee.",
    },
    FunctionInfo {
        name: "get-onboarding-status",
        purpose: "Read the stored onboarding record for one employee.",
    },
    FunctionInfo {
        name: "list-onboardings",
        purpose: "Enumerate stored onboarding records, optionally filtered by status.",
    },
];

// ===========================================================================
// 4. Pure helpers (unit-tested on the host)
// ===========================================================================

/// `"https://api.example.com/v1/hire?x=1"` -> `"api.example.com"`.
///
/// The egress allow-list is keyed on host, so every authorisation decision goes
/// through here. A URL that hides its host behind user-info or a scheme we did
/// not expect yields the full remainder, which then fails authorisation rather
/// than being silently allowed.
pub fn host_of(url: &str) -> String {
    let after_scheme = match url.split_once("://") {
        Some((scheme, rest)) if scheme.eq_ignore_ascii_case("http") || scheme.eq_ignore_ascii_case("https") => rest,
        _ => url,
    };
    after_scheme
        .split(['/', '?', '#'])
        .next()
        .unwrap_or(after_scheme)
        .to_string()
}

/// Resolve `steps: [...]` from the input against the compiled-in list.
/// `None` or `[]` means "every step".
pub fn select_steps(requested: &Option<Vec<String>>) -> Result<Vec<&'static StepSpec>, String> {
    let names = match requested {
        None => return Ok(STEPS.iter().collect()),
        Some(names) if names.is_empty() => return Ok(STEPS.iter().collect()),
        Some(names) => names,
    };

    let mut chosen: Vec<&'static StepSpec> = Vec::new();
    for name in names {
        let spec = STEPS
            .iter()
            .find(|s| s.name == name.as_str())
            .ok_or_else(|| format!("unknown step '{name}'; known steps: {}", known_step_names()))?;
        if chosen.iter().any(|c| c.name == spec.name) {
            return Err(format!("duplicate step '{name}'"));
        }
        chosen.push(spec);
    }
    Ok(chosen)
}

pub fn known_step_names() -> String {
    let mut out = String::new();
    for (i, s) in STEPS.iter().enumerate() {
        if i > 0 {
            out.push_str(", ");
        }
        out.push_str(s.name);
    }
    out
}

/// Union of every referenced profile field, de-duplicated, order-preserving.
pub fn required_profile_fields(steps: &[&StepSpec]) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for step in steps {
        for field in step.placeholders {
            if !out.iter().any(|f| f == field) {
                out.push(field.to_string());
            }
        }
    }
    out
}

pub fn log_key(employee_ref: &str) -> Vec<u8> {
    format!("{LOG_KEY_PREFIX}{employee_ref}").into_bytes()
}

/// Roll per-step outcomes into one record-level status.
pub fn summarise(steps: &[StepResult], dry_run: bool) -> &'static str {
    let ok = steps.iter().filter(|s| s.status == "ok").count();
    let bad = steps
        .iter()
        .filter(|s| s.status == "failed" || s.status == "denied")
        .count();

    if bad == 0 {
        return if dry_run { "planned" } else { "completed" };
    }
    if ok == 0 {
        "failed"
    } else {
        "partial"
    }
}

/// Reject identifiers that would be ambiguous inside a map key: the log key is
/// `onboard:<ref>` and `employee_ref` is embedded in the JSON record too.
pub fn validate_employee_ref(value: &str) -> Result<(), String> {
    if value.is_empty() {
        return Err("employee_ref must not be empty".to_string());
    }
    if value.len() > 64 {
        return Err(format!("employee_ref must be <= 64 chars, got {}", value.len()));
    }
    if !value
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.' | '/'))
    {
        return Err(
            "employee_ref may only contain ASCII letters, digits, '-', '_', '.' and '/'".to_string(),
        );
    }
    // `;` terminates the scan range, and `:` separates the key prefix from the
    // id, and neither may appear inside the id itself.
    if value.contains(':') || value.contains(';') {
        return Err("employee_ref must not contain ':' or ';'".to_string());
    }
    Ok(())
}

pub fn validate_start(input: &StartInput) -> Result<(), String> {
    validate_employee_ref(&input.employee_ref)?;
    for (label, value) in [("role", &input.role), ("department", &input.department)] {
        if value.trim().is_empty() {
            return Err(format!("{label} must not be empty"));
        }
        if value.len() > 128 {
            return Err(format!("{label} must be <= 128 chars"));
        }
    }
    if !is_iso_date(&input.start_date) {
        return Err(format!(
            "start_date must be 'YYYY-MM-DD', got '{}'",
            input.start_date
        ));
    }
    if let Some(currency) = &input.currency {
        if currency.len() != 3 || !currency.chars().all(|c| c.is_ascii_uppercase()) {
            return Err(format!("currency must be a 3-letter ISO code, got '{currency}'"));
        }
    }
    Ok(())
}

fn is_iso_date(value: &str) -> bool {
    let bytes = value.as_bytes();
    if bytes.len() != 10 || bytes[4] != b'-' || bytes[7] != b'-' {
        return false;
    }

    let all_digits = |range: core::ops::Range<usize>| {
        bytes[range].iter().all(|b| b.is_ascii_digit())
    };
    if !all_digits(0..4) || !all_digits(5..7) || !all_digits(8..10) {
        return false;
    }

    // Every byte is ASCII, so these slices sit on char boundaries.
    let month: u8 = value[5..7].parse().unwrap_or(0);
    let day: u8 = value[8..10].parse().unwrap_or(0);
    (1..=12).contains(&month) && (1..=31).contains(&day)
}

/// Build the outbound JSON body for a step.
///
/// Every place a human value belongs holds a `{{profile.<field>}}` marker
/// instead. The host substitutes real values inside the enclave, after this
/// function has returned and after the bytes have left WASM.
pub fn build_body(step_name: &str, input: &StartInput) -> Result<Vec<u8>, String> {
    #[derive(Serialize)]
    struct IdentityBody<'a> {
        external_ref: &'a str,
        given_name: &'a str,
        family_name: &'a str,
        personal_email: &'a str,
        role: &'a str,
        department: &'a str,
        start_date: &'a str,
    }

    #[derive(Serialize)]
    struct PayrollBody<'a> {
        external_ref: &'a str,
        given_name: &'a str,
        family_name: &'a str,
        tax_id: &'a str,
        address: &'a str,
        country: &'a str,
        currency: &'a str,
    }

    let marker = |field: &str| format!("{{{{profile.{field}}}}}");

    match step_name {
        "provision-identity" => to_json(&IdentityBody {
            external_ref: &input.employee_ref,
            given_name: &marker(FIELD_FIRST_NAME),
            family_name: &marker(FIELD_LAST_NAME),
            personal_email: &marker(FIELD_EMAIL),
            role: &input.role,
            department: &input.department,
            start_date: &input.start_date,
        }),
        "enroll-payroll" => to_json(&PayrollBody {
            external_ref: &input.employee_ref,
            given_name: &marker(FIELD_FIRST_NAME),
            family_name: &marker(FIELD_LAST_NAME),
            tax_id: &marker(FIELD_TAX_ID),
            address: &marker(FIELD_ADDRESS),
            country: &marker(FIELD_COUNTRY),
            currency: input.currency.as_deref().unwrap_or("USD"),
        }),
        other => Err(format!("no request template for step '{other}'")),
    }
}

fn to_json<T: Serialize>(value: &T) -> Result<Vec<u8>, String> {
    serde_json::to_vec(value).map_err(|e| format!("serialise response: {e}"))
}

fn parse<T: serde::de::DeserializeOwned>(input: &[u8], fn_name: &str) -> Result<T, String> {
    serde_json::from_slice(input).map_err(|e| format!("{fn_name}: bad input: {e}"))
}

// ===========================================================================
// 5. Entry points
// ===========================================================================

/// Pure: no host calls, so it answers even before `init` has run. That matters
/// because "what do you need from me?" is the first question an operator asks.
pub fn contract_info() -> Result<Vec<u8>, String> {
    let mut config_keys = Vec::new();
    let mut secret_keys = Vec::new();
    for step in STEPS {
        config_keys.push(step.endpoint_key.to_string());
        config_keys.push(step.headers_key.to_string());
        secret_keys.push(step.secret_key.to_string());
    }

    to_json(&ContractInfo {
        contract: "hr-onboard",
        contract_version: CONTRACT_VERSION,
        functions: FUNCTIONS
            .iter()
            .map(|f| FunctionInfo {
                name: f.name,
                purpose: f.purpose,
            })
            .collect(),
        steps: STEPS.iter().map(clone_spec).collect(),
        config_keys,
        secret_keys,
        profile_fields: required_profile_fields(&STEPS.iter().collect::<Vec<_>>()),
        maps: [CONFIG_TAIL, SECRETS_TAIL, LOG_TAIL],
        default_dry_run: true,
    })
}

/// `StepSpec` holds only `Copy` fields, so a split-borrow clone is enough and
/// no `Clone` derive is needed on the constant.
fn clone_spec(spec: &StepSpec) -> StepSpec {
    StepSpec {
        name: spec.name,
        purpose: spec.purpose,
        endpoint_key: spec.endpoint_key,
        headers_key: spec.headers_key,
        secret_key: spec.secret_key,
        placeholders: spec.placeholders,
    }
}

pub fn preflight(input: &[u8]) -> Result<Vec<u8>, String> {
    let req: StepsInput = parse(input, "preflight")?;
    let steps = select_steps(&req.steps)?;

    #[cfg(target_arch = "wasm32")]
    {
        to_json(&preflight_wasm(&steps)?)
    }
    #[cfg(not(target_arch = "wasm32"))]
    {
        let _ = steps;
        Err("preflight reads tenant maps and only runs inside the TEE (wasm32)".to_string())
    }
}

pub fn start_onboarding(input: &[u8]) -> Result<Vec<u8>, String> {
    let req: StartInput = parse(input, "start-onboarding")?;
    validate_start(&req)?;
    let steps = select_steps(&req.steps)?;
    // Safe by default: a caller that forgets `dry_run` gets a plan, not a
    // payroll enrolment.
    let dry_run = req.dry_run.unwrap_or(true);

    #[cfg(target_arch = "wasm32")]
    {
        to_json(&run_onboarding_wasm(&req, &steps, dry_run)?)
    }
    #[cfg(not(target_arch = "wasm32"))]
    {
        let _ = (steps, dry_run);
        Err("start-onboarding only runs inside the TEE (wasm32)".to_string())
    }
}

pub fn get_onboarding_status(input: &[u8]) -> Result<Vec<u8>, String> {
    let req: StatusInput = parse(input, "get-onboarding-status")?;
    validate_employee_ref(&req.employee_ref)?;

    #[cfg(target_arch = "wasm32")]
    {
        let response = match hostcalls::kv_get(LOG_TAIL, &log_key(&req.employee_ref)) {
            Ok(Some(bytes)) => StatusResponse {
                found: true,
                record: Some(read_record(&bytes, &req.employee_ref)?),
            },
            Ok(None) => StatusResponse {
                found: false,
                record: None,
            },
            Err(e) => return Err(map_read_error(e)),
        };
        to_json(&response)
    }
    #[cfg(not(target_arch = "wasm32"))]
    {
        let _ = req;
        Err("get-onboarding-status only runs inside the TEE (wasm32)".to_string())
    }
}

pub fn list_onboardings(input: &[u8]) -> Result<Vec<u8>, String> {
    let req: ListInput = parse(input, "list-onboardings")?;
    let limit = req.limit.unwrap_or(50).clamp(1, LOG_SCAN_LIMIT);

    #[cfg(target_arch = "wasm32")]
    {
        let pairs = hostcalls::kv_scan(
            LOG_TAIL,
            LOG_KEY_PREFIX.as_bytes(),
            LOG_SCAN_END.as_bytes(),
            limit,
        )
        .map_err(map_read_error)?;

        let scanned = pairs.len();
        let mut records = Vec::new();
        for (_, value) in pairs {
            // A record that cannot be decoded is skipped rather than failing the
            // whole page: one bad row must not hide the other 99.
            if let Ok(record) = serde_json::from_slice::<OnboardingRecord>(&value) {
                if let Some(wanted) = &req.status {
                    if &record.status != wanted {
                        continue;
                    }
                }
                records.push(record);
            }
        }

        to_json(&ListResponse {
            count: records.len() as u32,
            truncated: scanned >= limit as usize,
            records,
        })
    }
    #[cfg(not(target_arch = "wasm32"))]
    {
        let _ = (req, limit);
        Err("list-onboardings only runs inside the TEE (wasm32)".to_string())
    }
}

fn map_read_error(error: String) -> String {
    format!(
        "could not read map '{LOG_TAIL}' ({error}). Run `hr-onboard init` to create the tenant maps"
    )
}

fn read_record(bytes: &[u8], employee_ref: &str) -> Result<OnboardingRecord, String> {
    serde_json::from_slice(bytes)
        .map_err(|e| format!("stored record for '{employee_ref}' is unreadable: {e}"))
}

// ===========================================================================
// 6. Host calls, compiled only for the TEE target
// ===========================================================================

#[cfg(target_arch = "wasm32")]
mod hostcalls {
    use super::*;
    use crate::host::interfaces::{http_with_placeholders as hwp, kv_store, logging};
    use crate::host::tenant::tenant_context;

    /// `z:<tenant-tid>:<tail>`. The tenant DID comes from the dispatcher, never
    /// from the caller, so a contract cannot be pointed at another tenant's maps.
    fn map_name(tail: &str) -> String {
        format!("z:{}:{tail}", hex::encode(tenant_context::tenant_did()))
    }

    pub fn now_secs() -> u64 {
        tenant_context::cluster_timestamp_secs()
    }

    pub fn kv_get(tail: &str, key: &[u8]) -> Result<Option<Vec<u8>>, String> {
        kv_store::get(&map_name(tail), key)
    }

    pub fn kv_put(tail: &str, key: &[u8], value: &[u8]) -> Result<(), String> {
        kv_store::put(&map_name(tail), key, value)
    }

    pub fn kv_scan(
        tail: &str,
        start: &[u8],
        end: &[u8],
        limit: u32,
    ) -> Result<Vec<(Vec<u8>, Vec<u8>)>, String> {
        kv_store::scan(&map_name(tail), start, end, limit)
    }

    pub fn log_info(message: &str) {
        let _ = logging::info(message);
    }

    pub fn log_error(message: &str) {
        let _ = logging::error(message);
    }

    // There is deliberately no `authorise` helper here. The host is the only
    // authority on egress policy, and the only place it tells us is the dispatch
    // error itself; see `describe_http_error`.

    /// POST JSON with host-side placeholder resolution.
    ///
    /// `Content-Type` is deliberately not set: the host attaches it, and sending
    /// our own produces a duplicate the upstream rejects.
    pub fn post_json(
        url: &str,
        headers: &BTreeMap<String, String>,
        body: &[u8],
    ) -> Result<(u16, Vec<u8>), StepError> {
        let wire_headers: Vec<(String, String)> = headers
            .iter()
            .map(|(k, v)| (k.clone(), v.clone()))
            .collect();

        let response = hwp::call(&hwp::Request {
            method: hwp::Verb::Post,
            url: url.to_string(),
            headers: Some(wire_headers),
            payload: Some(body.to_vec()),
        })
        .map_err(describe_http_error)?;

        Ok((response.code, response.payload))
    }

    /// Never includes resolved PII, only field names and host-side reasons.
    ///
    /// `EgressDenied` becomes `StepError::Denied` so a refusal caused by policy
    /// reads differently from a refusal caused by a fault.
    fn describe_http_error(error: hwp::HttpError) -> StepError {
        match error {
            hwp::HttpError::EgressDenied(host) => {
                StepError::Denied(format!("egress denied for host {host}"))
            }
            hwp::HttpError::PlaceholderDenied(marker) => {
                StepError::Failed(format!("placeholder not permitted: {marker}"))
            }
            hwp::HttpError::PlaceholderUnknown(field) => {
                StepError::Failed(format!("the calling profile is missing field '{field}'"))
            }
            hwp::HttpError::PlaceholderNoUserContext => StepError::Failed(
                "no user profile is bound to this call, so placeholders cannot be resolved"
                    .to_string(),
            ),
            hwp::HttpError::UpstreamError(reason) => {
                StepError::Failed(format!("upstream error: {reason}"))
            }
        }
    }
}

// ===========================================================================
// 7. Wasm-only business flows
// ===========================================================================

#[cfg(target_arch = "wasm32")]
fn read_config(key: &str) -> Result<Option<String>, String> {
    match hostcalls::kv_get(CONFIG_TAIL, key.as_bytes()) {
        Ok(Some(bytes)) => Ok(Some(String::from_utf8_lossy(&bytes).trim().to_string())),
        Ok(None) => Ok(None),
        Err(e) => Err(format!(
            "could not read '{key}' from map '{CONFIG_TAIL}' ({e}). Run `hr-onboard init` first"
        )),
    }
}

#[cfg(target_arch = "wasm32")]
fn read_headers(step: &StepSpec) -> BTreeMap<String, String> {
    let mut headers: BTreeMap<String, String> = match hostcalls::kv_get(
        CONFIG_TAIL,
        step.headers_key.as_bytes(),
    ) {
        Ok(Some(bytes)) => serde_json::from_slice(&bytes).unwrap_or_default(),
        _ => BTreeMap::new(),
    };

    // The credential never becomes a field on `StepResult` and is never logged.
    if let Ok(Some(secret)) = hostcalls::kv_get(SECRETS_TAIL, step.secret_key.as_bytes()) {
        let token = String::from_utf8_lossy(&secret).trim().to_string();
        if !token.is_empty() {
            headers.insert("Authorization".to_string(), format!("Bearer {token}"));
        }
    }

    headers.insert("Accept".to_string(), "application/json".to_string());
    headers
}

#[cfg(target_arch = "wasm32")]
fn preflight_wasm(steps: &[&'static StepSpec]) -> Result<PreflightReport, String> {
    let mut missing_config: Vec<String> = Vec::new();
    let mut missing_secrets: Vec<String> = Vec::new();
    let mut step_reports: Vec<StepPreflight> = Vec::new();

    for step in steps {
        let endpoint = match read_config(step.endpoint_key)? {
            Some(url) if !url.is_empty() => Some(url),
            _ => {
                missing_config.push(step.endpoint_key.to_string());
                None
            }
        };

        let secret_present = matches!(
            hostcalls::kv_get(SECRETS_TAIL, step.secret_key.as_bytes()),
            Ok(Some(_))
        );
        if !secret_present {
            missing_secrets.push(step.secret_key.to_string());
        }

        let (host, egress_note) = match &endpoint {
            Some(url) => (
                host_of(url),
                Some(
                    "egress policy is applied by the host at dispatch; this contract cannot query it in advance"
                        .to_string(),
                ),
            ),
            None => (
                String::new(),
                Some("no endpoint configured for this step".to_string()),
            ),
        };

        step_reports.push(StepPreflight {
            name: step.name.to_string(),
            host,
            endpoint_configured: endpoint.is_some(),
            secret_present,
            egress_authorised: None,
            egress_note,
            placeholders: step.placeholders.iter().map(|f| f.to_string()).collect(),
        });
    }

    let ready = missing_config.is_empty() && step_reports.iter().all(|s| s.endpoint_configured);
    let required = required_profile_fields(steps);

    Ok(PreflightReport {
        contract_version: CONTRACT_VERSION.to_string(),
        ready,
        egress_enforcement: "host-side per-contract allow-list, evaluated at dispatch; a refused host is reported as status `denied` with an `egress denied for host ...` reason".to_string(),
        steps: step_reports,
        missing_config,
        missing_secrets,
        required_profile_fields: required,
    })
}

#[cfg(target_arch = "wasm32")]
fn run_onboarding_wasm(
    input: &StartInput,
    steps: &[&'static StepSpec],
    dry_run: bool,
) -> Result<OnboardingRecord, String> {
    let mut results: Vec<StepResult> = Vec::with_capacity(steps.len());

    for step in steps {
        let result = match run_step(step, input, dry_run) {
            Ok(result) => result,
            Err(detail) => StepResult {
                name: step.name.to_string(),
                status: "failed".to_string(),
                host: String::new(),
                http_status: None,
                request_body: None,
                detail: Some(detail),
            },
        };
        hostcalls::log_info(&format!(
            "hr-onboard: step {} -> {}",
            result.name, result.status
        ));
        results.push(result);
    }

    let record = OnboardingRecord {
        employee_ref: input.employee_ref.clone(),
        role: input.role.clone(),
        department: input.department.clone(),
        start_date: input.start_date.clone(),
        status: summarise(&results, dry_run).to_string(),
        dry_run,
        steps: results,
        contract_version: CONTRACT_VERSION.to_string(),
        recorded_at_secs: hostcalls::now_secs(),
        contains_pii: false,
    };

    // A dry run must leave no trace, or the next reader cannot tell a plan from
    // a fact.
    if !dry_run {
        hostcalls::kv_put(
            LOG_TAIL,
            &log_key(&input.employee_ref),
            &to_json(&record)?,
        )?;
    }

    Ok(record)
}

#[cfg(target_arch = "wasm32")]
fn run_step(
    step: &'static StepSpec,
    input: &StartInput,
    dry_run: bool,
) -> Result<StepResult, String> {
    let endpoint = match read_config(step.endpoint_key) {
        Ok(Some(url)) if !url.is_empty() => url,
        Ok(_) => {
            return Err(format!(
                "missing config '{}' in map '{CONFIG_TAIL}'; run `hr-onboard init`",
                step.endpoint_key
            ))
        }
        Err(e) => return Err(e),
    };
    let host = host_of(&endpoint);
    let body = build_body(step.name, input)?;
    // Note: there is no placeholder list to pass. `http-with-placeholders` has
    // no such field on its `request` record; the host scans the payload for
    // `{{profile.<field>}}` markers itself. `step.placeholders` is only used to
    // answer `contract-info` about what a caller must supply.

    if dry_run {
        return Ok(StepResult {
            name: step.name.to_string(),
            status: "planned".to_string(),
            host,
            http_status: None,
            request_body: Some(String::from_utf8_lossy(&body).to_string()),
            detail: Some("dry run: request not sent".to_string()),
        });
    }

    let headers = read_headers(step);
    match hostcalls::post_json(&endpoint, &headers, &body) {
        Ok((code, _response)) => {
            let ok = (200..300).contains(&code);
            Ok(StepResult {
                name: step.name.to_string(),
                status: if ok { "ok" } else { "failed" }.to_string(),
                host,
                http_status: Some(code),
                request_body: None,
                // The upstream body is dropped on purpose: it can echo the
                // resolved PII straight back to the caller.
                detail: if ok {
                    None
                } else {
                    Some(format!("upstream returned HTTP {code}"))
                },
            })
        }
        Err(StepError::Denied(reason)) => {
            // A denial can only be discovered by attempting the call: the host
            // holds the allow-list and exposes no way to ask. It is still
            // reported as `denied` rather than `failed`, because the operator's
            // fix is a grant, not a bug hunt.
            hostcalls::log_error(&format!("hr-onboard: step {} denied: {reason}", step.name));
            Ok(StepResult {
                name: step.name.to_string(),
                status: "denied".to_string(),
                host,
                http_status: None,
                request_body: None,
                detail: Some(reason),
            })
        }
        Err(StepError::Failed(reason)) => {
            hostcalls::log_error(&format!("hr-onboard: step {} failed: {reason}", step.name));
            Ok(StepResult {
                name: step.name.to_string(),
                status: "failed".to_string(),
                host,
                http_status: None,
                request_body: None,
                detail: Some(reason),
            })
        }
    }
}

// ===========================================================================
// 8. Tests (host target)
// ===========================================================================

#[cfg(test)]
mod tests {
    use super::*;

    fn start_input() -> StartInput {
        StartInput {
            employee_ref: "emp-2041".to_string(),
            role: "Backend Engineer".to_string(),
            department: "Platform".to_string(),
            start_date: "2026-10-01".to_string(),
            currency: None,
            dry_run: None,
            steps: None,
        }
    }

    #[test]
    fn host_of_strips_scheme_path_and_query() {
        assert_eq!(host_of("https://api.example.com/v1/hire?x=1"), "api.example.com");
        assert_eq!(host_of("http://localhost:8080/hook"), "localhost:8080");
        assert_eq!(host_of("https://api.example.com"), "api.example.com");
        // Not a shape we recognise: returned as-is so authorisation fails loudly
        // rather than matching a host it should not.
        assert_eq!(host_of("api.example.com/v1"), "api.example.com");
    }

    #[test]
    fn host_of_does_not_launder_userinfo() {
        // `evil.com@api.example.com` must not be read as api.example.com.
        let host = host_of("https://evil.com@api.example.com/x");
        assert_ne!(host, "api.example.com");
    }

    #[test]
    fn select_steps_defaults_to_all_and_rejects_unknown() {
        assert_eq!(select_steps(&None).unwrap().len(), STEPS.len());
        assert_eq!(select_steps(&Some(vec![])).unwrap().len(), STEPS.len());

        let one = select_steps(&Some(vec!["enroll-payroll".to_string()])).unwrap();
        assert_eq!(one.len(), 1);
        assert_eq!(one[0].name, "enroll-payroll");

        let err = select_steps(&Some(vec!["nope".to_string()])).unwrap_err();
        assert!(err.contains("unknown step 'nope'"), "got: {err}");
        assert!(err.contains("provision-identity"), "error should list valid steps: {err}");

        // Order is caller-controlled, and duplicates are a mistake, not a no-op.
        let reordered =
            select_steps(&Some(vec!["enroll-payroll".to_string(), "provision-identity".to_string()]))
                .unwrap();
        assert_eq!(reordered[0].name, "enroll-payroll");
        assert!(select_steps(&Some(vec!["preflight".to_string()]))
            .unwrap_err()
            .contains("unknown step"));
    }

    #[test]
    fn required_profile_fields_are_deduped_and_ordered() {
        let all = select_steps(&None).unwrap();
        let fields = required_profile_fields(&all);
        assert_eq!(
            fields,
            vec![
                "first_name",
                "last_name",
                "verified_contacts.email.value",
                "ssn",
                "address",
                "country_of_residence"
            ]
        );
        assert_eq!(fields.len(), 6, "first_name/last_name must not repeat across steps");
    }

    #[test]
    fn validate_employee_ref_rejects_key_hostile_values() {
        assert!(validate_employee_ref("emp-2041").is_ok());
        assert!(validate_employee_ref("emp_2041/v2").is_ok());
        assert!(validate_employee_ref("").is_err());
        assert!(validate_employee_ref("emp:1").is_err(), "':' is the map-key separator");
        assert!(validate_employee_ref("emp;1").is_err(), "';' terminates the scan range");
        assert!(validate_employee_ref(&"x".repeat(65)).is_err());
        assert!(validate_employee_ref("emp 1").is_err(), "no whitespace");
    }

    #[test]
    fn validate_start_checks_shape_not_just_presence() {
        assert!(validate_start(&start_input()).is_ok());

        let mut bad = start_input();
        bad.start_date = "01-10-2026".to_string();
        assert!(validate_start(&bad).unwrap_err().contains("YYYY-MM-DD"));

        let mut bad = start_input();
        bad.start_date = "2026-13-01".to_string();
        assert!(validate_start(&bad).is_err(), "month 13 must be rejected");

        let mut bad = start_input();
        bad.role = "  ".to_string();
        assert!(validate_start(&bad).unwrap_err().contains("role"));

        let mut bad = start_input();
        bad.currency = Some("usd".to_string());
        assert!(validate_start(&bad).unwrap_err().contains("currency"));
    }

    #[test]
    fn is_iso_date_boundaries() {
        assert!(is_iso_date("2026-01-01"));
        assert!(is_iso_date("2026-12-31"));
        assert!(!is_iso_date("2026-00-01"));
        assert!(!is_iso_date("2026-01-00"));
        assert!(!is_iso_date("2026-1-01"));
        assert!(!is_iso_date("20260101"));
        assert!(!is_iso_date(""));
    }

    #[test]
    fn build_body_contains_markers_and_no_identity_values() {
        let input = start_input();

        let identity = String::from_utf8(build_body("provision-identity", &input).unwrap()).unwrap();
        assert!(identity.contains("{{profile.first_name}}"));
        assert!(identity.contains("{{profile.last_name}}"));
        // Nested on purpose; see FIELD_EMAIL.
        assert!(identity.contains("{{profile.verified_contacts.email.value}}"));
        // The only caller-supplied values present are non-PII operational ones.
        assert!(identity.contains("emp-2041"));
        assert!(identity.contains("Backend Engineer"));
        assert!(identity.contains("2026-10-01"));

        let payroll = String::from_utf8(build_body("enroll-payroll", &input).unwrap()).unwrap();
        assert!(payroll.contains("{{profile.ssn}}"));
        assert!(payroll.contains("{{profile.address}}"));
        assert!(payroll.contains("{{profile.country_of_residence}}"));
        assert!(payroll.contains("\"currency\":\"USD\""), "currency defaults to USD");
        assert!(build_body("nope", &input).is_err());
    }

    #[test]
    fn every_step_has_a_body_template() {
        // Guards the one drift that would only surface at dispatch time.
        for step in STEPS {
            assert!(
                build_body(step.name, &start_input()).is_ok(),
                "step '{}' has no request template in build_body",
                step.name
            );
        }
    }

    #[test]
    fn summarise_rolls_up_partial_failures() {
        let result = |status: &str| StepResult {
            name: "s".to_string(),
            status: status.to_string(),
            host: String::new(),
            http_status: None,
            request_body: None,
            detail: None,
        };

        assert_eq!(summarise(&[result("planned")], true), "planned");
        assert_eq!(summarise(&[result("ok")], false), "completed");
        assert_eq!(summarise(&[result("ok"), result("failed")], false), "partial");
        assert_eq!(summarise(&[result("denied"), result("failed")], false), "failed");
        assert_eq!(summarise(&[], false), "completed");
    }

    #[test]
    fn log_key_is_prefix_scannable() {
        assert_eq!(log_key("emp-2041"), b"onboard:emp-2041".to_vec());
        // The scan end must sort strictly after every key the prefix can build.
        let key = log_key("zzzzzzzzzzzzzzzzzzzzzzzz");
        assert!(key.as_slice() < LOG_SCAN_END.as_bytes(), "scan range would miss keys");
    }

    #[test]
    fn contract_info_is_host_free_and_self_consistent() {
        let raw = contract_info().expect("contract-info must work before init");
        let info: serde_json::Value = serde_json::from_slice(&raw).unwrap();

        assert_eq!(info["contract"], "hr-onboard");
        assert_eq!(info["contract_version"], CONTRACT_VERSION);
        assert_eq!(info["default_dry_run"], true);

        let functions: Vec<String> = info["functions"]
            .as_array()
            .unwrap()
            .iter()
            .map(|f| f["name"].as_str().unwrap().to_string())
            .collect();
        for expected in [
            "contract-info",
            "preflight",
            "start-onboarding",
            "get-onboarding-status",
            "list-onboardings",
        ] {
            assert!(functions.contains(&expected.to_string()), "missing {expected}");
        }
        assert_eq!(functions.len(), FUNCTIONS.len());

        // The advertised profile fields must match what the bodies actually use.
        let advertised: Vec<String> = info["profile_fields"]
            .as_array()
            .unwrap()
            .iter()
            .map(|f| f.as_str().unwrap().to_string())
            .collect();
        let actual = required_profile_fields(&STEPS.iter().collect::<Vec<_>>());
        assert_eq!(advertised, actual);
    }

    #[test]
    fn record_roundtrips_without_pii() {
        let record = OnboardingRecord {
            employee_ref: "emp-2041".to_string(),
            role: "Backend Engineer".to_string(),
            department: "Platform".to_string(),
            start_date: "2026-10-01".to_string(),
            status: "planned".to_string(),
            dry_run: true,
            steps: vec![StepResult {
                name: "provision-identity".to_string(),
                status: "planned".to_string(),
                host: "api.example.com".to_string(),
                http_status: None,
                request_body: Some("{\"given_name\":\"{{profile.first_name}}\"}".to_string()),
                detail: None,
            }],
            contract_version: CONTRACT_VERSION.to_string(),
            recorded_at_secs: 1,
            contains_pii: false,
        };

        let encoded = to_json(&record).unwrap();
        let decoded: OnboardingRecord = serde_json::from_slice(&encoded).unwrap();
        assert_eq!(decoded.employee_ref, "emp-2041");
        assert!(!decoded.contains_pii);
        assert_eq!(decoded.steps[0].status, "planned");
    }
}
