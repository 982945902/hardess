use std::collections::BTreeMap;
use std::collections::VecDeque;
use std::path::PathBuf;
use std::sync::atomic::AtomicU64;
use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::RwLock;
use std::time::Duration;
use std::time::SystemTime;
use std::time::UNIX_EPOCH;

use anyhow::Context;
use async_trait::async_trait;
use gateway_host::bad_request_public_error;
use gateway_host::inspect_worker_project;
use gateway_host::internal_public_error;
use gateway_host::public_error_response;
use gateway_host::shutdown_draining_public_error;
use gateway_host::DrainSnapshot;
use gateway_host::GatewayRequest;
use gateway_host::GatewayResponse;
use gateway_host::GatewayResponseBody;
use gateway_host::IngressRequestBody;
use gateway_host::PublicError;
use gateway_host::RequestBodyCompletionPolicy;
use gateway_host::RequestDrainController;
use gateway_host::RuntimeCompletionMode;
use gateway_host::RuntimePoolError;
use gateway_host::RuntimePoolSnapshot;
use gateway_host::WorkerProjectSnapshot;
use gateway_host::WorkerRuntimePool;
use gateway_host::HARDESS_CLIENT_ADDR_METADATA_KEY;
use gateway_host::HARDESS_HTTP_VERSION_METADATA_KEY;
use gateway_host::HARDESS_REQUEST_BODY_MODE_METADATA_KEY;
use gateway_host::HARDESS_REQUEST_COMPLETION_POLICY_METADATA_KEY;
use gateway_host::HARDESS_REQUEST_TASK_ID_METADATA_KEY;
use http::Response;
use http::StatusCode;
use pingora::apps::HttpPersistentSettings;
use pingora::apps::HttpServerApp;
use pingora::apps::ReusedHttpStream;
use pingora::http::ResponseHeader;
use pingora::listeners::TcpSocketOptions;
use pingora::protocols::http::ServerSession;
use pingora::protocols::TcpKeepalive;
use pingora::server::configuration::Opt as PingoraOpt;
use pingora::server::configuration::ServerConf;
use pingora::server::RunArgs;
use pingora::server::Server;
#[cfg(unix)]
use pingora::server::ShutdownSignal;
#[cfg(unix)]
use pingora::server::ShutdownSignalWatch;
use pingora::services::listening::Service;
use serde::Deserialize;
use serde::Serialize;
#[cfg(unix)]
use tokio::signal::unix;
use worker_abi::WorkerContext;
use worker_abi::WorkerEnv;

struct PingoraCliArgs {
    worker_entry: PathBuf,
    listen: String,
    worker_id: String,
    runtime_threads: usize,
    queue_capacity: usize,
    exec_timeout_ms: u64,
    completion_mode: RuntimeCompletionMode,
    tcp_fastopen_backlog: Option<usize>,
    tcp_keepalive_idle_secs: Option<u64>,
    tcp_keepalive_interval_secs: Option<u64>,
    tcp_keepalive_count: Option<usize>,
    #[cfg(target_os = "linux")]
    tcp_keepalive_user_timeout_ms: Option<u64>,
    tcp_reuseport: Option<bool>,
    shutdown_drain_timeout_ms: u64,
    generation_drain_timeout_ms: u64,
}

impl PingoraCliArgs {
    fn parse() -> anyhow::Result<Self> {
        let mut args = std::env::args().skip(1);
        let worker_entry = args.next().map(PathBuf::from).context(
            "usage: cargo run --bin pingora_ingress -- <path-to-worker> [--listen ADDR] [--worker-id ID]",
        )?;

        let mut parsed = Self {
            worker_entry,
            listen: "127.0.0.1:6190".to_string(),
            worker_id: "pingora-worker".to_string(),
            runtime_threads: 1,
            queue_capacity: 64,
            exec_timeout_ms: 5_000,
            completion_mode: RuntimeCompletionMode::Auto,
            tcp_fastopen_backlog: None,
            tcp_keepalive_idle_secs: None,
            tcp_keepalive_interval_secs: None,
            tcp_keepalive_count: None,
            #[cfg(target_os = "linux")]
            tcp_keepalive_user_timeout_ms: None,
            tcp_reuseport: None,
            shutdown_drain_timeout_ms: 30_000,
            generation_drain_timeout_ms: 30_000,
        };

        while let Some(flag) = args.next() {
            match flag.as_str() {
                "--listen" => {
                    parsed.listen = args.next().context("--listen requires a value")?;
                }
                "--worker-id" => {
                    parsed.worker_id = args.next().context("--worker-id requires a value")?;
                }
                "--runtime-threads" => {
                    parsed.runtime_threads = args
                        .next()
                        .context("--runtime-threads requires a value")?
                        .parse()
                        .context("--runtime-threads must be an integer")?;
                }
                "--queue-capacity" => {
                    parsed.queue_capacity = args
                        .next()
                        .context("--queue-capacity requires a value")?
                        .parse()
                        .context("--queue-capacity must be an integer")?;
                }
                "--exec-timeout-ms" => {
                    parsed.exec_timeout_ms = args
                        .next()
                        .context("--exec-timeout-ms requires a value")?
                        .parse()
                        .context("--exec-timeout-ms must be an integer")?;
                }
                "--completion-mode" => {
                    let value = args.next().context("--completion-mode requires a value")?;
                    parsed.completion_mode = match value.as_str() {
                        "auto" => RuntimeCompletionMode::Auto,
                        "async" => RuntimeCompletionMode::Async,
                        "blocking" => RuntimeCompletionMode::Blocking,
                        _ => {
                            anyhow::bail!("--completion-mode must be one of: auto, async, blocking")
                        }
                    };
                }
                "--shutdown-drain-timeout-ms" => {
                    parsed.shutdown_drain_timeout_ms = args
                        .next()
                        .context("--shutdown-drain-timeout-ms requires a value")?
                        .parse()
                        .context("--shutdown-drain-timeout-ms must be an integer")?;
                }
                "--tcp-fastopen-backlog" => {
                    parsed.tcp_fastopen_backlog = Some(
                        args.next()
                            .context("--tcp-fastopen-backlog requires a value")?
                            .parse()
                            .context("--tcp-fastopen-backlog must be an integer")?,
                    );
                }
                "--tcp-keepalive-idle-secs" => {
                    parsed.tcp_keepalive_idle_secs = Some(
                        args.next()
                            .context("--tcp-keepalive-idle-secs requires a value")?
                            .parse()
                            .context("--tcp-keepalive-idle-secs must be an integer")?,
                    );
                }
                "--tcp-keepalive-interval-secs" => {
                    parsed.tcp_keepalive_interval_secs = Some(
                        args.next()
                            .context("--tcp-keepalive-interval-secs requires a value")?
                            .parse()
                            .context("--tcp-keepalive-interval-secs must be an integer")?,
                    );
                }
                "--tcp-keepalive-count" => {
                    parsed.tcp_keepalive_count = Some(
                        args.next()
                            .context("--tcp-keepalive-count requires a value")?
                            .parse()
                            .context("--tcp-keepalive-count must be an integer")?,
                    );
                }
                #[cfg(target_os = "linux")]
                "--tcp-keepalive-user-timeout-ms" => {
                    parsed.tcp_keepalive_user_timeout_ms = Some(
                        args.next()
                            .context("--tcp-keepalive-user-timeout-ms requires a value")?
                            .parse()
                            .context("--tcp-keepalive-user-timeout-ms must be an integer")?,
                    );
                }
                "--tcp-reuseport" => {
                    parsed.tcp_reuseport = Some(
                        args.next()
                            .context("--tcp-reuseport requires a value")?
                            .parse()
                            .context("--tcp-reuseport must be true or false")?,
                    );
                }
                "--generation-drain-timeout-ms" => {
                    parsed.generation_drain_timeout_ms = args
                        .next()
                        .context("--generation-drain-timeout-ms requires a value")?
                        .parse()
                        .context("--generation-drain-timeout-ms must be an integer")?;
                }
                other => anyhow::bail!("unknown argument: {other}"),
            }
        }

        Ok(parsed)
    }

    fn tcp_socket_options(&self) -> TcpSocketOptions {
        let tcp_keepalive = match (
            self.tcp_keepalive_idle_secs,
            self.tcp_keepalive_interval_secs,
            self.tcp_keepalive_count,
        ) {
            (Some(idle), Some(interval), Some(count)) => Some(TcpKeepalive {
                idle: Duration::from_secs(idle),
                interval: Duration::from_secs(interval),
                count,
                #[cfg(target_os = "linux")]
                user_timeout: Duration::from_millis(
                    self.tcp_keepalive_user_timeout_ms.unwrap_or(0),
                ),
            }),
            _ => None,
        };

        let mut options = TcpSocketOptions::default();
        options.tcp_fastopen = self.tcp_fastopen_backlog;
        options.tcp_keepalive = tcp_keepalive;
        options.so_reuseport = self.tcp_reuseport;
        options
    }
}

struct WorkerHttpApp {
    runtime_manager: Arc<RuntimeGenerationManager>,
    drain_controller: Arc<RequestDrainController>,
    ingress_metrics: Arc<IngressMetrics>,
    request_tasks: Arc<RequestTaskRegistry>,
    next_request_task_id: AtomicU64,
    worker_id: String,
}

#[derive(Serialize)]
struct IngressSnapshot {
    drain: DrainSnapshot,
    active_request_tasks: ActiveRequestTasksSnapshot,
    recent_request_tasks: RecentRequestTasksSnapshot,
    ingress_metrics: IngressMetricsSnapshot,
    runtime_pool: RuntimePoolSnapshot,
    generations: RuntimeGenerationManagerSnapshot,
}

#[derive(Debug, Clone)]
struct RequestTaskDescriptor {
    request_task_id: u64,
    method: String,
    uri: String,
    client_addr: Option<String>,
    http_version: String,
    request_body_mode: String,
    completion_policy: String,
}

#[derive(Debug, Clone)]
struct ActiveRequestTask {
    descriptor: RequestTaskDescriptor,
    started_at: std::time::Instant,
    phase: RequestTaskPhase,
}

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "snake_case")]
enum RequestTaskPhase {
    RuntimeExecute,
    RequestBodyFinalize,
    ResponseWrite,
    SessionFinish,
}

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "snake_case")]
enum RequestTaskOutcome {
    Succeeded,
    ShutdownDraining,
    BadRequest,
    RuntimeError,
    InternalError,
    ResponseWriteError,
    Dropped,
}

#[derive(Debug, Clone, Serialize)]
struct ActiveRequestTaskSnapshot {
    request_task_id: u64,
    method: String,
    uri: String,
    client_addr: Option<String>,
    http_version: String,
    request_body_mode: String,
    completion_policy: String,
    phase: RequestTaskPhase,
    age_ms: u64,
}

#[derive(Debug, Clone, Serialize)]
struct ActiveRequestTasksSnapshot {
    inflight_count: usize,
    tasks: Vec<ActiveRequestTaskSnapshot>,
}

#[derive(Debug, Clone)]
struct CompletedRequestTask {
    descriptor: RequestTaskDescriptor,
    phase: RequestTaskPhase,
    outcome: RequestTaskOutcome,
    duration_ms: u64,
}

#[derive(Debug, Clone, Serialize)]
struct CompletedRequestTaskSnapshot {
    request_task_id: u64,
    method: String,
    uri: String,
    client_addr: Option<String>,
    http_version: String,
    request_body_mode: String,
    completion_policy: String,
    last_phase: RequestTaskPhase,
    outcome: RequestTaskOutcome,
    duration_ms: u64,
}

