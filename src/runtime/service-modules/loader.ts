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
  const cached = cache.get(entry);
  if (cached && cached.mtimeMs === fileStat.mtimeMs) {
    return cached.promise;
  }

  const promise = (async () => {
    const source = await readFile(absolutePath, "utf8");
    const shadowCopyPath = join(
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
    const nextCached = cache.get(entry);
    if (nextCached) {
      nextCached.shadowCopyPath = shadowCopyPath;
    }

    return serviceModule;
  })();

  cache.set(entry, {
    mtimeMs: fileStat.mtimeMs,
    promise,
    shadowCopyPath: undefined
  });
  return promise;
}

export function invalidateServiceModule(entry: string): void {
  const cached = cache.get(entry);
  if (cached?.shadowCopyPath) {
    void rm(cached.shadowCopyPath, { force: true });
  }
  cache.delete(entry);
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
