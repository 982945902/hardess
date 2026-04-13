import { createEnvelope, parseEnvelope, serializeEnvelope } from "../shared/envelope.ts";
import {
  diffMetricsSnapshot,
  envNumberFirst,
  envStringFirst,
  fetchAdminMetrics,
  incCounter,
  summarizeLatencies,
  type MetricsSnapshot
} from "./shared.ts";

export interface ClusterWsLoadTestConfig {
  senderWsUrl: string;
  receiverWsUrl: string;
  senderAdminBaseUrl: string;
  receiverAdminBaseUrl: string;
  protocol: string;
  senderCount: number;
  receiverCount: number;
  messagesPerSender: number;
  sendIntervalMs: number;
  connectTimeoutMs: number;
  completionTimeoutMs: number;
}

export interface ClusterWsLoadTestResult {
  kind: "cluster_ws_load_test";
  config: {
    senderWsUrl: string;
    receiverWsUrl: string;
    senderAdminBaseUrl: string;
    receiverAdminBaseUrl: string;
    protocol: string;
    senderCount: number;
    receiverCount: number;
    messagesPerSender: number;
    expectedMessages: number;
    sendIntervalMs: number;
    connectTimeoutMs: number;
    completionTimeoutMs: number;
  };
  summary: {
    authenticatedPeers: number;
    elapsedMs: number;
    messagesSent: number;
    receiverMessageCount: number;
    routeCount: number;
    recvAckCount: number;
    duplicateRecvAckCount: number;
    handleAckCount: number;
    messagesPerSecond: number;
    recvAckLatencyMs: ReturnType<typeof summarizeLatencies>;
    handleAckLatencyMs: ReturnType<typeof summarizeLatencies>;
    closeCodes: Record<string, number>;
    sysErrCodes: Record<string, number>;
    pendingMessages: number;
    oldestPendingAgeMs: number;
    topPendingSenders: PendingMessageSummary["topPendingSenders"];
    pendingSamples: PendingMessageSummary["pendingSamples"];
    routeCacheRetryCount: number;
    clusterHttpFallbackCount: number;
    clusterEgressOverflowCount: number;
    clusterEgressBackpressureCount: number;
  };
  senderMetricsDelta: MetricsSnapshot | null;
  receiverMetricsDelta: MetricsSnapshot | null;
}

type Role = "sender" | "receiver";

interface PeerSocket {
  role: Role;
  peerId: string;
  socket: WebSocket;
}

interface PendingMessageState {
  sentAt: number;
  senderPeerId: string;
  messageIndex: number;
}

interface PendingMessageSummary {
  pendingMessages: number;
  oldestPendingAgeMs: number;
  topPendingSenders: Array<{
    peerId: string;
    count: number;
  }>;
  pendingSamples: Array<{
    msgId: string;
    senderPeerId: string;
    messageIndex: number;
    ageMs: number;
  }>;
}

