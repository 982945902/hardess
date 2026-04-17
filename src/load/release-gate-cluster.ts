import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseClusterPeersAdminResponse } from "../runtime/cluster/schema.ts";
import { evaluateClusterWsGateSlo, readClusterWsGateSloThresholds } from "./gate-slo.ts";
import { runClusterWsLoadTest } from "./cluster-ws.ts";
import { applyClusterReleaseGateProfile } from "./profiles.ts";
import { envNumber, envNumberFirst, envString, envStringFirst, parseErrorPayload, parseJsonText } from "./shared.ts";

interface ManagedProcess {
  name: string;
  child: ReturnType<typeof spawn>;
  stdout: string[];
  stderr: string[];
}

type ListenerMode = "single" | "dual";

export interface ClusterReleaseGateOptions {
  nodeAPort?: number;
  nodeBPort?: number;
  nodeAControlPort?: number;
  nodeBControlPort?: number;
  nodeAInternalPort?: number;
  nodeBInternalPort?: number;
  upstreamPort?: number;
  readyTimeoutMs?: number;
  sharedSecret?: string;
  senderCount?: number;
  receiverCount?: number;
  messagesPerSender?: number;
  sendIntervalMs?: number;
  completionTimeoutMs?: number;
  metricsSink?: string;
  listenerMode?: ListenerMode;
}

