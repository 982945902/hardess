use anyhow::Result;
use gateway_host::CliArgs;
use gateway_host::DenoWorkerRuntime;
use worker_abi::WorkerContext;
use worker_abi::WorkerEnv;
use worker_abi::WorkerRequest;
use worker_abi::WorkerRuntime;

#[tokio::main(flavor = "current_thread")]
async fn main() -> Result<()> {
    let cli = CliArgs::parse()?;
    let mut runtime = DenoWorkerRuntime::new(&cli.worker_entry).await?;
    let response = runtime
        .fetch(
            WorkerRequest {
                method: cli.method,
                url: cli.url,
                headers: Default::default(),
                body: cli.body,
            },
            WorkerEnv {
                worker_id: cli.worker_id,
                vars: Default::default(),
            },
            WorkerContext::default(),
        )
        .await
        .map_err(anyhow::Error::msg)?;

    println!("runtime={}", runtime.name());
    println!("{}", serde_json::to_string_pretty(&response)?);

    Ok(())
}