export function defaultClusterWsLoadTestConfig(): ClusterWsLoadTestConfig {
  return {
    senderWsUrl: envStringFirst(["CLUSTER_WS_LOAD_SENDER_WS_URL", "SENDER_WS_URL"], "ws://127.0.0.1:3000/ws"),
    receiverWsUrl: envStringFirst(
      ["CLUSTER_WS_LOAD_RECEIVER_WS_URL", "RECEIVER_WS_URL"],
      "ws://127.0.0.1:3001/ws"
    ),
    senderAdminBaseUrl: envStringFirst(
      ["CLUSTER_WS_LOAD_SENDER_ADMIN_BASE_URL", "SENDER_ADMIN_BASE_URL"],
      "http://127.0.0.1:3000"
    ),
    receiverAdminBaseUrl: envStringFirst(
      ["CLUSTER_WS_LOAD_RECEIVER_ADMIN_BASE_URL", "RECEIVER_ADMIN_BASE_URL"],
      "http://127.0.0.1:3001"
    ),
    protocol: envStringFirst(["CLUSTER_WS_LOAD_PROTOCOL", "PROTOCOL"], "chat"),
    senderCount: envNumberFirst(["CLUSTER_WS_LOAD_SENDER_COUNT", "SENDER_COUNT"], 10),
    receiverCount: envNumberFirst(["CLUSTER_WS_LOAD_RECEIVER_COUNT", "RECEIVER_COUNT"], 10),
    messagesPerSender: envNumberFirst(
      ["CLUSTER_WS_LOAD_MESSAGES_PER_SENDER", "MESSAGES_PER_SENDER"],
      50
    ),
    sendIntervalMs: envNumberFirst(["CLUSTER_WS_LOAD_SEND_INTERVAL_MS", "SEND_INTERVAL_MS"], 0),
    connectTimeoutMs: envNumberFirst(
      ["CLUSTER_WS_LOAD_CONNECT_TIMEOUT_MS", "CONNECT_TIMEOUT_MS"],
      5_000
    ),
    completionTimeoutMs: envNumberFirst(
      ["CLUSTER_WS_LOAD_COMPLETION_TIMEOUT_MS", "COMPLETION_TIMEOUT_MS"],
      20_000
    )
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function summarizePendingMessages(
  pendingByMsgId: Map<string, PendingMessageState>,
  sampleLimit = 5
): PendingMessageSummary {
  const now = performance.now();
  const entries = Array.from(pendingByMsgId.entries());
  const countsBySender = new Map<string, number>();

  for (const [, pending] of entries) {
    countsBySender.set(pending.senderPeerId, (countsBySender.get(pending.senderPeerId) ?? 0) + 1);
  }

  return {
    pendingMessages: entries.length,
    oldestPendingAgeMs: entries.reduce((max, [, pending]) => Math.max(max, now - pending.sentAt), 0),
    topPendingSenders: Array.from(countsBySender.entries())
      .map(([peerId, count]) => ({ peerId, count }))
      .sort((left, right) => right.count - left.count || left.peerId.localeCompare(right.peerId))
      .slice(0, sampleLimit),
    pendingSamples: entries.slice(0, sampleLimit).map(([msgId, pending]) => ({
      msgId,
      senderPeerId: pending.senderPeerId,
      messageIndex: pending.messageIndex,
      ageMs: now - pending.sentAt
    }))
  };
}

function sendSystemEnvelope(socket: WebSocket, action: string, payload: unknown, traceId?: string): void {
  socket.send(
    serializeEnvelope(
      createEnvelope({
        kind: "system",
        src: { peerId: "local", connId: "local" },
        protocol: "sys",
        version: "1.0",
        action,
        traceId,
        payload
      })
    )
  );
}

function counterValue(snapshot: MetricsSnapshot | null, name: string): number {
  return snapshot?.counters?.[name] ?? 0;
}

export async function runClusterWsLoadTest(
  overrides: Partial<ClusterWsLoadTestConfig> = {}
): Promise<ClusterWsLoadTestResult> {
  const config = {
    ...defaultClusterWsLoadTestConfig(),
    ...overrides
  };

  const recvAckLatenciesMs: number[] = [];
  const handleAckLatenciesMs: number[] = [];
  const sysErrCodes: Record<string, number> = {};
  const closeCodes: Record<string, number> = {};
  const pendingByMsgId = new Map<string, PendingMessageState>();
  const recvAckedMsgIds = new Set<string>();
  let rawRecvAckCount = 0;
  let authenticatedPeers = 0;
  let receiverMessageCount = 0;
  let routeCount = 0;

  async function connectPeer(role: Role, peerId: string, wsUrl: string): Promise<PeerSocket> {
    return await new Promise<PeerSocket>((resolve, reject) => {
      const socket = new WebSocket(wsUrl);
      const timeout = setTimeout(() => {
        socket.close();
        reject(new Error(`Timed out connecting ${peerId}`));
      }, config.connectTimeoutMs);
      let authenticated = false;

      socket.addEventListener("open", () => {
        socket.send(
          serializeEnvelope(
            createEnvelope({
              kind: "system",
              src: { peerId: "anonymous", connId: "pending" },
              protocol: "sys",
              version: "1.0",
              action: "auth",
              payload: {
                provider: "bearer",
                payload: `demo:${peerId}`
              }
            })
          )
        );
      });

      socket.addEventListener("message", (event) => {
        const envelope = parseEnvelope(String(event.data ?? ""));
        if (!envelope) {
          return;
        }

        if (envelope.kind === "system") {
          switch (envelope.action) {
            case "auth.ok":
              if (!authenticated) {
                authenticated = true;
                authenticatedPeers += 1;
                clearTimeout(timeout);
                resolve({ role, peerId, socket });
              }
              return;
            case "ping":
              sendSystemEnvelope(socket, "pong", envelope.payload, envelope.traceId);
              return;
            case "recvAck": {
              const ackFor = (envelope.payload as { ackFor?: string } | undefined)?.ackFor;
              rawRecvAckCount += 1;
              if (!ackFor) {
                return;
              }

              if (recvAckedMsgIds.has(ackFor)) {
                return;
              }

              recvAckedMsgIds.add(ackFor);
              const pending = ackFor ? pendingByMsgId.get(ackFor) : undefined;
              if (pending) {
                recvAckLatenciesMs.push(performance.now() - pending.sentAt);
              }
              return;
            }
            case "handleAck": {
              const ackFor = (envelope.payload as { ackFor?: string } | undefined)?.ackFor;
              const pending = ackFor ? pendingByMsgId.get(ackFor) : undefined;
              if (ackFor && pending) {
                handleAckLatenciesMs.push(performance.now() - pending.sentAt);
                pendingByMsgId.delete(ackFor);
              }
              return;
            }
            case "route":
              routeCount += 1;
              return;
            case "err": {
              const code = (envelope.payload as { code?: string } | undefined)?.code ?? "UNKNOWN";
              incCounter(sysErrCodes, code);
              return;
            }
            default:
              return;
          }
        }

        if (role === "receiver") {
          receiverMessageCount += 1;
          sendSystemEnvelope(
            socket,
            "handleAck",
            {
              ackFor: envelope.msgId
            },
            envelope.traceId
          );
        }
      });

      socket.addEventListener("close", (event) => {
        incCounter(closeCodes, String(event.code ?? 1005));
        if (!authenticated) {
          clearTimeout(timeout);
          reject(new Error(`Socket closed before auth for ${peerId}: ${event.code} ${event.reason}`));
        }
      });

      socket.addEventListener("error", () => {
        if (!authenticated) {
          clearTimeout(timeout);
          reject(new Error(`Socket error before auth for ${peerId}`));
        }
      });
    });
  }

  async function waitForCompletion(expectedHandleAcks: number): Promise<void> {
    const deadline = Date.now() + config.completionTimeoutMs;
    while (Date.now() < deadline) {
      if (handleAckLatenciesMs.length >= expectedHandleAcks) {
        return;
      }

      await sleep(50);
    }

    throw new Error(
      JSON.stringify({
        message: `Timed out waiting for handleAck completion: expected=${expectedHandleAcks} actual=${handleAckLatenciesMs.length}`,
        pending: summarizePendingMessages(pendingByMsgId)
      })
    );
  }

  const senderMetricsBefore = await fetchAdminMetrics(config.senderAdminBaseUrl);
  const receiverMetricsBefore = await fetchAdminMetrics(config.receiverAdminBaseUrl);
  const startedAt = Date.now();
  const receivers = await Promise.all(
    Array.from({ length: config.receiverCount }, (_, index) =>
      connectPeer("receiver", `receiver-${index}`, config.receiverWsUrl))
  );
  const senders = await Promise.all(
    Array.from({ length: config.senderCount }, (_, index) =>
      connectPeer("sender", `sender-${index}`, config.senderWsUrl))
  );

  await Promise.all(
    senders.map(async (sender, senderIndex) => {
      const target = receivers[senderIndex % receivers.length];
      for (let messageIndex = 0; messageIndex < config.messagesPerSender; messageIndex += 1) {
        const msgId = `${sender.peerId}-${messageIndex}-${crypto.randomUUID()}`;
        pendingByMsgId.set(msgId, {
          sentAt: performance.now(),
          senderPeerId: sender.peerId,
          messageIndex
        });
        sender.socket.send(
          serializeEnvelope(
            createEnvelope({
              msgId,
              kind: "biz",
              src: { peerId: sender.peerId, connId: sender.peerId },
              protocol: config.protocol,
              version: "1.0",
              action: "send",
              payload: {
                toPeerId: target.peerId,
                content: `cluster-load-message-${messageIndex}`
              }
            })
          )
        );

        if (config.sendIntervalMs > 0) {
          await sleep(config.sendIntervalMs);
        }
      }
    })
  );

  const expectedMessages = config.senderCount * config.messagesPerSender;
  try {
    await waitForCompletion(expectedMessages);
  } finally {
    for (const peer of [...senders, ...receivers]) {
      peer.socket.close();
    }
  }

  const elapsedMs = Date.now() - startedAt;
  const senderMetricsAfter = await fetchAdminMetrics(config.senderAdminBaseUrl);
  const receiverMetricsAfter = await fetchAdminMetrics(config.receiverAdminBaseUrl);
  const pendingSummary = summarizePendingMessages(pendingByMsgId);
  const senderMetricsDelta = diffMetricsSnapshot(senderMetricsBefore, senderMetricsAfter);
  const receiverMetricsDelta = diffMetricsSnapshot(receiverMetricsBefore, receiverMetricsAfter);

  return {
    kind: "cluster_ws_load_test",
    config: {
      senderWsUrl: config.senderWsUrl,
      receiverWsUrl: config.receiverWsUrl,
      senderAdminBaseUrl: config.senderAdminBaseUrl,
      receiverAdminBaseUrl: config.receiverAdminBaseUrl,
      protocol: config.protocol,
      senderCount: config.senderCount,
      receiverCount: config.receiverCount,
      messagesPerSender: config.messagesPerSender,
      expectedMessages,
      sendIntervalMs: config.sendIntervalMs,
      connectTimeoutMs: config.connectTimeoutMs,
      completionTimeoutMs: config.completionTimeoutMs
    },
    summary: {
      authenticatedPeers,
      elapsedMs,
      messagesSent: expectedMessages,
      receiverMessageCount,
      routeCount,
      recvAckCount: recvAckLatenciesMs.length,
      duplicateRecvAckCount: rawRecvAckCount - recvAckedMsgIds.size,
      handleAckCount: handleAckLatenciesMs.length,
      messagesPerSecond: elapsedMs > 0 ? (expectedMessages * 1000) / elapsedMs : 0,
      recvAckLatencyMs: summarizeLatencies(recvAckLatenciesMs),
      handleAckLatencyMs: summarizeLatencies(handleAckLatenciesMs),
      closeCodes,
      sysErrCodes,
      pendingMessages: pendingSummary.pendingMessages,
      oldestPendingAgeMs: pendingSummary.oldestPendingAgeMs,
      topPendingSenders: pendingSummary.topPendingSenders,
      pendingSamples: pendingSummary.pendingSamples,
      routeCacheRetryCount: counterValue(senderMetricsDelta, "ws.route_cache_retry"),
      clusterHttpFallbackCount:
        counterValue(senderMetricsDelta, "cluster.http_fallback") +
        counterValue(receiverMetricsDelta, "cluster.http_fallback"),
      clusterEgressOverflowCount:
        counterValue(senderMetricsDelta, "cluster.egress_overflow") +
        counterValue(receiverMetricsDelta, "cluster.egress_overflow"),
      clusterEgressBackpressureCount:
        counterValue(senderMetricsDelta, "cluster.egress_backpressure") +
        counterValue(receiverMetricsDelta, "cluster.egress_backpressure")
    },
    senderMetricsDelta,
    receiverMetricsDelta
  };
}

if (import.meta.main) {
  console.log(JSON.stringify(await runClusterWsLoadTest(), null, 2));
}
