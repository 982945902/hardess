import { createPublicKey, createVerify } from "node:crypto";
import {
  ERROR_CODES,
  HardessError,
  parseBearerSysAuthPayload,
  type AuthContext,
  type RuntimeAuthTokenIssuerTrust,
  type RuntimeAuthTrust
} from "../../shared/index.ts";
import type { AuthProvider } from "./provider.ts";

type JwtHeader = {
  alg?: string;
  kid?: string;
  typ?: string;
};

type JwtPayload = {
  iss?: string;
  aud?: string | string[];
  sub?: string;
  exp?: number;
  nbf?: number;
  iat?: number;
  jti?: string;
  workspaceId?: string;
  principalId?: string;
  sessionNonce?: string;
  peerId?: string;
  scope?: string | string[];
  capabilities?: string[];
};

type Jwk = JsonWebKey & {
  kid?: string;
  alg?: string;
};

type Jwks = {
  keys?: Jwk[];
};

const JWT_PART_COUNT = 3;
const DEFAULT_CLOCK_SKEW_SEC = 30;
const DEFAULT_MAX_TOKEN_TTL_SEC = 15 * 60;

export class JwtIssuerAuthProvider implements AuthProvider {
  readonly name = "bearer";
  private readonly jwksCache = new Map<string, { fetchedAt: number; keys: Jwk[] }>();

  constructor(
    private readonly trust: RuntimeAuthTrust,
    private readonly options: {
      fetchFn?: typeof fetch;
      now?: () => number;
      jwksCacheTtlMs?: number;
    } = {}
  ) {}

  async validateBearerToken(token: string): Promise<AuthContext> {
    const normalized = token.startsWith("Bearer ") ? token.slice(7) : token;
    return this.validateJwt(normalized);
  }

  async validateSystemAuth(payload: unknown): Promise<AuthContext> {
    const authPayload = parseBearerSysAuthPayload(payload);
    return this.validateBearerToken(authPayload.payload);
  }

  private async validateJwt(token: string): Promise<AuthContext> {
    const parts = token.split(".");
    if (parts.length !== JWT_PART_COUNT) {
      throw new HardessError(ERROR_CODES.AUTH_INVALID_TOKEN, "Malformed JWT bearer token");
    }

    const [encodedHeader, encodedPayload, encodedSignature] = parts;
    const header = parseJwtJson<JwtHeader>(encodedHeader, "Invalid JWT header");
    const payload = parseJwtJson<JwtPayload>(encodedPayload, "Invalid JWT payload");
    const issuerTrust = this.resolveIssuerTrust(payload, header);

    await this.verifySignature({
      token,
      signingInput: `${encodedHeader}.${encodedPayload}`,
      signature: encodedSignature,
      header,
      trust: issuerTrust
    });
    this.validateClaims(payload, issuerTrust);

    const peerId = resolvePeerId(payload);
    if (!peerId) {
      throw new HardessError(ERROR_CODES.AUTH_INVALID_TOKEN, "JWT must include peerId, principalId, or sub");
    }

    return {
      peerId,
      tokenId: payload.jti ?? `${payload.iss ?? "unknown"}:${peerId}:${payload.iat ?? 0}`,
      capabilities: resolveCapabilities(payload),
      expiresAt: Number(payload.exp) * 1000,
      groupId: typeof payload.workspaceId === "string" ? payload.workspaceId : undefined
    };
  }

  private resolveIssuerTrust(payload: JwtPayload, header: JwtHeader): RuntimeAuthTokenIssuerTrust {
    const issuer = payload.iss;
    if (!issuer) {
      throw new HardessError(ERROR_CODES.AUTH_INVALID_TOKEN, "JWT issuer is required");
    }
    const trust = this.trust.tokenIssuers.find((entry) => entry.issuer === issuer);
    if (!trust) {
      throw new HardessError(ERROR_CODES.AUTH_INVALID_TOKEN, `Unsupported JWT issuer: ${issuer}`);
    }
    const allowedAlgorithms = trust.algorithms ?? ["RS256"];
    if (!header.alg || !allowedAlgorithms.includes(header.alg as never)) {
      throw new HardessError(ERROR_CODES.AUTH_INVALID_TOKEN, `Unsupported JWT algorithm: ${header.alg ?? "missing"}`);
    }
    return trust;
  }

