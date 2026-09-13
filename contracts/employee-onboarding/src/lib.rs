//! hr-onboard: privacy-preserving employee onboarding inside the TEE.
//!
//! Splits cleanly in two:
//! - `onboarding`: everything the contract does, with the few host calls
//!   isolated behind `#[cfg(target_arch = "wasm32")]` so the pure logic is
//!   unit-testable with a plain `cargo test` on the host.
//! - the `Guest` impl below: the thin WIT boundary the node dispatches to.
//!
//! Why this contract exists: onboarding is the moment an enterprise moves a
//! new hire's most sensitive data (legal name, personal email, national id,
//! home address) between systems. Doing that from application code means that
//! data transits the app, its logs, and its operators. Here the PII is never
//! an argument and never a local variable: the contract emits
//! `{{profile.<field>}}` markers and the host substitutes real values inside
//! the enclave, immediately before the outbound request leaves.
#![warn(clippy::style, missing_debug_implementations)]
#![cfg_attr(not(target_arch = "wasm32"), allow(dead_code))]

extern crate alloc;

/// Semantic version of the compiled contract. Kept in lockstep with
/// `Cargo.toml`; surfaced by `contract-info` so an operator can tell which
/// build is registered without reading the chain.
pub const CONTRACT_VERSION: &str = "0.1.2";

wit_bindgen::generate!({
    world: "hr-onboard",
    path: "wit",
    additional_derives: [
        serde::Deserialize,
        serde::Serialize,
    ],
    generate_all,
});

mod onboarding;

struct Component;

#[cfg(target_arch = "wasm32")]
impl exports::z::hr_onboard::contracts::Guest for Component {
    fn contract_info(
        _req: exports::z::hr_onboard::contracts::GenericInput,
    ) -> Result<alloc::vec::Vec<u8>, alloc::string::String> {
        onboarding::contract_info()
    }

    fn preflight(
        req: exports::z::hr_onboard::contracts::GenericInput,
    ) -> Result<alloc::vec::Vec<u8>, alloc::string::String> {
        onboarding::preflight(&input_bytes(req)?)
    }

    fn start_onboarding(
        req: exports::z::hr_onboard::contracts::GenericInput,
    ) -> Result<alloc::vec::Vec<u8>, alloc::string::String> {
        onboarding::start_onboarding(&input_bytes(req)?)
    }

    fn get_onboarding_status(
        req: exports::z::hr_onboard::contracts::GenericInput,
    ) -> Result<alloc::vec::Vec<u8>, alloc::string::String> {
        onboarding::get_onboarding_status(&input_bytes(req)?)
    }

    fn list_onboardings(
        req: exports::z::hr_onboard::contracts::GenericInput,
    ) -> Result<alloc::vec::Vec<u8>, alloc::string::String> {
        onboarding::list_onboardings(&input_bytes(req)?)
    }
}

/// Every exported function takes the same envelope and every one of them is
/// useless without `input`, so the guard lives in exactly one place.
#[cfg(target_arch = "wasm32")]
fn input_bytes(
    req: exports::z::hr_onboard::contracts::GenericInput,
) -> Result<alloc::vec::Vec<u8>, alloc::string::String> {
    req.input
        .ok_or_else(|| alloc::string::String::from("missing input"))
}

#[cfg(target_arch = "wasm32")]
export!(Component);

#[cfg(test)]
mod tests {
    use super::CONTRACT_VERSION;

    #[test]
    fn contract_version_is_semver() {
        let parts: Vec<&str> = CONTRACT_VERSION.split('.').collect();
        assert_eq!(parts.len(), 3, "CONTRACT_VERSION must be MAJOR.MINOR.PATCH");
        for part in parts {
            assert!(part.parse::<u32>().is_ok(), "each part must be a number");
        }
    }

    #[test]
    fn cargo_version_matches_contract_version() {
        // Guards the one drift that silently breaks `contract-info` consumers.
        let manifest = include_str!("../Cargo.toml");
        let line = manifest
            .lines()
            .find(|l| l.starts_with("version = "))
            .expect("Cargo.toml has a version line");
        assert!(
            line.contains(CONTRACT_VERSION),
            "Cargo.toml version must match CONTRACT_VERSION ({CONTRACT_VERSION}); found: {line}"
        );
    }
}
