use std::collections::BTreeMap;
use std::fs;
use std::path::PathBuf;
use std::time::Instant;

use gateway_host::DenoWorkerRuntime;
use gateway_host::RuntimeMicroBenchmarkSummary;
use gateway_host::WorkerWebSocketCloseEvent;
use gateway_host::WorkerWebSocketContext;
use gateway_host::WorkerWebSocketEvent;
use serde::Serialize;

#[derive(Debug, Clone)]
struct Config {
    warmup_iterations: usize,
    measured_iterations: usize,
}

#[derive(Debug, Clone, Serialize)]
struct EventSummary {
    iterations: usize,
    elapsed_ms: f64,
    operations_per_second: f64,
    average_us: f64,
}

#[derive(Debug, Clone, Serialize)]
struct BenchmarkSummary {
    warmup_iterations: usize,
    measured_iterations: usize,
    event_materialization: EventMaterializationSummary,
    context_materialization: ContextMaterializationSummary,
    open: EventSummary,
    message: EventSummary,
    close: EventSummary,
}

#[derive(Debug, Clone, Serialize)]
struct EventMaterializationSummary {
    open: RuntimeMicroBenchmarkSummary,
    message: RuntimeMicroBenchmarkSummary,
    close: RuntimeMicroBenchmarkSummary,
}

#[derive(Debug, Clone, Serialize)]
struct ContextMaterializationSummary {
    total: RuntimeMicroBenchmarkSummary,
    ids: RuntimeMicroBenchmarkSummary,
    vars: RuntimeMicroBenchmarkSummary,
    metadata: RuntimeMicroBenchmarkSummary,
}

fn env_usize(name: &str, fallback: usize) -> usize {
    std::env::var(name)
        .ok()
        .and_then(|value| value.parse::<usize>().ok())
        .filter(|value| *value > 0)
        .unwrap_or(fallback)
}

fn load_config() -> Config {
    Config {
        warmup_iterations: env_usize("WS_RUNTIME_MICRO_WARMUP", 20_000),
        measured_iterations: env_usize("WS_RUNTIME_MICRO_ITERATIONS", 100_000),
    }
}

fn unique_temp_dir(name: &str) -> PathBuf {
    let nonce = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .expect("system time should be after unix epoch")
        .as_nanos();
    let dir = std::env::temp_dir().join(format!(
        "hardess-pingora-worker-runtime-{name}-{}-{nonce}",
        std::process::id()
    ));
    fs::create_dir_all(&dir).expect("temp dir should be created");
    dir
}

fn temp_worker_path(name: &str, source: &str) -> PathBuf {
    let dir = unique_temp_dir(name);
    let worker_path = dir.join("mod.ts");
    fs::write(&worker_path, source).expect("temp worker should be written");
    worker_path
}

fn sample_context() -> WorkerWebSocketContext {
    WorkerWebSocketContext {
        connection_id: "micro-bench-connection".to_string(),
        worker_id: "micro-bench-worker".to_string(),
        vars: [("region".to_string(), "hz".to_string())]
            .into_iter()
            .collect::<BTreeMap<_, _>>(),
        metadata: [("stage".to_string(), "bench".to_string())]
            .into_iter()
            .collect::<BTreeMap<_, _>>(),
    }
}

async fn warmup(
    runtime: &mut DenoWorkerRuntime,
    ctx: &WorkerWebSocketContext,
    iterations: usize,
) -> Result<(), String> {
    for _ in 0..iterations {
        runtime
            .invoke_websocket(&WorkerWebSocketEvent::Open, ctx)
            .await?;
        runtime
            .invoke_websocket(
                &WorkerWebSocketEvent::Message {
                    text: "ping".to_string(),
                },
                ctx,
            )
            .await?;
        runtime
            .invoke_websocket(
                &WorkerWebSocketEvent::Close(WorkerWebSocketCloseEvent {
                    code: Some(1000),
                    reason: Some("done".to_string()),
                    remote: false,
                }),
                ctx,
            )
            .await?;
    }
    Ok(())
}

