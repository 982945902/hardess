import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import {
  ADMIN_TRANSPORT_OPERATIONS,
  MockAdminTransport,
  buildPlacementCandidateHosts,
  buildMembershipSnapshot,
  buildPlacementSnapshot,
  buildDeploymentRolloutSummary,
  buildHttpWorkerArtifactManifest,
  normalizeReplicaCount,
  planHttpWorkerDeploymentOwners,
  parseDesiredHostStateQuery,
  parseHeartbeatHostInput,
  parseHostRegistration,
  parseObservedHostState,
  projectHttpWorkerDesiredState,
  type ArtifactManifest,
  type DeploymentRolloutHostStatus,
  type DeploymentRolloutSummary,
  type DesiredTopology,
  type DesiredHostState,
  type HostRegistration,
  type HttpWorkerDeploymentPlan,
  type PlacementCandidateHost
} from "../sdk/index.ts";

declare const Bun: {
  serve(options: {
    port: number;
    fetch(request: Request): Response | Promise<Response>;
  }): { port: number };
};

interface DemoWorkerArtifactFiles {
  source: string;
  digest: string;
}

interface DemoArtifactFiles {
  sharedWorker: DemoWorkerArtifactFiles;
  hostWorker: DemoWorkerArtifactFiles;
  serveApp: DemoWorkerArtifactFiles;
  serviceModule: DemoWorkerArtifactFiles;
  packageJson: string;
  bunLock: string;
}

interface DemoServiceModuleDeploymentPlan {
  deploymentId: string;
  groupId?: string;
  declaredArtifactId?: string;
  declaredVersion: string;
  manifestId: string;
  sourceUri: string;
  sourceDigest?: string;
  serviceName: string;
  serviceEntry: string;
  assignmentMode?: "all-hosts";
  metadataAnnotations?: Record<string, string>;
}

interface DemoRolloutState {
  sharedDeploymentReplicas: number;
  revisionToken: number;
}

export interface DemoAdminAppOptions {
  upstreamBaseUrl?: string;
  routePrefix?: string;
  sharedDeploymentReplicas?: number;
  pollAfterMs?: number;
  nextPollAfterMs?: number;
  artifactBaseUrl?: string;
}

export interface DemoAdminApp {
  fetch(request: Request): Promise<Response>;
}

const DEFAULT_PORT = 9100;
const sharedWorkerArtifactUrl = new URL("./admin-artifacts/demo-http-worker.ts", import.meta.url);
const hostWorkerArtifactUrl = new URL("./admin-artifacts/demo-host-worker.ts", import.meta.url);
const serveAppArtifactUrl = new URL("./admin-artifacts/demo-serve-app.ts", import.meta.url);
const serviceModuleArtifactUrl = new URL("./admin-artifacts/demo-chat-service-module.ts", import.meta.url);
const packageJsonArtifactUrl = new URL("./admin-artifacts/package.json", import.meta.url);
const bunLockArtifactUrl = new URL("./admin-artifacts/bun.lock", import.meta.url);
const DEMO_GROUP_ID = "group-personnel";

