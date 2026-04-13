import {
  ERROR_CODES,
  HardessError,
  parseSysAuthPayload,
  type AuthContext
} from "../../shared/index.ts";

export interface AuthProvider {
  name: string;
  validateBearerToken(token: string): Promise<AuthContext>;
  validateSystemAuth(payload: unknown): Promise<AuthContext>;
}

export class DemoBearerAuthProvider implements AuthProvider {
  readonly name = "bearer";

  async validateBearerToken(token: string): Promise<AuthContext> {
    const normalized = token.startsWith("Bearer ") ? token.slice(7) : token;
    const [scheme, peerId] = normalized.split(":");

    if (scheme !== "demo" || !peerId) {
      throw new HardessError(ERROR_CODES.AUTH_INVALID_TOKEN, "Unsupported token format");
    }

    return {
      peerId,
      tokenId: normalized,
      capabilities: ["notify.conn", "push.system"],
      expiresAt: Date.now() + 60 * 60 * 1000
    };
  }

  async validateSystemAuth(payload: unknown): Promise<AuthContext> {
    const authPayload = parseSysAuthPayload(payload);
    if (typeof authPayload.payload !== "string") {
      throw new HardessError(ERROR_CODES.AUTH_INVALID_TOKEN, "Invalid bearer auth payload");
    }

    return this.validateBearerToken(authPayload.payload);
  }
}