async fn measure_event(
    runtime: &mut DenoWorkerRuntime,
    event: WorkerWebSocketEvent,
    ctx: &WorkerWebSocketContext,
    iterations: usize,
) -> Result<EventSummary, String> {
    let started_at = Instant::now();
    for _ in 0..iterations {
        runtime.invoke_websocket(&event, ctx).await?;
    }
    let elapsed = started_at.elapsed();
    let elapsed_ms = elapsed.as_secs_f64() * 1000.0;
    let operations_per_second = iterations as f64 / elapsed.as_secs_f64();
    let average_us = elapsed.as_secs_f64() * 1_000_000.0 / iterations as f64;
    Ok(EventSummary {
        iterations,
        elapsed_ms,
        operations_per_second,
        average_us,
    })
}

#[tokio::main(flavor = "current_thread")]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let config = load_config();
    let worker_path = temp_worker_path(
        "websocket-runtime-micro",
        r#"
export function fetch() {
  return new Response("ok");
}

export const websocket = {
  onOpen(ctx) {
    void ctx.connectionId;
    void ctx.workerId;
    void ctx.metadata.stage;
    void ctx.vars.region;
  },
  onMessage(message, ctx) {
    if (message.kind !== "text") {
      throw new Error("unexpected message kind");
    }
    void message.text;
    void ctx.connectionId;
  },
  onClose(event, ctx) {
    void event.code;
    void event.reason;
    void event.remote;
    void ctx.workerId;
  },
};
"#,
    );
    let mut runtime = DenoWorkerRuntime::new(&worker_path).await?;
    let ctx = sample_context();

    warmup(&mut runtime, &ctx, config.warmup_iterations).await?;

    let event_materialization = EventMaterializationSummary {
        open: runtime.benchmark_websocket_event_materialization(
            &WorkerWebSocketEvent::Open,
            config.measured_iterations,
        )?,
        message: runtime.benchmark_websocket_event_materialization(
            &WorkerWebSocketEvent::Message {
                text: "ping".to_string(),
            },
            config.measured_iterations,
        )?,
        close: runtime.benchmark_websocket_event_materialization(
            &WorkerWebSocketEvent::Close(WorkerWebSocketCloseEvent {
                code: Some(1000),
                reason: Some("done".to_string()),
                remote: false,
            }),
            config.measured_iterations,
        )?,
    };
    let context_materialization = ContextMaterializationSummary {
        total: runtime
            .benchmark_websocket_context_materialization(&ctx, config.measured_iterations)?,
        ids: runtime
            .benchmark_websocket_context_id_materialization(&ctx, config.measured_iterations)?,
        vars: runtime
            .benchmark_websocket_context_vars_materialization(&ctx, config.measured_iterations)?,
        metadata: runtime.benchmark_websocket_context_metadata_materialization(
            &ctx,
            config.measured_iterations,
        )?,
    };

    let open = measure_event(
        &mut runtime,
        WorkerWebSocketEvent::Open,
        &ctx,
        config.measured_iterations,
    )
    .await?;
    let message = measure_event(
        &mut runtime,
        WorkerWebSocketEvent::Message {
            text: "ping".to_string(),
        },
        &ctx,
        config.measured_iterations,
    )
    .await?;
    let close = measure_event(
        &mut runtime,
        WorkerWebSocketEvent::Close(WorkerWebSocketCloseEvent {
            code: Some(1000),
            reason: Some("done".to_string()),
            remote: false,
        }),
        &ctx,
        config.measured_iterations,
    )
    .await?;

    println!(
        "{}",
        serde_json::to_string_pretty(&BenchmarkSummary {
            warmup_iterations: config.warmup_iterations,
            measured_iterations: config.measured_iterations,
            event_materialization,
            context_materialization,
            open,
            message,
            close,
        })?
    );

    Ok(())
}
