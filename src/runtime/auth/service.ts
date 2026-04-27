import { ERROR_CODES, HardessError, type AuthContext, type RuntimeAuthTrust, type SysAuthPayload } from "../../shared/index.ts";
import type { AuthProvider } from "./provider.ts";
import { JwtIssuerAuthProvider } from "./jwt-provider.ts";

export interface AuthService {
  validateBearerToken(token: string | null): Promise<AuthContext>;
  validateSystemAuth(payload: SysAuthPayload): Promise<AuthContext>;
  isAuthContextValid(auth: AuthContext): Promise<boolean>;
  revoke(tokenId: string): Promise<void>;
  applyRuntimeAuthTrust?(trust?: RuntimeAuthTrust): Promise<void> | void;
}

export class RuntimeAuthService implements AuthService {
  private readonly revokedTokenIds = new Set<string>();
  private readonly providers = new Map<string, AuthProvider>();
  private dynamicProviders = new Map<string, AuthProvider>();

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

    const providers = this.resolveProviders(this.defaultProviderName);
    if (providers.length === 0) {
      throw new HardessError(ERROR_CODES.INTERNAL_ERROR, "Default auth provider is not configured");
    }

    const auth = await this.validateWithProviders(
      providers,
      (provider) => provider.validateBearerToken(token)
    );
    this.ensureNotRevoked(auth.tokenId);
    return auth;
  }

  async validateSystemAuth(payload: SysAuthPayload): Promise<AuthContext> {
    const providers = this.resolveProviders(payload.provider);
    if (providers.length === 0) {
      throw new HardessError(ERROR_CODES.AUTH_INVALID_TOKEN, "Unsupported auth provider");
    }

    const auth = await this.validateWithProviders(
      providers,
      (provider) => provider.validateSystemAuth(payload)
    );
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

  applyRuntimeAuthTrust(trust?: RuntimeAuthTrust): void {
    const next = new Map<string, AuthProvider>();
    if (trust && trust.tokenIssuers.length > 0) {
      const provider = new JwtIssuerAuthProvider(trust);
      next.set(provider.name, provider);
    }
    this.dynamicProviders = next;
  }

  private resolveProviders(name: string): AuthProvider[] {
    return [
      ...(this.dynamicProviders.has(name) ? [this.dynamicProviders.get(name)!] : []),
      ...(this.providers.has(name) ? [this.providers.get(name)!] : [])
    ];
  }

  private async validateWithProviders(
    providers: AuthProvider[],
    validate: (provider: AuthProvider) => Promise<AuthContext>
  ): Promise<AuthContext> {
    let firstError: unknown;
    for (const provider of providers) {
      try {
        return await validate(provider);
      } catch (error) {
        firstError ??= error;
      }
    }
    throw firstError;
  }

  private ensureNotRevoked(tokenId: string): void {
    if (this.revokedTokenIds.has(tokenId)) {
      throw new HardessError(ERROR_CODES.AUTH_REVOKED_TOKEN, "Token has been revoked");
    }
  }
}
