import { ERROR_CODES, HardessError, type AuthContext, type SysAuthPayload } from "../../shared/index.ts";

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
    if (!payload || typeof payload !== "object") {
      throw new HardessError(ERROR_CODES.AUTH_INVALID_TOKEN, "Invalid auth payload");
    }

    const authPayload = payload as SysAuthPayload;
    if (typeof authPayload.payload !== "string") {
      throw new HardessError(ERROR_CODES.AUTH_INVALID_TOKEN, "Invalid bearer auth payload");
    }

    return this.validateBearerToken(authPayload.payload);
  }
}
