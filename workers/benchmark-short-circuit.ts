import type { HardessWorkerModule } from "../src/shared/types.ts";

const benchmarkShortCircuitWorker: HardessWorkerModule = {
  async fetch(request, env) {
    return {
      response: new Response(
        JSON.stringify({
          ok: true,
          method: request.method,
          pathname: new URL(request.url).pathname,
          peerId: env.auth.peerId,
          pipelineId: env.pipeline.id
        }),
        {
          status: 200,
          headers: {
            "content-type": "application/json; charset=utf-8",
            "x-benchmark-worker": "v1-short-circuit"
          }
        }
      )
    };
  }
};

export default benchmarkShortCircuitWorker;
