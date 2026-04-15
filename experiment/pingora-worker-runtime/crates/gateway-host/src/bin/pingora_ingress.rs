use std::path::PathBuf;
use std::sync::atomic::AtomicU64;
use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::RwLock;
use std::time::Duration;

use anyhow::Context;
use async_trait::async_trait;
use gateway_host::bad_request_public_error;
use gateway_host::inspect_worker_project;
use gateway_host::internal_public_error;
use gateway_host::public_error_response;
use gateway_host::shutdown_draining_public_error;
use gateway_host::CompatPublicError;
use gateway_host::DrainSnapshot;
use gateway_host::RequestDrainController;
use gateway_host::RuntimePoolError;
use gateway_host::RuntimePoolSnapshot;
use gateway_host::WorkerProjectSnapshot;
use gateway_host::WorkerRuntimePool;
use http::Response;
use http::StatusCode;
use pingora::apps::http_app::HttpServer;
use pingora::apps::http_app::ServeHttp;
use pingora::protocols::http::ServerSession;
use pingora::server::configuration::Opt as PingoraOpt;
use pingora::server::configuration::ServerConf;
use pingora::server::RunArgs;
use pingora::server::Server;
#[cfg(unix)]
use pingora::server::ShutdownSignal;
#[cfg(unix)]
use pingora::server::ShutdownSignalWatch;
use pingora::services::listening::Service;
use serde::Serialize;
#[cfg(unix)]
use tokio::signal::unix;
use worker_abi::WorkerContext;
use worker_abi::WorkerEnv;
use worker_abi::WorkerRequest;

struct PingoraCliArgs {
    worker_entry: PathBuf,
    listen: String,
    worker_id: String,
    runtime_threads: usize,
    queue_capacity: usize,
    exec_timeout_ms: u64,
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
                "--shutdown-drain-timeout-ms" => {
                    parsed.shutdown_drain_timeout_ms = args
                        .next()
                        .context("--shutdown-drain-timeout-ms requires a value")?
                        .parse()
                        .context("--shutdown-drain-timeout-ms must be an integer")?;
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
}

struct WorkerHttpApp {
    runtime_manager: Arc<RuntimeGenerationManager>,
    drain_controller: Arc<RequestDrainController>,
    worker_id: String,
}

#[derive(Serialize)]
struct IngressSnapshot {
    drain: DrainSnapshot,
    runtime_pool: RuntimePoolSnapshot,
    generations: RuntimeGenerationManagerSnapshot,
}

#[derive(Clone)]
struct RuntimeGeneration {
    generation_id: u64,
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
    prepared_generation_id: Option<u64>,
    active_generation_id: u64,
    failed_generation_id: Option<u64>,
    failed_error: Option<String>,
    status: String,
}

#[derive(Debug, Clone, Serialize)]
struct PrepareAttemptSnapshot {
    target_generation_id: u64,
    worker_entry: String,
    status: String,
    project: Option<WorkerProjectSnapshot>,
    error: Option<String>,
}

#[derive(Clone)]
struct RuntimeGenerationManagerConfig {
    worker_entry: PathBuf,
    runtime_threads: usize,
    queue_capacity: usize,
    exec_timeout: Duration,
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
        let project = inspect_worker_project(&self.worker_entry).unwrap_or_else(|error| {
            eprintln!(
                "failed to refresh worker project snapshot for {}: {}",
                self.worker_entry.display(),
                error
            );
            self.project.clone()
        });
        RuntimeGenerationSnapshot {
            generation_id: self.generation_id,
            active,
            worker_entry: self.worker_entry.display().to_string(),
            prepare_status: "ready".to_string(),
            project,
            drain: self.drain_controller.snapshot(),
            runtime_pool: self.runtime_pool.metrics_snapshot(),
        }
    }
}

