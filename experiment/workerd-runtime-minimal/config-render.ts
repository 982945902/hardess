import type { Assignment, PlanningFragment, ProtocolPackage, RuntimeAdapter } from "./config-model";
import { dirname, relative, resolve } from "node:path";
import { resolveRuntimeModel } from "./resolved-runtime-model";

function renderCapnpString(value: string): string {
  return JSON.stringify(value);
}

function renderBinding(name: string, value: unknown): string {
  if (typeof value === "string") {
    return `    (name = ${renderCapnpString(name)}, text = ${renderCapnpString(value)}),`;
  }

  return `    (name = ${renderCapnpString(name)}, json = ${renderCapnpString(JSON.stringify(value))}),`;
}

function renderModule(name: string, path: string): string {
  return `    (name = ${renderCapnpString(name)}, esModule = embed ${renderCapnpString(path)}),`;
}

function collectWorkerModules(outputPath: string, entryPath: string): Array<{ name: string; path: string }> {
  const workerModules = [
    entryPath,
    "worker-route-contract.ts",
    "runtime-dispatch-model.ts",
    "worker-runtime.ts",
    "worker-action-contract.ts",
    "worker-error-contract.ts",
    "worker-admin.ts",
    "worker-admin-contract.ts",
    "worker-actions.ts",
    "worker-response.ts",
    "worker-types.ts",
  ];

  return workerModules.map((modulePath) => ({
    name: modulePath,
    path: relative(dirname(outputPath), resolve(import.meta.dir, modulePath)),
  }));
}

function collectBindings(
  assignment: Assignment,
  runtimeAdapter: RuntimeAdapter,
  planningFragment: PlanningFragment,
  protocolPackage: ProtocolPackage
): Array<[string, unknown]> {
  const deployment = assignment.httpWorker.deployment;
  const resolvedModel = resolveRuntimeModel(assignment, runtimeAdapter, planningFragment, protocolPackage);
  const bindings: Array<[string, unknown]> = [
    ...Object.entries(deployment.bindings),
    ...Object.entries(deployment.secrets),
    [
      "HARDESS_ASSIGNMENT_META",
      {
        assignmentId: assignment.assignmentId,
        hostId: assignment.hostId,
        deploymentId: assignment.deploymentId,
        declaredVersion: assignment.declaredVersion,
        manifestId: assignment.artifact.manifestId,
        routeRefs: assignment.httpWorker.routeRefs
      }
    ],
    ["HARDESS_CONFIG", deployment.config],
    ["HARDESS_RESOLVED_RUNTIME_MODEL", resolvedModel],
  ];

  if (resolvedModel.bindingContract.compatibilityBindings.includes("HARDESS_ROUTE_TABLE")) {
    bindings.push(["HARDESS_ROUTE_TABLE", resolvedModel.compatibilityRouteTable]);
  }

  if (resolvedModel.bindingContract.compatibilityBindings.includes("HARDESS_PROTOCOL_PACKAGE")) {
    bindings.push(["HARDESS_PROTOCOL_PACKAGE", resolvedModel.compatibilityProtocolPackage]);
  }

  return bindings;
}

function renderBindings(
  assignment: Assignment,
  runtimeAdapter: RuntimeAdapter,
  planningFragment: PlanningFragment,
  protocolPackage: ProtocolPackage
): string {
  const bindings = collectBindings(assignment, runtimeAdapter, planningFragment, protocolPackage);
  if (bindings.length === 0) {
    return "  bindings = [],";
  }

  return ["  bindings = [", ...bindings.map(([name, value]) => renderBinding(name, value)), "  ],"].join("\n");
}

function renderCompatibilityFlags(flags: string[]): string {
  if (flags.length === 0) {
    return "";
  }

  return `  compatibilityFlags = [${flags.map((flag) => renderCapnpString(flag)).join(", ")}],\n`;
}

export function renderConfig(
  assignment: Assignment,
  runtimeAdapter: RuntimeAdapter,
  planningFragment: PlanningFragment,
  protocolPackage: ProtocolPackage,
  outputPath: string
): string {
  const workerModules = collectWorkerModules(outputPath, assignment.httpWorker.entry);
  const renderedModules = workerModules.map((module) => renderModule(module.name, module.path)).join("\n");

  return `using Workerd = import "/workerd/workerd.capnp";

# Generated from assignment.json, runtime-adapter.json, planning-fragment.json, and protocol-package.json.
# This is a minimal Hardess control-plane object plus a thin workerd adapter.

const config :Workerd.Config = (
  services = [
    (name = "main", worker = .demoWorker),
  ],

  sockets = [
    (name = ${renderCapnpString(runtimeAdapter.socketName)}, address = ${renderCapnpString(runtimeAdapter.listenAddress)}, http = (), service = "main"),
  ]
);

const demoWorker :Workerd.Worker = (
  modules = [
${renderedModules}
  ],

${renderBindings(assignment, runtimeAdapter, planningFragment, protocolPackage)}

  compatibilityDate = ${renderCapnpString(runtimeAdapter.compatibilityDate)},
${renderCompatibilityFlags(runtimeAdapter.compatibilityFlags)});`;
}
