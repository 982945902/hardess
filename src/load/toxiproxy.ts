import { envNumberFirst, envStringFirst } from "./shared.ts";

interface ProxyDefinition {
  name: string;
  listen: string;
  upstream: string;
  enabled?: boolean;
  toxics?: Array<{ name: string }>;
}

const env = globalThis as {
  process?: {
    argv?: string[];
  };
};

const apiBaseUrl = envStringFirst(["TOXIPROXY_API_URL"], "http://127.0.0.1:8474");
const httpProxyPort = envNumberFirst(["TOXI_HTTP_PORT"], 8666);
const wsProxyPort = envNumberFirst(["TOXI_WS_PORT"], 8765);
const upstreamProxyPort = envNumberFirst(["TOXI_UPSTREAM_PORT"], 8667);
const latencyMs = envNumberFirst(["TOXI_LATENCY_MS", "LATENCY_MS"], 250);
const jitterMs = envNumberFirst(["TOXI_JITTER_MS", "JITTER_MS"], 80);
const bandwidthRateKbps = envNumberFirst(["TOXI_BANDWIDTH_KBPS", "BANDWIDTH_KBPS"], 256);

const proxies: ProxyDefinition[] = [
  {
    name: "hardess_http",
    listen: `0.0.0.0:${httpProxyPort}`,
    upstream: envStringFirst(["TOXI_HTTP_UPSTREAM"], "host.docker.internal:3000")
  },
  {
    name: "hardess_ws",
    listen: `0.0.0.0:${wsProxyPort}`,
    upstream: envStringFirst(["TOXI_WS_UPSTREAM"], "host.docker.internal:3000")
  },
  {
    name: "demo_upstream",
    listen: `0.0.0.0:${upstreamProxyPort}`,
    upstream: envStringFirst(["TOXI_UPSTREAM_TARGET"], "host.docker.internal:9000")
  }
];

async function request(path: string, init?: RequestInit): Promise<Response> {
  const response = await fetch(`${apiBaseUrl}${path}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...init?.headers
    }
  });

  if (!response.ok) {
    throw new Error(`Toxiproxy API ${init?.method ?? "GET"} ${path} failed with ${response.status}`);
  }

  return response;
}

async function listProxies(): Promise<Record<string, ProxyDefinition>> {
  const response = await request("/proxies");
  return await response.json() as Record<string, ProxyDefinition>;
}

async function populateProxies(): Promise<void> {
  await request("/populate", {
    method: "POST",
    body: JSON.stringify(proxies)
  });
}

async function resetAll(): Promise<void> {
  await request("/reset", {
    method: "POST",
    body: JSON.stringify({})
  });
}

async function addToxic(
  proxyName: string,
  toxic: {
    name: string;
    type: string;
    stream: "upstream" | "downstream";
    toxicity?: number;
    attributes: Record<string, number>;
  }
): Promise<void> {
  await request(`/proxies/${proxyName}/toxics`, {
    method: "POST",
    body: JSON.stringify(toxic)
  });
}

async function applyWeakClientProfile(): Promise<void> {
  for (const proxyName of ["hardess_http", "hardess_ws"] as const) {
    await addToxic(proxyName, {
      name: "latency_downstream",
      type: "latency",
      stream: "downstream",
      attributes: {
        latency: latencyMs,
        jitter: jitterMs
      }
    });
    await addToxic(proxyName, {
      name: "latency_upstream",
      type: "latency",
      stream: "upstream",
      attributes: {
        latency: latencyMs,
        jitter: jitterMs
      }
    });
    await addToxic(proxyName, {
      name: "bandwidth_downstream",
      type: "bandwidth",
      stream: "downstream",
      attributes: {
        rate: bandwidthRateKbps
      }
    });
  }
}

async function applyWeakUpstreamProfile(): Promise<void> {
  await addToxic("demo_upstream", {
    name: "latency_upstream",
    type: "latency",
    stream: "upstream",
    attributes: {
      latency: latencyMs,
      jitter: jitterMs
    }
  });
  await addToxic("demo_upstream", {
    name: "bandwidth_downstream",
    type: "bandwidth",
    stream: "downstream",
    attributes: {
      rate: bandwidthRateKbps
    }
  });
}

const command = env.process?.argv?.[2] ?? "status";

switch (command) {
  case "setup":
    await populateProxies();
    console.log(
      JSON.stringify(
        {
          ok: true,
          command,
          proxies
        },
        null,
        2
      )
    );
    break;
  case "reset":
    await resetAll();
    console.log(JSON.stringify({ ok: true, command }, null, 2));
    break;
  case "weak-client":
    await resetAll();
    await populateProxies();
    await applyWeakClientProfile();
    console.log(
      JSON.stringify(
        {
          ok: true,
          command,
          latencyMs,
          jitterMs,
          bandwidthRateKbps
        },
        null,
        2
      )
    );
    break;
  case "weak-upstream":
    await resetAll();
    await populateProxies();
    await applyWeakUpstreamProfile();
    console.log(
      JSON.stringify(
        {
          ok: true,
          command,
          latencyMs,
          jitterMs,
          bandwidthRateKbps
        },
        null,
        2
      )
    );
    break;
  case "status":
    console.log(
      JSON.stringify(
        {
          ok: true,
          command,
          proxies: await listProxies()
        },
        null,
        2
      )
    );
    break;
  default:
    throw new Error(`Unknown toxiproxy command: ${command}`);
}
