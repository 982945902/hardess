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
  const cached = cache.get(absolutePath);
  if (cached && cached.mtimeMs === fileStat.mtimeMs) {
    return cached.promise;
  }

  let shadowCopyPath: string | undefined;
  const promise = (async () => {
    const source = await readFile(absolutePath, "utf8");
    shadowCopyPath = join(
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
    const nextCached = cache.get(absolutePath);
    if (nextCached && shadowCopyPath) {
      nextCached.shadowCopyPath = shadowCopyPath;
    }

    return workerModule;
  })();

  cache.set(absolutePath, {
    mtimeMs: fileStat.mtimeMs,
    promise,
    shadowCopyPath: undefined
  });
  try {
    return await promise;
  } catch (error) {
    if (shadowCopyPath) {
      await rm(shadowCopyPath, { force: true });
    }

    const nextCached = cache.get(absolutePath);
    if (nextCached?.promise === promise) {
      if (cached) {
        cache.set(absolutePath, cached);
      } else {
        cache.delete(absolutePath);
      }
    }

    throw error;
  }
}

export function invalidateWorker(entry: string): void {
  const absolutePath = resolve(entry);
  const cached = cache.get(absolutePath);
  if (cached?.shadowCopyPath) {
    void rm(cached.shadowCopyPath, { force: true });
  }
  cache.delete(absolutePath);
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