export async function createDemoAdminApp(
  options: DemoAdminAppOptions = {}
): Promise<DemoAdminApp> {
  const transport = new MockAdminTransport({
    pollAfterMs: options.pollAfterMs ?? 5_000,
    nextPollAfterMs: options.nextPollAfterMs ?? 5_000
  });
  const artifactFiles = await loadArtifactFiles();
  const rolloutState: DemoRolloutState = {
    sharedDeploymentReplicas: normalizeReplicaCount(options.sharedDeploymentReplicas ?? 1),
    revisionToken: 1
  };

  return {
    async fetch(request: Request): Promise<Response> {
      const url = new URL(request.url);
      const origin = options.artifactBaseUrl ?? url.origin;
      const upstreamBaseUrl = options.upstreamBaseUrl ?? "http://127.0.0.1:9000";
      const routePrefix = normalizeRoutePrefix(options.routePrefix ?? "/demo");
      const resolvePlan = () => {
        const httpDeployments = buildDemoHttpDeployments(routePrefix, rolloutState.sharedDeploymentReplicas);
        const serviceModuleDeployments = buildDemoServiceModuleDeployments();
        const manifests = [
          ...httpDeployments.map((deployment) =>
            buildHttpArtifactManifest(origin, artifactFiles, deployment, rolloutState.sharedDeploymentReplicas)
          ),
          ...serviceModuleDeployments.map((deployment) =>
            buildServiceModuleArtifactManifest(origin, artifactFiles, deployment)
          )
        ];
        const manifestsById = new Map(
          manifests.map((manifest) => [manifest.manifestId, manifest] as const)
        );
        return {
          httpDeployments,
          serviceModuleDeployments,
          manifests,
          manifestsById
        };
      };
      let { httpDeployments, serviceModuleDeployments, manifests, manifestsById } = resolvePlan();

      if (request.method === "GET") {
        const artifactResponse = serveArtifactRequest(url.pathname, artifactFiles);
        if (artifactResponse) {
          return artifactResponse;
        }

        if (url.pathname === "/__admin/mock/state") {
          return jsonResponse(buildMockStateSnapshot(transport, manifests, rolloutState));
        }
      }

      if (request.method !== "POST") {
        return jsonResponse(
          {
            error: "not_found",
            pathname: url.pathname
          },
          404
        );
      }

      const payload = await request.json();
      switch (url.pathname) {
        case "/__admin/mock/rollouts/shared-deployment": {
          rolloutState.sharedDeploymentReplicas = normalizeReplicaCount(
            typeof payload?.sharedDeploymentReplicas === "number"
              ? payload.sharedDeploymentReplicas
              : Number(payload?.sharedDeploymentReplicas)
          );
          rolloutState.revisionToken += 1;
          ({ httpDeployments, serviceModuleDeployments, manifests, manifestsById } = resolvePlan());
          reseedAllDesiredHostStates(
            transport,
            manifests,
            buildDesiredHostStates({
              transport,
              upstreamBaseUrl,
              httpDeployments,
              serviceModuleDeployments,
              manifestsById,
              revisionToken: rolloutState.revisionToken
            })
          );
          return jsonResponse({
            accepted: true,
            sharedDeploymentReplicas: rolloutState.sharedDeploymentReplicas,
            revisionToken: rolloutState.revisionToken
          });
        }
        case "/v1/admin/hosts/register": {
          const registration = parseHostRegistration(payload);
          const result = await transport.request(ADMIN_TRANSPORT_OPERATIONS.REGISTER_HOST, registration);
          reseedAllDesiredHostStates(
            transport,
            manifests,
            buildDesiredHostStates({
              transport,
              upstreamBaseUrl,
              httpDeployments,
              serviceModuleDeployments,
              manifestsById,
              revisionToken: rolloutState.revisionToken
            })
          );
          return jsonResponse(result);
        }
        case "/v1/admin/hosts/heartbeat": {
          const heartbeat = parseHeartbeatHostInput(payload);
          const result = await transport.request(ADMIN_TRANSPORT_OPERATIONS.HEARTBEAT_HOST, heartbeat);
          reseedAllDesiredHostStates(
            transport,
            manifests,
            buildDesiredHostStates({
              transport,
              upstreamBaseUrl,
              httpDeployments,
              serviceModuleDeployments,
              manifestsById,
              revisionToken: rolloutState.revisionToken
            })
          );
          return jsonResponse(result);
        }
        case "/v1/admin/hosts/desired": {
          const query = parseDesiredHostStateQuery(payload);
          seedHostState(
            transport,
            query.hostId,
            manifests,
            buildDesiredHostStates({
              transport,
              upstreamBaseUrl,
              httpDeployments,
              serviceModuleDeployments,
              manifestsById,
              revisionToken: rolloutState.revisionToken,
              extraHostIds: [query.hostId]
            })
          );
          return jsonResponse(
            await transport.request(ADMIN_TRANSPORT_OPERATIONS.GET_DESIRED_HOST_STATE, query)
          );
        }
        case "/v1/admin/hosts/observed": {
          const observed = parseObservedHostState(payload);
          const result = await transport.request(
            ADMIN_TRANSPORT_OPERATIONS.REPORT_OBSERVED_HOST_STATE,
            observed
          );
          reseedAllDesiredHostStates(
            transport,
            manifests,
            buildDesiredHostStates({
              transport,
              upstreamBaseUrl,
              httpDeployments,
              serviceModuleDeployments,
              manifestsById,
              revisionToken: rolloutState.revisionToken
            })
          );
          return jsonResponse(result);
        }
        case "/v1/admin/artifacts/manifest": {
          for (const manifest of manifests) {
            transport.putArtifactManifest(manifest);
          }
          return jsonResponse(
            await transport.request(ADMIN_TRANSPORT_OPERATIONS.FETCH_ARTIFACT_MANIFEST, payload)
          );
        }
        default:
          return jsonResponse(
            {
              error: "not_found",
              pathname: url.pathname
            },
            404
          );
      }
    }
  };
}

