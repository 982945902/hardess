import type { HardessWorkerModule } from "../src/runtime/workers/types.ts";

const demoWorker: HardessWorkerModule = {
  async fetch(request, env) {
    const headers = new Headers(request.headers);
    headers.set("x-hardess-worker", env.pipeline.id);
    headers.set("x-hardess-auth-peer", env.auth.peerId);

    return {
      request: new Request(request, {
        headers
      })
    };
  }
};

export default demoWorker;
