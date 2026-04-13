import { afterEach, describe, expect, test } from "bun:test";
import {
  envNumberFirst,
  envOptionalStringFirst,
  envStringFirst,
  parseAdminMetricsResponse,
  parseErrorPayload,
  parseJsonText
} from "./shared.ts";

const SHARED_ENV_KEYS = ["LOAD_TEST_PRIMARY", "LOAD_TEST_SECONDARY", "LOAD_TEST_NUMBER"] as const;

const originalEnv = Object.fromEntries(
  SHARED_ENV_KEYS.map((name) => [name, process.env[name]])
) as Record<(typeof SHARED_ENV_KEYS)[number], string | undefined>;

function restoreSharedEnv(): void {
  for (const name of SHARED_ENV_KEYS) {
    const originalValue = originalEnv[name];
    if (originalValue === undefined) {
      delete process.env[name];
      continue;
    }

    process.env[name] = originalValue;
  }
}

afterEach(() => {
  restoreSharedEnv();
});

describe("load env helpers", () => {
  test("envStringFirst prefers the first defined env", () => {
    process.env.LOAD_TEST_PRIMARY = "first";
    process.env.LOAD_TEST_SECONDARY = "second";

    expect(envStringFirst(["LOAD_TEST_PRIMARY", "LOAD_TEST_SECONDARY"], "fallback")).toBe("first");
  });

  test("envNumberFirst skips invalid values and falls through", () => {
    process.env.LOAD_TEST_PRIMARY = "not-a-number";
    process.env.LOAD_TEST_NUMBER = "42";

    expect(envNumberFirst(["LOAD_TEST_PRIMARY", "LOAD_TEST_NUMBER"], 7)).toBe(42);
  });

  test("envOptionalStringFirst returns undefined when no env is present", () => {
    delete process.env.LOAD_TEST_PRIMARY;
    delete process.env.LOAD_TEST_SECONDARY;

    expect(envOptionalStringFirst(["LOAD_TEST_PRIMARY", "LOAD_TEST_SECONDARY"])).toBeUndefined();
  });

  test("parseAdminMetricsResponse accepts only the metrics snapshot envelope", () => {
    expect(
      parseAdminMetricsResponse({
        metrics: {
          counters: {
            "ws.egress_backpressure": 1
          },
          timings: {
            http: [1, 2, 3]
          }
        }
      })
    ).toEqual({
      counters: {
        "ws.egress_backpressure": 1
      },
      timings: {
        http: [1, 2, 3]
      }
    });

    expect(parseAdminMetricsResponse({ metrics: { counters: { invalid: "x" } } })).toBeNull();
  });

  test("parseJsonText and parseErrorPayload keep structured error output when available", () => {
    expect(parseJsonText('{"ok":false,"error":"boom"}')).toEqual({
      ok: false,
      error: "boom"
    });
    expect(parseJsonText("not-json")).toBeUndefined();
    expect(parseErrorPayload(new Error('{"ok":false,"error":"boom"}'))).toEqual({
      ok: false,
      error: "boom"
    });
    expect(parseErrorPayload(new Error("plain boom"))).toBe("plain boom");
  });
});