async function loadArtifactFiles(): Promise<DemoArtifactFiles> {
  const sharedWorkerSource = await readFile(sharedWorkerArtifactUrl, "utf8");
  const hostWorkerSource = await readFile(hostWorkerArtifactUrl, "utf8");
  const serveAppSource = await readFile(serveAppArtifactUrl, "utf8");
  const serviceModuleSource = await readFile(serviceModuleArtifactUrl, "utf8");
  const packageJson = await readFile(packageJsonArtifactUrl, "utf8");
  const bunLock = await readFile(bunLockArtifactUrl, "utf8");
  return {
    sharedWorker: {
      source: sharedWorkerSource,
      digest: `sha256:${createHash("sha256").update(sharedWorkerSource).digest("hex")}`
    },
    hostWorker: {
      source: hostWorkerSource,
      digest: `sha256:${createHash("sha256").update(hostWorkerSource).digest("hex")}`
    },
    serveApp: {
      source: serveAppSource,
      digest: `sha256:${createHash("sha256").update(serveAppSource).digest("hex")}`
    },
    serviceModule: {
      source: serviceModuleSource,
      digest: `sha256:${createHash("sha256").update(serviceModuleSource).digest("hex")}`
    },
    packageJson,
    bunLock
  };
}

function buildDemoHttpDeployments(
  routePrefix: string,
  sharedDeploymentReplicas: number
): HttpWorkerDeploymentPlan[] {
  return [
    {
      deploymentId: "deployment:demo-http-shared",
      groupId: DEMO_GROUP_ID,
      declaredArtifactId: "demo-http-shared-worker",
      declaredVersion: "demo-http-shared/v1",
      manifestId: "manifest:demo-http-shared:v1",
      replicas: sharedDeploymentReplicas,
      sourceUri: "",
      workerName: "demo-http-shared-worker",
      workerEntry: "workers/demo-http-worker.ts",
      routeId: "route:demo-http-shared",
      routePathPrefix: `${routePrefix}/shared`,
      routeScope: "shared",
      assignmentMode: "select-first-n-hosts",
      rollout: {
        strategy: "gradual",
        batchSize: 1,
        maxUnavailable: 0
      }
    },
    {
      deploymentId: "deployment:demo-http-host",
      groupId: DEMO_GROUP_ID,
      declaredArtifactId: "demo-http-host-worker",
      declaredVersion: "demo-http-host/v1",
      manifestId: "manifest:demo-http-host:v1",
      replicas: Number.MAX_SAFE_INTEGER,
      sourceUri: "",
      workerName: "demo-http-host-worker",
      workerEntry: "workers/demo-host-worker.ts",
      routeId: "route:demo-http-host",
      routePathPrefix: `${routePrefix}/hosts`,
      routeScope: "per_host",
      assignmentMode: "all-hosts"
    },
    {
      deploymentId: "deployment:demo-personnel-serve",
      deploymentKind: "serve",
      groupId: DEMO_GROUP_ID,
      declaredArtifactId: "demo-personnel-serve",
      declaredVersion: "demo-personnel-serve/v1",
      manifestId: "manifest:demo-personnel-serve:v1",
      replicas: Number.MAX_SAFE_INTEGER,
      sourceUri: "",
      workerName: "demo-personnel-serve",
      workerEntry: "apps/demo-serve-app.ts",
      routeId: "route:demo-personnel-serve",
      routePathPrefix: `${routePrefix}/serve`,
      assignmentMode: "all-hosts"
    }
  ];
}

