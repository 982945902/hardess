import { z } from "zod";
import type {
  ArtifactManifest,
  ArtifactManifestQuery,
  Assignment,
  Deployment,
  DesiredHostState,
  DesiredHostStateQuery,
  DesiredHostStateResult,
  HeartbeatHostInput,
  HeartbeatHostResult,
  HostRegistration,
  ObservedHostState,
  RegisterHostResult,
  ReportObservedHostStateResult
} from "./admin-types.ts";
import { formatZodError } from "./schema.ts";

const stringRecordSchema = z.record(z.string(), z.string());
const unknownRecordSchema = z.record(z.string(), z.unknown());
const numberRecordSchema = z.record(z.string(), z.number().finite());
const deploymentKindSchema = z.enum(["http_worker", "service_module"]);
const assignmentObservedStateSchema = z.enum([
  "pending",
  "preparing",
  "ready",
  "active",
  "draining",
  "failed"
]);

const hostStaticCapacitySchema = z.object({
  maxHttpWorkerAssignments: z.number().int().nonnegative().optional(),
  maxServiceModuleAssignments: z.number().int().nonnegative().optional(),
  maxConnections: z.number().int().nonnegative().optional(),
  maxInflightRequests: z.number().int().nonnegative().optional()
});

export const hostRegistrationSchema = z.object({
  hostId: z.string().min(1, "hostId is required"),
  nodeId: z.string().min(1).optional(),
  startedAt: z.number().finite().nonnegative(),
  runtime: z.object({
    kind: z.literal("hardess-v1"),
    version: z.string().min(1, "runtime.version is required"),
    pid: z.number().int().nonnegative().optional()
  }),
  network: z.object({
    publicBaseUrl: z.string().url().optional(),
    internalBaseUrl: z.string().url().optional(),
    publicListenerEnabled: z.boolean(),
    internalListenerEnabled: z.boolean()
  }),
  staticLabels: stringRecordSchema,
  staticCapabilities: z.array(z.string().min(1)),
  staticCapacity: hostStaticCapacitySchema,
  dynamicFields: unknownRecordSchema.optional()
});

const artifactRefSchema = z.object({
  manifestId: z.string().min(1, "artifact.manifestId is required"),
  sourceUri: z.string().url("artifact.sourceUri must be a valid absolute URL"),
  digest: z.string().min(1).optional()
});

const membershipHostStateSchema = z.enum(["ready", "draining", "offline"]);

export const deploymentSchema = z.object({
  deploymentId: z.string().min(1, "deploymentId is required"),
  deploymentKind: deploymentKindSchema,
  name: z.string().min(1, "name is required"),
  declaredVersion: z.string().min(1, "declaredVersion is required"),
  declaredArtifactId: z.string().min(1).optional(),
  replicas: z.number().int().nonnegative(),
  artifact: artifactRefSchema,
  routeBindings: z.array(
    z.object({
      routeId: z.string().min(1, "routeId is required")
    })
  ).optional(),
  authPolicyRef: z.string().min(1).optional(),
  secretRefs: z.array(z.string().min(1)).optional(),
  scheduling: z.object({
    requiredLabels: stringRecordSchema.optional(),
    preferredLabels: stringRecordSchema.optional()
  }).optional(),
  rollout: z.object({
    strategy: z.literal("gradual").optional(),
    maxUnavailable: z.number().int().nonnegative().optional(),
    batchSize: z.number().int().positive().optional()
  }).optional()
});

const httpWorkerAssignmentSchema = z.object({
  name: z.string().min(1, "httpWorker.name is required"),
  entry: z.string().min(1, "httpWorker.entry is required"),
  routeRefs: z.array(z.string().min(1)).optional()
});

const serviceModuleAssignmentSchema = z.object({
  name: z.string().min(1, "serviceModule.name is required"),
  entry: z.string().min(1, "serviceModule.entry is required")
});

export const assignmentSchema = z.object({
  assignmentId: z.string().min(1, "assignmentId is required"),
  hostId: z.string().min(1, "hostId is required"),
  deploymentId: z.string().min(1, "deploymentId is required"),
  deploymentKind: deploymentKindSchema,
  declaredVersion: z.string().min(1, "declaredVersion is required"),
  declaredArtifactId: z.string().min(1).optional(),
  artifact: artifactRefSchema,
  httpWorker: httpWorkerAssignmentSchema.optional(),
  serviceModule: serviceModuleAssignmentSchema.optional(),
  authPolicyRef: z.string().min(1).optional(),
  secretRefs: z.array(z.string().min(1)).optional()
}).superRefine((value, ctx) => {
  if (value.deploymentKind === "http_worker") {
    if (!value.httpWorker) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "httpWorker is required when deploymentKind is http_worker",
        path: ["httpWorker"]
      });
    }
    if (value.serviceModule) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "serviceModule must be absent when deploymentKind is http_worker",
        path: ["serviceModule"]
      });
    }
  }

  if (value.deploymentKind === "service_module") {
    if (!value.serviceModule) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "serviceModule is required when deploymentKind is service_module",
        path: ["serviceModule"]
      });
    }
    if (value.httpWorker) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "httpWorker must be absent when deploymentKind is service_module",
        path: ["httpWorker"]
      });
    }
  }
});

