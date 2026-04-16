import { readClusterWsGateSloThresholds } from "./gate-slo.ts";
import { envNumber, envString, parseErrorPayload, summarizeSeries } from "./shared.ts";
import { runClusterReleaseGate } from "./release-gate-cluster.ts";
import { applyClusterBenchmarkProfile } from "./profiles.ts";

type ListenerMode = "single" | "dual";

interface BenchmarkSloViolation {
  metric: string;
  actual: number;
  threshold: number;
}

interface BenchmarkScenarioResult {
  messagesPerSender: number;
  expectedMessages: number;
  likelyPolicyLimited: boolean;
  successRuns: number;
  sloPassingRuns: number;
  totalRuns: number;
  sloPassed: boolean;
  firstSloFailure?: {
    run: number;
    violations: BenchmarkSloViolation[];
  };
  firstFailure?: {
    run: number;
    error: unknown;
  };
  throughputMps: ReturnType<typeof summarizeSeries>;
  recvAckP99Ms: ReturnType<typeof summarizeSeries>;
  handleAckP99Ms: ReturnType<typeof summarizeSeries>;
  sysErrCount: ReturnType<typeof summarizeSeries>;
  routeCacheRetryCount: ReturnType<typeof summarizeSeries>;
  clusterHttpFallbackCount: ReturnType<typeof summarizeSeries>;
  clusterEgressOverflowCount: ReturnType<typeof summarizeSeries>;
  clusterEgressBackpressureCount: ReturnType<typeof summarizeSeries>;
  runs: Array<{
    run: number;
    ok: boolean;
    throughputMps?: number;
    recvAckP99Ms?: number;
    handleAckP99Ms?: number;
    sysErrCount?: number;
    routeCacheRetryCount?: number;
    clusterHttpFallbackCount?: number;
    clusterEgressOverflowCount?: number;
    clusterEgressBackpressureCount?: number;
    sloPassed?: boolean;
    sloViolations?: BenchmarkSloViolation[];
    elapsedMs?: number;
    error?: unknown;
  }>;
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

function formatSloViolations(violations: BenchmarkSloViolation[]): string {
  if (violations.length === 0) {
    return "none";
  }

  return violations
    .map((violation) => `${violation.metric}=${violation.actual} threshold=${violation.threshold}`)
    .join(",");
}

function evaluateSlo(
  summary: Awaited<ReturnType<typeof runClusterReleaseGate>>["clusterWsLoad"]["summary"],
  thresholds: ReturnType<typeof readClusterWsGateSloThresholds>
): BenchmarkSloViolation[] {
  const violations: BenchmarkSloViolation[] = [];

  function check(metric: string, actual: number, threshold: number | undefined): void {
    if (threshold === undefined) {
      return;
    }
    if (actual > threshold) {
      violations.push({ metric, actual, threshold });
    }
  }

  check("recvAckP99Ms", summary.recvAckLatencyMs.p99Ms, thresholds.maxRecvAckP99Ms);
  check("handleAckP99Ms", summary.handleAckLatencyMs.p99Ms, thresholds.maxHandleAckP99Ms);
  check("routeCacheRetryCount", summary.routeCacheRetryCount, thresholds.maxRouteCacheRetryCount);
  check("clusterHttpFallbackCount", summary.clusterHttpFallbackCount, thresholds.maxHttpFallbackCount);
  check("clusterEgressOverflowCount", summary.clusterEgressOverflowCount, thresholds.maxEgressOverflowCount);
  check(
    "clusterEgressBackpressureCount",
    summary.clusterEgressBackpressureCount,
    thresholds.maxEgressBackpressureCount
  );
  check("sysErrCount", countValues(summary.sysErrCodes), thresholds.maxSysErrCount);

  return violations;
}

const senderCount = envNumber("BENCH_CLUSTER_SENDERS", 10);
const benchmarkProfile = applyClusterBenchmarkProfile(envString("BENCH_CLUSTER_PROFILE", "default"));
const benchmarkSloProfile = envString("BENCH_CLUSTER_SLO_PROFILE", "default");
const receiverCount = envNumber("BENCH_CLUSTER_RECEIVERS", 10);
const scenarioValues = parseScenarioValues(envString("BENCH_CLUSTER_SCENARIOS", "30,60,80,100"));
const runsPerScenario = envNumber("BENCH_CLUSTER_RUNS", 3);
const completionTimeoutMs = envNumber("BENCH_CLUSTER_COMPLETION_TIMEOUT_MS", 40_000);
const portBase = envNumber("BENCH_CLUSTER_PORT_BASE", 3400);
const upstreamPortBase = envNumber("BENCH_CLUSTER_UPSTREAM_PORT_BASE", 9400);
const sendIntervalMs = envNumber("BENCH_CLUSTER_SEND_INTERVAL_MS", 0);
const listenerMode = (() => {
  const raw = envString("BENCH_CLUSTER_LISTENER_MODE", "single");
  if (raw === "single" || raw === "dual") {
    return raw as ListenerMode;
  }

  throw new Error(`Invalid BENCH_CLUSTER_LISTENER_MODE: ${raw}`);
})();
const wsRateLimitWindowMs = envNumber("WS_RATE_LIMIT_WINDOW_MS", 1_000);
const wsRateLimitMaxMessages = envNumber("WS_RATE_LIMIT_MAX_MESSAGES", 100);
const sloThresholds = readClusterWsGateSloThresholds("BENCH_CLUSTER", benchmarkSloProfile);

const results: BenchmarkScenarioResult[] = [];
let firstUnstableScenario: number | undefined;
let firstSloFailedScenario: number | undefined;

for (const [scenarioIndex, messagesPerSender] of scenarioValues.entries()) {
  const throughputRuns: number[] = [];
  const recvAckP99Runs: number[] = [];
  const handleAckP99Runs: number[] = [];
  const sysErrCountRuns: number[] = [];
  const routeCacheRetryRuns: number[] = [];
  const clusterHttpFallbackRuns: number[] = [];
  const clusterEgressOverflowRuns: number[] = [];
  const clusterEgressBackpressureRuns: number[] = [];
  const runs: BenchmarkScenarioResult["runs"] = [];
  let firstFailure: BenchmarkScenarioResult["firstFailure"] | undefined;
  let firstSloFailure: BenchmarkScenarioResult["firstSloFailure"] | undefined;

  for (let runIndex = 0; runIndex < runsPerScenario; runIndex += 1) {
    const portOffset = scenarioIndex * 40 + runIndex * 5;
    console.error(
      `[bench:cluster] scenario=${messagesPerSender} run=${runIndex + 1}/${runsPerScenario} listenerMode=${listenerMode} status=starting`
    );

    try {
      const result = await runClusterReleaseGate({
        listenerMode,
        nodeAPort: portBase + portOffset,
        nodeBPort: portBase + portOffset + 1,
        nodeAInternalPort: listenerMode === "dual" ? portBase + portOffset + 2 : undefined,
        nodeBInternalPort: listenerMode === "dual" ? portBase + portOffset + 3 : undefined,
        upstreamPort: upstreamPortBase + portOffset,
        senderCount,
        receiverCount,
        messagesPerSender,
        sendIntervalMs,
        completionTimeoutMs
      });
      const summary = result.clusterWsLoad.summary;
      const sysErrCount = countValues(summary.sysErrCodes);
      const sloViolations = evaluateSlo(summary, sloThresholds);
      const sloPassed = sloViolations.length === 0;
      throughputRuns.push(summary.messagesPerSecond);
      recvAckP99Runs.push(summary.recvAckLatencyMs.p99Ms);
      handleAckP99Runs.push(summary.handleAckLatencyMs.p99Ms);
      sysErrCountRuns.push(sysErrCount);
      routeCacheRetryRuns.push(summary.routeCacheRetryCount);
      clusterHttpFallbackRuns.push(summary.clusterHttpFallbackCount);
      clusterEgressOverflowRuns.push(summary.clusterEgressOverflowCount);
      clusterEgressBackpressureRuns.push(summary.clusterEgressBackpressureCount);
      if (!sloPassed) {
        firstSloFailure ??= {
          run: runIndex + 1,
          violations: sloViolations
        };
      }
      runs.push({
        run: runIndex + 1,
        ok: true,
        throughputMps: summary.messagesPerSecond,
        recvAckP99Ms: summary.recvAckLatencyMs.p99Ms,
        handleAckP99Ms: summary.handleAckLatencyMs.p99Ms,
        sysErrCount,
        routeCacheRetryCount: summary.routeCacheRetryCount,
        clusterHttpFallbackCount: summary.clusterHttpFallbackCount,
        clusterEgressOverflowCount: summary.clusterEgressOverflowCount,
        clusterEgressBackpressureCount: summary.clusterEgressBackpressureCount,
        sloPassed,
        sloViolations,
        elapsedMs: summary.elapsedMs
      });
      console.error(
        `[bench:cluster] scenario=${messagesPerSender} run=${runIndex + 1}/${runsPerScenario} listenerMode=${listenerMode} ` +
          `status=ok throughput=${summary.messagesPerSecond.toFixed(2)} recvAckP99Ms=${summary.recvAckLatencyMs.p99Ms.toFixed(2)} ` +
          `handleAckP99Ms=${summary.handleAckLatencyMs.p99Ms.toFixed(2)} routeCacheRetry=${summary.routeCacheRetryCount} ` +
          `httpFallback=${summary.clusterHttpFallbackCount} egressOverflow=${summary.clusterEgressOverflowCount} ` +
          `egressBackpressure=${summary.clusterEgressBackpressureCount} sysErrCount=${sysErrCount} ` +
          `slo=${sloPassed ? "pass" : "fail"} sloViolations=${formatSloViolations(sloViolations)} elapsedMs=${summary.elapsedMs}`
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
        `[bench:cluster] scenario=${messagesPerSender} run=${runIndex + 1}/${runsPerScenario} listenerMode=${listenerMode} status=failed ` +
          `error=${JSON.stringify(parsedError)}`
      );
    }
  }

  const scenarioResult: BenchmarkScenarioResult = {
    messagesPerSender,
    expectedMessages: senderCount * messagesPerSender,
    likelyPolicyLimited:
      sendIntervalMs === 0 &&
      wsRateLimitWindowMs === 1_000 &&
      messagesPerSender + 1 > wsRateLimitMaxMessages,
    successRuns: throughputRuns.length,
    sloPassingRuns: runs.filter((run) => run.sloPassed).length,
    totalRuns: runsPerScenario,
    sloPassed: throughputRuns.length === runsPerScenario && runs.every((run) => run.sloPassed === true),
    firstSloFailure,
    firstFailure,
    throughputMps: summarizeSeries(throughputRuns),
    recvAckP99Ms: summarizeSeries(recvAckP99Runs),
    handleAckP99Ms: summarizeSeries(handleAckP99Runs),
    sysErrCount: summarizeSeries(sysErrCountRuns),
    routeCacheRetryCount: summarizeSeries(routeCacheRetryRuns),
    clusterHttpFallbackCount: summarizeSeries(clusterHttpFallbackRuns),
    clusterEgressOverflowCount: summarizeSeries(clusterEgressOverflowRuns),
    clusterEgressBackpressureCount: summarizeSeries(clusterEgressBackpressureRuns),
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
      kind: "cluster_benchmark",
      config: {
        senderCount,
        receiverCount,
        runsPerScenario,
        sendIntervalMs,
        completionTimeoutMs,
        scenarioValues,
        listenerMode,
        benchmarkProfile,
        benchmarkSloProfile,
        websocketPolicy: {
          rateLimitWindowMs: wsRateLimitWindowMs,
          rateLimitMaxMessages: wsRateLimitMaxMessages
        },
        sloThresholds: {
          maxRecvAckP99Ms: sloThresholds.maxRecvAckP99Ms ?? null,
          maxHandleAckP99Ms: sloThresholds.maxHandleAckP99Ms ?? null,
          maxRouteCacheRetryCount: sloThresholds.maxRouteCacheRetryCount ?? null,
          maxClusterHttpFallbackCount: sloThresholds.maxHttpFallbackCount ?? null,
          maxClusterEgressOverflowCount: sloThresholds.maxEgressOverflowCount ?? null,
          maxClusterEgressBackpressureCount: sloThresholds.maxEgressBackpressureCount ?? null,
          maxSysErrCount: sloThresholds.maxSysErrCount ?? null
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
