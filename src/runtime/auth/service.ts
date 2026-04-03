import { ERROR_CODES, HardessError, type AuthContext, type SysAuthPayload } from "../../shared/index.ts";
import type { AuthProvider } from "./provider.ts";

export interface AuthService {
  validateBearerToken(token: string | null): Promise<AuthContext>;
  validateSystemAuth(payload: SysAuthPayload): Promise<AuthContext>;
  isAuthContextValid(auth: AuthContext): Promise<boolean>;
  revoke(tokenId: string): Promise<void>;
}

export class RuntimeAuthService implements AuthService {
  private readonly revokedTokenIds = new Set<string>();
  private readonly providers = new Map<string, AuthProvider>();

  constructor(
    providers: AuthProvider[],
    private readonly defaultProviderName = "bearer"
  ) {
    for (const provider of providers) {
      this.providers.set(provider.name, provider);
    }
  }

  async validateBearerToken(token: string | null): Promise<AuthContext> {
    if (!token) {
      throw new HardessError(ERROR_CODES.AUTH_INVALID_TOKEN, "Missing bearer token");
    }

    const provider = this.providers.get(this.defaultProviderName);
    if (!provider) {
      throw new HardessError(ERROR_CODES.INTERNAL_ERROR, "Default auth provider is not configured");
    }

    const auth = await provider.validateBearerToken(token);
    this.ensureNotRevoked(auth.tokenId);
    return auth;
  }

  async validateSystemAuth(payload: SysAuthPayload): Promise<AuthContext> {
    const provider = this.providers.get(payload.provider);
    if (!provider) {
      throw new HardessError(ERROR_CODES.AUTH_INVALID_TOKEN, "Unsupported auth provider");
    }

    const auth = await provider.validateSystemAuth(payload);
    this.ensureNotRevoked(auth.tokenId);
    return auth;
  }

  async isAuthContextValid(auth: AuthContext): Promise<boolean> {
    if (this.revokedTokenIds.has(auth.tokenId)) {
      return false;
    }

    return auth.expiresAt > Date.now();
  }

  async revoke(tokenId: string): Promise<void> {
    this.revokedTokenIds.add(tokenId);
  }

  private ensureNotRevoked(tokenId: string): void {
    if (this.revokedTokenIds.has(tokenId)) {
      throw new HardessError(ERROR_CODES.AUTH_REVOKED_TOKEN, "Token has been revoked");
    }
  }
}