const membershipHostSchema = z.object({
  hostId: z.string().min(1, "hostId is required"),
  nodeId: z.string().min(1).optional(),
  publicBaseUrl: z.string().url().optional(),
  internalBaseUrl: z.string().url().optional(),
  publicListenerEnabled: z.boolean(),
  internalListenerEnabled: z.boolean(),
  state: membershipHostStateSchema,
  staticLabels: stringRecordSchema,
  staticCapabilities: z.array(z.string().min(1)),
  staticCapacity: hostStaticCapacitySchema,
  lastSeenAt: z.number().finite().nonnegative().optional()
});

const membershipSnapshotSchema = z.object({
  revision: z.string().min(1, "membership.revision is required"),
  generatedAt: z.number().finite().nonnegative(),
  hosts: z.array(membershipHostSchema)
});

const placementDeploymentSchema = z.object({
  deploymentId: z.string().min(1, "deploymentId is required"),
  deploymentKind: deploymentKindSchema,
  ownerHostIds: z.array(z.string().min(1)),
  routes: z.array(
    z.object({
      routeId: z.string().min(1, "routeId is required"),
      pathPrefix: z
        .string()
        .min(1, "pathPrefix is required")
        .refine((value) => value.startsWith("/"), "pathPrefix must start with '/'"),
      ownerHostIds: z.array(z.string().min(1))
    })
  )
});

const placementSnapshotSchema = z.object({
  revision: z.string().min(1, "placement.revision is required"),
  generatedAt: z.number().finite().nonnegative(),
  deployments: z.array(placementDeploymentSchema)
});

const desiredTopologySchema = z.object({
  membership: membershipSnapshotSchema,
  placement: placementSnapshotSchema
});

export const desiredHostStateSchema = z.object({
  hostId: z.string().min(1, "hostId is required"),
  revision: z.string().min(1, "revision is required"),
  generatedAt: z.number().finite().nonnegative(),
  assignments: z.array(assignmentSchema),
  topology: desiredTopologySchema.optional(),
  sharedHttpForwardConfig: z.object({
    routes: z.array(
      z.object({
        routeId: z.string().min(1, "routeId is required"),
        match: z.object({
          pathPrefix: z
            .string()
            .min(1, "match.pathPrefix is required")
            .refine((value) => value.startsWith("/"), "match.pathPrefix must start with '/'")
        }),
        upstream: z.object({
          baseUrl: z.string().url("upstream.baseUrl must be a valid absolute URL"),
          websocketEnabled: z.boolean().optional()
        })
      })
    )
  }).optional()
});

export const observedHostStateSchema = z.object({
  hostId: z.string().min(1, "hostId is required"),
  observedAt: z.number().finite().nonnegative(),
  ready: z.boolean(),
  draining: z.boolean(),
  staticLabels: stringRecordSchema,
  staticCapabilities: z.array(z.string().min(1)),
  staticCapacity: hostStaticCapacitySchema,
  dynamicState: z.object({
    currentAssignmentCount: z.number().int().nonnegative(),
    currentConnectionCount: z.number().int().nonnegative().optional(),
    currentInflightRequests: z.number().int().nonnegative().optional(),
    schedulable: z.boolean().optional(),
    appliedTopology: z.object({
      membershipRevision: z.string().min(1).optional(),
      placementRevision: z.string().min(1).optional()
    }).optional(),
    resourceHints: numberRecordSchema.optional(),
    dynamicFields: unknownRecordSchema.optional()
  }),
  assignmentStatuses: z.array(
    z.object({
      assignmentId: z.string().min(1, "assignmentId is required"),
      deploymentId: z.string().min(1, "deploymentId is required"),
      declaredVersion: z.string().min(1, "declaredVersion is required"),
      generationId: z.string().min(1).optional(),
      state: assignmentObservedStateSchema,
      preparedAt: z.number().finite().nonnegative().optional(),
      activatedAt: z.number().finite().nonnegative().optional(),
      failedAt: z.number().finite().nonnegative().optional(),
      lastError: z.object({
        code: z.string().min(1, "lastError.code is required"),
        message: z.string().min(1, "lastError.message is required"),
        retryable: z.boolean().optional()
      }).optional()
    })
  )
});

