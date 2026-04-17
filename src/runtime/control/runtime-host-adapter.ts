import type {
  ArtifactManifest,
  DesiredHostState,
  HostRegistration,
  HardessConfig,
  HostStaticCapacity,
  PipelineConfig,
  ObservedHostState
} from "../../shared/index.ts";
import type { ConfigStore } from "../config/store.ts";
import type { Logger } from "../observability/logger.ts";
import { ArtifactStore } from "./artifact-store.ts";
import type { HostRuntimeAdapter } from "./host-agent.ts";
import type { ServiceModuleManager } from "./service-module-manager.ts";
import type { RuntimeTopologyStore } from "./topology-store.ts";

interface RuntimeStateSnapshot {
  startedAt: number;
  uptimeMs: number;
  shuttingDown: boolean;
  disposed: boolean;
  ready: boolean;
  inFlightHttpRequests: number;
}

export interface RuntimeHostAdapterApp {
  logger: Logger;
  runtimeState(): RuntimeStateSnapshot;
}

export interface RuntimeHostAdapterOptions {
  app: RuntimeHostAdapterApp;
  configStore: ConfigStore;
  artifactStore?: ArtifactStore;
  artifactRootDir?: string;
  hostId: string;
  nodeId?: string;
  runtimeVersion: string;
  publicBaseUrl?: string;
  internalBaseUrl?: string;
  publicListenerEnabled?: boolean;
  internalListenerEnabled?: boolean;
  staticLabels?: Record<string, string>;
  staticCapabilities?: string[];
  staticCapacity?: HostStaticCapacity;
  defaultConnectTimeoutMs?: number;
  defaultResponseTimeoutMs?: number;
  defaultWorkerTimeoutMs?: number;
  registrationDynamicFields?: Record<string, unknown>;
  observedDynamicFields?: Record<string, unknown>;
  topologyStore?: RuntimeTopologyStore;
  serviceModuleManager?: ServiceModuleManager;
}

export class RuntimeHostAdapter implements HostRuntimeAdapter {
  private lastDesired?: DesiredHostState;
  private warnedPlaceholderApply = false;
  private readonly artifactStore: ArtifactStore;
  private readonly assignmentStates = new Map<
    string,
    {
      deploymentId: string;
      declaredVersion: string;
      state: "pending" | "preparing" | "ready" | "active" | "draining" | "failed";
      generationId?: string;
      preparedAt?: number;
      activatedAt?: number;
      failedAt?: number;
      lastError?: {
        code: string;
        message: string;
        retryable?: boolean;
      };
    }
  >();

  constructor(private readonly options: RuntimeHostAdapterOptions) {
    this.artifactStore =
      options.artifactStore ??
      new ArtifactStore({
        rootDir: options.artifactRootDir ?? ".hardess-admin-artifacts",
        logger: options.app.logger
      });
  }

  getHostRegistration(): HostRegistration {
    const state = this.options.app.runtimeState();
    return {
      hostId: this.options.hostId,
      nodeId: this.options.nodeId,
      startedAt: state.startedAt,
      runtime: {
        kind: "hardess-v1",
        version: this.options.runtimeVersion
      },
      network: {
        publicBaseUrl: this.options.publicBaseUrl,
        internalBaseUrl: this.options.internalBaseUrl,
        publicListenerEnabled: this.options.publicListenerEnabled ?? Boolean(this.options.publicBaseUrl),
        internalListenerEnabled: this.options.internalListenerEnabled ?? Boolean(this.options.internalBaseUrl)
      },
      staticLabels: { ...(this.options.staticLabels ?? {}) },
      staticCapabilities: [...(this.options.staticCapabilities ?? [])],
      staticCapacity: { ...(this.options.staticCapacity ?? {}) },
      dynamicFields: this.options.registrationDynamicFields
        ? { ...this.options.registrationDynamicFields }
        : undefined
    };
  }

