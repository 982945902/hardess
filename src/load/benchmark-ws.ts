import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { evaluateWsGateSlo, readWsGateSloThresholds } from "./gate-slo.ts";
import { applyWsBenchmarkProfile } from "./profiles.ts";
import { envNumber, envString, parseErrorPayload, summarizeSeries } from "./shared.ts";
import { runWsLoadTest } from "./ws.ts";

interface ManagedProcess {
  name: string;
  child: ReturnType<typeof spawn>;
  stdout: string[];
  stderr: string[];
}

interface BenchmarkWsViolation {
  metric: string;
  actual: number;
  threshold: number;
}

interface BenchmarkWsScenarioResult {
  messagesPerSender: number;
  expectedMessages: number;
  likelyPolicyLimited: boolean;
  successRuns: number;
  sloPassingRuns: number;
  totalRuns: number;
  sloPassed: boolean;
  firstSloFailure?: {
    run: number;
    violations: BenchmarkWsViolation[];
  };
  firstFailure?: {
    run: number;
    error: unknown;
  };
  throughputMps: ReturnType<typeof summarizeSeries>;
  recvAckP99Ms: ReturnType<typeof summarizeSeries>;
  handleAckP99Ms: ReturnType<typeof summarizeSeries>;
  sysErrCount: ReturnType<typeof summarizeSeries>;
  egressOverflowCount: ReturnType<typeof summarizeSeries>;
  egressBackpressureCount: ReturnType<typeof summarizeSeries>;
  runs: Array<{
    run: number;
    ok: boolean;
    throughputMps?: number;
    recvAckP99Ms?: number;
    handleAckP99Ms?: number;
    sysErrCount?: number;
    egressOverflowCount?: number;
    egressBackpressureCount?: number;
    sloPassed?: boolean;
    sloViolations?: BenchmarkWsViolation[];
    elapsedMs?: number;
    error?: unknown;
  }>;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

function parseScenarioValues(raw: string): number[] {
  return raw
    .split(",")
    .map((value) => Number(value.trim()))
    .filter((value) => Number.isFinite(value) && value > 0);
}

function countValues(values: Record<string, number>): number {
  return Object.values(values).reduce((sum, value) => sum + value, 0);
}

function counterValue(counters: Record<string, number> | undefined, name: string): number {
  return counters?.[name] ?? 0;
}

function formatSloViolations(violations: BenchmarkWsViolation[]): string {
  if (violations.length === 0) {
    return "none";
  }

  return violations
    .map((violation) => `${violation.metric}=${violation.actual} threshold=${violation.threshold}`)
    .join(",");
}

const benchmarkProfile = applyWsBenchmarkProfile(envString("BENCH_WS_PROFILE", "default"));
const benchmarkSloProfile = envString("BENCH_WS_SLO_PROFILE", "default");
const senderCount = envNumber("BENCH_WS_SENDERS", 10);
const receiverCount = envNumber("BENCH_WS_RECEIVERS", 10);
const scenarioValues = parseScenarioValues(envString("BENCH_WS_SCENARIOS", "30,60,90,120"));
const runsPerScenario = envNumber("BENCH_WS_RUNS", 3);
const completionTimeoutMs = envNumber("BENCH_WS_COMPLETION_TIMEOUT_MS", 40_000);
const readyTimeoutMs = envNumber("BENCH_WS_READY_TIMEOUT_MS", 10_000);
const portBase = envNumber("BENCH_WS_PORT_BASE", 3600);
const sendIntervalMs = envNumber("BENCH_WS_SEND_INTERVAL_MS", 0);
const metricsSink = envString("BENCH_WS_METRICS_SINK", "windowed");
const wsRateLimitWindowMs = envNumber("WS_RATE_LIMIT_WINDOW_MS", 1_000);
const wsRateLimitMaxMessages = envNumber("WS_RATE_LIMIT_MAX_MESSAGES", 100);
const sloThresholds = readWsGateSloThresholds("BENCH_WS", benchmarkSloProfile);

const tempDir = await mkdtemp(join(tmpdir(), "hardess-bench-ws-"));
const configPath = join(tempDir, "hardess.bench-ws.config.ts");
await writeFile(
  configPath,
  `export const hardessConfig = {
  pipelines: [
    {
      id: "demo-http",
      matchPrefix: "/demo",
      auth: { required: true },
      downstream: {
        origin: "http://127.0.0.1:9",
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

const results: BenchmarkWsScenarioResult[] = [];
let firstUnstableScenario: number | undefined;
let firstSloFailedScenario: number | undefined;

try {
  for (const [scenarioIndex, messagesPerSender] of scenarioValues.entries()) {
    const throughputRuns: number[] = [];
    const recvAckP99Runs: number[] = [];
    const handleAckP99Runs: number[] = [];
    const sysErrCountRuns: number[] = [];
    const egressOverflowRuns: number[] = [];
    const egressBackpressureRuns: number[] = [];
    const runs: BenchmarkWsScenarioResult["runs"] = [];
    let firstFailure: BenchmarkWsScenarioResult["firstFailure"] | undefined;
    let firstSloFailure: BenchmarkWsScenarioResult["firstSloFailure"] | undefined;

    for (let runIndex = 0; runIndex < runsPerScenario; runIndex += 1) {
      const runtimePort = portBase + scenarioIndex * 10 + runIndex;
      let runtime: ManagedProcess | undefined;
      console.error(
        `[bench:ws] scenario=${messagesPerSender} run=${runIndex + 1}/${runsPerScenario} status=starting`
      );

      try {
        runtime = spawnManagedProcess("runtime", ["run", "src/runtime/server.ts"], {
          PORT: String(runtimePort),
          CONFIG_MODULE_PATH: configPath,
          METRICS_SINK: metricsSink,
          SHUTDOWN_DRAIN_MS: "0"
        });

        const baseUrl = `http://127.0.0.1:${runtimePort}`;
        await waitForReady(`${baseUrl}/__admin/ready`, readyTimeoutMs);
        const wsLoad = await runWsLoadTest({
          wsUrl: `ws://127.0.0.1:${runtimePort}/ws`,
          adminBaseUrl: baseUrl,
          senderCount,
          receiverCount,
          messagesPerSender,
          sendIntervalMs,
          completionTimeoutMs
        });
        const sysErrCount = countValues(wsLoad.summary.sysErrCodes);
        const egressOverflowCount = counterValue(wsLoad.metricsDelta?.counters, "ws.egress_overflow");
        const egressBackpressureCount = counterValue(wsLoad.metricsDelta?.counters, "ws.egress_backpressure");
        if (sysErrCount > 0) {
          throw new Error(
            JSON.stringify({
              message: "WS benchmark run reported sys.err events",
              sysErrCodes: wsLoad.summary.sysErrCodes,
              wsLoadSummary: wsLoad.summary,
              metricsDelta: wsLoad.metricsDelta
            })
          );
        }
        if (wsLoad.summary.pendingMessages !== 0 || wsLoad.summary.handleAckCount !== wsLoad.summary.messagesSent) {
          throw new Error(
            JSON.stringify({
              message:
                `WS benchmark run did not fully ack all messages: pending=${wsLoad.summary.pendingMessages} ` +
                `handleAck=${wsLoad.summary.handleAckCount} expected=${wsLoad.summary.messagesSent}`,
              wsLoadSummary: wsLoad.summary,
              metricsDelta: wsLoad.metricsDelta
            })
          );
        }

        const slo = evaluateWsGateSlo(
          {
            ...wsLoad.summary,
            egressOverflowCount,
            egressBackpressureCount
          },
          sloThresholds
        );
        const sloPassed = slo.passed;

        throughputRuns.push(wsLoad.summary.messagesPerSecond);
        recvAckP99Runs.push(wsLoad.summary.recvAckLatencyMs.p99Ms);
        handleAckP99Runs.push(wsLoad.summary.handleAckLatencyMs.p99Ms);
        sysErrCountRuns.push(sysErrCount);
        egressOverflowRuns.push(egressOverflowCount);
        egressBackpressureRuns.push(egressBackpressureCount);
        if (!sloPassed) {
          firstSloFailure ??= {
            run: runIndex + 1,
            violations: slo.violations
          };
        }

        runs.push({
          run: runIndex + 1,
          ok: true,
          throughputMps: wsLoad.summary.messagesPerSecond,
          recvAckP99Ms: wsLoad.summary.recvAckLatencyMs.p99Ms,
          handleAckP99Ms: wsLoad.summary.handleAckLatencyMs.p99Ms,
          sysErrCount,
          egressOverflowCount,
          egressBackpressureCount,
          sloPassed,
          sloViolations: slo.violations,
          elapsedMs: wsLoad.summary.elapsedMs
        });
        console.error(
          `[bench:ws] scenario=${messagesPerSender} run=${runIndex + 1}/${runsPerScenario} ` +
            `status=ok throughput=${wsLoad.summary.messagesPerSecond.toFixed(2)} ` +
            `recvAckP99Ms=${wsLoad.summary.recvAckLatencyMs.p99Ms.toFixed(2)} ` +
            `handleAckP99Ms=${wsLoad.summary.handleAckLatencyMs.p99Ms.toFixed(2)} ` +
            `egressOverflow=${egressOverflowCount} egressBackpressure=${egressBackpressureCount} ` +
            `sysErrCount=${sysErrCount} slo=${sloPassed ? "pass" : "fail"} ` +
            `sloViolations=${formatSloViolations(slo.violations)} elapsedMs=${wsLoad.summary.elapsedMs}`
        );
      } catch (error) {
        const parsedError = parseErrorPayload(error);
        firstFailure ??= {
          run: runIndex + 1,
          error: parsedError
        };
        runs.push({
          run: runIndex + 1,
          ok: false,
          error: parsedError
        });
        console.error(
          `[bench:ws] scenario=${messagesPerSender} run=${runIndex + 1}/${runsPerScenario} status=failed ` +
            `error=${JSON.stringify(parsedError)}`
        );
      } finally {
        if (runtime) {
          await stopProcess(runtime).catch(() => {});
        }
      }
    }

    const scenarioResult: BenchmarkWsScenarioResult = {
      messagesPerSender,
      expectedMessages: senderCount * messagesPerSender,
      likelyPolicyLimited:
        sendIntervalMs === 0 &&
        wsRateLimitWindowMs === 1_000 &&
        messagesPerSender + 1 > wsRateLimitMaxMessages,
      successRuns: throughputRuns.length,
      sloPassingRuns: runs.filter((run) => run.sloPassed === true).length,
      totalRuns: runsPerScenario,
      sloPassed: throughputRuns.length === runsPerScenario && runs.every((run) => run.sloPassed === true),
      firstSloFailure,
      firstFailure,
      throughputMps: summarizeSeries(throughputRuns),
      recvAckP99Ms: summarizeSeries(recvAckP99Runs),
      handleAckP99Ms: summarizeSeries(handleAckP99Runs),
      sysErrCount: summarizeSeries(sysErrCountRuns),
      egressOverflowCount: summarizeSeries(egressOverflowRuns),
      egressBackpressureCount: summarizeSeries(egressBackpressureRuns),
      runs
    };
    results.push(scenarioResult);

    if (firstUnstableScenario === undefined && scenarioResult.successRuns < scenarioResult.totalRuns) {
      firstUnstableScenario = messagesPerSender;
    }
    if (firstSloFailedScenario === undefined && !scenarioResult.sloPassed) {
      firstSloFailedScenario = messagesPerSender;
    }
  }

  console.log(
    JSON.stringify(
      {
        ok: true,
        kind: "ws_benchmark",
        config: {
          senderCount,
          receiverCount,
          runsPerScenario,
          sendIntervalMs,
          completionTimeoutMs,
          readyTimeoutMs,
          scenarioValues,
          benchmarkProfile,
          benchmarkSloProfile,
          websocketPolicy: {
            rateLimitWindowMs: wsRateLimitWindowMs,
            rateLimitMaxMessages: wsRateLimitMaxMessages
          },
          sloThresholds: {
            maxRecvAckP99Ms: sloThresholds.maxRecvAckP99Ms ?? null,
            maxHandleAckP99Ms: sloThresholds.maxHandleAckP99Ms ?? null,
            maxSysErrCount: sloThresholds.maxSysErrCount ?? null,
            maxEgressOverflowCount: sloThresholds.maxEgressOverflowCount ?? null,
            maxEgressBackpressureCount: sloThresholds.maxEgressBackpressureCount ?? null
          }
        },
        summary: {
          stablePrefixUpToMessagesPerSender: (() => {
            const stablePrefix: number[] = [];
            for (const result of results) {
              if (result.successRuns !== result.totalRuns) {
                break;
              }
              stablePrefix.push(result.messagesPerSender);
            }

            return stablePrefix.at(-1) ?? null;
          })(),
          highestFullyStableMessagesPerSender: results
            .filter((result) => result.successRuns === result.totalRuns)
            .map((result) => result.messagesPerSender)
            .at(-1) ?? null,
          stableSloPrefixUpToMessagesPerSender: (() => {
            const stablePrefix: number[] = [];
            for (const result of results) {
              if (!result.sloPassed) {
                break;
              }
              stablePrefix.push(result.messagesPerSender);
            }

            return stablePrefix.at(-1) ?? null;
          })(),
          highestSloPassingMessagesPerSender: results
            .filter((result) => result.sloPassed)
            .map((result) => result.messagesPerSender)
            .at(-1) ?? null,
          firstObservedFailureMessagesPerSender: firstUnstableScenario ?? null,
          firstObservedSloFailureMessagesPerSender: firstSloFailedScenario ?? null,
          firstLikelyPolicyLimitedMessagesPerSender: results
            .filter((result) => result.likelyPolicyLimited)
            .map((result) => result.messagesPerSender)
            .at(0) ?? null
        },
        scenarios: results
      },
      null,
      2
    )
  );
} finally {
  await rm(tempDir, { recursive: true, force: true });
}
