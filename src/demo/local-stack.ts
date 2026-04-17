import { spawn } from "node:child_process";
import { rm } from "node:fs/promises";

interface ManagedProcess {
  name: string;
  child: ReturnType<typeof spawn>;
}

const env = globalThis as {
  process?: {
    env?: Record<string, string | undefined>;
    exit?(code?: number): never;
    on?(event: string, listener: (...args: unknown[]) => void): void;
  };
};

const processEnv = env.process?.env ?? {};

function envString(name: string, fallback: string): string {
  return processEnv[name] ?? fallback;
}

function envNumber(name: string, fallback: number): number {
  const value = processEnv[name];
  if (!value) {
    return fallback;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function prefixStream(
  stream: NodeJS.ReadableStream | null,
  name: string,
  writer: (line: string) => void
): void {
  if (!stream) {
    return;
  }

  stream.setEncoding("utf8");
  let pending = "";
  stream.on("data", (chunk: string) => {
    pending += chunk;
    const lines = pending.split("\n");
    pending = lines.pop() ?? "";
    for (const line of lines) {
      writer(`[${name}] ${line}`);
    }
  });
  stream.on("end", () => {
    if (pending.length > 0) {
      writer(`[${name}] ${pending}`);
    }
  });
}

function spawnManagedProcess(
  name: string,
  args: string[],
  extraEnv: Record<string, string>
): ManagedProcess {
  const child = spawn("bun", args, {
    cwd: process.cwd(),
    env: {
      ...process.env,
      ...extraEnv
    },
    stdio: ["ignore", "pipe", "pipe"]
  });

  prefixStream(child.stdout, name, console.log);
  prefixStream(child.stderr, name, console.error);

  return {
    name,
    child
  };
}

async function stopProcess(
  processRef: ManagedProcess,
  signal: NodeJS.Signals = "SIGTERM"
): Promise<number | null> {
  if (processRef.child.exitCode !== null) {
    return processRef.child.exitCode;
  }

  processRef.child.kill(signal);
  const forceKillTimer = setTimeout(() => {
    if (processRef.child.exitCode === null) {
      processRef.child.kill("SIGKILL");
    }
  }, 5_000);

  const code = await waitForChildExit(processRef.child);
  clearTimeout(forceKillTimer);
  return code;
}

async function waitForReady(url: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) {
        return;
      }
    } catch {}

    await sleep(100);
  }

  throw new Error(`Timed out waiting for readiness: ${url}`);
}

async function waitForAdminHosts(
  adminBaseUrl: string,
  expectedHosts: number,
  timeoutMs: number
): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${adminBaseUrl}/__admin/mock/state`);
      if (response.ok) {
        const body = await response.json() as {
          registeredHosts?: unknown[];
        };
        if ((body.registeredHosts?.length ?? 0) >= expectedHosts) {
          return;
        }
      }
    } catch {}

    await sleep(100);
  }

  throw new Error(`Timed out waiting for admin to observe ${expectedHosts} hosts`);
}

async function maybeCleanArtifactDirs(paths: string[]): Promise<void> {
  if (envString("DEMO_STACK_RESET_ARTIFACTS", "0") !== "1") {
    return;
  }

  for (const path of paths) {
    await rm(path, { recursive: true, force: true });
  }
}

function waitForChildExit(child: ReturnType<typeof spawn>): Promise<number | null> {
  if (child.exitCode !== null) {
    return Promise.resolve(child.exitCode);
  }

  return new Promise<number | null>((resolve) => {
    const finalize = (code: number | null) => {
      child.off("exit", onExit);
      child.off("close", onClose);
      resolve(code);
    };

    const onExit = (code: number | null) => {
      finalize(code);
    };

    const onClose = () => {
      finalize(child.exitCode);
    };

    child.once("exit", onExit);
    child.once("close", onClose);

    queueMicrotask(() => {
      if (child.exitCode !== null) {
        finalize(child.exitCode);
      }
    });
  });
}

const upstreamPort = envNumber("DEMO_STACK_UPSTREAM_PORT", 9000);
const adminPort = envNumber("DEMO_STACK_ADMIN_PORT", 9100);
const hostAPort = envNumber("DEMO_STACK_HOST_A_PORT", 3000);
const hostBPort = envNumber("DEMO_STACK_HOST_B_PORT", 3001);
const readyTimeoutMs = envNumber("DEMO_STACK_READY_TIMEOUT_MS", 15_000);
const artifactRootDirA = envString("DEMO_STACK_ARTIFACT_DIR_A", ".hardess-admin-artifacts-a");
const artifactRootDirB = envString("DEMO_STACK_ARTIFACT_DIR_B", ".hardess-admin-artifacts-b");
const sharedDeploymentReplicas = processEnv.DEMO_STACK_SHARED_DEPLOYMENT_REPLICAS;
const hostGroupId = envString("DEMO_STACK_GROUP_ID", "group-personnel");

const upstreamBaseUrl = `http://127.0.0.1:${upstreamPort}`;
const adminBaseUrl = `http://127.0.0.1:${adminPort}`;
const hostABaseUrl = `http://127.0.0.1:${hostAPort}`;
const hostBBaseUrl = `http://127.0.0.1:${hostBPort}`;