  async applyDesiredHostState(
    desired: DesiredHostState,
    artifacts: Map<string, ArtifactManifest> = new Map()
  ): Promise<void> {
    const revisionGenerationId = `admin:${desired.revision}`;
    const nextStates = new Map<
      string,
      {
        deploymentId: string;
        declaredVersion: string;
        state: "pending" | "preparing" | "ready" | "active" | "draining" | "failed";
        generationId?: string;
        preparedAt?: number;
        activatedAt?: number;
        failedAt?: number;
        lastError?: {
          code: string;
          message: string;
          retryable?: boolean;
        };
      }
    >();

    for (const assignment of desired.assignments) {
      nextStates.set(assignment.assignmentId, {
        deploymentId: assignment.deploymentId,
        declaredVersion: assignment.declaredVersion,
        state: "preparing",
        generationId: revisionGenerationId
      });
    }

    const config = await this.buildConfigFromDesiredState(
      desired,
      artifacts,
      nextStates,
      revisionGenerationId
    );
    if (this.options.serviceModuleManager) {
      await this.options.serviceModuleManager.applyAssignments({
        assignments: desired.assignments,
        artifacts,
        assignmentStates: nextStates,
        revision: desired.revision,
        revisionGenerationId,
        previousAssignmentStates: this.assignmentStates
      });
    }
    await this.options.configStore.applyConfig(config, {
      source: `admin:${desired.revision}`
    });
    this.options.topologyStore?.setTopology(desired.topology);
    this.lastDesired = desired;
    this.assignmentStates.clear();
    for (const [assignmentId, state] of nextStates) {
      if (state.state === "ready") {
        state.state = "active";
        state.activatedAt = Date.now();
      }
      this.assignmentStates.set(assignmentId, state);
    }

    const hasServiceModuleAssignments = desired.assignments.some(
      (assignment) => assignment.deploymentKind === "service_module"
    );
    if (hasServiceModuleAssignments && !this.options.serviceModuleManager && !this.warnedPlaceholderApply) {
      this.warnedPlaceholderApply = true;
      this.options.app.logger.warn("runtime host adapter does not yet apply service_module assignments", {
        hostId: this.options.hostId,
        revision: desired.revision
      });
    }
  }

  collectObservedHostState(): ObservedHostState {
    const state = this.options.app.runtimeState();
    const assignments = this.lastDesired?.assignments ?? [];
    const drainingAssignments = this.options.serviceModuleManager?.listDrainingAssignments?.() ?? [];
    const assignmentStatuses = assignments.map((assignment) => {
      const recorded = this.assignmentStates.get(assignment.assignmentId);
      return {
        assignmentId: assignment.assignmentId,
        deploymentId: assignment.deploymentId,
        declaredVersion: assignment.declaredVersion,
        generationId: recorded?.generationId,
        state: recorded?.state ?? "pending",
        preparedAt: recorded?.preparedAt,
        activatedAt: recorded?.activatedAt,
        failedAt: recorded?.failedAt,
        lastError: recorded?.lastError
      };
    });

    for (const draining of drainingAssignments) {
      if (assignmentStatuses.some((status) => status.assignmentId === draining.assignmentId)) {
        continue;
      }
      assignmentStatuses.push({
        assignmentId: draining.assignmentId,
        deploymentId: draining.deploymentId,
        declaredVersion: draining.declaredVersion,
        generationId: draining.generationId,
        state: "draining",
        preparedAt: draining.preparedAt,
        activatedAt: draining.activatedAt,
        failedAt: undefined,
        lastError: undefined
      });
    }

    return {
      hostId: this.options.hostId,
      observedAt: Date.now(),
      ready: state.ready,
      draining: state.shuttingDown,
      staticLabels: { ...(this.options.staticLabels ?? {}) },
      staticCapabilities: [...(this.options.staticCapabilities ?? [])],
      staticCapacity: { ...(this.options.staticCapacity ?? {}) },
      dynamicState: {
        currentAssignmentCount: assignmentStatuses.length,
        currentInflightRequests: state.inFlightHttpRequests,
        schedulable: state.ready,
        appliedTopology: {
          membershipRevision: this.lastDesired?.topology?.membership.revision,
          placementRevision: this.lastDesired?.topology?.placement.revision
        },
        dynamicFields: {
          uptimeMs: state.uptimeMs,
          disposed: state.disposed,
          ...(this.options.observedDynamicFields ?? {})
        }
      },
      assignmentStatuses
    };
  }

