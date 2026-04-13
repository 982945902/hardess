import { describe, expect, it } from "bun:test";
import { HardessError } from "../../shared/errors.ts";
import { DemoBearerAuthProvider } from "./provider.ts";
import { RuntimeAuthService } from "./service.ts";

describe("RuntimeAuthService", () => {
  it("validates demo bearer tokens", async () => {
    const service = new RuntimeAuthService([new DemoBearerAuthProvider()]);
    const auth = await service.validateBearerToken("Bearer demo:alice");

    expect(auth.peerId).toBe("alice");
    expect(auth.tokenId).toBe("demo:alice");
  });

  it("rejects missing token", async () => {
    const service = new RuntimeAuthService([new DemoBearerAuthProvider()]);

    await expect(service.validateBearerToken(null)).rejects.toBeInstanceOf(HardessError);
  });

  it("marks revoked token invalid", async () => {
    const service = new RuntimeAuthService([new DemoBearerAuthProvider()]);
    const auth = await service.validateBearerToken("demo:bob");

    await service.revoke(auth.tokenId);

    expect(await service.isAuthContextValid(auth)).toBe(false);
  });

  it("validates system auth payloads through the shared schema path", async () => {
    const service = new RuntimeAuthService([new DemoBearerAuthProvider()]);
    const auth = await service.validateSystemAuth({
      provider: "bearer",
      payload: "demo:alice"
    });

    expect(auth.peerId).toBe("alice");
    expect(auth.tokenId).toBe("demo:alice");
  });

  it("rejects invalid system auth payloads", async () => {
    const service = new RuntimeAuthService([new DemoBearerAuthProvider()]);

    await expect(
      service.validateSystemAuth({
        provider: "bearer",
        payload: 123
      } as never)
    ).rejects.toBeInstanceOf(HardessError);
  });
});