export const artifactManifestSchema = z.object({
  manifestId: z.string().min(1, "manifestId is required"),
  artifactKind: deploymentKindSchema,
  declaredArtifactId: z.string().min(1).optional(),
  declaredVersion: z.string().min(1, "declaredVersion is required"),
  source: z.object({
    uri: z.string().url("source.uri must be a valid absolute URL"),
    digest: z.string().min(1).optional()
  }),
  entry: z.string().min(1, "entry is required"),
  packageManager: z.object({
    kind: z.literal("deno"),
    denoJson: z.string().min(1).optional(),
    denoLock: z.string().min(1).optional(),
    frozenLock: z.boolean().optional()
  }),
  metadata: z.object({
    annotations: stringRecordSchema.optional()
  }).optional()
});

export const registerHostResultSchema = z.object({
  hostId: z.string().min(1, "hostId is required"),
  accepted: z.boolean(),
  pollAfterMs: z.number().int().nonnegative().optional()
});

export const heartbeatHostInputSchema = z.object({
  hostId: z.string().min(1, "hostId is required"),
  observed: observedHostStateSchema
}).superRefine((value, ctx) => {
  if (value.hostId !== value.observed.hostId) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "hostId must match observed.hostId",
      path: ["observed", "hostId"]
    });
  }
});

export const heartbeatHostResultSchema = z.object({
  accepted: z.boolean(),
  nextPollAfterMs: z.number().int().nonnegative().optional()
});

export const desiredHostStateQuerySchema = z.object({
  hostId: z.string().min(1, "hostId is required"),
  ifRevision: z.string().min(1).optional()
});

export const desiredHostStateResultSchema = z.object({
  changed: z.boolean(),
  desired: desiredHostStateSchema.optional()
}).superRefine((value, ctx) => {
  if (!value.changed && value.desired) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "desired must be absent when changed is false",
      path: ["desired"]
    });
  }
});

export const reportObservedHostStateResultSchema = z.object({
  accepted: z.boolean()
});

export const artifactManifestQuerySchema = z.object({
  manifestId: z.string().min(1, "manifestId is required")
});

function parseWithSchema<T>(schema: z.ZodType<T>, value: unknown, message: string): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new Error(`${message}: ${formatZodError(result.error)}`);
  }
  return result.data;
}

export function parseHostRegistration(value: unknown): HostRegistration {
  return parseWithSchema(hostRegistrationSchema, value, "Invalid HostRegistration");
}

export function parseDeployment(value: unknown): Deployment {
  return parseWithSchema(deploymentSchema, value, "Invalid Deployment");
}

export function parseAssignment(value: unknown): Assignment {
  return parseWithSchema(assignmentSchema, value, "Invalid Assignment");
}

export function parseDesiredHostState(value: unknown): DesiredHostState {
  return parseWithSchema(desiredHostStateSchema, value, "Invalid DesiredHostState");
}

export function parseObservedHostState(value: unknown): ObservedHostState {
  return parseWithSchema(observedHostStateSchema, value, "Invalid ObservedHostState");
}

export function parseArtifactManifest(value: unknown): ArtifactManifest {
  return parseWithSchema(artifactManifestSchema, value, "Invalid ArtifactManifest");
}

export function parseRegisterHostResult(value: unknown): RegisterHostResult {
  return parseWithSchema(registerHostResultSchema, value, "Invalid RegisterHostResult");
}

export function parseHeartbeatHostInput(value: unknown): HeartbeatHostInput {
  return parseWithSchema(heartbeatHostInputSchema, value, "Invalid HeartbeatHostInput");
}

export function parseHeartbeatHostResult(value: unknown): HeartbeatHostResult {
  return parseWithSchema(heartbeatHostResultSchema, value, "Invalid HeartbeatHostResult");
}

export function parseDesiredHostStateQuery(value: unknown): DesiredHostStateQuery {
  return parseWithSchema(desiredHostStateQuerySchema, value, "Invalid DesiredHostStateQuery");
}

export function parseDesiredHostStateResult(value: unknown): DesiredHostStateResult {
  return parseWithSchema(desiredHostStateResultSchema, value, "Invalid DesiredHostStateResult");
}

export function parseReportObservedHostStateResult(value: unknown): ReportObservedHostStateResult {
  return parseWithSchema(reportObservedHostStateResultSchema, value, "Invalid ReportObservedHostStateResult");
}

export function parseArtifactManifestQuery(value: unknown): ArtifactManifestQuery {
  return parseWithSchema(artifactManifestQuerySchema, value, "Invalid ArtifactManifestQuery");
}
