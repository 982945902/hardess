import {
  ERROR_CODES,
  HardessError,
  type ServerActionHooks,
  type ServerProtocolModule
} from "../../shared/index.ts";

function keyOf(protocol: string, version: string, action: string): string {
  return `${protocol}:${version}:${action}`;
}

export class ServerProtocolRegistry {
  private readonly actions = new Map<string, ServerActionHooks<unknown>>();

  register(module: ServerProtocolModule<unknown>): void {
    for (const [action, hooks] of Object.entries(module.actions)) {
      const key = keyOf(module.protocol, module.version, action);
      if (this.actions.has(key)) {
        throw new HardessError(
          ERROR_CODES.PROTO_REGISTRATION_CONFLICT,
          `Server protocol action already registered: ${module.protocol}@${module.version}/${action}`
        );
      }

      this.actions.set(key, hooks);
    }
  }

  replace(module: ServerProtocolModule<unknown>): void {
    this.unregister(module.protocol, module.version);
    for (const [action, hooks] of Object.entries(module.actions)) {
      this.actions.set(keyOf(module.protocol, module.version, action), hooks);
    }
  }

  unregister(protocol: string, version: string): void {
    const prefix = `${protocol}:${version}:`;
    for (const key of this.actions.keys()) {
      if (key.startsWith(prefix)) {
        this.actions.delete(key);
      }
    }
  }

  get(protocol: string, version: string, action: string): ServerActionHooks<unknown> {
    const hooks = this.actions.get(keyOf(protocol, version, action));
    if (!hooks) {
      throw new HardessError(
        ERROR_CODES.PROTO_UNKNOWN_ACTION,
        `Unknown protocol action: ${protocol}@${version}/${action}`
      );
    }

    return hooks;
  }
}
