import { readFile, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join, resolve } from "node:path";
import { parseServiceModuleExport, type HardessServiceModule } from "../../shared/index.ts";

interface CachedServiceModule {
  mtimeMs: number;
  promise: Promise<HardessServiceModule>;
  shadowCopyPath?: string;
}

const cache = new Map<string, CachedServiceModule>();
let shadowCounter = 0;

export async function loadServiceModule(entry: string): Promise<HardessServiceModule> {
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
      `.${basename(absolutePath, extname(absolutePath))}.hardess-service-module-${fileStat.mtimeMs}-${shadowCounter += 1}${extname(absolutePath)}`
    );
    await writeFile(shadowCopyPath, source, "utf8");
    const moduleUrl = new URL(`file://${shadowCopyPath}`);
    const loaded = await import(moduleUrl.href);
    const serviceModule = parseServiceModuleExport(loaded.default ?? loaded, entry);

    if (cached?.shadowCopyPath) {
      await rm(cached.shadowCopyPath, { force: true });
    }
    const nextCached = cache.get(absolutePath);
    if (nextCached && shadowCopyPath) {
      nextCached.shadowCopyPath = shadowCopyPath;
    }

    return serviceModule;
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

export function invalidateServiceModule(entry: string): void {
  const absolutePath = resolve(entry);
  const cached = cache.get(absolutePath);
  if (cached?.shadowCopyPath) {
    void rm(cached.shadowCopyPath, { force: true });
  }
  cache.delete(absolutePath);
}

export function invalidateServiceModules(entries?: string[]): void {
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
    invalidateServiceModule(entry);
  }
}
