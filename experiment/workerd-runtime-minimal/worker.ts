import { HardessWorkerRuntime } from "./worker-runtime.ts";
import type { Env } from "./worker-types.ts";

let currentRuntime: HardessWorkerRuntime | null = null;

function getRuntime(env: Env): HardessWorkerRuntime {
  if (!currentRuntime || !currentRuntime.canServe(env)) {
    currentRuntime = new HardessWorkerRuntime(env);
  }

  return currentRuntime;
}

export default {
  fetch(request: Request, env: Env): Promise<Response> {
    return getRuntime(env).fetch(request, env);
  },
} satisfies ExportedHandler<Env>;