#[derive(Debug, Clone, Serialize)]
struct RecentRequestTasksSnapshot {
    count: usize,
    tasks: Vec<CompletedRequestTaskSnapshot>,
}

struct RequestTaskRegistry {
    tasks: Mutex<BTreeMap<u64, ActiveRequestTask>>,
    recent: Mutex<VecDeque<CompletedRequestTask>>,
}

impl RequestTaskRegistry {
    const MAX_RECENT_TASKS: usize = 32;

    fn new() -> Self {
        Self {
            tasks: Mutex::new(BTreeMap::new()),
            recent: Mutex::new(VecDeque::new()),
        }
    }

    fn track(self: &Arc<Self>, descriptor: RequestTaskDescriptor) -> RequestTaskGuard {
        let request_task_id = descriptor.request_task_id;
        self.tasks
            .lock()
            .expect("request task registry mutex should not be poisoned")
            .insert(
                request_task_id,
                ActiveRequestTask {
                    descriptor,
                    started_at: std::time::Instant::now(),
                    phase: RequestTaskPhase::RuntimeExecute,
                },
            );
        RequestTaskGuard {
            registry: Arc::clone(self),
            request_task_id,
            finished: false,
        }
    }

    fn set_phase(&self, request_task_id: u64, phase: RequestTaskPhase) {
        if let Some(task) = self
            .tasks
            .lock()
            .expect("request task registry mutex should not be poisoned")
            .get_mut(&request_task_id)
        {
            task.phase = phase;
        }
    }

    fn finish(&self, request_task_id: u64, outcome: RequestTaskOutcome) {
        let finished = self
            .tasks
            .lock()
            .expect("request task registry mutex should not be poisoned")
            .remove(&request_task_id);
        if let Some(task) = finished {
            let mut recent = self
                .recent
                .lock()
                .expect("recent request task registry mutex should not be poisoned");
            recent.push_front(CompletedRequestTask {
                descriptor: task.descriptor,
                phase: task.phase,
                outcome,
                duration_ms: task.started_at.elapsed().as_millis() as u64,
            });
            while recent.len() > Self::MAX_RECENT_TASKS {
                recent.pop_back();
            }
        }
    }

    fn snapshot(&self) -> ActiveRequestTasksSnapshot {
        let now = std::time::Instant::now();
        let tasks = self
            .tasks
            .lock()
            .expect("request task registry mutex should not be poisoned");
        ActiveRequestTasksSnapshot {
            inflight_count: tasks.len(),
            tasks: tasks
                .values()
                .map(|task| ActiveRequestTaskSnapshot {
                    request_task_id: task.descriptor.request_task_id,
                    method: task.descriptor.method.clone(),
                    uri: task.descriptor.uri.clone(),
                    client_addr: task.descriptor.client_addr.clone(),
                    http_version: task.descriptor.http_version.clone(),
                    request_body_mode: task.descriptor.request_body_mode.clone(),
                    completion_policy: task.descriptor.completion_policy.clone(),
                    phase: task.phase,
                    age_ms: now.saturating_duration_since(task.started_at).as_millis() as u64,
                })
                .collect(),
        }
    }

    fn recent_snapshot(&self) -> RecentRequestTasksSnapshot {
        let recent = self
            .recent
            .lock()
            .expect("recent request task registry mutex should not be poisoned");
        RecentRequestTasksSnapshot {
            count: recent.len(),
            tasks: recent
                .iter()
                .map(|task| CompletedRequestTaskSnapshot {
                    request_task_id: task.descriptor.request_task_id,
                    method: task.descriptor.method.clone(),
                    uri: task.descriptor.uri.clone(),
                    client_addr: task.descriptor.client_addr.clone(),
                    http_version: task.descriptor.http_version.clone(),
                    request_body_mode: task.descriptor.request_body_mode.clone(),
                    completion_policy: task.descriptor.completion_policy.clone(),
                    last_phase: task.phase,
                    outcome: task.outcome,
                    duration_ms: task.duration_ms,
                })
                .collect(),
        }
    }
}

struct RequestTaskGuard {
    registry: Arc<RequestTaskRegistry>,
    request_task_id: u64,
    finished: bool,
}

impl RequestTaskGuard {
    fn set_phase(&self, phase: RequestTaskPhase) {
        self.registry.set_phase(self.request_task_id, phase);
    }

    fn finish(mut self, outcome: RequestTaskOutcome) {
        self.registry.finish(self.request_task_id, outcome);
        self.finished = true;
    }
}

struct HandleRequestResult {
    response: GatewayResponse,
    request_task_guard: Option<RequestTaskGuard>,
    outcome: RequestTaskOutcome,
}

impl Drop for RequestTaskGuard {
    fn drop(&mut self) {
        if !self.finished {
            self.registry
                .finish(self.request_task_id, RequestTaskOutcome::Dropped);
            self.finished = true;
        }
    }
}

struct IngressMetrics {
    requests: AtomicU64,
    total_request_read_nanos: AtomicU64,
    total_request_build_nanos: AtomicU64,
    total_runtime_execute_nanos: AtomicU64,
    total_response_write_nanos: AtomicU64,
    total_finish_nanos: AtomicU64,
    total_request_nanos: AtomicU64,
}

impl IngressMetrics {
    fn new() -> Self {
        Self {
            requests: AtomicU64::new(0),
            total_request_read_nanos: AtomicU64::new(0),
            total_request_build_nanos: AtomicU64::new(0),
            total_runtime_execute_nanos: AtomicU64::new(0),
            total_response_write_nanos: AtomicU64::new(0),
            total_finish_nanos: AtomicU64::new(0),
            total_request_nanos: AtomicU64::new(0),
        }
    }

    fn record_request_read(&self, elapsed: Duration) {
        self.total_request_read_nanos
            .fetch_add(elapsed.as_nanos() as u64, Ordering::Relaxed);
    }

    fn record_request_build(&self, elapsed: Duration) {
        self.total_request_build_nanos
            .fetch_add(elapsed.as_nanos() as u64, Ordering::Relaxed);
    }

    fn record_runtime_execute(&self, elapsed: Duration) {
        self.total_runtime_execute_nanos
            .fetch_add(elapsed.as_nanos() as u64, Ordering::Relaxed);
    }

    fn record_response_write(&self, elapsed: Duration) {
        self.total_response_write_nanos
            .fetch_add(elapsed.as_nanos() as u64, Ordering::Relaxed);
    }

    fn record_finish(&self, elapsed: Duration) {
        self.total_finish_nanos
            .fetch_add(elapsed.as_nanos() as u64, Ordering::Relaxed);
    }

    fn record_request_total(&self, elapsed: Duration) {
        self.requests.fetch_add(1, Ordering::Relaxed);
        self.total_request_nanos
            .fetch_add(elapsed.as_nanos() as u64, Ordering::Relaxed);
    }

    fn snapshot(&self) -> IngressMetricsSnapshot {
        let requests = self.requests.load(Ordering::Relaxed);
        let avg = |total: u64| {
            if requests == 0 {
                0.0
            } else {
                (total as f64 / requests as f64) / 1_000_000.0
            }
        };
        IngressMetricsSnapshot {
            requests,
            average_request_read_ms: avg(self.total_request_read_nanos.load(Ordering::Relaxed)),
            average_request_build_ms: avg(self.total_request_build_nanos.load(Ordering::Relaxed)),
            average_runtime_execute_ms: avg(self
                .total_runtime_execute_nanos
                .load(Ordering::Relaxed)),
            average_response_write_ms: avg(self.total_response_write_nanos.load(Ordering::Relaxed)),
            average_finish_ms: avg(self.total_finish_nanos.load(Ordering::Relaxed)),
            average_request_total_ms: avg(self.total_request_nanos.load(Ordering::Relaxed)),
        }
    }
}

#[derive(Debug, Clone, Serialize)]
struct IngressMetricsSnapshot {
    requests: u64,
    average_request_read_ms: f64,
    average_request_build_ms: f64,
    average_runtime_execute_ms: f64,
    average_response_write_ms: f64,
    average_finish_ms: f64,
    average_request_total_ms: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
struct DesiredWorkerSpec {
    worker_entry: PathBuf,
    #[serde(default)]
    declared_artifact_id: Option<String>,
    #[serde(default)]
    declared_version: Option<String>,
}

impl DesiredWorkerSpec {
    fn local_path(worker_entry: PathBuf) -> Self {
        Self {
            worker_entry,
            declared_artifact_id: None,
            declared_version: None,
        }
    }

