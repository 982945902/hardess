import { watch, type FSWatcher } from "node:fs";
import { readFile, rm, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join, resolve } from "node:path";
import { parseConfigModuleExport, parseHardessConfig, type HardessConfig } from "../../shared/index.ts";
import type { Logger } from "../observability/logger.ts";

type TimeoutHandle = ReturnType<typeof globalThis.setTimeout> | number;

export interface ConfigStore {
  getConfig(): HardessConfig;
  reload(): Promise<HardessConfig>;
  applyConfig(config: HardessConfig, options?: { source?: string }): Promise<HardessConfig>;
  watch(): void;
  dispose(): void;
  subscribe(listener: (config: HardessConfig) => void | Promise<void>): () => void;
}

export interface ModuleConfigStoreOptions {
  watchDebounceMs?: number;
  watchFn?: (
    path: string,
    options: { persistent: boolean },
    listener: (eventType: string, filename: string | Buffer | null | undefined) => void
  ) => FSWatcher;
  setTimeoutFn?: (callback: () => void, delay: number) => TimeoutHandle;
  clearTimeoutFn?: (timeout: TimeoutHandle) => void;
}

export class ModuleConfigStore implements ConfigStore {
  private currentConfig!: HardessConfig;
  private watching = false;
  private disposed = false;
  private readonly listeners = new Set<(config: HardessConfig) => void | Promise<void>>();
  private shadowCopyPath?: string;
  private reloadCounter = 0;
  private watcher?: FSWatcher;
  private reloadInFlight?: Promise<HardessConfig>;
  private reloadQueued = false;
  private watchDebounceTimer?: TimeoutHandle;

  constructor(
    private readonly modulePath: string,
    private readonly exportName = "hardessConfig",
    private readonly logger?: Logger,
    private readonly options: ModuleConfigStoreOptions = {}
  ) {}

  getConfig(): HardessConfig {
    if (!this.currentConfig) {
      throw new Error("Config has not been loaded yet");
    }

    return this.currentConfig;
  }

  async reload(): Promise<HardessConfig> {
    if (this.reloadInFlight) {
      this.reloadQueued = true;
      return this.reloadInFlight;
    }

    this.reloadInFlight = this.performReload();
    try {
      let config = await this.reloadInFlight;
      while (this.reloadQueued && !this.disposed) {
        this.reloadQueued = false;
        this.reloadInFlight = this.performReload();
        config = await this.reloadInFlight;
      }

      return config;
    } finally {
      this.reloadInFlight = undefined;
    }
  }

  async applyConfig(config: HardessConfig, options: { source?: string } = {}): Promise<HardessConfig> {
    const parsed = parseHardessConfig(config);
    await this.publishConfig(parsed, options.source ?? "runtime");
    return parsed;
  }

  private async performReload(): Promise<HardessConfig> {
    const absolutePath = resolve(this.modulePath);
    const source = await readFile(absolutePath, "utf8");
    const shadowCopyPath = join(
      dirname(absolutePath),
      `.${basename(absolutePath, extname(absolutePath))}.hardess-config-${Date.now()}-${this.reloadCounter += 1}${extname(absolutePath)}`
    );
    await writeFile(shadowCopyPath, source, "utf8");
    const moduleUrl = new URL(`file://${shadowCopyPath}`);
    const loaded = await import(moduleUrl.href);

    if (this.shadowCopyPath) {
      await rm(this.shadowCopyPath, { force: true });
    }
    this.shadowCopyPath = shadowCopyPath;

    const config = parseConfigModuleExport(loaded, {
      exportName: this.exportName,
      modulePath: this.modulePath
    });
    await this.publishConfig(config, this.modulePath);
    return config;
  }

  private async publishConfig(config: HardessConfig, source: string): Promise<void> {
    this.currentConfig = config;
    this.logger?.info("config reloaded", {
      modulePath: this.modulePath,
      source,
      pipelines: config.pipelines.length
    });

    for (const listener of this.listeners) {
      await listener(config);
    }
  }

  private scheduleReload(): void {
    if (this.disposed) {
      return;
    }

    if (this.watchDebounceTimer) {
      (this.options.clearTimeoutFn ?? clearTimeout)(this.watchDebounceTimer);
    }

    this.watchDebounceTimer = (this.options.setTimeoutFn ?? setTimeout)(() => {
      this.watchDebounceTimer = undefined;
      void this.reload().catch((error) => {
        this.logger?.error("config reload failed", {
          modulePath: this.modulePath,
          error: error instanceof Error ? error.message : String(error)
        });
      });
    }, this.options.watchDebounceMs ?? 25);
  }

  watch(): void {
    if (this.watching || this.watcher) {
      return;
    }

    this.watching = true;
    const absolutePath = resolve(this.modulePath);
    const targetDir = dirname(absolutePath);
    const targetFile = basename(absolutePath);
    this.watcher = (this.options.watchFn ?? watch)(
      targetDir,
      { persistent: false },
      (_eventType: string, filename: string | Buffer | null | undefined) => {
      const changedFile = typeof filename === "string" ? filename : filename?.toString();
      if (changedFile && changedFile !== targetFile) {
        return;
      }

      this.scheduleReload();
      }
    );
  }

  dispose(): void {
    this.watching = false;
    this.disposed = true;
    this.watcher?.close();
    this.watcher = undefined;
    if (this.watchDebounceTimer) {
      (this.options.clearTimeoutFn ?? clearTimeout)(this.watchDebounceTimer);
      this.watchDebounceTimer = undefined;
    }
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
