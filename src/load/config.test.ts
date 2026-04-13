import { afterEach, describe, expect, test } from "bun:test";
import { defaultHttpLoadTestConfig } from "./http.ts";
import { defaultWsLoadTestConfig } from "./ws.ts";
import { defaultClusterWsLoadTestConfig } from "./cluster-ws.ts";

const CONFIG_ENV_KEYS = [
  "HTTP_LOAD_BASE_URL",
  "HTTP_LOAD_ADMIN_BASE_URL",
  "HTTP_LOAD_CONCURRENCY",
  "HTTP_LOAD_REQUESTS",
  "HTTP_LOAD_REQUEST_BODY",
  "BASE_URL",
  "ADMIN_BASE_URL",
  "CONCURRENCY",
  "REQUESTS",
  "REQUEST_BODY",
  "WS_LOAD_WS_URL",
  "WS_LOAD_SENDER_COUNT",
  "WS_LOAD_MESSAGES_PER_SENDER",
  "WS_URL",
  "SENDER_COUNT",
  "MESSAGES_PER_SENDER",
  "CLUSTER_WS_LOAD_SENDER_WS_URL",
  "CLUSTER_WS_LOAD_RECEIVER_WS_URL",
  "CLUSTER_WS_LOAD_RECEIVER_COUNT",
  "SENDER_WS_URL",
  "RECEIVER_WS_URL",
  "RECEIVER_COUNT"
] as const;

const originalEnv = Object.fromEntries(
  CONFIG_ENV_KEYS.map((name) => [name, process.env[name]])
) as Record<(typeof CONFIG_ENV_KEYS)[number], string | undefined>;

function restoreConfigEnv(): void {
  for (const name of CONFIG_ENV_KEYS) {
    const originalValue = originalEnv[name];
    if (originalValue === undefined) {
      delete process.env[name];
      continue;
    }

    process.env[name] = originalValue;
  }
}

afterEach(() => {
  restoreConfigEnv();
});

describe("load config env precedence", () => {
  test("http load prefers namespaced envs over legacy aliases", () => {
    process.env.BASE_URL = "http://legacy.example";
    process.env.HTTP_LOAD_BASE_URL = "http://namespaced.example";
    process.env.CONCURRENCY = "5";
    process.env.HTTP_LOAD_CONCURRENCY = "9";
    process.env.REQUEST_BODY = "{\"legacy\":true}";
    process.env.HTTP_LOAD_REQUEST_BODY = "{\"namespaced\":true}";

    const config = defaultHttpLoadTestConfig();

    expect(config.baseUrl).toBe("http://namespaced.example");
    expect(config.concurrency).toBe(9);
    expect(config.requestBody).toBe("{\"namespaced\":true}");
  });

  test("ws load still falls back to legacy aliases", () => {
    delete process.env.WS_LOAD_WS_URL;
    delete process.env.WS_LOAD_SENDER_COUNT;
    delete process.env.WS_LOAD_MESSAGES_PER_SENDER;
    process.env.WS_URL = "ws://legacy.example/ws";
    process.env.SENDER_COUNT = "12";
    process.env.MESSAGES_PER_SENDER = "34";

    const config = defaultWsLoadTestConfig();

    expect(config.wsUrl).toBe("ws://legacy.example/ws");
    expect(config.senderCount).toBe(12);
    expect(config.messagesPerSender).toBe(34);
  });

  test("cluster ws load prefers namespaced envs and isolates sender/receiver settings", () => {
    process.env.SENDER_WS_URL = "ws://legacy-sender/ws";
    process.env.RECEIVER_WS_URL = "ws://legacy-receiver/ws";
    process.env.RECEIVER_COUNT = "8";
    process.env.CLUSTER_WS_LOAD_SENDER_WS_URL = "ws://namespaced-sender/ws";
    process.env.CLUSTER_WS_LOAD_RECEIVER_WS_URL = "ws://namespaced-receiver/ws";
    process.env.CLUSTER_WS_LOAD_RECEIVER_COUNT = "15";

    const config = defaultClusterWsLoadTestConfig();

    expect(config.senderWsUrl).toBe("ws://namespaced-sender/ws");
    expect(config.receiverWsUrl).toBe("ws://namespaced-receiver/ws");
    expect(config.receiverCount).toBe(15);
  });
});