    fn worker_entry_display(&self) -> String {
        self.worker_entry.display().to_string()
    }
}

#[derive(Clone)]
struct RuntimeGeneration {
    generation_id: u64,
    desired: DesiredWorkerSpec,
    worker_entry: PathBuf,
    project: WorkerProjectSnapshot,
    runtime_pool: Arc<WorkerRuntimePool>,
    drain_controller: Arc<RequestDrainController>,
}

#[derive(Debug, Clone, Serialize)]
struct RuntimeGenerationSnapshot {
    generation_id: u64,
    active: bool,
    worker_entry: String,
    declared_artifact_id: Option<String>,
    declared_version: Option<String>,
    prepare_status: String,
    project: WorkerProjectSnapshot,
    drain: DrainSnapshot,
    runtime_pool: RuntimePoolSnapshot,
}

#[derive(Debug, Clone, Serialize)]
struct RuntimeGenerationManagerSnapshot {
    active_generation_id: u64,
    version_state: RuntimeVersionStateSnapshot,
    last_prepare: PrepareAttemptSnapshot,
    generations: Vec<RuntimeGenerationSnapshot>,
}

#[derive(Debug, Clone, Serialize)]
struct RuntimeVersionStateSnapshot {
    desired_worker_entry: String,
    desired_generation_id: u64,
    desired_artifact_id: String,
    desired_declared_artifact_id: Option<String>,
    desired_declared_version: Option<String>,
    desired_updated_at_unix_ms: u64,
    prepared_generation_id: Option<u64>,
    prepared_artifact_id: Option<String>,
    prepared_declared_artifact_id: Option<String>,
    prepared_declared_version: Option<String>,
    prepared_at_unix_ms: Option<u64>,
    active_generation_id: u64,
    active_artifact_id: String,
    active_declared_artifact_id: Option<String>,
    active_declared_version: Option<String>,
    active_at_unix_ms: u64,
    failed_generation_id: Option<u64>,
    failed_artifact_id: Option<String>,
    failed_declared_artifact_id: Option<String>,
    failed_declared_version: Option<String>,
    failed_at_unix_ms: Option<u64>,
    failed_error_kind: Option<String>,
    failed_error: Option<String>,
    status: String,
    status_updated_at_unix_ms: u64,
}

#[derive(Debug, Clone, Serialize)]
struct PrepareAttemptSnapshot {
    target_generation_id: u64,
    worker_entry: String,
    artifact_id: Option<String>,
    declared_artifact_id: Option<String>,
    declared_version: Option<String>,
    status: String,
    started_at_unix_ms: u64,
    finished_at_unix_ms: Option<u64>,
    project: Option<WorkerProjectSnapshot>,
    error_kind: Option<String>,
    error: Option<String>,
}

#[derive(Clone)]
struct RuntimeGenerationManagerConfig {
    worker_entry: PathBuf,
    runtime_threads: usize,
    queue_capacity: usize,
    exec_timeout: Duration,
    completion_mode: RuntimeCompletionMode,
    generation_drain_timeout: Duration,
}

struct RuntimeGenerationManager {
    config: RuntimeGenerationManagerConfig,
    active: RwLock<Arc<RuntimeGeneration>>,
    draining: Mutex<Vec<Arc<RuntimeGeneration>>>,
    version_state: Mutex<RuntimeVersionStateSnapshot>,
    last_prepare: Mutex<PrepareAttemptSnapshot>,
    next_generation_id: AtomicU64,
}

impl RuntimeGeneration {
    fn snapshot(&self, active: bool) -> RuntimeGenerationSnapshot {
        RuntimeGenerationSnapshot {
            generation_id: self.generation_id,
            active,
            worker_entry: self.worker_entry.display().to_string(),
            declared_artifact_id: self.desired.declared_artifact_id.clone(),
            declared_version: self.desired.declared_version.clone(),
            prepare_status: "ready".to_string(),
            project: self.project.clone(),
            drain: self.drain_controller.snapshot(),
            runtime_pool: self.runtime_pool.metrics_snapshot(),
        }
    }
}

fn unix_timestamp_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

fn classify_prepare_error(error: &anyhow::Error) -> String {
    let message = error.to_string();
    if message.contains("unable to parse")
        || message.contains("Expected ")
        || message.contains("Expression expected")
        || message.contains("Unsupported module extension")
    {
        return "worker_code_invalid".to_string();
    }
    if message.contains("deno.lock")
        || message.contains("lockfile")
        || message.contains("Integrity check failed")
        || message.contains("Module not found in frozen lockfile")
    {
        return "dependency_validation_failed".to_string();
    }
    if message.contains("unable to read")
        || message.contains("unable to canonicalize")
        || message.contains("does not exist")
    {
        return "artifact_unavailable".to_string();
    }
    if message.contains("Unable to resolve")
        || message.contains("Import resolution")
        || message.contains("Module loading is not supported")
    {
        return "module_resolution_failed".to_string();
    }

    "prepare_failed".to_string()
}

impl RuntimeGenerationManager {
    fn new(config: RuntimeGenerationManagerConfig) -> anyhow::Result<Arc<Self>> {
        let now = unix_timestamp_ms();
        let initial_desired = DesiredWorkerSpec::local_path(config.worker_entry.clone());
        let initial_generation = Arc::new(Self::build_generation(&config, &initial_desired, 1)?);
        let version_state = RuntimeVersionStateSnapshot {
            desired_worker_entry: initial_desired.worker_entry_display(),
            desired_generation_id: 1,
            desired_artifact_id: initial_generation.project.artifact_id.clone(),
            desired_declared_artifact_id: initial_desired.declared_artifact_id.clone(),
            desired_declared_version: initial_desired.declared_version.clone(),
            desired_updated_at_unix_ms: now,
            prepared_generation_id: Some(1),
            prepared_artifact_id: Some(initial_generation.project.artifact_id.clone()),
            prepared_declared_artifact_id: initial_desired.declared_artifact_id.clone(),
            prepared_declared_version: initial_desired.declared_version.clone(),
            prepared_at_unix_ms: Some(now),
            active_generation_id: 1,
            active_artifact_id: initial_generation.project.artifact_id.clone(),
            active_declared_artifact_id: initial_desired.declared_artifact_id.clone(),
            active_declared_version: initial_desired.declared_version.clone(),
            active_at_unix_ms: now,
            failed_generation_id: None,
            failed_artifact_id: None,
            failed_declared_artifact_id: None,
            failed_declared_version: None,
            failed_at_unix_ms: None,
            failed_error_kind: None,
            failed_error: None,
            status: "active".to_string(),
            status_updated_at_unix_ms: now,
        };
        let last_prepare = PrepareAttemptSnapshot {
            target_generation_id: 1,
            worker_entry: initial_desired.worker_entry_display(),
            artifact_id: Some(initial_generation.project.artifact_id.clone()),
            declared_artifact_id: initial_desired.declared_artifact_id.clone(),
            declared_version: initial_desired.declared_version.clone(),
            status: "ready".to_string(),
            started_at_unix_ms: now,
            finished_at_unix_ms: Some(now),
            project: Some(initial_generation.project.clone()),
            error_kind: None,
            error: None,
        };

        Ok(Arc::new(Self {
            config,
            active: RwLock::new(initial_generation),
            draining: Mutex::new(Vec::new()),
            version_state: Mutex::new(version_state),
            last_prepare: Mutex::new(last_prepare),
            next_generation_id: AtomicU64::new(2),
        }))
    }

    async fn execute(
        &self,
        request: GatewayRequest,
        env: WorkerEnv,
        ctx: WorkerContext,
    ) -> Result<GatewayResponse, RuntimePoolError> {
        let mut request = Some(request);
        let mut env = Some(env);
        let mut ctx = Some(ctx);

        for _ in 0..4 {
            let generation = self.active_generation();
            if let Some(_guard) = generation.drain_controller.try_acquire() {
                return generation
                    .runtime_pool
                    .execute_gateway(
                        request.take().expect("request should be available"),
                        env.take().expect("env should be available"),
                        ctx.take().expect("ctx should be available"),
                    )
                    .await;
            }

            tokio::task::yield_now().await;
        }

        Err(RuntimePoolError::Unavailable(
            "no active worker generation accepted the request".to_string(),
        ))
    }

    // Debug-only local apply wrapper used by the experiment's mutable endpoints.
    // Long-term production direction is control-plane-driven desired-version apply.
    async fn apply_configured_worker_debug(
        self: &Arc<Self>,
    ) -> anyhow::Result<RuntimeGenerationManagerSnapshot> {
        self.apply_desired_worker(DesiredWorkerSpec::local_path(
            self.config.worker_entry.clone(),
        ))
        .await
    }

    async fn apply_desired_worker(
        self: &Arc<Self>,
        desired: DesiredWorkerSpec,
    ) -> anyhow::Result<RuntimeGenerationManagerSnapshot> {
        let generation_id = self.next_generation_id.fetch_add(1, Ordering::Relaxed);
        let started_at = unix_timestamp_ms();
        let target_project = inspect_worker_project(&desired.worker_entry).ok();
        let target_artifact_id = target_project
            .as_ref()
            .map(|project| project.artifact_id.clone());
        {
            let preparing = PrepareAttemptSnapshot {
                target_generation_id: generation_id,
                worker_entry: desired.worker_entry_display(),
                artifact_id: target_artifact_id.clone(),
                declared_artifact_id: desired.declared_artifact_id.clone(),
                declared_version: desired.declared_version.clone(),
                status: "preparing".to_string(),
                started_at_unix_ms: started_at,
                finished_at_unix_ms: None,
                project: None,
                error_kind: None,
                error: None,
            };
            *self
                .last_prepare
                .lock()
                .expect("last prepare mutex should not be poisoned") = preparing;
        }
        {
            let mut version_state = self
                .version_state
                .lock()
                .expect("version state mutex should not be poisoned");
            version_state.desired_worker_entry = desired.worker_entry_display();
            version_state.desired_generation_id = generation_id;
            version_state.desired_artifact_id = target_artifact_id
                .clone()
                .unwrap_or_else(|| "unknown".to_string());
            version_state.desired_declared_artifact_id = desired.declared_artifact_id.clone();
            version_state.desired_declared_version = desired.declared_version.clone();
            version_state.desired_updated_at_unix_ms = started_at;
            version_state.status = "preparing".to_string();
            version_state.status_updated_at_unix_ms = started_at;
            version_state.failed_generation_id = None;
            version_state.failed_artifact_id = None;
            version_state.failed_declared_artifact_id = None;
            version_state.failed_declared_version = None;
            version_state.failed_at_unix_ms = None;
            version_state.failed_error_kind = None;
            version_state.failed_error = None;
        }
        let next_generation = match Self::build_generation(&self.config, &desired, generation_id) {
            Ok(generation) => {
                let prepared_at = unix_timestamp_ms();
                {
                    let mut version_state = self
                        .version_state
                        .lock()
                        .expect("version state mutex should not be poisoned");
                    version_state.desired_artifact_id = generation.project.artifact_id.clone();
                    version_state.prepared_generation_id = Some(generation_id);
                    version_state.prepared_artifact_id =
                        Some(generation.project.artifact_id.clone());
                    version_state.prepared_declared_artifact_id =
                        desired.declared_artifact_id.clone();
                    version_state.prepared_declared_version = desired.declared_version.clone();
                    version_state.prepared_at_unix_ms = Some(prepared_at);
                    version_state.status = "prepared".to_string();
                    version_state.status_updated_at_unix_ms = prepared_at;
                }
                let prepare = PrepareAttemptSnapshot {
                    target_generation_id: generation_id,
                    worker_entry: desired.worker_entry_display(),
                    artifact_id: Some(generation.project.artifact_id.clone()),
                    declared_artifact_id: desired.declared_artifact_id.clone(),
                    declared_version: desired.declared_version.clone(),
                    status: "ready".to_string(),
                    started_at_unix_ms: started_at,
                    finished_at_unix_ms: Some(prepared_at),
                    project: Some(generation.project.clone()),
                    error_kind: None,
                    error: None,
                };
                *self
                    .last_prepare
                    .lock()
                    .expect("last prepare mutex should not be poisoned") = prepare;
                Arc::new(generation)
            }
            Err(error) => {
                let failed_at = unix_timestamp_ms();
                let error_kind = classify_prepare_error(&error);
                let failed_project =
                    target_project.or_else(|| inspect_worker_project(&desired.worker_entry).ok());
                let failed_artifact_id = failed_project
                    .as_ref()
                    .map(|project| project.artifact_id.clone());
                {
                    let mut version_state = self
                        .version_state
                        .lock()
                        .expect("version state mutex should not be poisoned");
                    version_state.desired_artifact_id = failed_artifact_id
                        .clone()
                        .unwrap_or_else(|| "unknown".to_string());
                    version_state.failed_generation_id = Some(generation_id);
                    version_state.failed_artifact_id = failed_artifact_id.clone();
                    version_state.failed_declared_artifact_id =
                        desired.declared_artifact_id.clone();
                    version_state.failed_declared_version = desired.declared_version.clone();
                    version_state.failed_at_unix_ms = Some(failed_at);
                    version_state.failed_error_kind = Some(error_kind.clone());
                    version_state.failed_error = Some(error.to_string());
                    version_state.status = "failed".to_string();
                    version_state.status_updated_at_unix_ms = failed_at;
                }
                let prepare = PrepareAttemptSnapshot {
                    target_generation_id: generation_id,
                    worker_entry: desired.worker_entry_display(),
                    artifact_id: failed_artifact_id,
                    declared_artifact_id: desired.declared_artifact_id.clone(),
                    declared_version: desired.declared_version.clone(),
                    status: "failed".to_string(),
                    started_at_unix_ms: started_at,
                    finished_at_unix_ms: Some(failed_at),
                    project: failed_project,
                    error_kind: Some(error_kind),
                    error: Some(error.to_string()),
                };
                *self
                    .last_prepare
                    .lock()
                    .expect("last prepare mutex should not be poisoned") = prepare;
                return Err(error);
            }
        };
        let next_artifact_id = next_generation.project.artifact_id.clone();

        let previous_generation = {
            let mut active = self
                .active
                .write()
                .expect("active generation rwlock should not be poisoned");
            let previous = active.clone();
            *active = next_generation;
            previous
        };
        {
            let active_at = unix_timestamp_ms();
            let mut version_state = self
                .version_state
                .lock()
                .expect("version state mutex should not be poisoned");
            version_state.active_generation_id = generation_id;
            version_state.active_artifact_id = next_artifact_id;
            version_state.active_declared_artifact_id = desired.declared_artifact_id.clone();
            version_state.active_declared_version = desired.declared_version.clone();
            version_state.active_at_unix_ms = active_at;
            version_state.status = "active".to_string();
            version_state.status_updated_at_unix_ms = active_at;
        }

        previous_generation.drain_controller.start_draining();
        self.draining
            .lock()
            .expect("generation drain mutex should not be poisoned")
            .push(previous_generation.clone());

        let manager = Arc::clone(self);
        tokio::spawn(async move {
            let drained = previous_generation
                .drain_controller
                .wait_for_drain(manager.config.generation_drain_timeout)
                .await;
            println!(
                "worker generation {} drain {} after reload",
                previous_generation.generation_id,
                if drained { "completed" } else { "timed out" }
            );
            manager
                .draining
                .lock()
                .expect("generation drain mutex should not be poisoned")
                .retain(|generation| generation.generation_id != previous_generation.generation_id);
        });

        Ok(self.snapshot())
    }

