import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { envNumber, envString } from "./shared.ts";
import { evaluateHttpGateSlo, evaluateWsGateSlo, readHttpGateSloThresholds, readWsGateSloThresholds } from "./gate-slo.ts";
import { runHttpLoadTest } from "./http.ts";
import { runWsLoadTest } from "./ws.ts";

interface ManagedProcess {
  name: string;
  child: ReturnType<typeof spawn>;
  stdout: string[];
  stderr: string[];
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function tail(lines: string[], count = 20): string[] {
  return lines.slice(-count);
}

function spawnManagedProcess(
  name: string,
  args: string[],
  extraEnv: Record<string, string>
): ManagedProcess {
  const child = spawn("bun", args, {
    cwd: process.cwd(),
    env: {
      ...process.env,
      ...extraEnv
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  const stdout: string[] = [];
  const stderr: string[] = [];
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdout.push(chunk.trimEnd());
  });
  child.stderr.on("data", (chunk: string) => {
    stderr.push(chunk.trimEnd());
  });

  return {
    name,
    child,
    stdout,
    stderr
  };
}

async function stopProcess(processRef: ManagedProcess, signal: NodeJS.Signals = "SIGTERM"): Promise<number | null> {
  if (processRef.child.exitCode !== null) {
    return processRef.child.exitCode;
  }

  processRef.child.kill(signal);
  return await new Promise<number | null>((resolve) => {
    const killTimer = setTimeout(() => {
      if (processRef.child.exitCode === null) {
        processRef.child.kill("SIGKILL");
      }
    }, 5_000);

    processRef.child.once("exit", (code) => {
      clearTimeout(killTimer);
      resolve(code);
    });
  });
}

async function waitForReady(url: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) {
        return;
      }
    } catch {}

    await sleep(100);
  }

  throw new Error(`Timed out waiting for readiness: ${url}`);
}

async function waitForHttpOk(url: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) {
        return;
      }
    } catch {}

    await sleep(100);
  }

  throw new Error(`Timed out waiting for upstream readiness: ${url}`);
}

