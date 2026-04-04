import type { HardessWorkerModule } from "../src/runtime/workers/types.ts";

const benchShortWorker: HardessWorkerModule = {
  async fetch(_request, env) {
    return Response.json({
      ok: true,
      mode: "hardess-short-circuit",
      peerId: env.auth.peerId,
      pipelineId: env.pipeline.id
    });
  }
};

export default benchShortWorker;