    fn snapshot(&self) -> RuntimeGenerationManagerSnapshot {
        let active = self.active_generation();
        let active_generation_id = active.generation_id;
        let version_state = self
            .version_state
            .lock()
            .expect("version state mutex should not be poisoned")
            .clone();
        let last_prepare = self
            .last_prepare
            .lock()
            .expect("last prepare mutex should not be poisoned")
            .clone();
        let mut generations = vec![active.snapshot(true)];
        generations.extend(
            self.draining
                .lock()
                .expect("generation drain mutex should not be poisoned")
                .iter()
                .map(|generation| generation.snapshot(false)),
        );

        RuntimeGenerationManagerSnapshot {
            active_generation_id,
            version_state,
            last_prepare,
            generations,
        }
    }

    fn active_runtime_pool_snapshot(&self) -> RuntimePoolSnapshot {
        self.active_generation().runtime_pool.metrics_snapshot()
    }

    fn active_project_snapshot(&self) -> anyhow::Result<WorkerProjectSnapshot> {
        inspect_worker_project(&self.active_generation().worker_entry)
    }

    fn cleanup_cache(&self) -> anyhow::Result<WorkerProjectSnapshot> {
        self.active_project_snapshot()
    }

    fn active_generation(&self) -> Arc<RuntimeGeneration> {
        self.active
            .read()
            .expect("active generation rwlock should not be poisoned")
            .clone()
    }

    fn build_generation(
        config: &RuntimeGenerationManagerConfig,
        desired: &DesiredWorkerSpec,
        generation_id: u64,
    ) -> anyhow::Result<RuntimeGeneration> {
        let project = inspect_worker_project(&desired.worker_entry)?;
        Ok(RuntimeGeneration {
            generation_id,
            desired: desired.clone(),
            worker_entry: desired.worker_entry.clone(),
            project,
            runtime_pool: WorkerRuntimePool::new(
                desired.worker_entry.clone(),
                config.runtime_threads,
                config.queue_capacity,
                config.exec_timeout,
                config.completion_mode,
            )?,
            drain_controller: Arc::new(RequestDrainController::new()),
        })
    }
}

impl WorkerHttpApp {
    fn metrics_response(&self) -> Response<Vec<u8>> {
        match serde_json::to_vec_pretty(&self.runtime_manager.active_runtime_pool_snapshot()) {
            Ok(body) => Response::builder()
                .status(StatusCode::OK)
                .header(
                    http::header::CONTENT_TYPE,
                    "application/json; charset=utf-8",
                )
                .header(http::header::CONTENT_LENGTH, body.len())
                .body(body)
                .expect("metrics response should build"),
            Err(error) => self.public_error_http_response(internal_public_error(error.to_string())),
        }
    }

    fn module_cache_response(&self) -> Response<Vec<u8>> {
        match self.runtime_manager.active_project_snapshot() {
            Ok(snapshot) => match serde_json::to_vec_pretty(&snapshot) {
                Ok(body) => Response::builder()
                    .status(StatusCode::OK)
                    .header(
                        http::header::CONTENT_TYPE,
                        "application/json; charset=utf-8",
                    )
                    .header(http::header::CONTENT_LENGTH, body.len())
                    .body(body)
                    .expect("module-cache response should build"),
                Err(error) => {
                    self.public_error_http_response(internal_public_error(error.to_string()))
                }
            },
            Err(error) => self.public_error_http_response(internal_public_error(error.to_string())),
        }
    }

    fn cleanup_cache_response(&self) -> Response<Vec<u8>> {
        match self.runtime_manager.cleanup_cache() {
            Ok(snapshot) => match serde_json::to_vec_pretty(&snapshot) {
                Ok(body) => Response::builder()
                    .status(StatusCode::OK)
                    .header(
                        http::header::CONTENT_TYPE,
                        "application/json; charset=utf-8",
                    )
                    .header(http::header::CONTENT_LENGTH, body.len())
                    .body(body)
                    .expect("cleanup-cache response should build"),
                Err(error) => {
                    self.public_error_http_response(internal_public_error(error.to_string()))
                }
            },
            Err(error) => self.public_error_http_response(internal_public_error(error.to_string())),
        }
    }

    fn ingress_state_response(&self) -> Response<Vec<u8>> {
        let snapshot = IngressSnapshot {
            drain: self.drain_controller.snapshot(),
            active_request_tasks: self.request_tasks.snapshot(),
            recent_request_tasks: self.request_tasks.recent_snapshot(),
            ingress_metrics: self.ingress_metrics.snapshot(),
            runtime_pool: self.runtime_manager.active_runtime_pool_snapshot(),
            generations: self.runtime_manager.snapshot(),
        };
        match serde_json::to_vec_pretty(&snapshot) {
            Ok(body) => Response::builder()
                .status(StatusCode::OK)
                .header(
                    http::header::CONTENT_TYPE,
                    "application/json; charset=utf-8",
                )
                .header(http::header::CONTENT_LENGTH, body.len())
                .body(body)
                .expect("ingress state response should build"),
            Err(error) => self.public_error_http_response(internal_public_error(error.to_string())),
        }
    }

    fn generations_response(&self) -> Response<Vec<u8>> {
        match serde_json::to_vec_pretty(&self.runtime_manager.snapshot()) {
            Ok(body) => Response::builder()
                .status(StatusCode::OK)
                .header(
                    http::header::CONTENT_TYPE,
                    "application/json; charset=utf-8",
                )
                .header(http::header::CONTENT_LENGTH, body.len())
                .body(body)
                .expect("generations response should build"),
            Err(error) => self.public_error_http_response(internal_public_error(error.to_string())),
        }
    }

    async fn apply_worker_debug_response(
        &self,
        http_stream: &mut ServerSession,
    ) -> Response<Vec<u8>> {
        let body = match read_full_request_body(http_stream).await {
            Ok(bytes) if bytes.is_empty() => {
                return self.public_error_http_response(bad_request_public_error(
                    "missing JSON body".to_string(),
                ));
            }
            Ok(bytes) => bytes,
            Err(error) => {
                return self
                    .public_error_http_response(bad_request_public_error(error.to_string()));
            }
        };
        let desired: DesiredWorkerSpec = match serde_json::from_slice(&body) {
            Ok(desired) => desired,
            Err(error) => {
                return self.public_error_http_response(bad_request_public_error(format!(
                    "invalid apply-worker JSON: {error}"
                )));
            }
        };

        match self.runtime_manager.apply_desired_worker(desired).await {
            Ok(snapshot) => match serde_json::to_vec_pretty(&snapshot) {
                Ok(body) => Response::builder()
                    .status(StatusCode::OK)
                    .header(
                        http::header::CONTENT_TYPE,
                        "application/json; charset=utf-8",
                    )
                    .header(http::header::CONTENT_LENGTH, body.len())
                    .body(body)
                    .expect("apply-worker response should build"),
                Err(error) => {
                    self.public_error_http_response(internal_public_error(error.to_string()))
                }
            },
            Err(error) => self.public_error_http_response(internal_public_error(error.to_string())),
        }
    }

    async fn build_request(
        &self,
        http_stream: &mut ServerSession,
    ) -> Result<(GatewayRequest, Option<IngressRequestBody>), String> {
        let header = http_stream.req_header();
        let method = header.method.as_str().to_string();
        let uri = header.uri.to_string();
        let mut headers = Vec::with_capacity(header.headers.len());
        let mut host = None::<String>;
        let mut content_length = None::<u64>;
        let mut has_transfer_encoding = false;

        for (name, value) in header.headers.iter() {
            let Ok(value) = value.to_str() else {
                continue;
            };
            let name = name.as_str().to_string();
            let value = value.to_string();

            if name.eq_ignore_ascii_case("host") {
                host = Some(value.clone());
            } else if name.eq_ignore_ascii_case("content-length") {
                content_length = value.trim().parse::<u64>().ok();
            } else if name.eq_ignore_ascii_case("transfer-encoding") {
                has_transfer_encoding = true;
            }

            headers.push((name, value));
        }

        let url = host
            .map(|host| format!("http://{host}{uri}"))
            .unwrap_or(uri);

        if request_body_expected(content_length, has_transfer_encoding) {
            let completion_policy =
                request_body_completion_policy(content_length, has_transfer_encoding);
            let (request, ingress_body) =
                GatewayRequest::streaming_parts(method, url, headers, completion_policy);
            Ok((request, Some(ingress_body)))
        } else {
            Ok((GatewayRequest::buffered_parts(method, url, headers), None))
        }
    }

    fn next_request_task_id(&self) -> u64 {
        self.next_request_task_id.fetch_add(1, Ordering::Relaxed) + 1
    }

    fn build_request_task_descriptor(
        &self,
        request_task_id: u64,
        http_stream: &ServerSession,
        has_ingress_body: bool,
        completion_policy: RequestBodyCompletionPolicy,
    ) -> RequestTaskDescriptor {
        RequestTaskDescriptor {
            request_task_id,
            method: http_stream.req_header().method.as_str().to_string(),
            uri: http_stream.req_header().uri.to_string(),
            client_addr: http_stream.client_addr().map(|addr| addr.to_string()),
            http_version: http_version_label(http_stream.req_header().version).to_string(),
            request_body_mode: request_body_mode_label(has_ingress_body).to_string(),
            completion_policy: completion_policy_label(completion_policy).to_string(),
        }
    }

    fn build_worker_context(&self, descriptor: &RequestTaskDescriptor) -> WorkerContext {
        let mut metadata = BTreeMap::new();
        metadata.insert(
            HARDESS_REQUEST_TASK_ID_METADATA_KEY.to_string(),
            descriptor.request_task_id.to_string(),
        );
        if let Some(client_addr) = descriptor.client_addr.as_ref() {
            metadata.insert(
                HARDESS_CLIENT_ADDR_METADATA_KEY.to_string(),
                client_addr.clone(),
            );
        }
        metadata.insert(
            HARDESS_HTTP_VERSION_METADATA_KEY.to_string(),
            descriptor.http_version.clone(),
        );
        metadata.insert(
            HARDESS_REQUEST_BODY_MODE_METADATA_KEY.to_string(),
            descriptor.request_body_mode.clone(),
        );
        metadata.insert(
            HARDESS_REQUEST_COMPLETION_POLICY_METADATA_KEY.to_string(),
            descriptor.completion_policy.clone(),
        );
        WorkerContext { metadata }
    }

