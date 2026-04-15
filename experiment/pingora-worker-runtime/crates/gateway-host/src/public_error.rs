use std::collections::BTreeMap;
use std::sync::OnceLock;

use serde::Deserialize;
use serde::Serialize;
use worker_abi::WorkerResponse;

use crate::RuntimePoolError;

const PUBLIC_ERROR_CONTRACT_JSON: &str = include_str!("../../../contracts/public-errors.json");

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PublicErrorCategory {
    BadRequest,
    Unauthorized,
    Forbidden,
    NotFound,
    Conflict,
    RateLimited,
    UpstreamTimeout,
    ExecutionTimeout,
    TemporarilyUnavailable,
    ShutdownDraining,
    InternalError,
    NetworkLost,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PublicError {
    pub category: PublicErrorCategory,
    pub code: String,
    pub message: String,
    pub retryable: bool,
    pub status: u16,
}

#[derive(Debug, Clone, Deserialize)]
struct PublicErrorContract {
    pub version: u32,
    pub errors: Vec<PublicErrorSpec>,
}

#[derive(Debug, Clone, Deserialize)]
struct PublicErrorSpec {
    pub code: String,
    pub category: PublicErrorCategory,
    pub status: u16,
    pub retryable: bool,
    pub public: bool,
}

fn public_error_specs() -> &'static BTreeMap<String, PublicErrorSpec> {
    static SPECS: OnceLock<BTreeMap<String, PublicErrorSpec>> = OnceLock::new();

    SPECS.get_or_init(|| {
        let contract: PublicErrorContract = serde_json::from_str(PUBLIC_ERROR_CONTRACT_JSON)
            .expect("public error contract JSON should parse");
        assert_eq!(
            contract.version, 1,
            "public error contract version should match runtime expectation"
        );

        let mut specs = BTreeMap::new();
        for spec in contract.errors {
            assert!(
                spec.public,
                "non-public error specs should not be loaded into the public error contract"
            );
            let previous = specs.insert(spec.code.clone(), spec);
            assert!(
                previous.is_none(),
                "duplicate public error code in contract"
            );
        }
        specs
    })
}

fn public_error_spec(code: &str) -> Option<&'static PublicErrorSpec> {
    public_error_specs().get(code)
}

fn public_error_from_registered_code(code: &str, message: impl Into<String>) -> PublicError {
    let message = message.into();
    let spec = public_error_spec(code)
        .unwrap_or_else(|| panic!("public error code `{code}` must exist in contract"));

    PublicError {
        category: spec.category,
        code: spec.code.clone(),
        message,
        retryable: spec.retryable,
        status: spec.status,
    }
}

fn canonicalize_public_error(error: PublicError) -> PublicError {
    match public_error_spec(&error.code) {
        Some(spec) => PublicError {
            category: spec.category,
            code: spec.code.clone(),
            message: error.message,
            retryable: spec.retryable,
            status: spec.status,
        },
        None => internal_public_error(error.message),
    }
}

pub fn bad_request_public_error(message: impl Into<String>) -> PublicError {
    public_error_from_registered_code("bad_request", message)
}

pub fn internal_public_error(message: impl Into<String>) -> PublicError {
    public_error_from_registered_code("internal_error", message)
}

pub fn shutdown_draining_public_error() -> PublicError {
    public_error_from_registered_code(
        "shutdown_draining",
        "server is draining in-flight requests for shutdown",
    )
}

pub fn public_error_response(error: PublicError) -> WorkerResponse {
    let error = canonicalize_public_error(error);

    WorkerResponse {
        status: error.status,
        headers: [(
            "content-type".to_string(),
            "application/json; charset=utf-8".to_string(),
        )]
        .into_iter()
        .collect(),
        body: Some(
            serde_json::to_string(&error)
                .expect("public error should serialize into a JSON response"),
        ),
    }
}

impl RuntimePoolError {
    pub fn to_public_error(&self) -> PublicError {
        match self {
            RuntimePoolError::Overloaded => {
                public_error_from_registered_code("temporarily_unavailable", self.message())
            }
            RuntimePoolError::TimedOut(_) => {
                public_error_from_registered_code("execution_timeout", self.message())
            }
            RuntimePoolError::Recycling(_) | RuntimePoolError::Unavailable(_) => {
                public_error_from_registered_code("temporarily_unavailable", self.message())
            }
            RuntimePoolError::Worker(_) => {
                public_error_from_registered_code("internal_error", self.message())
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn public_error_contract_contains_core_codes() {
        assert!(public_error_specs().contains_key("bad_request"));
        assert!(public_error_specs().contains_key("execution_timeout"));
        assert!(public_error_specs().contains_key("temporarily_unavailable"));
    }

    #[test]
    fn runtime_pool_errors_map_to_public_error_categories() {
        assert_eq!(
            RuntimePoolError::Overloaded.to_public_error(),
            PublicError {
                category: PublicErrorCategory::TemporarilyUnavailable,
                code: "temporarily_unavailable".to_string(),
                message: "worker runtime pool is overloaded".to_string(),
                retryable: true,
                status: 503,
            }
        );
        assert_eq!(
            RuntimePoolError::TimedOut(100).to_public_error(),
            PublicError {
                category: PublicErrorCategory::ExecutionTimeout,
                code: "execution_timeout".to_string(),
                message: "worker execution timed out after 100ms".to_string(),
                retryable: false,
                status: 504,
            }
        );
    }

    #[test]
    fn serializes_public_error_into_response_body() {
        let response = public_error_response(internal_public_error("boom"));

        assert_eq!(response.status, 500);
        assert_eq!(
            response.headers.get("content-type"),
            Some(&"application/json; charset=utf-8".to_string())
        );
        assert_eq!(
            response.body,
            Some(
                serde_json::json!({
                    "category": "internal_error",
                    "code": "internal_error",
                    "message": "boom",
                    "retryable": false,
                    "status": 500
                })
                .to_string()
            )
        );
    }
}
