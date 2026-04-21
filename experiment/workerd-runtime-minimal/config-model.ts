import { readFileSync } from "node:fs";
import { z } from "zod";

const bindingValueSchema: z.ZodType<unknown> = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.null(),
  z.array(z.unknown()),
  z.record(z.string(), z.unknown())
]);

export const assignmentSchema = z.object({
  assignmentId: z.string().min(1),
  hostId: z.string().min(1),
  deploymentId: z.string().min(1),
  deploymentKind: z.literal("http_worker"),
  declaredVersion: z.string().min(1),
  artifact: z.object({
    manifestId: z.string().min(1),
    sourceUri: z.string().min(1)
  }).strict(),
  httpWorker: z.object({
    name: z.string().min(1),
    entry: z.string().min(1),
    routeRefs: z.array(z.string()).default([]),
    deployment: z.object({
      config: z.record(z.string(), z.unknown()).default({}),
      bindings: z.record(z.string(), bindingValueSchema).default({}),
      secrets: z.record(z.string(), z.string()).default({})
    }).strict().default({})
  }).strict()
}).strict();

export const runtimeAdapterSchema = z.object({
  socketName: z.string().min(1).default("http"),
  listenAddress: z.string().min(1),
  compatibilityDate: z.string().min(1),
  compatibilityFlags: z.array(z.string()).default([]),
  compatibilityBindings: z.object({
    routeTable: z.boolean().default(true),
    protocolPackage: z.boolean().default(true)
  }).strict().default({})
}).strict();

export const protocolActionSchema = z.object({
  actionId: z.string().min(1),
  kind: z.enum(["http", "websocket"]),
  methods: z.array(z.string().min(1)).min(1),
  websocket: z.boolean().optional()
}).strict();

export const protocolPackageSchema = z.object({
  packageId: z.string().min(1),
  protocol: z.string().min(1),
  version: z.string().min(1),
  actions: z.array(protocolActionSchema).min(1)
}).strict();

export const routeSchema = z.object({
  routeId: z.string().min(1),
  match: z.object({
    pathPrefix: z.string().min(1)
  }).strict(),
  actionId: z.string().min(1),
  upstream: z.object({
    baseUrl: z.string().min(1),
    websocketEnabled: z.boolean().optional()
  }).strict()
}).strict();

export const planningFragmentSchema = z.object({
  sharedHttpForwardConfig: z.object({
    routes: z.array(routeSchema)
  }).strict()
}).strict();

export type Assignment = z.infer<typeof assignmentSchema>;
export type RuntimeAdapter = z.infer<typeof runtimeAdapterSchema>;
export type ProtocolAction = z.infer<typeof protocolActionSchema>;
export type ProtocolPackage = z.infer<typeof protocolPackageSchema>;
export type Route = z.infer<typeof routeSchema>;
export type PlanningFragment = z.infer<typeof planningFragmentSchema>;

export interface InputPaths {
  assignmentPath: string;
  runtimeAdapterPath: string;
  planningFragmentPath: string;
  protocolPackagePath: string;
}

export interface ExperimentInputs {
  assignment: Assignment;
  runtimeAdapter: RuntimeAdapter;
  planningFragment: PlanningFragment;
  protocolPackage: ProtocolPackage;
}

export interface RuntimeAdapterOverrides {
  listenAddress?: string;
}

function readJsonFile(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8"));
}

export function loadExperimentInputs(paths: InputPaths): ExperimentInputs {
  return {
    assignment: assignmentSchema.parse(readJsonFile(paths.assignmentPath)),
    runtimeAdapter: runtimeAdapterSchema.parse(readJsonFile(paths.runtimeAdapterPath)),
    planningFragment: planningFragmentSchema.parse(readJsonFile(paths.planningFragmentPath)),
    protocolPackage: protocolPackageSchema.parse(readJsonFile(paths.protocolPackagePath))
  };
}

export function applyRuntimeAdapterOverrides(
  runtimeAdapter: RuntimeAdapter,
  overrides: RuntimeAdapterOverrides
): RuntimeAdapter {
  if (!overrides.listenAddress) {
    return runtimeAdapter;
  }

  return runtimeAdapterSchema.parse({
    ...runtimeAdapter,
    listenAddress: overrides.listenAddress
  });
}