function buildDemoServiceModuleDeployments(): DemoServiceModuleDeploymentPlan[] {
  return [
    {
      deploymentId: "deployment:demo-chat-service-module",
      groupId: DEMO_GROUP_ID,
      declaredArtifactId: "demo-chat-service-module",
      declaredVersion: "demo-chat-service-module/v1",
      manifestId: "manifest:demo-chat-service-module:v1",
      sourceUri: "",
      serviceName: "demo-chat-service-module",
      serviceEntry: "services/demo-chat-service-module.ts",
      assignmentMode: "all-hosts",
      metadataAnnotations: {
        demo: "true",
        deploymentId: "deployment:demo-chat-service-module"
      }
    }
  ];
}

function buildHttpArtifactManifest(
  origin: string,
  artifactFiles: DemoArtifactFiles,
  deployment: HttpWorkerDeploymentPlan,
  sharedDeploymentReplicas: number
): ArtifactManifest {
  const workerArtifact =
    deployment.deploymentId === "deployment:demo-http-shared"
      ? artifactFiles.sharedWorker
      : deployment.deploymentId === "deployment:demo-http-host"
        ? artifactFiles.hostWorker
        : artifactFiles.serveApp;
  const sourcePath =
    deployment.deploymentId === "deployment:demo-http-shared"
      ? "/artifacts/demo-http-worker.ts"
      : deployment.deploymentId === "deployment:demo-http-host"
        ? "/artifacts/demo-host-worker.ts"
        : "/artifacts/demo-serve-app.ts";

  return buildHttpWorkerArtifactManifest({
    ...deployment,
    replicas:
      deployment.deploymentId === "deployment:demo-http-shared"
        ? sharedDeploymentReplicas
        : Number.MAX_SAFE_INTEGER,
    sourceUri: new URL(sourcePath, origin).toString(),
    sourceDigest: workerArtifact.digest,
    packageManagerKind: "bun",
    packageJson: new URL("/artifacts/package.json", origin).toString(),
    bunLock: new URL("/artifacts/bun.lock", origin).toString(),
    frozenLock: true,
    metadataAnnotations: {
      demo: "true",
      deploymentId: deployment.deploymentId
    }
  });
}

function buildServiceModuleArtifactManifest(
  origin: string,
  artifactFiles: DemoArtifactFiles,
  deployment: DemoServiceModuleDeploymentPlan
): ArtifactManifest {
  return {
    manifestId: deployment.manifestId,
    artifactKind: "service_module",
    declaredArtifactId: deployment.declaredArtifactId,
    declaredVersion: deployment.declaredVersion,
    source: {
      uri: new URL("/artifacts/demo-chat-service-module.ts", origin).toString(),
      digest: artifactFiles.serviceModule.digest
    },
    entry: deployment.serviceEntry,
    packageManager: {
      kind: "bun",
      packageJson: new URL("/artifacts/package.json", origin).toString(),
      bunLock: new URL("/artifacts/bun.lock", origin).toString(),
      frozenLock: true
    },
    metadata: deployment.metadataAnnotations
      ? {
          annotations: { ...deployment.metadataAnnotations }
        }
      : undefined
  };
}

