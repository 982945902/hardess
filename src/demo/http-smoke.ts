const env = globalThis as {
  process?: {
    env?: Record<string, string | undefined>;
  };
};

const baseUrl = env.process?.env?.BASE_URL ?? "http://127.0.0.1:3000";
const peerId = env.process?.env?.PEER_ID ?? "alice";
const path = env.process?.env?.PATHNAME ?? "/demo/orders";

const response = await fetch(`${baseUrl}${path}`, {
  headers: {
    authorization: `Bearer demo:${peerId}`
  }
});

const contentType = response.headers.get("content-type") ?? "";
const body = contentType.includes("application/json")
  ? await response.json()
  : await response.text();

console.log(
  JSON.stringify(
    {
      ok: response.ok,
      status: response.status,
      body
    },
    null,
    2
  )
);

export {};