const managedProcesses: ManagedProcess[] = [];
let shuttingDown = false;
let exitCode = 0;

async function shutdown(signal: "SIGINT" | "SIGTERM" | "SIGTERM_CHILD"): Promise<void> {
  if (shuttingDown) {
    return;
  }

  shuttingDown = true;
  console.log(`[demo:stack] shutting down (${signal})`);

  for (const processRef of [...managedProcesses].reverse()) {
    await stopProcess(processRef);
  }

  process.exit(exitCode);
}

function trackUnexpectedExit(processRef: ManagedProcess): void {
  processRef.child.once("exit", (code, signal) => {
    if (shuttingDown) {
      return;
    }

    exitCode = code ?? 1;
    console.error(
      `[demo:stack] process exited unexpectedly: ${processRef.name} code=${code ?? "null"} signal=${signal ?? "null"}`
    );
    void shutdown("SIGTERM_CHILD");
  });
}

try {
  await maybeCleanArtifactDirs([artifactRootDirA, artifactRootDirB]);

  const upstream = spawnManagedProcess("upstream", ["run", "demo:upstream"], {
    UPSTREAM_PORT: String(upstreamPort)
  });
  managedProcesses.push(upstream);
  trackUnexpectedExit(upstream);
  await waitForReady(`${upstreamBaseUrl}/`, readyTimeoutMs);

  const admin = spawnManagedProcess("admin", ["run", "demo:admin"], {
    ADMIN_DEMO_PORT: String(adminPort),
    ADMIN_DEMO_UPSTREAM_BASE_URL: upstreamBaseUrl,
    ...(sharedDeploymentReplicas
      ? {
          ADMIN_DEMO_SHARED_DEPLOYMENT_REPLICAS: sharedDeploymentReplicas
        }
      : {})
  });
  managedProcesses.push(admin);
  trackUnexpectedExit(admin);
  await waitForReady(`${adminBaseUrl}/__admin/mock/state`, readyTimeoutMs);

  const hostA = spawnManagedProcess("host-a", ["run", "dev"], {
    PORT: String(hostAPort),
    ADMIN_BASE_URL: adminBaseUrl,
    ADMIN_HOST_ID: "host-demo-a",
    ADMIN_ARTIFACT_ROOT_DIR: artifactRootDirA,
    HOST_GROUP_ID: hostGroupId
  });
  managedProcesses.push(hostA);
  trackUnexpectedExit(hostA);

  const hostB = spawnManagedProcess("host-b", ["run", "dev"], {
    PORT: String(hostBPort),
    ADMIN_BASE_URL: adminBaseUrl,
    ADMIN_HOST_ID: "host-demo-b",
    ADMIN_ARTIFACT_ROOT_DIR: artifactRootDirB,
    HOST_GROUP_ID: hostGroupId
  });
  managedProcesses.push(hostB);
  trackUnexpectedExit(hostB);

  await waitForReady(`${hostABaseUrl}/__admin/ready`, readyTimeoutMs);
  await waitForReady(`${hostBBaseUrl}/__admin/ready`, readyTimeoutMs);
  await waitForAdminHosts(adminBaseUrl, 2, readyTimeoutMs);

  console.log("[demo:stack] ready");
  console.log(`[demo:stack] upstream: ${upstreamBaseUrl}`);
  console.log(`[demo:stack] admin:    ${adminBaseUrl}`);
  console.log(`[demo:stack] host-a:   ${hostABaseUrl}`);
  console.log(`[demo:stack] host-b:   ${hostBBaseUrl}`);
  console.log(`[demo:stack] group:    ${hostGroupId}`);
  console.log("[demo:stack] try:");
  console.log(`  curl -s -H 'authorization: Bearer demo:alice' ${hostABaseUrl}/demo/shared | jq .`);
  console.log(`  curl -s -H 'authorization: Bearer demo:alice' ${hostABaseUrl}/demo/hosts/host-demo-a | jq .`);
  console.log(`  curl -i -H 'authorization: Bearer demo:alice' ${hostABaseUrl}/demo/serve/health`);
  console.log(`  curl -s ${adminBaseUrl}/__admin/mock/state | jq .`);

  env.process?.on?.("SIGINT", () => {
    void shutdown("SIGINT");
  });
  env.process?.on?.("SIGTERM", () => {
    void shutdown("SIGTERM");
  });

  await new Promise(() => {});
} catch (error) {
  exitCode = 1;
  console.error(
    `[demo:stack] failed to start: ${error instanceof Error ? error.message : String(error)}`
  );
  await shutdown("SIGTERM_CHILD");
}