function buildDesiredProjection(input: {
  hostId: string;
  upstreamBaseUrl: string;
  httpDeployments: HttpWorkerDeploymentPlan[];
  serviceModuleDeployments: DemoServiceModuleDeploymentPlan[];
  registrationsByHostId: Map<string, HostRegistration>;
  manifestsById: Map<string, ArtifactManifest>;
  registeredHostIds: string[];
  candidateHosts: PlacementCandidateHost[];
  revisionToken: number;
}): DesiredHostState {
  const httpDesiredState = projectHttpWorkerDesiredState({
    hostId: input.hostId,
    upstreamBaseUrl: input.upstreamBaseUrl,
    deployments: input.httpDeployments.map((deployment) => {
      const manifest = input.manifestsById.get(deployment.manifestId);
      if (!manifest) {
        throw new Error(`Missing manifest for deployment ${deployment.deploymentId}`);
      }

      return {
        ...deployment,
        replicas:
          deployment.deploymentId === "deployment:demo-http-shared"
            ? normalizeReplicaCount(deployment.replicas ?? 1)
            : Number.MAX_SAFE_INTEGER,
        sourceUri: manifest.source.uri,
        sourceDigest: manifest.source.digest,
        packageManagerKind: manifest.packageManager.kind,
        packageJson: manifest.packageManager.kind === "bun" ? manifest.packageManager.packageJson : undefined,
        bunfigToml: manifest.packageManager.kind === "bun" ? manifest.packageManager.bunfigToml : undefined,
        bunLock: manifest.packageManager.kind === "bun" ? manifest.packageManager.bunLock : undefined,
        denoJson: manifest.packageManager.kind === "deno" ? manifest.packageManager.denoJson : undefined,
        denoLock: manifest.packageManager.kind === "deno" ? manifest.packageManager.denoLock : undefined,
        frozenLock: manifest.packageManager.frozenLock
      };
    }),
    registeredHostIds: input.registeredHostIds,
    candidateHosts: input.candidateHosts,
    revisionToken: input.revisionToken
  });

  const serviceAssignments = input.serviceModuleDeployments.flatMap((deployment) =>
    shouldAssignServiceModuleToHost(deployment, input.hostId, input.registrationsByHostId)
      ? [buildServiceModuleAssignmentForHost(input.hostId, deployment, input.manifestsById)]
      : []
  );

  return {
    ...httpDesiredState,
    revision: buildDesiredRevision(
      input.hostId,
      input.revisionToken,
      [...httpDesiredState.assignments, ...serviceAssignments]
    ),
    assignments: [...httpDesiredState.assignments, ...serviceAssignments]
  };
}

function seedHostState(
  transport: MockAdminTransport,
  hostId: string,
  manifests: ArtifactManifest[],
  desiredHostStates: DesiredHostState[]
): void {
  const desired = desiredHostStates.find((value) => value.hostId === hostId);
  if (!desired) {
    throw new Error(`Missing desired host state for ${hostId}`);
  }

  for (const manifest of manifests) {
    transport.putArtifactManifest(manifest);
  }
  transport.setDesiredHostState(desired);
}