    fn response_from_worker(
        &self,
        worker_response: worker_abi::WorkerResponse,
    ) -> Response<Vec<u8>> {
        let mut builder = Response::builder().status(worker_response.status);
        for (name, value) in worker_response.headers {
            builder = builder.header(name, value);
        }

        let body = worker_response.body.unwrap_or_default().into_bytes();
        builder
            .header(http::header::CONTENT_LENGTH, body.len())
            .body(body)
            .unwrap_or_else(|error| {
                self.fallback_error_response(StatusCode::INTERNAL_SERVER_ERROR, error.to_string())
            })
    }

    fn gateway_response_from_http_response(&self, response: Response<Vec<u8>>) -> GatewayResponse {
        let (parts, body) = response.into_parts();
        let headers = parts
            .headers
            .iter()
            .filter_map(|(name, value)| {
                value
                    .to_str()
                    .ok()
                    .map(|value| (name.as_str().to_string(), value.to_string()))
            })
            .collect();
        GatewayResponse::buffered(parts.status.as_u16(), headers, body)
    }

    fn public_error_http_response(&self, error: PublicError) -> Response<Vec<u8>> {
        self.response_from_worker(public_error_response(error))
    }

    fn public_error_gateway_response(&self, error: PublicError) -> GatewayResponse {
        self.gateway_response_from_http_response(self.public_error_http_response(error))
    }

    fn runtime_pool_error_response(&self, error: RuntimePoolError) -> Response<Vec<u8>> {
        self.public_error_http_response(error.to_public_error())
    }

    fn runtime_pool_gateway_response(&self, error: RuntimePoolError) -> GatewayResponse {
        self.gateway_response_from_http_response(self.runtime_pool_error_response(error))
    }

    fn fallback_error_response(&self, status: StatusCode, message: String) -> Response<Vec<u8>> {
        Response::builder()
            .status(status)
            .header(http::header::CONTENT_TYPE, "text/plain; charset=utf-8")
            .body(message.into_bytes())
            .expect("fallback error response should build")
    }

    fn draining_response(&self) -> Response<Vec<u8>> {
        let mut response = self.public_error_http_response(shutdown_draining_public_error());
        response.headers_mut().insert(
            http::header::CONNECTION,
            http::HeaderValue::from_static("close"),
        );
        response.headers_mut().insert(
            http::header::RETRY_AFTER,
            http::HeaderValue::from_static("1"),
        );
        response
    }

    fn draining_gateway_response(&self) -> GatewayResponse {
        self.gateway_response_from_http_response(self.draining_response())
    }

    async fn write_gateway_response(
        &self,
        http_stream: &mut ServerSession,
        mut response: GatewayResponse,
    ) -> Result<(), String> {
        let header_pairs = response
            .headers()
            .iter()
            .map(|(name, value)| (name.clone(), value.clone()))
            .collect::<Vec<_>>();
        let has_content_length = response.headers().contains_key("content-length");
        let mut response_header = ResponseHeader::build(
            response.status(),
            Some(header_pairs.len().saturating_add(1)),
        )
        .map_err(|error| error.to_string())?;
        for (name, value) in header_pairs {
            response_header
                .insert_header(name, value)
                .map_err(|error| error.to_string())?;
        }

        match response.take_body() {
            GatewayResponseBody::Empty => {
                if !has_content_length {
                    response_header
                        .insert_header(http::header::CONTENT_LENGTH.as_str(), "0")
                        .map_err(|error| error.to_string())?;
                }
                http_stream
                    .write_response_header(Box::new(response_header))
                    .await
                    .map_err(|error| error.to_string())?;
                http_stream
                    .write_response_body(Vec::new().into(), true)
                    .await
                    .map_err(|error| error.to_string())
            }
            GatewayResponseBody::Buffered(body) => {
                if !has_content_length {
                    response_header
                        .insert_header(
                            http::header::CONTENT_LENGTH.as_str(),
                            body.len().to_string(),
                        )
                        .map_err(|error| error.to_string())?;
                }
                http_stream
                    .write_response_header(Box::new(response_header))
                    .await
                    .map_err(|error| error.to_string())?;
                http_stream
                    .write_response_body(body.into(), true)
                    .await
                    .map_err(|error| error.to_string())
            }
            GatewayResponseBody::Streaming(mut body) => {
                http_stream
                    .write_response_header(Box::new(response_header))
                    .await
                    .map_err(|error| error.to_string())?;
                while let Some(chunk) = body.read_next_chunk().await? {
                    http_stream
                        .write_response_body(chunk.into(), false)
                        .await
                        .map_err(|error| error.to_string())?;
                }
                http_stream
                    .write_response_body(Vec::new().into(), true)
                    .await
                    .map_err(|error| error.to_string())
            }
        }
    }

    async fn handle_request(&self, http_stream: &mut ServerSession) -> HandleRequestResult {
        let header = http_stream.req_header();
        if header.method == http::Method::GET && header.uri.path() == "/_hardess/runtime-pool" {
            return HandleRequestResult {
                response: self.gateway_response_from_http_response(self.metrics_response()),
                request_task_guard: None,
                outcome: RequestTaskOutcome::Succeeded,
            };
        }
        if header.method == http::Method::GET && header.uri.path() == "/_hardess/module-cache" {
            return HandleRequestResult {
                response: self.gateway_response_from_http_response(self.module_cache_response()),
                request_task_guard: None,
                outcome: RequestTaskOutcome::Succeeded,
            };
        }
        if header.method == http::Method::GET && header.uri.path() == "/_hardess/ingress-state" {
            return HandleRequestResult {
                response: self.gateway_response_from_http_response(self.ingress_state_response()),
                request_task_guard: None,
                outcome: RequestTaskOutcome::Succeeded,
            };
        }
        if header.method == http::Method::GET && header.uri.path() == "/_hardess/generations" {
            return HandleRequestResult {
                response: self.gateway_response_from_http_response(self.generations_response()),
                request_task_guard: None,
                outcome: RequestTaskOutcome::Succeeded,
            };
        }
        if header.method == http::Method::POST && header.uri.path() == "/_hardess/cleanup-cache" {
            return HandleRequestResult {
                response: self.gateway_response_from_http_response(self.cleanup_cache_response()),
                request_task_guard: None,
                outcome: RequestTaskOutcome::Succeeded,
            };
        }
        if header.method == http::Method::POST && header.uri.path() == "/_hardess/apply-worker" {
            return HandleRequestResult {
                response: self.gateway_response_from_http_response(
                    self.apply_worker_debug_response(http_stream).await,
                ),
                request_task_guard: None,
                outcome: RequestTaskOutcome::Succeeded,
            };
        }
        if header.method == http::Method::POST && header.uri.path() == "/_hardess/reload-worker" {
            return HandleRequestResult {
                response: self.gateway_response_from_http_response(
                    match self.runtime_manager.apply_configured_worker_debug().await {
                        Ok(snapshot) => match serde_json::to_vec_pretty(&snapshot) {
                            Ok(body) => Response::builder()
                                .status(StatusCode::OK)
                                .header(
                                    http::header::CONTENT_TYPE,
                                    "application/json; charset=utf-8",
                                )
                                .header(http::header::CONTENT_LENGTH, body.len())
                                .body(body)
                                .expect("reload response should build"),
                            Err(error) => self.public_error_http_response(internal_public_error(
                                error.to_string(),
                            )),
                        },
                        Err(error) => self
                            .public_error_http_response(internal_public_error(error.to_string())),
                    },
                ),
                request_task_guard: None,
                outcome: RequestTaskOutcome::Succeeded,
            };
        }

        let _request_guard = match self.drain_controller.try_acquire() {
            Some(guard) => guard,
            None => {
                return HandleRequestResult {
                    response: self.draining_gateway_response(),
                    request_task_guard: None,
                    outcome: RequestTaskOutcome::ShutdownDraining,
                }
            }
        };

        let request_build_started_at = std::time::Instant::now();
        let (request, mut ingress_body) = match self.build_request(http_stream).await {
            Ok(request) => request,
            Err(error) => {
                return HandleRequestResult {
                    response: self.public_error_gateway_response(bad_request_public_error(error)),
                    request_task_guard: None,
                    outcome: RequestTaskOutcome::BadRequest,
                };
            }
        };
        self.ingress_metrics
            .record_request_build(request_build_started_at.elapsed());
        let completion_policy = request.completion_policy();
        let request_task_id = self.next_request_task_id();
        let request_task_descriptor = self.build_request_task_descriptor(
            request_task_id,
            http_stream,
            ingress_body.is_some(),
            completion_policy,
        );
        let request_task_guard = self.request_tasks.track(request_task_descriptor.clone());
        let worker_context = self.build_worker_context(&request_task_descriptor);
        let worker_id = self.worker_id.clone();
        let runtime_execute_started_at = std::time::Instant::now();
        let worker_future = self.runtime_manager.execute(
            request,
            WorkerEnv {
                worker_id,
                vars: Default::default(),
            },
            worker_context,
        );
        tokio::pin!(worker_future);

        let worker_result = loop {
            if let Some(body) = ingress_body.as_mut() {
                tokio::select! {
                    result = &mut worker_future => break result,
                    serviced = body.service_next(http_stream) => {
                        if !serviced {
                            ingress_body = None;
                        }
                    }
                }
            } else {
                break worker_future.await;
            }
        };
        self.ingress_metrics
            .record_runtime_execute(runtime_execute_started_at.elapsed());

        if let Some(body) = ingress_body.as_mut() {
            request_task_guard.set_phase(RequestTaskPhase::RequestBodyFinalize);
            if let Err(error) = body.finish(http_stream, completion_policy).await {
                return HandleRequestResult {
                    response: self.public_error_gateway_response(internal_public_error(error)),
                    request_task_guard: Some(request_task_guard),
                    outcome: RequestTaskOutcome::InternalError,
                };
            }
            if completion_policy == RequestBodyCompletionPolicy::DisableKeepalive {
                http_stream.set_keepalive(None);
            }
        }

        let (response, outcome) = match worker_result {
            Ok(response) => (response, RequestTaskOutcome::Succeeded),
            Err(error) => (
                self.runtime_pool_gateway_response(error),
                RequestTaskOutcome::RuntimeError,
            ),
        };
        HandleRequestResult {
            response,
            request_task_guard: Some(request_task_guard),
            outcome,
        }
    }
}

fn request_body_expected(content_length: Option<u64>, has_transfer_encoding: bool) -> bool {
    matches!(content_length, Some(length) if length > 0) || has_transfer_encoding
}

fn http_version_label(version: http::Version) -> &'static str {
    match version {
        http::Version::HTTP_09 => "http/0.9",
        http::Version::HTTP_10 => "http/1.0",
        http::Version::HTTP_11 => "http/1.1",
        http::Version::HTTP_2 => "h2",
        http::Version::HTTP_3 => "h3",
        _ => "unknown",
    }
}

fn request_body_mode_label(has_ingress_body: bool) -> &'static str {
    if has_ingress_body {
        "streaming"
    } else {
        "none"
    }
}

fn completion_policy_label(policy: RequestBodyCompletionPolicy) -> &'static str {
    match policy {
        RequestBodyCompletionPolicy::AlreadyComplete => "already_complete",
        RequestBodyCompletionPolicy::Drain => "drain",
        RequestBodyCompletionPolicy::DisableKeepalive => "disable_keepalive",
    }
}

