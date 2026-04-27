import { createPrivateKey, createSign, generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "bun:test";
import { HardessError } from "../../shared/errors.ts";
import { JwtIssuerAuthProvider } from "./jwt-provider.ts";
import { DemoBearerAuthProvider } from "./provider.ts";
import { RuntimeAuthService } from "./service.ts";

describe("JwtIssuerAuthProvider", () => {
  it("validates Curator-issued RS256 bearer tokens from JWKS trust", async () => {
    const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const kid = "curator-key-1";
    const token = signJwt(privateKey.export({ type: "pkcs8", format: "pem" }) as string, kid, {
      iss: "curator",
      aud: "hardess",
      sub: "employee-1",
      workspaceId: "workspace-1",
      principalId: "employee-1",
      sessionNonce: "nonce-1",
      scope: "notify.conn notification.subscribe",
      iat: 1_000,
      exp: 1_300
    });

    const provider = new JwtIssuerAuthProvider(
      {
        tokenIssuers: [
          {
            issuer: "curator",
            audiences: ["hardess"],
            jwksUrl: "https://curator.example/.well-known/jwks.json",
            requiredClaims: ["workspaceId", "principalId", "sessionNonce", "scope"],
            maxTokenTtlSec: 300
          }
        ]
      },
      {
        now: () => 1_100_000,
        fetchFn: (async () => new Response(
          JSON.stringify({
            keys: [
              {
                ...(publicKey.export({ format: "jwk" }) as JsonWebKey),
                kid,
                alg: "RS256",
                use: "sig"
              }
            ]
          }),
          { status: 200 }
        )) as unknown as typeof fetch
      }
    );

    const auth = await provider.validateBearerToken(`Bearer ${token}`);

    expect(auth.peerId).toBe("workspace-1:employee-1");
    expect(auth.tokenId).toBe("curator:workspace-1:employee-1:1000");
    expect(auth.capabilities).toContain("notify.conn");
    expect(auth.capabilities).toContain("notification.subscribe");
    expect(auth.expiresAt).toBe(1_300_000);
  });

  it("lets RuntimeAuthService accept JWT trust while preserving demo bearer fallback", async () => {
    const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const kid = "curator-key-2";
    const nowSec = Math.floor(Date.now() / 1000);
    const token = signJwt(privateKey.export({ type: "pkcs8", format: "pem" }) as string, kid, {
      iss: "curator",
      aud: "hardess",
      workspaceId: "workspace-2",
      principalId: "employee-2",
      sessionNonce: "nonce-2",
      scope: ["notify.conn"],
      iat: nowSec,
      exp: nowSec + 120
    });
    const service = new RuntimeAuthService([new DemoBearerAuthProvider()]);

    service.applyRuntimeAuthTrust({
      tokenIssuers: [
        {
          issuer: "curator",
          audiences: ["hardess"],
          publicKeys: [
            {
              kid,
              alg: "RS256",
              pem: publicKey.export({ type: "spki", format: "pem" }) as string
            }
          ],
          requiredClaims: ["workspaceId", "principalId", "sessionNonce", "scope"],
          maxTokenTtlSec: 300
        }
      ]
    });

    const jwtAuth = await service.validateSystemAuth({
      provider: "bearer",
      payload: token
    });
    const demoAuth = await service.validateSystemAuth({
      provider: "bearer",
      payload: "demo:alice"
    });

    expect(jwtAuth.peerId).toBe("workspace-2:employee-2");
    expect(demoAuth.peerId).toBe("alice");
  });

  it("rejects tokens with an audience outside the trust policy", async () => {
    const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const kid = "curator-key-3";
    const token = signJwt(privateKey.export({ type: "pkcs8", format: "pem" }) as string, kid, {
      iss: "curator",
      aud: "other-service",
      workspaceId: "workspace-3",
      principalId: "employee-3",
      sessionNonce: "nonce-3",
      scope: "notify.conn",
      iat: 3_000,
      exp: 3_120
    });
    const provider = new JwtIssuerAuthProvider(
      {
        tokenIssuers: [
          {
            issuer: "curator",
            audiences: ["hardess"],
            publicKeys: [
              {
                kid,
                alg: "RS256",
                pem: publicKey.export({ type: "spki", format: "pem" }) as string
              }
            ]
          }
        ]
      },
      { now: () => 3_030_000 }
    );

    await expect(provider.validateBearerToken(token)).rejects.toBeInstanceOf(HardessError);
  });
});

function signJwt(
  privateKeyPem: string,
  kid: string,
  payload: Record<string, unknown>
): string {
  const header = {
    alg: "RS256",
    typ: "JWT",
    kid
  };
  const signingInput = `${base64UrlJson(header)}.${base64UrlJson(payload)}`;
  const signer = createSign("RSA-SHA256");
  signer.update(signingInput);
  signer.end();
  const signature = signer.sign(createPrivateKey(privateKeyPem));
  return `${signingInput}.${base64Url(signature)}`;
}

function base64UrlJson(value: unknown): string {
  return base64Url(Buffer.from(JSON.stringify(value), "utf8"));
}

function base64Url(value: Buffer): string {
  return value.toString("base64").replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}
