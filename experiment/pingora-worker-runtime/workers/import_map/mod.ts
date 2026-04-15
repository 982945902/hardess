import { message } from "@lib/message.ts";

type WorkerEnv = {
  worker_id: string;
};

export function fetch(_request: Request, env: WorkerEnv) {
  return new Response(`message=${message} worker=${env.worker_id}`, {
    headers: {
      "content-type": "text/plain; charset=utf-8",
    },
  });
}