fn request_body_completion_policy(
    content_length: Option<u64>,
    has_transfer_encoding: bool,
) -> RequestBodyCompletionPolicy {
    if let Some(length) = content_length {
        if length == 0 {
            return RequestBodyCompletionPolicy::AlreadyComplete;
        }
        if length <= 64 * 1024 {
            return RequestBodyCompletionPolicy::Drain;
        }
    }

    if has_transfer_encoding {
        return RequestBodyCompletionPolicy::DisableKeepalive;
    }

    RequestBodyCompletionPolicy::DisableKeepalive
}

async fn read_full_request_body(http_stream: &mut ServerSession) -> Result<Vec<u8>, String> {
    let mut body = Vec::new();
    loop {
        match http_stream
            .read_request_body()
            .await
            .map_err(|error| error.to_string())?
        {
            Some(chunk) => body.extend_from_slice(&chunk),
            None => return Ok(body),
        }
    }
}

#[async_trait]
impl HttpServerApp for WorkerHttpApp {
    async fn process_new_http(
        self: &Arc<Self>,
        mut http_stream: ServerSession,
        shutdown: &pingora::server::ShutdownWatch,
    ) -> Option<ReusedHttpStream> {
        let request_started_at = std::time::Instant::now();
        let request_read_started_at = std::time::Instant::now();
        match http_stream.read_request().await {
            Ok(false) => return None,
            Ok(true) => {}
            Err(error) => {
                eprintln!("failed to read downstream request header: {error}");
                return None;
            }
        }
        self.ingress_metrics
            .record_request_read(request_read_started_at.elapsed());

        if *shutdown.borrow() {
            http_stream.set_keepalive(None);
        } else {
            http_stream.set_keepalive(Some(60));
        }

        let HandleRequestResult {
            response,
            mut request_task_guard,
            outcome,
        } = self.handle_request(&mut http_stream).await;
        let response_write_started_at = std::time::Instant::now();
        if let Some(guard) = request_task_guard.as_ref() {
            guard.set_phase(RequestTaskPhase::ResponseWrite);
        }
        if let Err(error) = self
            .write_gateway_response(&mut http_stream, response)
            .await
        {
            if let Some(guard) = request_task_guard.take() {
                guard.finish(RequestTaskOutcome::ResponseWriteError);
            }
            eprintln!("failed to write downstream response: {error}");
            return None;
        }
        self.ingress_metrics
            .record_response_write(response_write_started_at.elapsed());
        self.ingress_metrics
            .record_request_total(request_started_at.elapsed());

        let persistent_settings = HttpPersistentSettings::for_session(&http_stream);
        let finish_started_at = std::time::Instant::now();
        if let Some(guard) = request_task_guard.as_ref() {
            guard.set_phase(RequestTaskPhase::SessionFinish);
        }
        match http_stream.finish().await {
            Ok(connection) => {
                if let Some(guard) = request_task_guard.take() {
                    guard.finish(outcome);
                }
                self.ingress_metrics
                    .record_finish(finish_started_at.elapsed());
                connection.map(|stream| ReusedHttpStream::new(stream, Some(persistent_settings)))
            }
            Err(error) => {
                if let Some(guard) = request_task_guard.take() {
                    guard.finish(RequestTaskOutcome::InternalError);
                }
                eprintln!("failed to finish downstream request: {error}");
                None
            }
        }
    }
}

#[cfg(unix)]
struct DrainAwareShutdownSignalWatch {
    drain_controller: Arc<RequestDrainController>,
    drain_timeout: Duration,
}

#[cfg(unix)]
impl DrainAwareShutdownSignalWatch {
    async fn wait_for_inflight_or_fast_shutdown(
        &self,
        signal_name: &str,
        graceful_signal: ShutdownSignal,
        fast_shutdown_signal: &mut unix::Signal,
    ) -> ShutdownSignal {
        let already_draining = !self.drain_controller.start_draining();
        let inflight_requests = self.drain_controller.inflight_requests();
        println!(
            "{signal_name} received; draining={} inflight_requests={} drain_timeout_ms={}",
            if already_draining {
                "already-started"
            } else {
                "started"
            },
            inflight_requests,
            self.drain_timeout.as_millis()
        );

        let drained = tokio::select! {
            drained = self.drain_controller.wait_for_drain(self.drain_timeout) => drained,
            _ = fast_shutdown_signal.recv() => {
                println!("SIGINT received while draining; switching to fast shutdown");
                return ShutdownSignal::FastShutdown;
            }
        };

        if drained {
            println!("{signal_name} drain finished with inflight_requests=0");
        } else {
            println!(
                "{signal_name} drain timeout reached with inflight_requests={}",
                self.drain_controller.inflight_requests()
            );
        }

        graceful_signal
    }
}

#[cfg(unix)]
#[async_trait]
impl ShutdownSignalWatch for DrainAwareShutdownSignalWatch {
    async fn recv(&self) -> ShutdownSignal {
        let mut graceful_upgrade_signal = unix::signal(unix::SignalKind::quit()).unwrap();
        let mut graceful_terminate_signal = unix::signal(unix::SignalKind::terminate()).unwrap();
        let mut fast_shutdown_signal = unix::signal(unix::SignalKind::interrupt()).unwrap();

        tokio::select! {
            _ = fast_shutdown_signal.recv() => ShutdownSignal::FastShutdown,
            _ = graceful_terminate_signal.recv() => {
                self.wait_for_inflight_or_fast_shutdown(
                    "SIGTERM",
                    ShutdownSignal::GracefulTerminate,
                    &mut fast_shutdown_signal,
                ).await
            }
            _ = graceful_upgrade_signal.recv() => {
                self.wait_for_inflight_or_fast_shutdown(
                    "SIGQUIT",
                    ShutdownSignal::GracefulUpgrade,
                    &mut fast_shutdown_signal,
                ).await
            }
        }
    }
}

