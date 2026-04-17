import { readFile, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join, resolve } from "node:path";
import {
  parseServeModuleExport,
  parseWorkerModuleExport,
  type HardessWorkerModule
} from "../../shared/index.ts";
import { createWorkerFromServeModule } from "../serve/worker.ts";

interface CachedWorker {
  mtimeMs: number;
  promise: Promise<HardessWorkerModule>;
  shadowCopyPath?: string;
}

const cache = new Map<string, CachedWorker>();
let shadowCounter = 0;

export async function loadWorker(entry: string): Promise<HardessWorkerModule> {
  const absolutePath = resolve(entry);
  const fileStat = await stat(absolutePath);
  const cached = cache.get(entry);
  if (cached && cached.mtimeMs === fileStat.mtimeMs) {
    return cached.promise;
  }

  const promise = (async () => {
    const source = await readFile(absolutePath, "utf8");
    const shadowCopyPath = join(
      dirname(absolutePath),
      `.${basename(absolutePath, extname(absolutePath))}.hardess-worker-${fileStat.mtimeMs}-${shadowCounter += 1}${extname(absolutePath)}`
    );
    await writeFile(shadowCopyPath, source, "utf8");
    const moduleUrl = new URL(`file://${shadowCopyPath}`);
    const loaded = await import(moduleUrl.href);
    const exportedValue = loaded.default ?? loaded;
    let workerModule: HardessWorkerModule;
    try {
      workerModule = parseWorkerModuleExport(exportedValue, entry);
    } catch (workerError) {
      try {
        workerModule = createWorkerFromServeModule(parseServeModuleExport(exportedValue, entry));
      } catch {
        throw workerError;
      }
    }

    if (cached?.shadowCopyPath) {
      await rm(cached.shadowCopyPath, { force: true });
    }
    const nextCached = cache.get(entry);
    if (nextCached) {
      nextCached.shadowCopyPath = shadowCopyPath;
    }

    return workerModule;
  })();

  cache.set(entry, {
    mtimeMs: fileStat.mtimeMs,
    promise,
    shadowCopyPath: undefined
  });
  return promise;
}

export function invalidateWorker(entry: string): void {
  const cached = cache.get(entry);
  if (cached?.shadowCopyPath) {
    void rm(cached.shadowCopyPath, { force: true });
  }
  cache.delete(entry);
}

export function invalidateWorkers(entries?: string[]): void {
  if (!entries) {
    for (const cached of cache.values()) {
      if (cached.shadowCopyPath) {
        void rm(cached.shadowCopyPath, { force: true });
      }
    }
    cache.clear();
    return;
  }

  for (const entry of entries) {
    invalidateWorker(entry);
  }
}