function buildMockStateSnapshot(
  transport: MockAdminTransport,
  manifests: ArtifactManifest[],
  rolloutState: DemoRolloutState
): {
  registeredHosts: ReturnType<MockAdminTransport["listRegisteredHosts"]>;
  desiredHostStates: DesiredHostState[];
  observedHostStates: Exclude<ReturnType<MockAdminTransport["getObservedHostState"]>, undefined>[];
  artifactManifests: ArtifactManifest[];
  topology: DesiredTopology;
  rolloutState: DemoRolloutState;
  rolloutSummary: DemoDeploymentRolloutSummary[];
} {
  const registeredHosts = transport.listRegisteredHosts();
  const desiredHostStates = registeredHosts.map((host) =>
    transport.getDesiredHostStateSnapshot(host.hostId)
  );
  const observedHostStates = registeredHosts
    .map((host) => transport.getObservedHostState(host.hostId))
    .filter((value): value is Exclude<typeof value, undefined> => value !== undefined);
  const topology = desiredHostStates[0]?.topology ?? {
    membership: buildMembershipSnapshot({
      revision: `topology:${rolloutState.revisionToken}:membership`,
      registrations: registeredHosts,
      observedHostStates
    }),
    placement: buildPlacementSnapshot({
      revision: `topology:${rolloutState.revisionToken}:placement`,
      desiredHostStates
    })
  };

  return {
    registeredHosts,
    desiredHostStates,
    observedHostStates,
    artifactManifests: manifests,
    topology,
    rolloutState: { ...rolloutState },
    rolloutSummary: buildDeploymentRolloutSummary(desiredHostStates, observedHostStates)
  };
}

interface DemoDeploymentRolloutSummary extends DeploymentRolloutSummary {
  hosts: DemoDeploymentRolloutHostStatus[];
}

interface DemoDeploymentRolloutHostStatus extends DeploymentRolloutHostStatus {
  observedState?: "pending" | "preparing" | "ready" | "active" | "draining" | "failed" | "missing";
}

function reseedAllDesiredHostStates(
  transport: MockAdminTransport,
  manifests: ArtifactManifest[],
  desiredHostStates: DesiredHostState[]
): void {
  for (const manifest of manifests) {
    transport.putArtifactManifest(manifest);
  }

  for (const desired of desiredHostStates) {
    transport.setDesiredHostState(desired);
  }
}

function buildDesiredHostStates(input: {
  transport: MockAdminTransport;
  upstreamBaseUrl: string;
  httpDeployments: HttpWorkerDeploymentPlan[];
  serviceModuleDeployments: DemoServiceModuleDeploymentPlan[];
  manifestsById: Map<string, ArtifactManifest>;
  revisionToken: number;
  extraHostIds?: string[];
}): DesiredHostState[] {
  const registrations = collectTopologyRegistrations(input.transport, input.extraHostIds);
  const observedHostStates = registrations
    .map((registration) => input.transport.getObservedHostState(registration.hostId))
    .filter((value): value is Exclude<typeof value, undefined> => value !== undefined);
  const observedByHostId = new Map(
    observedHostStates.map((observed) => [observed.hostId, observed] as const)
  );
  const desiredHostStates: DesiredHostState[] = [];

  const registrationsByGroup = new Map<string, HostRegistration[]>();
  for (const registration of registrations) {
    const key = registration.groupId ?? "__default__";
    const values = registrationsByGroup.get(key) ?? [];
    values.push(registration);
    registrationsByGroup.set(key, values);
  }

  for (const [groupKey, groupRegistrations] of registrationsByGroup) {
    const groupId = groupKey === "__default__" ? undefined : groupKey;
    const groupObservedHostStates = groupRegistrations
      .map((registration) => observedByHostId.get(registration.hostId))
      .filter((value): value is Exclude<typeof value, undefined> => value !== undefined);
    const groupHostIds = groupRegistrations.map((registration) => registration.hostId);
    const candidateHosts = buildPlacementCandidateHosts({
      registrations: groupRegistrations,
      observedHostStates: groupObservedHostStates
    });
    const groupHttpDeployments = input.httpDeployments.filter((deployment) => deployment.groupId === groupId);
    const groupServiceModuleDeployments = input.serviceModuleDeployments.filter(
      (deployment) => deployment.groupId === groupId
    );
    const stickyHostIdsByDeployment = new Map<string, string[]>();
    for (const registration of groupRegistrations) {
      const currentDesired = input.transport.getDesiredHostStateSnapshot(registration.hostId);
      for (const assignment of currentDesired.assignments) {
        if (assignment.groupId !== groupId) {
          continue;
        }
        const owners = stickyHostIdsByDeployment.get(assignment.deploymentId) ?? [];
        if (!owners.includes(registration.hostId)) {
          owners.push(registration.hostId);
        }
        stickyHostIdsByDeployment.set(assignment.deploymentId, owners);
      }
    }
    const ownerHostIdsByDeployment = new Map<string, string[]>();
    for (const deployment of groupHttpDeployments) {
      if ((deployment.assignmentMode ?? "select-first-n-hosts") === "all-hosts") {
        continue;
      }

      const currentDesiredOwnerHostIds = stickyHostIdsByDeployment.get(deployment.deploymentId) ?? [];
      ownerHostIdsByDeployment.set(
        deployment.deploymentId,
        planHttpWorkerDeploymentOwners({
          deployment: {
            ...deployment,
            stickyHostIds: currentDesiredOwnerHostIds
          },
          candidateHosts,
          currentDesiredOwnerHostIds,
          observedHostStates: groupObservedHostStates
        })
      );
    }

    const groupDesiredHostStates = groupHostIds.map((hostId) =>
      buildDesiredProjection({
        hostId,
        upstreamBaseUrl: input.upstreamBaseUrl,
        httpDeployments: groupHttpDeployments.map((deployment) => ({
          ...deployment,
          stickyHostIds: stickyHostIdsByDeployment.get(deployment.deploymentId),
          ownerHostIds: ownerHostIdsByDeployment.get(deployment.deploymentId)
        })),
        serviceModuleDeployments: groupServiceModuleDeployments,
        registrationsByHostId: new Map(groupRegistrations.map((registration) => [registration.hostId, registration] as const)),
        manifestsById: input.manifestsById,
        registeredHostIds: groupHostIds,
        candidateHosts,
        revisionToken: input.revisionToken
      })
    );
    const topology = buildDesiredTopology(
      input.revisionToken,
      groupRegistrations,
      groupDesiredHostStates,
      groupObservedHostStates
    );
    desiredHostStates.push(
      ...groupDesiredHostStates.map((desired) => ({
        ...desired,
        topology
      }))
    );
  }

  return desiredHostStates.sort((left, right) => left.hostId.localeCompare(right.hostId));
}

