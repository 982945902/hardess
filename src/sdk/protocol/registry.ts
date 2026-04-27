import { ERROR_CODES } from "../../shared/codes.ts";
import { HardessError } from "../../shared/errors.ts";
import type { ClientProtocolModule } from "../../shared/types.ts";

function keyOf(protocol: string, version: string): string {
  return `${protocol}:${version}`;
}

export class ClientProtocolRegistry {
  private readonly modules = new Map<string, ClientProtocolModule<unknown, unknown>>();

  register(module: ClientProtocolModule<unknown, unknown>): void {
    const key = keyOf(module.protocol, module.version);
    if (this.modules.has(key)) {
      throw new HardessError(
        ERROR_CODES.PROTO_REGISTRATION_CONFLICT,
        `Client protocol already registered: ${module.protocol}@${module.version}`
      );
    }

    this.modules.set(key, module);
  }

  replace(module: ClientProtocolModule<unknown, unknown>): void {
    this.modules.set(keyOf(module.protocol, module.version), module);
  }

  unregister(protocol: string, version: string): void {
    this.modules.delete(keyOf(protocol, version));
  }

  get(protocol: string, version: string): ClientProtocolModule<unknown, unknown> | undefined {
    return this.modules.get(keyOf(protocol, version));
  }
}