async function validateShutdownReadiness(baseUrl: string, runtime: ManagedProcess): Promise<boolean> {
  runtime.child.kill("SIGTERM");
  const deadline = Date.now() + 5_000;

  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/__admin/ready`);
      if (response.status === 503) {
        await stopProcess(runtime, "SIGTERM");
        return true;
      }
    } catch {
      if (runtime.child.exitCode !== null) {
        return false;
      }
    }

    await sleep(50);
  }

  await stopProcess(runtime, "SIGTERM");
  return false;
}

async function runHttpSmoke(baseUrl: string): Promise<{ status: number; body: unknown }> {
  const response = await fetch(`${baseUrl}/demo/orders`, {
    headers: {
      authorization: "Bearer demo:alice"
    }
  });

  return {
    status: response.status,
    body: await response.json()
  };
}

const runtimePort = envNumber("RELEASE_GATE_PORT", 3100);
const upstreamPort = envNumber("RELEASE_GATE_UPSTREAM_PORT", 9100);
const readyTimeoutMs = envNumber("RELEASE_GATE_READY_TIMEOUT_MS", 10_000);
const httpGateSloThresholds = readHttpGateSloThresholds();
const wsGateSloThresholds = readWsGateSloThresholds("RELEASE_GATE_WS");

const tempDir = await mkdtemp(join(tmpdir(), "hardess-release-gate-"));
let upstream: ManagedProcess | undefined;
let runtime: ManagedProcess | undefined;

try {
  const configPath = join(tempDir, "hardess.release-gate.config.ts");
  await writeFile(
    configPath,
    `export const hardessConfig = {
  pipelines: [
    {
      id: "demo-http",
      matchPrefix: "/demo",
      auth: { required: true },
      downstream: {
        origin: "http://127.0.0.1:${upstreamPort}",
        connectTimeoutMs: 1000,
        responseTimeoutMs: 5000,
        forwardAuthContext: true,
        injectedHeaders: {
          "x-hardess-pipeline": "demo-http"
        }
      },
      worker: {
        entry: "workers/demo-worker.ts",
        timeoutMs: 50
      }
    }
  ]
};`
  );

  upstream = spawnManagedProcess("demo-upstream", ["run", "demo:upstream"], {
    UPSTREAM_PORT: String(upstreamPort)
  });

  runtime = spawnManagedProcess("runtime", ["run", "src/runtime/server.ts"], {
    PORT: String(runtimePort),
    CONFIG_MODULE_PATH: configPath,
    SHUTDOWN_DRAIN_MS: envString("RELEASE_GATE_SHUTDOWN_DRAIN_MS", "750"),
    METRICS_SINK: envString("RELEASE_GATE_METRICS_SINK", "windowed")
  });

  const baseUrl = `http://127.0.0.1:${runtimePort}`;
  const upstreamBaseUrl = `http://127.0.0.1:${upstreamPort}`;
  await waitForHttpOk(`${upstreamBaseUrl}/`, readyTimeoutMs);
  await waitForReady(`${baseUrl}/__admin/ready`, readyTimeoutMs);

  const smoke = await runHttpSmoke(baseUrl);
  if (smoke.status !== 200) {
    throw new Error(`HTTP smoke failed with status ${smoke.status}`);
  }

  const httpLoad = await runHttpLoadTest({
    baseUrl,
    adminBaseUrl: baseUrl,
    concurrency: envNumber("RELEASE_GATE_HTTP_CONCURRENCY", 20),
    totalRequests: envNumber("RELEASE_GATE_HTTP_REQUESTS", 300)
  });
  if (Object.keys(httpLoad.summary.errorCounts).length > 0) {
    throw new Error(`HTTP load reported transport errors: ${JSON.stringify(httpLoad.summary.errorCounts)}`);
  }
  if (httpLoad.summary.successCount !== httpLoad.summary.completed) {
    throw new Error(`HTTP load saw non-2xx responses: ${JSON.stringify(httpLoad.summary.statusCounts)}`);
  }
  const httpGateSlo = evaluateHttpGateSlo(httpLoad.summary, httpGateSloThresholds);
  if (!httpGateSlo.passed) {
    throw new Error(
      `HTTP load exceeded SLO thresholds: ${JSON.stringify(httpGateSlo.violations)}`
    );
  }

  const wsLoad = await runWsLoadTest({
    wsUrl: `ws://127.0.0.1:${runtimePort}/ws`,
    adminBaseUrl: baseUrl,
    senderCount: envNumber("RELEASE_GATE_WS_SENDERS", 10),
    receiverCount: envNumber("RELEASE_GATE_WS_RECEIVERS", 10),
    messagesPerSender: envNumber("RELEASE_GATE_WS_MESSAGES_PER_SENDER", 30),
    completionTimeoutMs: envNumber("RELEASE_GATE_WS_COMPLETION_TIMEOUT_MS", 20_000)
  });
  if (Object.keys(wsLoad.summary.sysErrCodes).length > 0) {
    throw new Error(`WS load reported sys.err events: ${JSON.stringify(wsLoad.summary.sysErrCodes)}`);
  }
  if (wsLoad.summary.pendingMessages !== 0 || wsLoad.summary.handleAckCount !== wsLoad.summary.messagesSent) {
    throw new Error(
      `WS load did not fully ack all messages: pending=${wsLoad.summary.pendingMessages} handleAck=${wsLoad.summary.handleAckCount} expected=${wsLoad.summary.messagesSent}`
    );
  }
  const wsGateSlo = evaluateWsGateSlo(wsLoad.summary, wsGateSloThresholds);
  if (!wsGateSlo.passed) {
    throw new Error(`WS load exceeded SLO thresholds: ${JSON.stringify(wsGateSlo.violations)}`);
  }

  const readyDroppedBeforeExit = await validateShutdownReadiness(baseUrl, runtime);
  if (!readyDroppedBeforeExit) {
    throw new Error("Runtime did not expose 503 readiness during graceful shutdown");
  }

  const result = {
    ok: true,
    runtimePort,
    upstreamPort,
    smoke,
    httpLoad,
    wsLoad,
    slo: {
      http: {
        thresholds: httpGateSloThresholds,
        ...httpGateSlo
      },
      ws: {
        thresholds: wsGateSloThresholds,
        ...wsGateSlo
      }
    },
    shutdown: {
      readyDroppedBeforeExit
    }
  };

  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  console.error(
    JSON.stringify(
      {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
        upstream: upstream
          ? {
              stdoutTail: tail(upstream.stdout),
              stderrTail: tail(upstream.stderr)
            }
          : null,
        runtime: runtime
          ? {
              stdoutTail: tail(runtime.stdout),
              stderrTail: tail(runtime.stderr)
            }
          : null
      },
      null,
      2
    )
  );
  process.exitCode = 1;
} finally {
  if (runtime) {
    await stopProcess(runtime).catch(() => {});
  }
  if (upstream) {
    await stopProcess(upstream).catch(() => {});
  }
  await rm(tempDir, { recursive: true, force: true });
}
