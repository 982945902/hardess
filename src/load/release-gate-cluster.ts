import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { envNumber, envString } from "./shared.ts";
import { evaluateClusterWsGateSlo, readClusterWsGateSloThresholds } from "./gate-slo.ts";
import { runClusterWsLoadTest } from "./cluster-ws.ts";
import { applyClusterReleaseGateProfile } from "./profiles.ts";

interface ManagedProcess {
  name: string;
  child: ReturnType<typeof spawn>;
  stdout: string[];
  stderr: string[];
}

export interface ClusterReleaseGateOptions {
  nodeAPort?: number;
  nodeBPort?: number;
  upstreamPort?: number;
  readyTimeoutMs?: number;
  sharedSecret?: string;
  senderCount?: number;
  receiverCount?: number;
  messagesPerSender?: number;
  sendIntervalMs?: number;
  completionTimeoutMs?: number;
  metricsSink?: string;
}

export interface ClusterReleaseGateResult {
  ok: true;
  nodeAPort: number;
  nodeBPort: number;
  upstreamPort: number;
  clusterWsLoad: Awaited<ReturnType<typeof runClusterWsLoadTest>>;
  slo: {
    clusterWs: ReturnType<typeof evaluateClusterWsGateSlo> & {
      thresholds: ReturnType<typeof readClusterWsGateSloThresholds>;
    };
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function tail(lines: string[], count = 20): string[] {
  return lines.slice(-count);
}

function parseErrorPayload(error: unknown): unknown {
  const message = error instanceof Error ? error.message : String(error);
  try {
    return JSON.parse(message);
  } catch {
    return message;
  }
}

function spawnManagedProcess(name: string, args: string[], extraEnv: Record<string, string>): ManagedProcess {
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

  return { name, child, stdout, stderr };
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

async function validateClusterPeers(baseUrl: string, expectedNodeId: string): Promise<void> {
  const response = await fetch(`${baseUrl}/__admin/cluster/peers`);
  if (!response.ok) {
    throw new Error(`Cluster peers endpoint failed for ${baseUrl}`);
  }

  const body = await response.json() as { nodeId?: string; peers?: Array<{ nodeId: string }> };
  if (body.nodeId !== expectedNodeId) {
    throw new Error(`Unexpected nodeId from ${baseUrl}: ${body.nodeId}`);
  }
  if (!Array.isArray(body.peers) || body.peers.length !== 1) {
    throw new Error(`Expected one configured cluster peer from ${baseUrl}`);
  }
}

async function validatePrometheus(baseUrl: string): Promise<void> {
  const response = await fetch(`${baseUrl}/__admin/metrics/prometheus`);
  if (!response.ok) {
    throw new Error(`Prometheus exporter failed for ${baseUrl}`);
  }

  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("text/plain")) {
    throw new Error(`Prometheus exporter returned unexpected content type for ${baseUrl}: ${contentType}`);
  }
}

export async function runClusterReleaseGate(
  overrides: ClusterReleaseGateOptions = {}
): Promise<ClusterReleaseGateResult> {
  applyClusterReleaseGateProfile(envString("CLUSTER_RELEASE_GATE_PROFILE", "default"));
  const nodeAPort = overrides.nodeAPort ?? envNumber("CLUSTER_RELEASE_GATE_PORT_A", 3200);
  const nodeBPort = overrides.nodeBPort ?? envNumber("CLUSTER_RELEASE_GATE_PORT_B", 3201);
  const upstreamPort = overrides.upstreamPort ?? envNumber("CLUSTER_RELEASE_GATE_UPSTREAM_PORT", 9200);
  const readyTimeoutMs = overrides.readyTimeoutMs ?? envNumber("CLUSTER_RELEASE_GATE_READY_TIMEOUT_MS", 10_000);
  const sharedSecret = overrides.sharedSecret ?? envString("CLUSTER_RELEASE_GATE_SHARED_SECRET", "hardess-cluster-secret");
  const senderCount = overrides.senderCount ?? envNumber("CLUSTER_RELEASE_GATE_WS_SENDERS", 10);
  const receiverCount = overrides.receiverCount ?? envNumber("CLUSTER_RELEASE_GATE_WS_RECEIVERS", 10);
  const messagesPerSender = overrides.messagesPerSender ?? envNumber("CLUSTER_RELEASE_GATE_WS_MESSAGES_PER_SENDER", 30);
  const sendIntervalMs = overrides.sendIntervalMs ?? envNumber("CLUSTER_RELEASE_GATE_WS_SEND_INTERVAL_MS", 0);
  const completionTimeoutMs = overrides.completionTimeoutMs ?? envNumber("CLUSTER_RELEASE_GATE_WS_COMPLETION_TIMEOUT_MS", 20_000);
  const metricsSink = overrides.metricsSink ?? envString("CLUSTER_RELEASE_GATE_METRICS_SINK", "windowed");
  const clusterWsGateSloThresholds = readClusterWsGateSloThresholds();

  const tempDir = await mkdtemp(join(tmpdir(), "hardess-cluster-release-gate-"));
  let upstream: ManagedProcess | undefined;
  let nodeA: ManagedProcess | undefined;
  let nodeB: ManagedProcess | undefined;
  let clusterWsLoad: Awaited<ReturnType<typeof runClusterWsLoadTest>> | undefined;

  try {
    const configPath = join(tempDir, "hardess.cluster.release-gate.config.ts");
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

    nodeA = spawnManagedProcess("runtime-node-a", ["run", "src/runtime/server.ts"], {
      NODE_ID: "node-a",
      PORT: String(nodeAPort),
      CONFIG_MODULE_PATH: configPath,
      CLUSTER_TRANSPORT: "ws",
      CLUSTER_SHARED_SECRET: sharedSecret,
      CLUSTER_PEERS_JSON: JSON.stringify([{ nodeId: "node-b", baseUrl: `http://127.0.0.1:${nodeBPort}` }]),
      METRICS_SINK: metricsSink
    });

    nodeB = spawnManagedProcess("runtime-node-b", ["run", "src/runtime/server.ts"], {
      NODE_ID: "node-b",
      PORT: String(nodeBPort),
      CONFIG_MODULE_PATH: configPath,
      CLUSTER_TRANSPORT: "ws",
      CLUSTER_SHARED_SECRET: sharedSecret,
      CLUSTER_PEERS_JSON: JSON.stringify([{ nodeId: "node-a", baseUrl: `http://127.0.0.1:${nodeAPort}` }]),
      METRICS_SINK: metricsSink
    });

    const nodeABaseUrl = `http://127.0.0.1:${nodeAPort}`;
    const nodeBBaseUrl = `http://127.0.0.1:${nodeBPort}`;
    const upstreamBaseUrl = `http://127.0.0.1:${upstreamPort}`;
    await Promise.all([
      waitForHttpOk(`${upstreamBaseUrl}/`, readyTimeoutMs),
      waitForReady(`${nodeABaseUrl}/__admin/ready`, readyTimeoutMs),
      waitForReady(`${nodeBBaseUrl}/__admin/ready`, readyTimeoutMs)
    ]);

    await Promise.all([
      validateClusterPeers(nodeABaseUrl, "node-a"),
      validateClusterPeers(nodeBBaseUrl, "node-b"),
      validatePrometheus(nodeABaseUrl),
      validatePrometheus(nodeBBaseUrl)
    ]);

    clusterWsLoad = await runClusterWsLoadTest({
      senderWsUrl: `ws://127.0.0.1:${nodeAPort}/ws`,
      receiverWsUrl: `ws://127.0.0.1:${nodeBPort}/ws`,
      senderAdminBaseUrl: nodeABaseUrl,
      receiverAdminBaseUrl: nodeBBaseUrl,
      senderCount,
      receiverCount,
      messagesPerSender,
      sendIntervalMs,
      completionTimeoutMs
    });

    if (Object.keys(clusterWsLoad.summary.sysErrCodes).length > 0) {
      throw new Error(
        JSON.stringify({
          message: "Cluster WS load reported sys.err events",
          sysErrCodes: clusterWsLoad.summary.sysErrCodes,
          clusterWsLoadSummary: clusterWsLoad.summary,
          senderMetricsDelta: clusterWsLoad.senderMetricsDelta,
          receiverMetricsDelta: clusterWsLoad.receiverMetricsDelta
        })
      );
    }
    if (
      clusterWsLoad.summary.pendingMessages !== 0 ||
      clusterWsLoad.summary.handleAckCount !== clusterWsLoad.summary.messagesSent
    ) {
      throw new Error(
        JSON.stringify({
          message:
            `Cluster WS load did not fully ack all messages: pending=${clusterWsLoad.summary.pendingMessages} ` +
            `handleAck=${clusterWsLoad.summary.handleAckCount} expected=${clusterWsLoad.summary.messagesSent}`,
          clusterWsLoadSummary: clusterWsLoad.summary,
          senderMetricsDelta: clusterWsLoad.senderMetricsDelta,
          receiverMetricsDelta: clusterWsLoad.receiverMetricsDelta
        })
      );
    }
    const clusterWsGateSlo = evaluateClusterWsGateSlo(clusterWsLoad.summary, clusterWsGateSloThresholds);
    if (!clusterWsGateSlo.passed) {
      throw new Error(
        JSON.stringify({
          message: "Cluster WS load exceeded SLO thresholds",
          violations: clusterWsGateSlo.violations,
          thresholds: clusterWsGateSloThresholds,
          clusterWsLoadSummary: clusterWsLoad.summary,
          senderMetricsDelta: clusterWsLoad.senderMetricsDelta,
          receiverMetricsDelta: clusterWsLoad.receiverMetricsDelta
        })
      );
    }

    return {
      ok: true,
      nodeAPort,
      nodeBPort,
      upstreamPort,
      clusterWsLoad,
      slo: {
        clusterWs: {
          thresholds: clusterWsGateSloThresholds,
          ...clusterWsGateSlo
        }
      }
    };
  } catch (error) {
    throw new Error(
      JSON.stringify(
        {
          ok: false,
          error: parseErrorPayload(error),
          clusterWsLoadSummary: clusterWsLoad?.summary,
          senderMetricsDelta: clusterWsLoad?.senderMetricsDelta,
          receiverMetricsDelta: clusterWsLoad?.receiverMetricsDelta,
          upstream: upstream ? { stdoutTail: tail(upstream.stdout), stderrTail: tail(upstream.stderr) } : null,
          nodeA: nodeA ? { stdoutTail: tail(nodeA.stdout), stderrTail: tail(nodeA.stderr) } : null,
          nodeB: nodeB ? { stdoutTail: tail(nodeB.stdout), stderrTail: tail(nodeB.stderr) } : null
        },
        null,
        2
      )
    );
  } finally {
    if (nodeA) {
      await stopProcess(nodeA).catch(() => {});
    }
    if (nodeB) {
      await stopProcess(nodeB).catch(() => {});
    }
    if (upstream) {
      await stopProcess(upstream).catch(() => {});
    }
    await rm(tempDir, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  try {
    console.log(JSON.stringify(await runClusterReleaseGate(), null, 2));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    try {
      console.error(JSON.stringify(JSON.parse(message), null, 2));
    } catch {
      console.error(JSON.stringify({ ok: false, error: message }, null, 2));
    }
    process.exitCode = 1;
  }
}