  private async buildConfigFromDesiredState(
    desired: DesiredHostState,
    artifacts: Map<string, ArtifactManifest>,
    assignmentStates: Map<
      string,
      {
        deploymentId: string;
        declaredVersion: string;
        state: "pending" | "preparing" | "ready" | "active" | "draining" | "failed";
        generationId?: string;
        preparedAt?: number;
        activatedAt?: number;
        failedAt?: number;
        lastError?: {
          code: string;
          message: string;
          retryable?: boolean;
        };
      }
    >,
    revisionGenerationId: string
  ): Promise<HardessConfig> {
    const routesById = new Map(
      (desired.sharedHttpForwardConfig?.routes ?? []).map((route) => [route.routeId, route] as const)
    );
    const pipelines: PipelineConfig[] = [];

    for (const assignment of desired.assignments) {
      if (assignment.deploymentKind === "service_module") {
        if (this.options.serviceModuleManager) {
          continue;
        }
        const state = assignmentStates.get(assignment.assignmentId);
        if (state) {
          state.state = "failed";
          state.failedAt = Date.now();
          state.lastError = {
            code: "SERVICE_MODULE_NOT_SUPPORTED",
            message: "Current runtime does not yet apply service_module assignments",
            retryable: false
          };
        }
        continue;
      }

      if (!assignment.httpWorker) {
        const state = assignmentStates.get(assignment.assignmentId);
        if (state) {
          state.state = "failed";
          state.failedAt = Date.now();
          state.lastError = {
            code: "HTTP_WORKER_PAYLOAD_MISSING",
            message: "Assignment is missing httpWorker payload",
            retryable: false
          };
        }
        continue;
      }

      try {
        const routeRefs = assignment.httpWorker.routeRefs ?? [];
        const artifactManifest = artifacts.get(assignment.artifact.manifestId);
        const prepared = await this.artifactStore.stageHttpWorker(assignment, artifactManifest);
        for (const routeRef of routeRefs) {
          const route = routesById.get(routeRef);
          if (!route) {
            const state = assignmentStates.get(assignment.assignmentId);
            if (state) {
              state.state = "failed";
              state.failedAt = Date.now();
              state.lastError = {
                code: "ROUTE_REF_MISSING",
                message: `Missing route ref ${routeRef}`,
                retryable: false
              };
            }
            this.options.app.logger.warn("runtime host adapter missing route ref for assignment", {
              hostId: this.options.hostId,
              revision: desired.revision,
              assignmentId: assignment.assignmentId,
              routeRef
            });
            throw new Error(`Missing route ref ${routeRef} for assignment ${assignment.assignmentId}`);
          }

          pipelines.push({
            id: `${assignment.assignmentId}:${route.routeId}`,
            matchPrefix: route.match.pathPrefix,
            auth: {
              required: true
            },
            downstream: {
              origin: route.upstream.baseUrl,
              connectTimeoutMs: this.options.defaultConnectTimeoutMs ?? 1_000,
              responseTimeoutMs: this.options.defaultResponseTimeoutMs ?? 5_000,
              websocket: route.upstream.websocketEnabled
            },
            worker: {
              entry: prepared.localEntry,
              timeoutMs: this.options.defaultWorkerTimeoutMs ?? 1_000
            }
          });
        }

        const state = assignmentStates.get(assignment.assignmentId);
        if (state) {
          state.state = "ready";
          state.generationId = revisionGenerationId;
          state.preparedAt = Date.now();
        }
      } catch (error) {
        const state = assignmentStates.get(assignment.assignmentId);
        if (state && state.state !== "failed") {
          state.state = "failed";
          state.failedAt = Date.now();
          state.lastError = {
            code: "ARTIFACT_PREPARE_FAILED",
            message: error instanceof Error ? error.message : String(error),
            retryable: true
          };
        }
        throw error;
      }
    }

    return {
      pipelines
    };
  }
}
