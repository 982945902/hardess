import { createEnvelope, parseEnvelope, serializeEnvelope } from "../shared/envelope.ts";
import {
  parseSysAuthOkPayload,
  parseSysErrPayload,
  parseSysHandleAckEventPayload,
  parseSysPingPayload,
  parseSysRecvAckPayload,
  parseSysRoutePayload
} from "../shared/index.ts";
import {
  diffMetricsSnapshot,
  envNumberFirst,
  envStringFirst,
  fetchAdminMetrics,
  incCounter,
  summarizeLatencies,
  type MetricsSnapshot
} from "./shared.ts";

export interface WsLoadTestConfig {
  wsUrl: string;
  adminBaseUrl: string;
  protocol: string;
  senderCount: number;
  receiverCount: number;
  messagesPerSender: number;
  sendIntervalMs: number;
  connectTimeoutMs: number;
  completionTimeoutMs: number;
}

export interface WsLoadTestResult {
  kind: "ws_load_test";
  config: {
    wsUrl: string;
    adminBaseUrl: string;
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
  };
  metricsDelta: MetricsSnapshot | null;
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

export function defaultWsLoadTestConfig(): WsLoadTestConfig {
  return {
    wsUrl: envStringFirst(["WS_LOAD_WS_URL", "WS_URL"], "ws://127.0.0.1:3000/ws"),
    adminBaseUrl: envStringFirst(["WS_LOAD_ADMIN_BASE_URL", "ADMIN_BASE_URL"], "http://127.0.0.1:3000"),
    protocol: envStringFirst(["WS_LOAD_PROTOCOL", "PROTOCOL"], "chat"),
    senderCount: envNumberFirst(["WS_LOAD_SENDER_COUNT", "SENDER_COUNT"], 10),
    receiverCount: envNumberFirst(["WS_LOAD_RECEIVER_COUNT", "RECEIVER_COUNT"], 10),
    messagesPerSender: envNumberFirst(["WS_LOAD_MESSAGES_PER_SENDER", "MESSAGES_PER_SENDER"], 50),
    sendIntervalMs: envNumberFirst(["WS_LOAD_SEND_INTERVAL_MS", "SEND_INTERVAL_MS"], 0),
    connectTimeoutMs: envNumberFirst(["WS_LOAD_CONNECT_TIMEOUT_MS", "CONNECT_TIMEOUT_MS"], 5_000),
    completionTimeoutMs: envNumberFirst(
      ["WS_LOAD_COMPLETION_TIMEOUT_MS", "COMPLETION_TIMEOUT_MS"],
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

export async function runWsLoadTest(
  overrides: Partial<WsLoadTestConfig> = {}
): Promise<WsLoadTestResult> {
  const config = {
    ...defaultWsLoadTestConfig(),
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

  async function connectPeer(role: Role, peerId: string): Promise<PeerSocket> {
    return await new Promise<PeerSocket>((resolve, reject) => {
      const socket = new WebSocket(config.wsUrl);
      const timeout = setTimeout(() => {
        socket.close();
        reject(new Error(`Timed out connecting ${peerId}`));
      }, config.connectTimeoutMs);
      let authenticated = false;

      function failSystemMessage(error: unknown): void {
        const message = error instanceof Error ? error.message : String(error);
        if (!authenticated) {
          clearTimeout(timeout);
          reject(new Error(`Invalid system message before auth for ${peerId}: ${message}`));
          socket.close();
          return;
        }

        incCounter(sysErrCodes, "INVALID_SYSTEM_MESSAGE");
        socket.close();
      }

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
          try {
            switch (envelope.action) {
              case "auth.ok":
                parseSysAuthOkPayload(envelope.payload);
                if (!authenticated) {
                  authenticated = true;
                  authenticatedPeers += 1;
                  clearTimeout(timeout);
                  resolve({ role, peerId, socket });
                }
                return;
              case "ping":
                sendSystemEnvelope(socket, "pong", parseSysPingPayload(envelope.payload), envelope.traceId);
                return;
              case "recvAck": {
                const payload = parseSysRecvAckPayload(envelope.payload);
                rawRecvAckCount += 1;

                if (recvAckedMsgIds.has(payload.ackFor)) {
                  return;
                }

                recvAckedMsgIds.add(payload.ackFor);
                const sentAt = pendingByMsgId.get(payload.ackFor);
                if (sentAt !== undefined) {
                  recvAckLatenciesMs.push(performance.now() - sentAt.sentAt);
                }
                return;
              }
              case "handleAck": {
                const payload = parseSysHandleAckEventPayload(envelope.payload);
                const sentAt = pendingByMsgId.get(payload.ackFor);
                if (sentAt !== undefined) {
                  handleAckLatenciesMs.push(performance.now() - sentAt.sentAt);
                  pendingByMsgId.delete(payload.ackFor);
                }
                return;
              }
              case "route":
                parseSysRoutePayload(envelope.payload);
                routeCount += 1;
                return;
              case "err": {
                const payload = parseSysErrPayload(envelope.payload);
                incCounter(sysErrCodes, payload.code);
                return;
              }
              default:
                return;
            }
          } catch (error) {
            failSystemMessage(error);
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
        message:
          `Timed out waiting for handleAck completion: expected=${expectedHandleAcks} ` +
          `actual=${handleAckLatenciesMs.length}`,
        pending: summarizePendingMessages(pendingByMsgId)
      })
    );
  }

  const metricsBefore = await fetchAdminMetrics(config.adminBaseUrl);
  const startedAt = Date.now();
  const receivers = await Promise.all(
    Array.from({ length: config.receiverCount }, (_, index) => connectPeer("receiver", `receiver-${index}`))
  );
  const senders = await Promise.all(
    Array.from({ length: config.senderCount }, (_, index) => connectPeer("sender", `sender-${index}`))
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
                content: `load-message-${messageIndex}`
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
  const metricsAfter = await fetchAdminMetrics(config.adminBaseUrl);
  const pendingSummary = summarizePendingMessages(pendingByMsgId);

  return {
    kind: "ws_load_test",
    config: {
      wsUrl: config.wsUrl,
      adminBaseUrl: config.adminBaseUrl,
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
      pendingSamples: pendingSummary.pendingSamples
    },
    metricsDelta: diffMetricsSnapshot(metricsBefore, metricsAfter)
  };
}

if (import.meta.main) {
  console.log(JSON.stringify(await runWsLoadTest(), null, 2));
}