export interface ClusterReleaseGateResult {
  ok: true;
  listenerMode: ListenerMode;
  nodeAPort: number;
  nodeBPort: number;
  nodeAControlPort?: number;
  nodeBControlPort?: number;
  nodeAInternalPort?: number;
  nodeBInternalPort?: number;
  upstreamPort: number;
  clusterWsLoad: Awaited<ReturnType<typeof runClusterWsLoadTest>>;
  slo: {
    clusterWs: ReturnType<typeof evaluateClusterWsGateSlo> & {
      profile: string;
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

  const body = parseClusterPeersAdminResponse(await response.json());
  if (body.nodeId !== expectedNodeId) {
    throw new Error(`Unexpected nodeId from ${baseUrl}: ${body.nodeId}`);
  }
  if (body.peers.length !== 1) {
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

function readListenerMode(raw: string | undefined, fallback: ListenerMode): ListenerMode {
  if (!raw) {
    return fallback;
  }

  if (raw === "single" || raw === "dual") {
    return raw;
  }

  throw new Error(`Invalid listener mode: ${raw}`);
}

export async function runClusterReleaseGate(
  overrides: ClusterReleaseGateOptions = {}
): Promise<ClusterReleaseGateResult> {
  applyClusterReleaseGateProfile(envString("CLUSTER_RELEASE_GATE_PROFILE", "default"));
  const clusterReleaseGateSloProfile = envString("CLUSTER_RELEASE_GATE_SLO_PROFILE", "default");
  const listenerMode = overrides.listenerMode ?? readListenerMode(
    envStringFirst(["CLUSTER_RELEASE_GATE_LISTENER_MODE"], "single"),
    "single"
  );
  const nodeAPort = overrides.nodeAPort ?? envNumber("CLUSTER_RELEASE_GATE_PORT_A", 3200);
  const nodeBPort = overrides.nodeBPort ?? envNumber("CLUSTER_RELEASE_GATE_PORT_B", 3201);
  const nodeAControlPort = listenerMode === "dual"
    ? overrides.nodeAControlPort ??
      overrides.nodeAInternalPort ??
      envNumberFirst(["CLUSTER_RELEASE_GATE_CONTROL_PORT_A", "CLUSTER_RELEASE_GATE_INTERNAL_PORT_A"], nodeAPort + 2)
    : undefined;
  const nodeBControlPort = listenerMode === "dual"
    ? overrides.nodeBControlPort ??
      overrides.nodeBInternalPort ??
      envNumberFirst(["CLUSTER_RELEASE_GATE_CONTROL_PORT_B", "CLUSTER_RELEASE_GATE_INTERNAL_PORT_B"], nodeBPort + 2)
    : undefined;
  const upstreamPort = overrides.upstreamPort ?? envNumber("CLUSTER_RELEASE_GATE_UPSTREAM_PORT", 9200);
  const readyTimeoutMs = overrides.readyTimeoutMs ?? envNumber("CLUSTER_RELEASE_GATE_READY_TIMEOUT_MS", 10_000);
  const sharedSecret = overrides.sharedSecret ?? envString("CLUSTER_RELEASE_GATE_SHARED_SECRET", "hardess-cluster-secret");
  const senderCount = overrides.senderCount ?? envNumber("CLUSTER_RELEASE_GATE_WS_SENDERS", 10);
  const receiverCount = overrides.receiverCount ?? envNumber("CLUSTER_RELEASE_GATE_WS_RECEIVERS", 10);
  const messagesPerSender = overrides.messagesPerSender ?? envNumber("CLUSTER_RELEASE_GATE_WS_MESSAGES_PER_SENDER", 30);
  const sendIntervalMs = overrides.sendIntervalMs ?? envNumber("CLUSTER_RELEASE_GATE_WS_SEND_INTERVAL_MS", 0);
  const completionTimeoutMs = overrides.completionTimeoutMs ?? envNumber("CLUSTER_RELEASE_GATE_WS_COMPLETION_TIMEOUT_MS", 20_000);
  const metricsSink = overrides.metricsSink ?? envString("CLUSTER_RELEASE_GATE_METRICS_SINK", "windowed");
  const clusterWsGateSloThresholds = readClusterWsGateSloThresholds(
    "CLUSTER_RELEASE_GATE_WS",
    clusterReleaseGateSloProfile
  );

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
      ...(listenerMode === "dual"
        ? {
            BUSINESS_PORT: String(nodeAPort),
            CONTROL_PORT: String(nodeAControlPort),
            BUSINESS_ALLOWED_PATH_PREFIXES: "/ws,/demo",
            CONTROL_ALLOWED_PATH_PREFIXES: "/__admin,/__cluster"
          }
        : {
            PORT: String(nodeAPort)
          }),
      CONFIG_MODULE_PATH: configPath,
      CLUSTER_TRANSPORT: "ws",
      CLUSTER_SHARED_SECRET: sharedSecret,
      CLUSTER_PEERS_JSON: JSON.stringify([
        {
          nodeId: "node-b",
          baseUrl: `http://127.0.0.1:${listenerMode === "dual" ? nodeBControlPort : nodeBPort}`
        }
      ]),
      METRICS_SINK: metricsSink
    });

    nodeB = spawnManagedProcess("runtime-node-b", ["run", "src/runtime/server.ts"], {
      NODE_ID: "node-b",
      ...(listenerMode === "dual"
        ? {
            BUSINESS_PORT: String(nodeBPort),
            CONTROL_PORT: String(nodeBControlPort),
            BUSINESS_ALLOWED_PATH_PREFIXES: "/ws,/demo",
            CONTROL_ALLOWED_PATH_PREFIXES: "/__admin,/__cluster"
          }
        : {
            PORT: String(nodeBPort)
          }),
      CONFIG_MODULE_PATH: configPath,
      CLUSTER_TRANSPORT: "ws",
      CLUSTER_SHARED_SECRET: sharedSecret,
      CLUSTER_PEERS_JSON: JSON.stringify([
        {
          nodeId: "node-a",
          baseUrl: `http://127.0.0.1:${listenerMode === "dual" ? nodeAControlPort : nodeAPort}`
        }
      ]),
      METRICS_SINK: metricsSink
    });

    const nodeAControlBaseUrl = `http://127.0.0.1:${nodeAControlPort ?? nodeAPort}`;
    const nodeBControlBaseUrl = `http://127.0.0.1:${nodeBControlPort ?? nodeBPort}`;
    const upstreamBaseUrl = `http://127.0.0.1:${upstreamPort}`;
    await Promise.all([
      waitForHttpOk(`${upstreamBaseUrl}/`, readyTimeoutMs),
      waitForReady(`${nodeAControlBaseUrl}/__admin/ready`, readyTimeoutMs),
      waitForReady(`${nodeBControlBaseUrl}/__admin/ready`, readyTimeoutMs)
    ]);

    await Promise.all([
      validateClusterPeers(nodeAControlBaseUrl, "node-a"),
      validateClusterPeers(nodeBControlBaseUrl, "node-b"),
      validatePrometheus(nodeAControlBaseUrl),
      validatePrometheus(nodeBControlBaseUrl)
    ]);

    clusterWsLoad = await runClusterWsLoadTest({
      senderWsUrl: `ws://127.0.0.1:${nodeAPort}/ws`,
      receiverWsUrl: `ws://127.0.0.1:${nodeBPort}/ws`,
      senderAdminBaseUrl: nodeAControlBaseUrl,
      receiverAdminBaseUrl: nodeBControlBaseUrl,
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
      listenerMode,
      nodeAPort,
      nodeBPort,
      nodeAControlPort,
      nodeBControlPort,
      nodeAInternalPort: nodeAControlPort,
      nodeBInternalPort: nodeBControlPort,
      upstreamPort,
      clusterWsLoad,
      slo: {
        clusterWs: {
          profile: clusterReleaseGateSloProfile,
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
    console.error(JSON.stringify(parseJsonText(message) ?? { ok: false, error: message }, null, 2));
    process.exitCode = 1;
  }
}
