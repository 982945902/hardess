import { watch, type FSWatcher } from "node:fs";
import { readFile, rm, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join, resolve } from "node:path";
import type { HardessConfig } from "../../shared/types.ts";
import type { Logger } from "../observability/logger.ts";

export interface ConfigStore {
  getConfig(): HardessConfig;
  reload(): Promise<HardessConfig>;
  watch(): void;
  dispose(): void;
  subscribe(listener: (config: HardessConfig) => void | Promise<void>): () => void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object";
}

function validateConfig(config: HardessConfig): void {
  if (!Array.isArray(config.pipelines) || config.pipelines.length === 0) {
    throw new Error("Config must define at least one pipeline");
  }

  for (const pipeline of config.pipelines) {
    if (!pipeline.id || !pipeline.matchPrefix || !pipeline.downstream?.origin) {
      throw new Error(`Invalid pipeline configuration: ${JSON.stringify(pipeline)}`);
    }
  }
}

export class ModuleConfigStore implements ConfigStore {
  private currentConfig!: HardessConfig;
  private watching = false;
  private readonly listeners = new Set<(config: HardessConfig) => void | Promise<void>>();
  private shadowCopyPath?: string;
  private reloadCounter = 0;
  private watcher?: FSWatcher;

  constructor(
    private readonly modulePath: string,
    private readonly exportName = "hardessConfig",
    private readonly logger?: Logger
  ) {}

  getConfig(): HardessConfig {
    if (!this.currentConfig) {
      throw new Error("Config has not been loaded yet");
    }

    return this.currentConfig;
  }

  async reload(): Promise<HardessConfig> {
    const absolutePath = resolve(this.modulePath);
    const source = await readFile(absolutePath, "utf8");
    const shadowCopyPath = join(
      dirname(absolutePath),
      `.${basename(absolutePath, extname(absolutePath))}.hardess-config-${Date.now()}-${this.reloadCounter += 1}${extname(absolutePath)}`
    );
    await writeFile(shadowCopyPath, source, "utf8");
    const moduleUrl = new URL(`file://${shadowCopyPath}`);
    const loaded = await import(moduleUrl.href);
    const candidate = (loaded[this.exportName] ?? loaded.default) as unknown;

    if (this.shadowCopyPath) {
      await rm(this.shadowCopyPath, { force: true });
    }
    this.shadowCopyPath = shadowCopyPath;

    if (!isRecord(candidate)) {
      throw new Error(`Config module ${this.modulePath} does not export a valid config object`);
    }

    const config = candidate as HardessConfig;
    validateConfig(config);
    this.currentConfig = config;
    this.logger?.info("config reloaded", {
      modulePath: this.modulePath,
      pipelines: config.pipelines.length
    });

    for (const listener of this.listeners) {
      await listener(config);
    }

    return config;
  }

  watch(): void {
    if (this.watching || this.watcher) {
      return;
    }

    this.watching = true;
    const absolutePath = resolve(this.modulePath);
    this.watcher = watch(absolutePath, { persistent: false }, async () => {
      try {
        await this.reload();
      } catch (error) {
        this.logger?.error("config reload failed", {
          modulePath: this.modulePath,
          error: error instanceof Error ? error.message : String(error)
        });
      }
    });
  }

  dispose(): void {
    this.watching = false;
    this.watcher?.close();
    this.watcher = undefined;
    if (this.shadowCopyPath) {
      void rm(this.shadowCopyPath, { force: true });
      this.shadowCopyPath = undefined;
    }
  }

  subscribe(listener: (config: HardessConfig) => void | Promise<void>): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
}