function collectTopologyRegistrations(
  transport: MockAdminTransport,
  extraHostIds: string[] = []
): HostRegistration[] {
  const registrations = transport.listRegisteredHosts().map((registration) => ({
    ...registration,
    network: {
      ...registration.network
    },
    staticLabels: { ...registration.staticLabels },
    staticCapabilities: [...registration.staticCapabilities],
    staticCapacity: { ...registration.staticCapacity }
  }));
  const knownHostIds = new Set(registrations.map((registration) => registration.hostId));

  for (const hostId of extraHostIds) {
    if (knownHostIds.has(hostId)) {
      continue;
    }
    registrations.push({
      hostId,
      groupId: undefined,
      startedAt: 0,
      runtime: {
        kind: "hardess-v1",
        version: "unknown"
      },
      network: {
        publicListenerEnabled: false,
        internalListenerEnabled: false
      },
      staticLabels: {},
      staticCapabilities: [],
      staticCapacity: {}
    });
  }

  return registrations.sort((left, right) => left.hostId.localeCompare(right.hostId));
}

function buildDesiredTopology(
  revisionToken: number,
  registrations: HostRegistration[],
  desiredHostStates: DesiredHostState[],
  observedHostStates: Exclude<ReturnType<MockAdminTransport["getObservedHostState"]>, undefined>[]
): DesiredTopology {
  return {
    membership: buildMembershipSnapshot({
      revision: `topology:${revisionToken}:membership`,
      registrations,
      observedHostStates
    }),
    placement: buildPlacementSnapshot({
      revision: `topology:${revisionToken}:placement`,
      desiredHostStates
    })
  };
}