impl RuntimeGenerationManager {
    fn new(config: RuntimeGenerationManagerConfig) -> anyhow::Result<Arc<Self>> {
        let initial_generation = Arc::new(Self::build_generation(&config, 1)?);
        let version_state = RuntimeVersionStateSnapshot {
            desired_worker_entry: config.worker_entry.display().to_string(),
            desired_generation_id: 1,
            prepared_generation_id: Some(1),
            active_generation_id: 1,
            failed_generation_id: None,
            failed_error: None,
            status: "active".to_string(),
        };
        let last_prepare = PrepareAttemptSnapshot {
            target_generation_id: 1,
            worker_entry: config.worker_entry.display().to_string(),
            status: "ready".to_string(),
            project: Some(initial_generation.project.clone()),
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
        request: WorkerRequest,
        env: WorkerEnv,
        ctx: WorkerContext,
    ) -> Result<worker_abi::WorkerResponse, RuntimePoolError> {
        for _ in 0..4 {
            let generation = self.active_generation();
            if let Some(_guard) = generation.drain_controller.try_acquire() {
                return generation
                    .runtime_pool
                    .execute(request.clone(), env.clone(), ctx.clone())
                    .await;
            }

            tokio::task::yield_now().await;
        }

        Err(RuntimePoolError::Unavailable(
            "no active worker generation accepted the request".to_string(),
        ))
    }

    async fn apply_configured_worker_debug(
        self: &Arc<Self>,
    ) -> anyhow::Result<RuntimeGenerationManagerSnapshot> {
        let generation_id = self.next_generation_id.fetch_add(1, Ordering::Relaxed);
        {
            let mut version_state = self
                .version_state
                .lock()
                .expect("version state mutex should not be poisoned");
            version_state.desired_worker_entry = self.config.worker_entry.display().to_string();
            version_state.desired_generation_id = generation_id;
            version_state.status = "preparing".to_string();
            version_state.failed_generation_id = None;
            version_state.failed_error = None;
        }
        let next_generation = match Self::build_generation(&self.config, generation_id) {
            Ok(generation) => {
                {
                    let mut version_state = self
                        .version_state
                        .lock()
                        .expect("version state mutex should not be poisoned");
                    version_state.prepared_generation_id = Some(generation_id);
                    version_state.status = "prepared".to_string();
                }
                let prepare = PrepareAttemptSnapshot {
                    target_generation_id: generation_id,
                    worker_entry: self.config.worker_entry.display().to_string(),
                    status: "ready".to_string(),
                    project: Some(generation.project.clone()),
                    error: None,
                };
                *self
                    .last_prepare
                    .lock()
                    .expect("last prepare mutex should not be poisoned") = prepare;
                Arc::new(generation)
            }
            Err(error) => {
                {
                    let mut version_state = self
                        .version_state
                        .lock()
                        .expect("version state mutex should not be poisoned");
                    version_state.failed_generation_id = Some(generation_id);
                    version_state.failed_error = Some(error.to_string());
                    version_state.status = "failed".to_string();
                }
                let prepare = PrepareAttemptSnapshot {
                    target_generation_id: generation_id,
                    worker_entry: self.config.worker_entry.display().to_string(),
                    status: "failed".to_string(),
                    project: None,
                    error: Some(error.to_string()),
                };
                *self
                    .last_prepare
                    .lock()
                    .expect("last prepare mutex should not be poisoned") = prepare;
                return Err(error);
            }
        };

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
            let mut version_state = self
                .version_state
                .lock()
                .expect("version state mutex should not be poisoned");
            version_state.active_generation_id = generation_id;
            version_state.status = "active".to_string();
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
        inspect_worker_project(&self.config.worker_entry)
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
        generation_id: u64,
    ) -> anyhow::Result<RuntimeGeneration> {
        let project = inspect_worker_project(&config.worker_entry)?;
        Ok(RuntimeGeneration {
            generation_id,
            worker_entry: config.worker_entry.clone(),
            project,
            runtime_pool: WorkerRuntimePool::new(
                config.worker_entry.clone(),
                config.runtime_threads,
                config.queue_capacity,
                config.exec_timeout,
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

    async fn build_request(
        &self,
        http_stream: &mut ServerSession,
    ) -> Result<WorkerRequest, String> {
        let header = http_stream.req_header();
        let method = header.method.as_str().to_string();
        let uri = header.uri.to_string();
        let headers: std::collections::BTreeMap<String, String> = header
            .headers
            .iter()
            .filter_map(|(name, value)| {
                value
                    .to_str()
                    .ok()
                    .map(|value| (name.as_str().to_string(), value.to_string()))
            })
            .collect();
        let url = headers
            .get("host")
            .map(|host| format!("http://{host}{uri}"))
            .unwrap_or(uri);
        let body = http_stream
            .read_request_body()
            .await
            .map_err(|error| error.to_string())?
            .map(|bytes| String::from_utf8_lossy(&bytes).into_owned());

        Ok(WorkerRequest {
            method,
            url,
            headers,
            body,
        })
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

    fn public_error_http_response(&self, error: CompatPublicError) -> Response<Vec<u8>> {
        self.response_from_worker(public_error_response(error))
    }

    fn runtime_pool_error_response(&self, error: RuntimePoolError) -> Response<Vec<u8>> {
        self.public_error_http_response(error.to_compat_public_error())
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
}

#[async_trait]
impl ServeHttp for WorkerHttpApp {
    async fn response(&self, http_stream: &mut ServerSession) -> Response<Vec<u8>> {
        let header = http_stream.req_header();
        if header.method == http::Method::GET && header.uri.path() == "/_hardess/runtime-pool" {
            return self.metrics_response();
        }
        if header.method == http::Method::GET && header.uri.path() == "/_hardess/module-cache" {
            return self.module_cache_response();
        }
        if header.method == http::Method::GET && header.uri.path() == "/_hardess/ingress-state" {
            return self.ingress_state_response();
        }
        if header.method == http::Method::GET && header.uri.path() == "/_hardess/generations" {
            return self.generations_response();
        }
        if header.method == http::Method::POST && header.uri.path() == "/_hardess/cleanup-cache" {
            return self.cleanup_cache_response();
        }
        if header.method == http::Method::POST && header.uri.path() == "/_hardess/reload-worker" {
            // Debug-only local wrapper. Production direction is control-plane-driven apply.
            return match self.runtime_manager.apply_configured_worker_debug().await {
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
                    Err(error) => {
                        self.public_error_http_response(internal_public_error(error.to_string()))
                    }
                },
                Err(error) => {
                    self.public_error_http_response(internal_public_error(error.to_string()))
                }
            };
        }

        let _request_guard = match self.drain_controller.try_acquire() {
            Some(guard) => guard,
            None => return self.draining_response(),
        };

        let request = match self.build_request(http_stream).await {
            Ok(request) => request,
            Err(error) => {
                return self.public_error_http_response(bad_request_public_error(error));
            }
        };
        let worker_id = self.worker_id.clone();
        match self
            .runtime_manager
            .execute(
                request,
                WorkerEnv {
                    worker_id,
                    vars: Default::default(),
                },
                WorkerContext::default(),
            )
            .await
        {
            Ok(response) => self.response_from_worker(response),
            Err(error) => self.runtime_pool_error_response(error),
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
    let runtime_manager = RuntimeGenerationManager::new(RuntimeGenerationManagerConfig {
        worker_entry: cli.worker_entry.clone(),
        runtime_threads: cli.runtime_threads,
        queue_capacity: cli.queue_capacity,
        exec_timeout: Duration::from_millis(cli.exec_timeout_ms),
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
        HttpServer::new_app(WorkerHttpApp {
            runtime_manager,
            drain_controller: drain_controller.clone(),
            worker_id: cli.worker_id.clone(),
        }),
    );
    service.add_tcp(&cli.listen);

    println!(
        "pingora ingress listening on http://{} for worker_id={} runtime_threads={} queue_capacity={} exec_timeout_ms={} shutdown_drain_timeout_ms={} generation_drain_timeout_ms={}",
        cli.listen,
        cli.worker_id,
        cli.runtime_threads,
        cli.queue_capacity,
        cli.exec_timeout_ms,
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
                generation_drain_timeout: Duration::from_millis(10),
            })
            .expect("runtime manager should initialize"),
            drain_controller: Arc::new(RequestDrainController::new()),
            worker_id: "test-worker".to_string(),
        }
    }

    fn test_app() -> WorkerHttpApp {
        test_app_with_worker(sample_worker_path())
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
            generation_drain_timeout: Duration::from_millis(10),
        })
        .expect("runtime manager should initialize");

        let initial = manager.snapshot();
        assert_eq!(initial.active_generation_id, 1);
        assert_eq!(initial.generations.len(), 1);
        assert_eq!(initial.version_state.status, "active");
        assert_eq!(initial.version_state.desired_generation_id, 1);
        assert_eq!(initial.version_state.prepared_generation_id, Some(1));
        assert_eq!(initial.version_state.active_generation_id, 1);
        assert_eq!(initial.version_state.failed_generation_id, None);
        assert_eq!(initial.last_prepare.status, "ready");
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
        assert_eq!(reloaded.version_state.prepared_generation_id, Some(2));
        assert_eq!(reloaded.version_state.active_generation_id, 2);
        assert_eq!(reloaded.version_state.failed_generation_id, None);
        assert_eq!(reloaded.last_prepare.status, "ready");
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
        assert_eq!(snapshot.version_state.prepared_generation_id, Some(1));
        assert_eq!(snapshot.version_state.active_generation_id, 1);
        assert_eq!(snapshot.version_state.failed_generation_id, Some(2));
        assert!(snapshot
            .version_state
            .failed_error
            .as_deref()
            .expect("failed version state should keep error")
            .contains("Expected ident"));
        assert_eq!(snapshot.last_prepare.status, "failed");
        assert_eq!(snapshot.last_prepare.target_generation_id, 2);
        assert!(snapshot.last_prepare.project.is_none());
        assert!(snapshot
            .last_prepare
            .error
            .as_deref()
            .expect("failed prepare should keep error")
            .contains("Expected ident"));
    }
}