  private validateClaims(payload: JwtPayload, trust: RuntimeAuthTokenIssuerTrust): void {
    if (!matchesAudience(payload.aud, trust.audiences)) {
      throw new HardessError(ERROR_CODES.AUTH_INVALID_TOKEN, "JWT audience is not accepted");
    }

    const nowSec = Math.floor((this.options.now?.() ?? Date.now()) / 1000);
    const clockSkewSec = trust.clockSkewSec ?? DEFAULT_CLOCK_SKEW_SEC;
    if (typeof payload.exp !== "number" || payload.exp + clockSkewSec <= nowSec) {
      throw new HardessError(ERROR_CODES.AUTH_EXPIRED_TOKEN, "JWT has expired");
    }
    if (typeof payload.nbf === "number" && payload.nbf - clockSkewSec > nowSec) {
      throw new HardessError(ERROR_CODES.AUTH_INVALID_TOKEN, "JWT is not valid yet");
    }
    if (typeof payload.iat === "number") {
      const maxTokenTtlSec = trust.maxTokenTtlSec ?? DEFAULT_MAX_TOKEN_TTL_SEC;
      if (payload.exp - payload.iat > maxTokenTtlSec + clockSkewSec) {
        throw new HardessError(ERROR_CODES.AUTH_INVALID_TOKEN, "JWT TTL exceeds trust policy");
      }
      if (payload.iat - clockSkewSec > nowSec) {
        throw new HardessError(ERROR_CODES.AUTH_INVALID_TOKEN, "JWT issued-at is in the future");
      }
    }

    for (const claim of trust.requiredClaims ?? []) {
      if (!(claim in payload) || (payload as Record<string, unknown>)[claim] === undefined) {
        throw new HardessError(ERROR_CODES.AUTH_INVALID_TOKEN, `JWT missing required claim: ${claim}`);
      }
    }
  }

  private async verifySignature(input: {
    token: string;
    signingInput: string;
    signature: string;
    header: JwtHeader;
    trust: RuntimeAuthTokenIssuerTrust;
  }): Promise<void> {
    if (input.header.alg !== "RS256") {
      throw new HardessError(ERROR_CODES.AUTH_INVALID_TOKEN, `Unsupported JWT algorithm: ${input.header.alg}`);
    }

    const keys = await this.resolveVerificationKeys(input.trust, input.header);
    const signature = base64UrlDecode(input.signature);
    for (const key of keys) {
      try {
        const publicKey = keyToPublicKey(key);
        const verifier = createVerify("RSA-SHA256");
        verifier.update(input.signingInput);
        verifier.end();
        if (verifier.verify(publicKey, signature)) {
          return;
        }
      } catch {
        continue;
      }
    }

    throw new HardessError(ERROR_CODES.AUTH_INVALID_TOKEN, "JWT signature verification failed");
  }

  private async resolveVerificationKeys(
    trust: RuntimeAuthTokenIssuerTrust,
    header: JwtHeader
  ): Promise<Array<Jwk | { kid?: string; alg?: string; pem: string }>> {
    const staticKeys = (trust.publicKeys ?? []).filter((key) =>
      (!header.kid || key.kid === header.kid) &&
      (!header.alg || key.alg === header.alg)
    );
    if (staticKeys.length > 0) {
      return staticKeys;
    }
    if (!trust.jwksUrl) {
      return [];
    }

    const jwks = await this.fetchJwks(trust.jwksUrl);
    return jwks.filter((key) =>
      (!header.kid || key.kid === header.kid) &&
      (!header.alg || !key.alg || key.alg === header.alg)
    );
  }

  private async fetchJwks(jwksUrl: string): Promise<Jwk[]> {
    const cached = this.jwksCache.get(jwksUrl);
    const now = this.options.now?.() ?? Date.now();
    if (cached && now - cached.fetchedAt < (this.options.jwksCacheTtlMs ?? 5 * 60 * 1000)) {
      return cached.keys;
    }

    const response = await (this.options.fetchFn ?? fetch)(jwksUrl);
    if (!response.ok) {
      throw new HardessError(ERROR_CODES.AUTH_INVALID_TOKEN, `JWKS fetch failed with ${response.status}`);
    }
    const body = await response.json() as Jwks;
    const keys = Array.isArray(body.keys) ? body.keys : [];
    this.jwksCache.set(jwksUrl, { fetchedAt: now, keys });
    return keys;
  }
}

function parseJwtJson<T>(encoded: string, message: string): T {
  try {
    return JSON.parse(new TextDecoder().decode(base64UrlDecode(encoded))) as T;
  } catch (error) {
    throw new HardessError(ERROR_CODES.AUTH_INVALID_TOKEN, message, { cause: error });
  }
}

function base64UrlDecode(value: string): Buffer {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
  return Buffer.from(padded, "base64");
}

function keyToPublicKey(key: Jwk | { pem: string }): ReturnType<typeof createPublicKey> | string {
  if ("pem" in key) {
    return key.pem;
  }
  return createPublicKey({ key, format: "jwk" });
}

function matchesAudience(actual: JwtPayload["aud"], accepted: string[]): boolean {
  const values = Array.isArray(actual) ? actual : actual ? [actual] : [];
  return values.some((value) => accepted.includes(value));
}

function resolvePeerId(payload: JwtPayload): string | undefined {
  if (typeof payload.peerId === "string" && payload.peerId.trim()) {
    return payload.peerId;
  }
  if (typeof payload.workspaceId === "string" && typeof payload.principalId === "string") {
    return `${payload.workspaceId}:${payload.principalId}`;
  }
  return typeof payload.sub === "string" && payload.sub.trim() ? payload.sub : undefined;
}

function resolveCapabilities(payload: JwtPayload): string[] {
  const scopeCapabilities = Array.isArray(payload.scope)
    ? payload.scope
    : typeof payload.scope === "string"
      ? payload.scope.split(/\s+/)
      : [];
  return Array.from(new Set([...(payload.capabilities ?? []), ...scopeCapabilities].filter(Boolean)));
}