fn main() {
    let cli = PingoraCliArgs::parse().expect("pingora ingress cli should parse");
    let tcp_socket_options = cli.tcp_socket_options();
    let tcp_keepalive_display = tcp_socket_options
        .tcp_keepalive
        .as_ref()
        .map(ToString::to_string);
    let runtime_manager = RuntimeGenerationManager::new(RuntimeGenerationManagerConfig {
        worker_entry: cli.worker_entry.clone(),
        runtime_threads: cli.runtime_threads,
        queue_capacity: cli.queue_capacity,
        exec_timeout: Duration::from_millis(cli.exec_timeout_ms),
        completion_mode: cli.completion_mode,
        generation_drain_timeout: Duration::from_millis(cli.generation_drain_timeout_ms),
    })
    .expect("worker runtime generation manager should initialize");
    let drain_controller = Arc::new(RequestDrainController::new());

    let mut server_conf = ServerConf::new().expect("pingora server conf should initialize");
    // App-level drain already waits for in-flight requests, so Pingora itself should not
    // add another fixed grace-period sleep on top.
    server_conf.grace_period_seconds = Some(0);
    server_conf.graceful_shutdown_timeout_seconds = Some(1);

    let mut server = Server::new_with_opt_and_conf(None::<PingoraOpt>, server_conf);
    server.bootstrap();

    let mut service = Service::new(
        "Hardess Worker Pingora Ingress".to_string(),
        WorkerHttpApp {
            runtime_manager,
            drain_controller: drain_controller.clone(),
            ingress_metrics: Arc::new(IngressMetrics::new()),
            request_tasks: Arc::new(RequestTaskRegistry::new()),
            next_request_task_id: AtomicU64::new(0),
            worker_id: cli.worker_id.clone(),
        },
    );
    service.add_tcp_with_settings(&cli.listen, tcp_socket_options);

    println!(
        "pingora ingress listening on http://{} for worker_id={} runtime_threads={} queue_capacity={} exec_timeout_ms={} completion_mode={:?} tcp_fastopen_backlog={:?} tcp_keepalive={:?} tcp_reuseport={:?} shutdown_drain_timeout_ms={} generation_drain_timeout_ms={}",
        cli.listen,
        cli.worker_id,
        cli.runtime_threads,
        cli.queue_capacity,
        cli.exec_timeout_ms,
        cli.completion_mode,
        cli.tcp_fastopen_backlog,
        tcp_keepalive_display,
        cli.tcp_reuseport,
        cli.shutdown_drain_timeout_ms,
        cli.generation_drain_timeout_ms
    );

    server.add_services(vec![Box::new(service)]);
    #[cfg(unix)]
    server.run(RunArgs {
        shutdown_signal: Box::new(DrainAwareShutdownSignalWatch {
            drain_controller,
            drain_timeout: Duration::from_millis(cli.shutdown_drain_timeout_ms),
        }),
    });
    #[cfg(not(unix))]
    server.run_forever();
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;
    use std::time::SystemTime;
    use std::time::UNIX_EPOCH;

    fn sample_worker_path() -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../workers/hello/mod.ts")
    }

    fn temp_worker_path(name: &str, source: &str) -> PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system time should be after unix epoch")
            .as_nanos();
        let dir = std::env::temp_dir().join(format!(
            "hardess-pingora-ingress-{name}-{}-{nonce}",
            std::process::id()
        ));
        std::fs::create_dir_all(&dir).expect("temp worker dir should be created");
        let worker_path = dir.join("mod.ts");
        std::fs::write(&worker_path, source).expect("temp worker should be written");
        worker_path
    }

    fn test_app_with_worker(worker_entry: PathBuf) -> WorkerHttpApp {
        WorkerHttpApp {
            runtime_manager: RuntimeGenerationManager::new(RuntimeGenerationManagerConfig {
                worker_entry,
                runtime_threads: 1,
                queue_capacity: 4,
                exec_timeout: Duration::from_secs(5),
                completion_mode: RuntimeCompletionMode::Auto,
                generation_drain_timeout: Duration::from_millis(10),
            })
            .expect("runtime manager should initialize"),
            drain_controller: Arc::new(RequestDrainController::new()),
            ingress_metrics: Arc::new(IngressMetrics::new()),
            request_tasks: Arc::new(RequestTaskRegistry::new()),
            next_request_task_id: AtomicU64::new(0),
            worker_id: "test-worker".to_string(),
        }
    }

    fn test_app() -> WorkerHttpApp {
        test_app_with_worker(sample_worker_path())
    }

    #[test]
    fn request_task_registry_tracks_lifecycle() {
        let registry = Arc::new(RequestTaskRegistry::new());
        let descriptor = RequestTaskDescriptor {
            request_task_id: 7,
            method: "POST".to_string(),
            uri: "/demo/orders".to_string(),
            client_addr: Some("127.0.0.1:12345".to_string()),
            http_version: "http/1.1".to_string(),
            request_body_mode: "streaming".to_string(),
            completion_policy: "drain".to_string(),
        };
        let guard = registry.track(descriptor);

        let snapshot = registry.snapshot();
        assert_eq!(snapshot.inflight_count, 1);
        assert_eq!(snapshot.tasks.len(), 1);
        assert_eq!(snapshot.tasks[0].request_task_id, 7);
        assert_eq!(snapshot.tasks[0].method, "POST");
        assert_eq!(snapshot.tasks[0].uri, "/demo/orders");
        assert_eq!(
            snapshot.tasks[0].client_addr.as_deref(),
            Some("127.0.0.1:12345")
        );
        assert_eq!(snapshot.tasks[0].http_version, "http/1.1");
        assert_eq!(snapshot.tasks[0].request_body_mode, "streaming");
        assert_eq!(snapshot.tasks[0].completion_policy, "drain");
        assert!(matches!(
            snapshot.tasks[0].phase,
            RequestTaskPhase::RuntimeExecute
        ));

        drop(guard);

        let settled = registry.snapshot();
        assert_eq!(settled.inflight_count, 0);
        assert!(settled.tasks.is_empty());

        let recent = registry.recent_snapshot();
        assert_eq!(recent.count, 1);
        assert_eq!(recent.tasks[0].request_task_id, 7);
        assert!(matches!(
            recent.tasks[0].outcome,
            RequestTaskOutcome::Dropped
        ));
    }

    #[test]
    fn helper_labels_match_public_metadata_shape() {
        assert_eq!(http_version_label(http::Version::HTTP_11), "http/1.1");
        assert_eq!(request_body_mode_label(true), "streaming");
        assert_eq!(request_body_mode_label(false), "none");
        assert_eq!(
            completion_policy_label(RequestBodyCompletionPolicy::AlreadyComplete),
            "already_complete"
        );
        assert_eq!(
            completion_policy_label(RequestBodyCompletionPolicy::Drain),
            "drain"
        );
        assert_eq!(
            completion_policy_label(RequestBodyCompletionPolicy::DisableKeepalive),
            "disable_keepalive"
        );
    }

    #[test]
    fn ingress_state_response_exposes_active_request_tasks() {
        let app = test_app();
        let _guard = app.request_tasks.track(RequestTaskDescriptor {
            request_task_id: 9,
            method: "GET".to_string(),
            uri: "/benchmark/orders".to_string(),
            client_addr: Some("127.0.0.1:54321".to_string()),
            http_version: "http/1.1".to_string(),
            request_body_mode: "none".to_string(),
            completion_policy: "already_complete".to_string(),
        });

        let response = app.ingress_state_response();
        assert_eq!(response.status(), StatusCode::OK);

        let body: Value =
            serde_json::from_slice(response.body()).expect("ingress-state response should be json");
        assert_eq!(
            body.pointer("/active_request_tasks/inflight_count")
                .and_then(Value::as_u64),
            Some(1)
        );
        assert_eq!(
            body.pointer("/active_request_tasks/tasks/0/request_task_id")
                .and_then(Value::as_u64),
            Some(9)
        );
        assert_eq!(
            body.pointer("/active_request_tasks/tasks/0/method")
                .and_then(Value::as_str),
            Some("GET")
        );
        assert_eq!(
            body.pointer("/active_request_tasks/tasks/0/uri")
                .and_then(Value::as_str),
            Some("/benchmark/orders")
        );
        assert_eq!(
            body.pointer("/active_request_tasks/tasks/0/phase")
                .and_then(Value::as_str),
            Some("runtime_execute")
        );
        assert_eq!(
            body.pointer("/recent_request_tasks/count")
                .and_then(Value::as_u64),
            Some(0)
        );
    }

    #[test]
    fn draining_response_uses_public_error_contract() {
        let app = test_app();
        let response = app.draining_response();

        assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
        assert_eq!(
            response.headers().get(http::header::CONTENT_TYPE),
            Some(&http::HeaderValue::from_static(
                "application/json; charset=utf-8"
            ))
        );
        assert_eq!(
            response.headers().get(http::header::CONNECTION),
            Some(&http::HeaderValue::from_static("close"))
        );
        assert_eq!(
            response.headers().get(http::header::RETRY_AFTER),
            Some(&http::HeaderValue::from_static("1"))
        );
        assert!(String::from_utf8(response.body().clone())
            .expect("response body should be utf-8")
            .contains("\"code\":\"shutdown_draining\""));
    }

    #[test]
    fn runtime_pool_timeout_uses_public_error_contract() {
        let app = test_app();
        let response = app.runtime_pool_error_response(RuntimePoolError::TimedOut(250));

        assert_eq!(response.status(), StatusCode::GATEWAY_TIMEOUT);
        assert_eq!(
            response.headers().get(http::header::CONTENT_TYPE),
            Some(&http::HeaderValue::from_static(
                "application/json; charset=utf-8"
            ))
        );
        let body =
            String::from_utf8(response.body().clone()).expect("response body should be utf-8");
        assert!(body.contains("\"code\":\"execution_timeout\""));
        assert!(body.contains("\"category\":\"execution_timeout\""));
    }

    #[test]
    fn module_cache_endpoint_returns_project_snapshot() {
        let app = test_app();
        let response = app.module_cache_response();

        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(
            response.headers().get(http::header::CONTENT_TYPE),
            Some(&http::HeaderValue::from_static(
                "application/json; charset=utf-8"
            ))
        );
        let body: Value = serde_json::from_slice(response.body())
            .expect("module-cache response body should be json");
        assert_eq!(
            body.get("module_cache_dir")
                .and_then(Value::as_str)
                .map(|path| path.ends_with("workers/hello/.hardess-cache/remote_modules")),
            Some(true)
        );
    }

    #[test]
    fn generations_endpoint_exposes_version_state() {
        let app = test_app();
        let response = app.generations_response();

        assert_eq!(response.status(), StatusCode::OK);
        let body: Value = serde_json::from_slice(response.body())
            .expect("generations response body should be json");
        assert_eq!(
            body.pointer("/version_state/status")
                .and_then(Value::as_str),
            Some("active")
        );
        assert_eq!(
            body.pointer("/version_state/desired_generation_id")
                .and_then(Value::as_u64),
            Some(1)
        );
        assert_eq!(
            body.pointer("/version_state/prepared_generation_id")
                .and_then(Value::as_u64),
            Some(1)
        );
        assert_eq!(
            body.pointer("/version_state/active_generation_id")
                .and_then(Value::as_u64),
            Some(1)
        );
        assert_eq!(
            body.pointer("/version_state/desired_artifact_id")
                .and_then(Value::as_str)
                .map(|artifact_id| artifact_id.starts_with("local-sha256:")),
            Some(true)
        );
        assert_eq!(
            body.pointer("/version_state/prepared_artifact_id")
                .and_then(Value::as_str)
                .map(|artifact_id| artifact_id.starts_with("local-sha256:")),
            Some(true)
        );
        assert_eq!(
            body.pointer("/version_state/active_artifact_id")
                .and_then(Value::as_str)
                .map(|artifact_id| artifact_id.starts_with("local-sha256:")),
            Some(true)
        );
        assert_eq!(
            body.pointer("/version_state/failed_artifact_id"),
            Some(&Value::Null)
        );
        assert_eq!(
            body.pointer("/version_state/desired_declared_artifact_id"),
            Some(&Value::Null)
        );
        assert_eq!(
            body.pointer("/version_state/desired_declared_version"),
            Some(&Value::Null)
        );
        assert_eq!(
            body.pointer("/version_state/prepared_declared_artifact_id"),
            Some(&Value::Null)
        );
        assert_eq!(
            body.pointer("/version_state/prepared_declared_version"),
            Some(&Value::Null)
        );
        assert_eq!(
            body.pointer("/version_state/active_declared_artifact_id"),
            Some(&Value::Null)
        );
        assert_eq!(
            body.pointer("/version_state/active_declared_version"),
            Some(&Value::Null)
        );
        assert_eq!(
            body.pointer("/version_state/failed_declared_artifact_id"),
            Some(&Value::Null)
        );
        assert_eq!(
            body.pointer("/version_state/failed_declared_version"),
            Some(&Value::Null)
        );
        assert!(body
            .pointer("/version_state/desired_updated_at_unix_ms")
            .and_then(Value::as_u64)
            .is_some());
        assert!(body
            .pointer("/version_state/prepared_at_unix_ms")
            .and_then(Value::as_u64)
            .is_some());
        assert!(body
            .pointer("/version_state/active_at_unix_ms")
            .and_then(Value::as_u64)
            .is_some());
        assert!(body
            .pointer("/version_state/status_updated_at_unix_ms")
            .and_then(Value::as_u64)
            .is_some());
    }

    #[test]
    fn cleanup_cache_endpoint_prunes_stale_entries() {
        let worker_path = temp_worker_path(
            "cleanup-cache-endpoint",
            "export function fetch() { return new Response('ok'); }\n",
        );
        let worker_dir = worker_path
            .parent()
            .expect("temp worker should have parent dir")
            .to_path_buf();
        std::fs::write(
            worker_dir.join("deno.json"),
            r#"{
  "lock": {
    "path": "./deno.lock",
    "frozen": true
  }
}"#,
        )
        .expect("deno.json should be written");
        std::fs::write(
            worker_dir.join("deno.lock"),
            r#"{
  "version": "5",
  "remote": {}
}"#,
        )
        .expect("deno.lock should be written");
        let cache_dir = worker_dir.join(".hardess-cache/remote_modules");
        std::fs::create_dir_all(&cache_dir).expect("cache dir should be created");
        let stale_key = "stale-cache-key";
        std::fs::write(
            cache_dir.join(format!("{stale_key}.body")),
            "export const x = 1;\n",
        )
        .expect("stale body should be written");
        std::fs::write(
            cache_dir.join(format!("{stale_key}.meta.json")),
            r#"{
  "url": "https://example.com/stale.ts",
  "content_type": "application/typescript"
}"#,
        )
        .expect("stale meta should be written");

        let app = test_app_with_worker(worker_path);
        let response = app.cleanup_cache_response();

        assert_eq!(response.status(), StatusCode::OK);
        let body: Value = serde_json::from_slice(response.body())
            .expect("cleanup-cache response body should be json");
        assert_eq!(
            body.pointer("/module_cache/entry_count")
                .and_then(Value::as_u64),
            Some(0)
        );
        assert!(!cache_dir.join(format!("{stale_key}.body")).exists());
        assert!(!cache_dir.join(format!("{stale_key}.meta.json")).exists());
    }

    #[tokio::test(flavor = "current_thread")]
    async fn reload_worker_swaps_active_generation_and_cleans_up_old_one() {
        let manager = RuntimeGenerationManager::new(RuntimeGenerationManagerConfig {
            worker_entry: sample_worker_path(),
            runtime_threads: 1,
            queue_capacity: 4,
            exec_timeout: Duration::from_secs(5),
            completion_mode: RuntimeCompletionMode::Auto,
            generation_drain_timeout: Duration::from_millis(10),
        })
        .expect("runtime manager should initialize");

        let initial = manager.snapshot();
        assert_eq!(initial.active_generation_id, 1);
        assert_eq!(initial.generations.len(), 1);
        assert_eq!(initial.version_state.status, "active");
        assert_eq!(initial.version_state.desired_generation_id, 1);
        assert_eq!(
            initial.version_state.desired_artifact_id,
            initial.generations[0].project.artifact_id
        );
        assert_eq!(initial.version_state.desired_declared_artifact_id, None);
        assert_eq!(initial.version_state.desired_declared_version, None);
        assert!(initial.version_state.desired_updated_at_unix_ms > 0);
        assert_eq!(initial.version_state.prepared_generation_id, Some(1));
        assert_eq!(
            initial.version_state.prepared_artifact_id.as_deref(),
            Some(initial.generations[0].project.artifact_id.as_str())
        );
        assert_eq!(initial.version_state.prepared_declared_artifact_id, None);
        assert_eq!(initial.version_state.prepared_declared_version, None);
        assert!(initial.version_state.prepared_at_unix_ms.is_some());
        assert_eq!(initial.version_state.active_generation_id, 1);
        assert_eq!(
            initial.version_state.active_artifact_id,
            initial.generations[0].project.artifact_id
        );
        assert_eq!(initial.version_state.active_declared_artifact_id, None);
        assert_eq!(initial.version_state.active_declared_version, None);
        assert!(initial.version_state.active_at_unix_ms > 0);
        assert_eq!(initial.version_state.failed_generation_id, None);
        assert_eq!(initial.version_state.failed_artifact_id, None);
        assert_eq!(initial.version_state.failed_declared_artifact_id, None);
        assert_eq!(initial.version_state.failed_declared_version, None);
        assert_eq!(initial.version_state.failed_at_unix_ms, None);
        assert_eq!(initial.version_state.failed_error_kind, None);
        assert!(initial.version_state.status_updated_at_unix_ms > 0);
        assert_eq!(initial.last_prepare.status, "ready");
        assert_eq!(
            initial.last_prepare.artifact_id.as_deref(),
            Some(initial.generations[0].project.artifact_id.as_str())
        );
        assert!(initial.last_prepare.started_at_unix_ms > 0);
        assert!(initial.last_prepare.finished_at_unix_ms.is_some());
        assert_eq!(initial.last_prepare.error_kind, None);
        assert!(initial.last_prepare.project.is_some());
        assert_eq!(initial.generations[0].prepare_status, "ready");

        let reloaded = manager
            .apply_configured_worker_debug()
            .await
            .expect("debug apply should succeed");
        assert_eq!(reloaded.active_generation_id, 2);
        assert_eq!(reloaded.generations.len(), 2);
        assert_eq!(reloaded.version_state.status, "active");
        assert_eq!(reloaded.version_state.desired_generation_id, 2);
        assert_eq!(
            reloaded.version_state.desired_artifact_id,
            reloaded.generations[0].project.artifact_id
        );
        assert_eq!(reloaded.version_state.desired_declared_artifact_id, None);
        assert_eq!(reloaded.version_state.desired_declared_version, None);
        assert!(reloaded.version_state.desired_updated_at_unix_ms > 0);
        assert_eq!(reloaded.version_state.prepared_generation_id, Some(2));
        assert_eq!(
            reloaded.version_state.prepared_artifact_id.as_deref(),
            Some(reloaded.generations[0].project.artifact_id.as_str())
        );
        assert_eq!(reloaded.version_state.prepared_declared_artifact_id, None);
        assert_eq!(reloaded.version_state.prepared_declared_version, None);
        assert!(reloaded.version_state.prepared_at_unix_ms.is_some());
        assert_eq!(reloaded.version_state.active_generation_id, 2);
        assert_eq!(
            reloaded.version_state.active_artifact_id,
            reloaded.generations[0].project.artifact_id
        );
        assert_eq!(reloaded.version_state.active_declared_artifact_id, None);
        assert_eq!(reloaded.version_state.active_declared_version, None);
        assert!(reloaded.version_state.active_at_unix_ms > 0);
        assert_eq!(reloaded.version_state.failed_generation_id, None);
        assert_eq!(reloaded.version_state.failed_artifact_id, None);
        assert_eq!(reloaded.version_state.failed_declared_artifact_id, None);
        assert_eq!(reloaded.version_state.failed_declared_version, None);
        assert_eq!(reloaded.version_state.failed_at_unix_ms, None);
        assert_eq!(reloaded.version_state.failed_error_kind, None);
        assert_eq!(reloaded.last_prepare.status, "ready");
        assert_eq!(
            reloaded.last_prepare.artifact_id.as_deref(),
            Some(reloaded.generations[0].project.artifact_id.as_str())
        );
        assert!(reloaded.last_prepare.started_at_unix_ms > 0);
        assert!(reloaded.last_prepare.finished_at_unix_ms.is_some());
        assert_eq!(reloaded.last_prepare.error_kind, None);
        assert_eq!(reloaded.last_prepare.target_generation_id, 2);
        assert!(reloaded.last_prepare.project.is_some());
        assert_eq!(
            reloaded.generations[0]
                .project
                .deno_json_path
                .as_deref()
                .map(|path| path.ends_with("workers/hello/deno.json")),
            Some(true)
        );
        assert!(reloaded
            .generations
            .iter()
            .any(|generation| generation.active));
        assert!(reloaded
            .generations
            .iter()
            .any(|generation| generation.generation_id == 1 && generation.drain.draining));

        tokio::time::sleep(Duration::from_millis(30)).await;

        let settled = manager.snapshot();
        assert_eq!(settled.active_generation_id, 2);
        assert_eq!(settled.generations.len(), 1);
        assert_eq!(settled.generations[0].generation_id, 2);
        assert_eq!(settled.version_state.status, "active");
        assert_eq!(settled.version_state.active_generation_id, 2);
        assert!(settled.version_state.status_updated_at_unix_ms > 0);
        assert_eq!(settled.last_prepare.status, "ready");
    }

    #[tokio::test(flavor = "current_thread")]
    async fn failed_prepare_keeps_active_generation_and_records_error() {
        let worker_path = temp_worker_path(
            "prepare-failure",
            "export function fetch() { return new Response('ok'); }\n",
        );
        let manager = RuntimeGenerationManager::new(RuntimeGenerationManagerConfig {
            worker_entry: worker_path.clone(),
            runtime_threads: 1,
            queue_capacity: 4,
            exec_timeout: Duration::from_secs(5),
            completion_mode: RuntimeCompletionMode::Auto,
            generation_drain_timeout: Duration::from_millis(10),
        })
        .expect("runtime manager should initialize");

        std::fs::write(&worker_path, "export function fetch( {\n")
            .expect("broken worker should be written");

        let error = manager
            .apply_configured_worker_debug()
            .await
            .expect_err("debug apply should surface prepare failure");
        assert!(error.to_string().contains("Expected ident"));

        let snapshot = manager.snapshot();
        assert_eq!(snapshot.active_generation_id, 1);
        assert_eq!(snapshot.generations.len(), 1);
        assert_eq!(snapshot.version_state.status, "failed");
        assert_eq!(snapshot.version_state.desired_generation_id, 2);
        assert_ne!(
            snapshot.version_state.desired_artifact_id,
            snapshot.version_state.active_artifact_id
        );
        assert_eq!(snapshot.version_state.desired_declared_artifact_id, None);
        assert_eq!(snapshot.version_state.desired_declared_version, None);
        assert!(snapshot.version_state.desired_updated_at_unix_ms > 0);
        assert_eq!(snapshot.version_state.prepared_generation_id, Some(1));
        assert_eq!(
            snapshot.version_state.prepared_artifact_id.as_deref(),
            Some(snapshot.generations[0].project.artifact_id.as_str())
        );
        assert_eq!(snapshot.version_state.prepared_declared_artifact_id, None);
        assert_eq!(snapshot.version_state.prepared_declared_version, None);
        assert!(snapshot.version_state.prepared_at_unix_ms.is_some());
        assert_eq!(snapshot.version_state.active_generation_id, 1);
        assert_eq!(
            snapshot.version_state.active_artifact_id,
            snapshot.generations[0].project.artifact_id
        );
        assert_eq!(snapshot.version_state.active_declared_artifact_id, None);
        assert_eq!(snapshot.version_state.active_declared_version, None);
        assert_eq!(snapshot.version_state.failed_generation_id, Some(2));
        assert_eq!(
            snapshot.version_state.failed_artifact_id.as_deref(),
            Some(snapshot.version_state.desired_artifact_id.as_str())
        );
        assert_eq!(snapshot.version_state.failed_declared_artifact_id, None);
        assert_eq!(snapshot.version_state.failed_declared_version, None);
        assert!(snapshot.version_state.failed_at_unix_ms.is_some());
        assert_eq!(
            snapshot.version_state.failed_error_kind.as_deref(),
            Some("worker_code_invalid")
        );
        assert!(snapshot
            .version_state
            .failed_error
            .as_deref()
            .expect("failed version state should keep error")
            .contains("Expected ident"));
        assert_eq!(snapshot.last_prepare.status, "failed");
        assert!(snapshot.last_prepare.started_at_unix_ms > 0);
        assert!(snapshot.last_prepare.finished_at_unix_ms.is_some());
        assert_eq!(
            snapshot.last_prepare.artifact_id.as_deref(),
            Some(snapshot.version_state.desired_artifact_id.as_str())
        );
        assert_eq!(
            snapshot.last_prepare.error_kind.as_deref(),
            Some("worker_code_invalid")
        );
        assert_eq!(snapshot.last_prepare.target_generation_id, 2);
        assert_eq!(
            snapshot
                .last_prepare
                .project
                .as_ref()
                .map(|project| project.artifact_id.as_str()),
            Some(snapshot.version_state.desired_artifact_id.as_str())
        );
        assert!(snapshot
            .last_prepare
            .error
            .as_deref()
            .expect("failed prepare should keep error")
            .contains("Expected ident"));
    }

    #[tokio::test(flavor = "current_thread")]
    async fn apply_desired_worker_can_switch_to_another_worker_entry() {
        let manager = RuntimeGenerationManager::new(RuntimeGenerationManagerConfig {
            worker_entry: sample_worker_path(),
            runtime_threads: 1,
            queue_capacity: 4,
            exec_timeout: Duration::from_secs(5),
            completion_mode: RuntimeCompletionMode::Auto,
            generation_drain_timeout: Duration::from_millis(10),
        })
        .expect("runtime manager should initialize");
        let next_worker = temp_worker_path(
            "apply-desired-worker",
            "export function fetch() { return new Response('switched'); }\n",
        );

        let updated = manager
            .apply_desired_worker(DesiredWorkerSpec {
                worker_entry: next_worker.clone(),
                declared_artifact_id: Some("cp-artifact-42".to_string()),
                declared_version: Some("worker-v2".to_string()),
            })
            .await
            .expect("apply desired worker should succeed");

        assert_eq!(updated.active_generation_id, 2);
        assert_eq!(
            updated.version_state.desired_worker_entry,
            next_worker.display().to_string()
        );
        assert_eq!(
            updated
                .version_state
                .desired_declared_artifact_id
                .as_deref(),
            Some("cp-artifact-42")
        );
        assert_eq!(
            updated.version_state.desired_declared_version.as_deref(),
            Some("worker-v2")
        );
        assert_eq!(
            updated
                .version_state
                .prepared_declared_artifact_id
                .as_deref(),
            Some("cp-artifact-42")
        );
        assert_eq!(
            updated.version_state.prepared_declared_version.as_deref(),
            Some("worker-v2")
        );
        assert_eq!(
            updated.version_state.active_declared_artifact_id.as_deref(),
            Some("cp-artifact-42")
        );
        assert_eq!(
            updated.version_state.active_declared_version.as_deref(),
            Some("worker-v2")
        );
        assert_eq!(updated.version_state.failed_declared_artifact_id, None);
        assert_eq!(updated.version_state.failed_declared_version, None);
        assert_eq!(
            updated.generations[0].worker_entry,
            next_worker.display().to_string()
        );
        assert_eq!(
            updated.generations[0].declared_artifact_id.as_deref(),
            Some("cp-artifact-42")
        );
        assert_eq!(
            updated.generations[0].declared_version.as_deref(),
            Some("worker-v2")
        );
        assert_eq!(
            updated.last_prepare.declared_artifact_id.as_deref(),
            Some("cp-artifact-42")
        );
        assert_eq!(
            updated.last_prepare.declared_version.as_deref(),
            Some("worker-v2")
        );
        assert_eq!(
            manager
                .active_project_snapshot()
                .expect("active project snapshot should switch to the new worker")
                .artifact_id,
            updated.generations[0].project.artifact_id
        );
    }
}