function serveArtifactRequest(
  pathname: string,
  artifactFiles: DemoArtifactFiles
): Response | undefined {
  if (pathname === "/artifacts/demo-http-worker.ts") {
    return textResponse(artifactFiles.sharedWorker.source, "text/typescript; charset=utf-8");
  }

  if (pathname === "/artifacts/demo-host-worker.ts") {
    return textResponse(artifactFiles.hostWorker.source, "text/typescript; charset=utf-8");
  }

  if (pathname === "/artifacts/demo-serve-app.ts") {
    return textResponse(artifactFiles.serveApp.source, "text/typescript; charset=utf-8");
  }

  if (pathname === "/artifacts/demo-chat-service-module.ts") {
    return textResponse(artifactFiles.serviceModule.source, "text/typescript; charset=utf-8");
  }

  if (pathname === "/artifacts/package.json") {
    return textResponse(artifactFiles.packageJson, "application/json; charset=utf-8");
  }

  if (pathname === "/artifacts/bun.lock") {
    return textResponse(artifactFiles.bunLock, "application/json; charset=utf-8");
  }

  return undefined;
}

function shouldAssignServiceModuleToHost(
  deployment: DemoServiceModuleDeploymentPlan,
  hostId: string,
  registrationsByHostId: Map<string, HostRegistration>
): boolean {
  if ((deployment.assignmentMode ?? "all-hosts") !== "all-hosts") {
    return false;
  }

  return registrationsByHostId.get(hostId)?.groupId === deployment.groupId;
}

function buildServiceModuleAssignmentForHost(
  hostId: string,
  deployment: DemoServiceModuleDeploymentPlan,
  manifestsById: Map<string, ArtifactManifest>
): DesiredHostState["assignments"][number] {
  const manifest = manifestsById.get(deployment.manifestId);
  if (!manifest) {
    throw new Error(`Missing manifest for deployment ${deployment.deploymentId}`);
  }

  return {
    assignmentId: `assign:${hostId}:${deployment.deploymentId}`,
    hostId,
    deploymentId: deployment.deploymentId,
    deploymentKind: "service_module",
    groupId: deployment.groupId,
    declaredVersion: deployment.declaredVersion,
    declaredArtifactId: deployment.declaredArtifactId,
    artifact: {
      manifestId: deployment.manifestId,
      sourceUri: manifest.source.uri,
      digest: manifest.source.digest
    },
    serviceModule: {
      name: deployment.serviceName,
      entry: deployment.serviceEntry
    }
  };
}

function buildDesiredRevision(
  hostId: string,
  revisionToken: number,
  assignments: DesiredHostState["assignments"]
): string {
  return `demo-rev:${revisionToken}:${hostId}:${assignments.map((assignment) => assignment.assignmentId).join(",")}`;
}

function normalizeRoutePrefix(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return "/demo";
  }
  if (trimmed.startsWith("/")) {
    return trimmed.endsWith("/") && trimmed !== "/" ? trimmed.slice(0, -1) : trimmed;
  }
  return `/${trimmed}`;
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload, null, 2), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8"
    }
  });
}

function textResponse(body: string, contentType: string): Response {
  return new Response(body, {
    headers: {
      "content-type": contentType
    }
  });
}

if (import.meta.main) {
  const port = Number(process.env.ADMIN_DEMO_PORT ?? DEFAULT_PORT);
  const app = await createDemoAdminApp({
    artifactBaseUrl: process.env.ADMIN_DEMO_ARTIFACT_BASE_URL,
    upstreamBaseUrl: process.env.ADMIN_DEMO_UPSTREAM_BASE_URL,
    routePrefix: process.env.ADMIN_DEMO_ROUTE_PREFIX,
    sharedDeploymentReplicas: process.env.ADMIN_DEMO_SHARED_DEPLOYMENT_REPLICAS
      ? Number(process.env.ADMIN_DEMO_SHARED_DEPLOYMENT_REPLICAS)
      : undefined
  });
  const server = Bun.serve({
    port,
    fetch(request) {
      return app.fetch(request);
    }
  });

  console.log(`demo admin listening on :${server.port}`);
}
