use std::collections::BTreeMap;
use std::sync::OnceLock;
use std::time::SystemTime;
use std::time::UNIX_EPOCH;

use serde::Deserialize;
use serde::Serialize;
use url::Url;
use worker_abi::WorkerContext;
use worker_abi::WorkerEnv;
use worker_abi::WorkerRequest;
use worker_abi::WorkerResponse;

use crate::RuntimePoolError;

const PUBLIC_ERROR_CONTRACT_JSON: &str = include_str!("../../../contracts/public-errors.json");

pub(crate) fn public_error_contract_json() -> &'static str {
    PUBLIC_ERROR_CONTRACT_JSON
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ParsedV1Request {
    pub method: String,
    pub url: String,
    pub path: String,
    #[serde(default)]
    pub query: BTreeMap<String, Vec<String>>,
    #[serde(default)]
    pub headers: BTreeMap<String, String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub body_text: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub body_bytes: Option<Vec<u8>>,
    pub protocol_version: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ParsedV1Response {
    pub status: u16,
    #[serde(default)]
    pub headers: BTreeMap<String, String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub body_text: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub body_bytes: Option<Vec<u8>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<CompatPublicError>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct HostExecutionEnvelope {
    pub request_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub trace_id: Option<String>,
    pub received_at_ms: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub deadline_ms: Option<u64>,
    pub shadow_mode: bool,
    pub protocol_version: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CompatEnv {
    pub worker_id: String,
    pub mode: String,
    #[serde(default)]
    pub vars: BTreeMap<String, String>,
    pub compat: CompatMetadata,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CompatContext {
    pub request_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub trace_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub deadline_ms: Option<u64>,
    #[serde(default)]
    pub metadata: BTreeMap<String, String>,
    pub compat: CompatMetadata,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CompatMetadata {
    pub protocol_version: String,
    pub shadow_mode: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CompatPublicErrorCategory {
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
pub struct CompatPublicError {
    pub category: CompatPublicErrorCategory,
    pub code: String,
    pub message: String,
    pub retryable: bool,
    pub status: u16,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CompatInvocationRecord {
    pub request_id: String,
    pub worker_id: String,
    pub mode: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub status: Option<u16>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub public_error_code: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub public_error_category: Option<CompatPublicErrorCategory>,
    pub latency_ms: u64,
    pub timed_out: bool,
    pub shadow_mode: bool,
}

#[derive(Debug, Clone, Deserialize)]
struct PublicErrorContract {
    pub version: u32,
    pub errors: Vec<PublicErrorSpec>,
}

#[derive(Debug, Clone, Deserialize)]
struct PublicErrorSpec {
    pub code: String,
    pub category: CompatPublicErrorCategory,
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

fn public_error_from_registered_code(code: &str, message: impl Into<String>) -> CompatPublicError {
    let message = message.into();
    let spec = public_error_spec(code)
        .unwrap_or_else(|| panic!("public error code `{code}` must exist in contract"));

    CompatPublicError {
        category: spec.category,
        code: spec.code.clone(),
        message,
        retryable: spec.retryable,
        status: spec.status,
    }
}

fn canonicalize_public_error(error: CompatPublicError) -> CompatPublicError {
    match public_error_spec(&error.code) {
        Some(spec) => CompatPublicError {
            category: spec.category,
            code: spec.code.clone(),
            message: error.message,
            retryable: spec.retryable,
            status: spec.status,
        },
        None => internal_public_error(error.message),
    }
}

pub fn bad_request_public_error(message: impl Into<String>) -> CompatPublicError {
    public_error_from_registered_code("bad_request", message)
}

pub fn internal_public_error(message: impl Into<String>) -> CompatPublicError {
    public_error_from_registered_code("internal_error", message)
}

pub fn parse_v1_request(request: &WorkerRequest) -> Result<ParsedV1Request, CompatPublicError> {
    let parsed_url = parse_url(&request.url).map_err(bad_request_public_error)?;

    let mut query = BTreeMap::<String, Vec<String>>::new();
    for (key, value) in parsed_url.query_pairs() {
        query
            .entry(key.into_owned())
            .or_default()
            .push(value.into_owned());
    }

    Ok(ParsedV1Request {
        method: request.method.clone(),
        url: request.url.clone(),
        path: parsed_url.path().to_string(),
        query,
        headers: request.headers.clone(),
        body_text: request.body.clone(),
        body_bytes: None,
        protocol_version: "v1".to_string(),
    })
}

pub fn parse_v1_response(response: &WorkerResponse) -> ParsedV1Response {
    ParsedV1Response {
        status: response.status,
        headers: response.headers.clone(),
        body_text: response.body.clone(),
        body_bytes: None,
        error: None,
    }
}

pub fn parsed_v1_response_to_worker_response(response: ParsedV1Response) -> WorkerResponse {
    if let Some(error) = response.error {
        let mut worker_response = public_error_response(error);
        for (name, value) in response.headers {
            worker_response.headers.entry(name).or_insert(value);
        }
        return worker_response;
    }

    WorkerResponse {
        status: response.status,
        headers: response.headers,
        body: response.body_text.or_else(|| {
            response
                .body_bytes
                .map(|bytes| String::from_utf8_lossy(&bytes).into_owned())
        }),
    }
}

pub fn build_host_execution_envelope(
    request_id: impl Into<String>,
    trace_id: Option<String>,
    received_at_ms: u64,
    deadline_ms: Option<u64>,
    shadow_mode: bool,
) -> HostExecutionEnvelope {
    HostExecutionEnvelope {
        request_id: request_id.into(),
        trace_id,
        received_at_ms,
        deadline_ms,
        shadow_mode,
        protocol_version: "v1".to_string(),
    }
}

pub fn build_host_execution_envelope_from_context(ctx: &WorkerContext) -> HostExecutionEnvelope {
    let received_at_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64;

    build_host_execution_envelope(
        ctx.metadata
            .get("request_id")
            .cloned()
            .unwrap_or_else(|| format!("compat-local-{received_at_ms}")),
        ctx.metadata.get("trace_id").cloned(),
        received_at_ms,
        ctx.metadata
            .get("deadline_ms")
            .and_then(|value| value.parse::<u64>().ok()),
        ctx.metadata
            .get("shadow_mode")
            .is_some_and(|value| parse_bool(value)),
    )
}

pub fn build_compat_env(env: &WorkerEnv, shadow_mode: bool) -> CompatEnv {
    CompatEnv {
        worker_id: env.worker_id.clone(),
        mode: "v2-compat-v1".to_string(),
        vars: env.vars.clone(),
        compat: CompatMetadata {
            protocol_version: "v1".to_string(),
            shadow_mode,
        },
    }
}

pub fn build_compat_context(
    ctx: &WorkerContext,
    envelope: &HostExecutionEnvelope,
) -> CompatContext {
    CompatContext {
        request_id: envelope.request_id.clone(),
        trace_id: envelope.trace_id.clone(),
        deadline_ms: envelope.deadline_ms,
        metadata: ctx.metadata.clone(),
        compat: CompatMetadata {
            protocol_version: envelope.protocol_version.clone(),
            shadow_mode: envelope.shadow_mode,
        },
    }
}

pub fn shutdown_draining_public_error() -> CompatPublicError {
    public_error_from_registered_code(
        "shutdown_draining",
        "server is draining in-flight requests for shutdown",
    )
}

pub fn public_error_response(error: CompatPublicError) -> WorkerResponse {
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
                .expect("compat public error should serialize into a JSON response"),
        ),
    }
}

impl RuntimePoolError {
    pub fn to_compat_public_error(&self) -> CompatPublicError {
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

fn parse_url(raw: &str) -> Result<Url, String> {
    match Url::parse(raw) {
        Ok(url) => Ok(url),
        Err(_) if raw.starts_with('/') => {
            Url::parse(&format!("http://hardess.local{raw}")).map_err(|error| error.to_string())
        }
        Err(error) => Err(format!("invalid v1 request url `{raw}`: {error}")),
    }
}

fn parse_bool(raw: &str) -> bool {
    matches!(
        raw,
        "1" | "true" | "TRUE" | "True" | "yes" | "YES" | "on" | "ON"
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_v1_request_into_canonical_shape() {
        assert!(public_error_specs().contains_key("bad_request"));

        let parsed = parse_v1_request(&WorkerRequest {
            method: "POST".to_string(),
            url: "http://localhost/demo?a=1&a=2&b=3".to_string(),
            headers: [
                ("x-test".to_string(), "7".to_string()),
                ("content-type".to_string(), "text/plain".to_string()),
            ]
            .into_iter()
            .collect(),
            body: Some("hello".to_string()),
        })
        .expect("request should parse");

        assert_eq!(parsed.method, "POST");
        assert_eq!(parsed.path, "/demo");
        assert_eq!(
            parsed.query.get("a"),
            Some(&vec!["1".to_string(), "2".to_string()])
        );
        assert_eq!(parsed.query.get("b"), Some(&vec!["3".to_string()]));
        assert_eq!(parsed.body_text.as_deref(), Some("hello"));
        assert_eq!(parsed.protocol_version, "v1");
    }

    #[test]
    fn supports_path_only_v1_urls() {
        let parsed = parse_v1_request(&WorkerRequest {
            method: "GET".to_string(),
            url: "/hello?x=9".to_string(),
            headers: Default::default(),
            body: None,
        })
        .expect("path-only request should parse");

        assert_eq!(parsed.path, "/hello");
        assert_eq!(parsed.query.get("x"), Some(&vec!["9".to_string()]));
    }

    #[test]
    fn runtime_pool_errors_map_to_public_error_categories() {
        assert_eq!(
            RuntimePoolError::Overloaded.to_compat_public_error(),
            CompatPublicError {
                category: CompatPublicErrorCategory::TemporarilyUnavailable,
                code: "temporarily_unavailable".to_string(),
                message: "worker runtime pool is overloaded".to_string(),
                retryable: true,
                status: 503,
            }
        );
        assert_eq!(
            RuntimePoolError::TimedOut(100).to_compat_public_error(),
            CompatPublicError {
                category: CompatPublicErrorCategory::ExecutionTimeout,
                code: "execution_timeout".to_string(),
                message: "worker execution timed out after 100ms".to_string(),
                retryable: false,
                status: 504,
            }
        );
        assert_eq!(
            RuntimePoolError::Worker("boom".to_string()).to_compat_public_error(),
            CompatPublicError {
                category: CompatPublicErrorCategory::InternalError,
                code: "internal_error".to_string(),
                message: "boom".to_string(),
                retryable: false,
                status: 500,
            }
        );
    }

    #[test]
    fn builds_env_and_context_without_changing_business_shape() {
        let env = build_compat_env(
            &WorkerEnv {
                worker_id: "demo".to_string(),
                vars: [("feature".to_string(), "on".to_string())]
                    .into_iter()
                    .collect(),
            },
            true,
        );
        let envelope = build_host_execution_envelope(
            "req-1",
            Some("trace-7".to_string()),
            123,
            Some(456),
            true,
        );
        let ctx = build_compat_context(
            &WorkerContext {
                metadata: [("tenant".to_string(), "acme".to_string())]
                    .into_iter()
                    .collect(),
            },
            &envelope,
        );

        assert_eq!(env.worker_id, "demo");
        assert_eq!(env.mode, "v2-compat-v1");
        assert!(env.compat.shadow_mode);
        assert_eq!(ctx.request_id, "req-1");
        assert_eq!(ctx.trace_id.as_deref(), Some("trace-7"));
        assert_eq!(ctx.deadline_ms, Some(456));
        assert_eq!(ctx.metadata.get("tenant"), Some(&"acme".to_string()));
        assert_eq!(ctx.compat.protocol_version, "v1");
    }

    #[test]
    fn builds_envelope_from_metadata_when_available() {
        let envelope = build_host_execution_envelope_from_context(&WorkerContext {
            metadata: [
                ("request_id".to_string(), "req-7".to_string()),
                ("trace_id".to_string(), "trace-9".to_string()),
                ("deadline_ms".to_string(), "456".to_string()),
                ("shadow_mode".to_string(), "true".to_string()),
            ]
            .into_iter()
            .collect(),
        });

        assert_eq!(envelope.request_id, "req-7");
        assert_eq!(envelope.trace_id.as_deref(), Some("trace-9"));
        assert_eq!(envelope.deadline_ms, Some(456));
        assert!(envelope.shadow_mode);
        assert_eq!(envelope.protocol_version, "v1");
    }

    #[test]
    fn serializes_public_error_into_response_body() {
        let response = public_error_response(shutdown_draining_public_error());

        assert_eq!(response.status, 503);
        assert_eq!(
            response.headers.get("content-type"),
            Some(&"application/json; charset=utf-8".to_string())
        );
        assert!(response
            .body
            .as_deref()
            .expect("error response should have body")
            .contains("\"code\":\"shutdown_draining\""));
    }

    #[test]
    fn parsed_error_response_normalizes_into_public_error_response() {
        let worker_response = parsed_v1_response_to_worker_response(ParsedV1Response {
            status: 520,
            headers: [("x-request-id".to_string(), "req-9".to_string())]
                .into_iter()
                .collect(),
            body_text: Some("should-be-ignored".to_string()),
            body_bytes: None,
            error: Some(CompatPublicError {
                category: CompatPublicErrorCategory::RateLimited,
                code: "tenant_over_quota".to_string(),
                message: "quota exceeded".to_string(),
                retryable: true,
                status: 429,
            }),
        });

        assert_eq!(worker_response.status, 429);
        assert_eq!(
            worker_response.headers.get("content-type"),
            Some(&"application/json; charset=utf-8".to_string())
        );
        assert_eq!(
            worker_response.headers.get("x-request-id"),
            Some(&"req-9".to_string())
        );
        assert!(worker_response
            .body
            .as_deref()
            .expect("error response should have body")
            .contains("\"code\":\"tenant_over_quota\""));
    }

    #[test]
    fn parsed_success_response_keeps_body_text() {
        let worker_response = parsed_v1_response_to_worker_response(ParsedV1Response {
            status: 204,
            headers: [("x-mode".to_string(), "ok".to_string())]
                .into_iter()
                .collect(),
            body_text: Some("done".to_string()),
            body_bytes: None,
            error: None,
        });

        assert_eq!(worker_response.status, 204);
        assert_eq!(
            worker_response.headers.get("x-mode"),
            Some(&"ok".to_string())
        );
        assert_eq!(worker_response.body.as_deref(), Some("done"));
    }

    #[test]
    fn helper_builders_use_stable_public_error_contract() {
        assert_eq!(
            bad_request_public_error("bad input"),
            CompatPublicError {
                category: CompatPublicErrorCategory::BadRequest,
                code: "bad_request".to_string(),
                message: "bad input".to_string(),
                retryable: false,
                status: 400,
            }
        );
        assert_eq!(
            internal_public_error("boom"),
            CompatPublicError {
                category: CompatPublicErrorCategory::InternalError,
                code: "internal_error".to_string(),
                message: "boom".to_string(),
                retryable: false,
                status: 500,
            }
        );
    }

    #[test]
    fn public_error_contract_contains_core_codes() {
        let specs = public_error_specs();

        assert!(specs.contains_key("bad_request"));
        assert!(specs.contains_key("execution_timeout"));
        assert!(specs.contains_key("temporarily_unavailable"));
        assert!(specs.contains_key("shutdown_draining"));
        assert!(specs.contains_key("internal_error"));
        assert!(specs.contains_key("tenant_over_quota"));
    }

    #[test]
    fn canonicalizes_known_public_error_to_contract_fields() {
        let response = public_error_response(CompatPublicError {
            category: CompatPublicErrorCategory::InternalError,
            code: "tenant_over_quota".to_string(),
            message: "quota exceeded".to_string(),
            retryable: false,
            status: 500,
        });

        assert_eq!(response.status, 429);
        assert!(response
            .body
            .as_deref()
            .expect("response should have body")
            .contains("\"category\":\"rate_limited\""));
    }

    #[test]
    fn unknown_public_error_code_falls_back_to_internal_error() {
        let response = public_error_response(CompatPublicError {
            category: CompatPublicErrorCategory::RateLimited,
            code: "brand_new_code".to_string(),
            message: "mystery".to_string(),
            retryable: true,
            status: 429,
        });

        assert_eq!(response.status, 500);
        let body = response.body.as_deref().expect("response should have body");
        assert!(body.contains("\"code\":\"internal_error\""));
        assert!(body.contains("\"message\":\"mystery\""));
    }
}
