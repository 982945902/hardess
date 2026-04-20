import {
  type ArtifactManifest,
  type Assignment,
  type ServiceModuleProtocolPackageRef,
  verifyServiceModuleProtocolPackageDigest
} from "../../shared/index.ts";
import { ArtifactStore } from "./artifact-store.ts";
import { loadServiceModule } from "../service-modules/loader.ts";
import type { ServerProtocolRegistry } from "../protocol/registry.ts";
import type { Logger } from "../observability/logger.ts";

interface AssignmentStateRecorder {
  deploymentId?: string;
  declaredVersion?: string;
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

interface ActiveServiceModule {
  assignmentId: string;
  deploymentId: string;
  declaredVersion: string;
  packageId: string;
  digest: string;
  protocol: string;
  version: string;
  localEntry: string;
  generationId?: string;
  preparedAt?: number;
  activatedAt?: number;
}

interface DrainingServiceModule extends ActiveServiceModule {
  drainTimer: ReturnType<typeof setTimeout>;
}

export interface DrainingServiceModuleAssignmentStatus {
  assignmentId: string;
  deploymentId: string;
  declaredVersion: string;
  generationId?: string;
  state: "draining";
  preparedAt?: number;
  activatedAt?: number;
}

export interface ServiceModuleManagerOptions {
  registry: ServerProtocolRegistry;
  artifactStore: ArtifactStore;
  logger: Logger;
  drainGraceMs?: number;
}

export class ServiceModuleManager {
  private readonly activeByAssignmentId = new Map<string, ActiveServiceModule>();
  private readonly drainingByAssignmentId = new Map<string, DrainingServiceModule>();

  constructor(private readonly options: ServiceModuleManagerOptions) {}

  async applyAssignments(input: {
    assignments: Assignment[];
    artifacts: Map<string, ArtifactManifest>;
    assignmentStates: Map<string, AssignmentStateRecorder>;
    revision: string;
    revisionGenerationId: string;
    previousAssignmentStates?: Map<string, AssignmentStateRecorder>;
  }): Promise<void> {
    const nextModules = await this.prepareAssignments(input);
    const nextAssignmentIds = new Set(nextModules.map((module) => module.assignmentId));

    for (const [assignmentId, active] of this.activeByAssignmentId.entries()) {
      if (nextAssignmentIds.has(assignmentId)) {
        continue;
      }
      this.beginDraining(active, input.previousAssignmentStates?.get(assignmentId));
    }

    for (const nextModule of nextModules) {
      const drainingConflict = this.findDrainingByProtocolVersion(nextModule.protocol, nextModule.version);
      if (drainingConflict && drainingConflict.assignmentId !== nextModule.assignmentId) {
        this.forceUnregisterDraining(drainingConflict.assignmentId);
      }
    }

    for (const nextModule of nextModules) {
      const current = this.activeByAssignmentId.get(nextModule.assignmentId);
      const draining = this.cancelDraining(nextModule.assignmentId);
      const previousState = input.previousAssignmentStates?.get(nextModule.assignmentId);
      if (current && current.protocol === nextModule.protocol && current.version === nextModule.version) {
        this.options.registry.replace(nextModule.module);
      } else if (draining && draining.protocol === nextModule.protocol && draining.version === nextModule.version) {
        this.options.registry.replace(nextModule.module);
      } else {
        if (current) {
          this.options.registry.unregister(current.protocol, current.version);
        }
        if (draining) {
          this.options.registry.unregister(draining.protocol, draining.version);
        }
        this.options.registry.register(nextModule.module);
      }

      this.activeByAssignmentId.set(nextModule.assignmentId, {
        assignmentId: nextModule.assignmentId,
        deploymentId: nextModule.assignment.deploymentId,
        declaredVersion: nextModule.assignment.declaredVersion,
        packageId: nextModule.packageId,
        digest: nextModule.digest,
        protocol: nextModule.protocol,
        version: nextModule.version,
        localEntry: nextModule.localEntry,
        generationId: input.revisionGenerationId,
        preparedAt: Date.now(),
        activatedAt: previousState?.activatedAt
      });

      const state = input.assignmentStates.get(nextModule.assignmentId);
      if (state) {
        state.state = "ready";
        state.generationId = input.revisionGenerationId;
        state.preparedAt = this.activeByAssignmentId.get(nextModule.assignmentId)?.preparedAt;
      }
    }
  }

  listDrainingAssignments(): DrainingServiceModuleAssignmentStatus[] {
    return Array.from(this.drainingByAssignmentId.values())
      .sort((left, right) => left.assignmentId.localeCompare(right.assignmentId))
      .map((draining) => ({
        assignmentId: draining.assignmentId,
        deploymentId: draining.deploymentId,
        declaredVersion: draining.declaredVersion,
        generationId: draining.generationId,
        state: "draining",
        preparedAt: draining.preparedAt,
        activatedAt: draining.activatedAt
      }));
  }

  listActiveProtocolPackages(): ServiceModuleProtocolPackageRef[] {
    return Array.from(this.activeByAssignmentId.values())
      .map((active) => ({
        packageId: active.packageId,
        digest: active.digest
      }))
      .sort((left, right) => left.packageId.localeCompare(right.packageId));
  }

  private async prepareAssignments(input: {
    assignments: Assignment[];
    artifacts: Map<string, ArtifactManifest>;
    assignmentStates: Map<string, AssignmentStateRecorder>;
    revision: string;
    revisionGenerationId: string;
  }): Promise<
    Array<{
      assignmentId: string;
      packageId: string;
      digest: string;
      protocol: string;
      version: string;
      localEntry: string;
      module: Awaited<ReturnType<typeof loadServiceModule>>;
      assignment: Assignment;
    }>
  > {
    const nextModules: Array<{
      assignmentId: string;
      packageId: string;
      digest: string;
      protocol: string;
      version: string;
      localEntry: string;
      module: Awaited<ReturnType<typeof loadServiceModule>>;
      assignment: Assignment;
    }> = [];
    const protocolVersionOwners = new Map<string, string>();

    for (const assignment of input.assignments) {
      if (assignment.deploymentKind !== "service_module") {
        continue;
      }
      if (!assignment.serviceModule) {
        this.markFailed(input.assignmentStates, assignment.assignmentId, {
          code: "SERVICE_MODULE_PAYLOAD_MISSING",
          message: "Assignment is missing serviceModule payload",
          retryable: false
        });
        throw new Error(`Missing serviceModule payload for assignment ${assignment.assignmentId}`);
      }

      try {
        const artifactManifest = input.artifacts.get(assignment.artifact.manifestId);
        const prepared = await this.options.artifactStore.stageServiceModule(assignment, artifactManifest);
        const serviceModule = await loadServiceModule(prepared.localEntry);
        const boundProtocolPackage = validateBoundProtocolPackage(assignment, serviceModule);
        const currentOwner = protocolVersionOwners.get(boundProtocolPackage.packageId);
        if (currentOwner && currentOwner !== assignment.assignmentId) {
          this.markFailed(input.assignmentStates, assignment.assignmentId, {
            code: "SERVICE_MODULE_CONFLICT",
            message: `Duplicate service module protocol package ${boundProtocolPackage.packageId} on one host`,
            retryable: false
          });
          throw new Error(
            `Duplicate service module protocol package ${boundProtocolPackage.packageId} for assignments ${currentOwner} and ${assignment.assignmentId}`
          );
        }
        protocolVersionOwners.set(boundProtocolPackage.packageId, assignment.assignmentId);
        nextModules.push({
          assignmentId: assignment.assignmentId,
          packageId: boundProtocolPackage.packageId,
          digest: boundProtocolPackage.digest,
          protocol: boundProtocolPackage.protocol,
          version: boundProtocolPackage.version,
          localEntry: prepared.localEntry,
          module: serviceModule,
          assignment
        });
      } catch (error) {
        this.markFailed(input.assignmentStates, assignment.assignmentId, {
          code: "SERVICE_MODULE_PREPARE_FAILED",
          message: error instanceof Error ? error.message : String(error),
          retryable: true
        });
        this.options.logger.warn("service module prepare failed", {
          revision: input.revision,
          assignmentId: assignment.assignmentId,
          hostId: assignment.hostId,
          error: error instanceof Error ? error.message : String(error)
        });
        throw error;
      }
    }

    return nextModules;
  }

  private markFailed(
    assignmentStates: Map<string, AssignmentStateRecorder>,
    assignmentId: string,
    lastError: {
      code: string;
      message: string;
      retryable?: boolean;
    }
  ): void {
    const state = assignmentStates.get(assignmentId);
    if (!state) {
      return;
    }
    state.state = "failed";
    state.failedAt = Date.now();
    state.lastError = lastError;
  }

  private beginDraining(active: ActiveServiceModule, previousState?: AssignmentStateRecorder): void {
    this.activeByAssignmentId.delete(active.assignmentId);
    if ((this.options.drainGraceMs ?? 3_000) <= 0) {
      this.options.registry.unregister(active.protocol, active.version);
      return;
    }

    const drainTimer = setTimeout(() => {
      const draining = this.drainingByAssignmentId.get(active.assignmentId);
      if (!draining || draining.drainTimer !== drainTimer) {
        return;
      }
      this.options.registry.unregister(draining.protocol, draining.version);
      this.drainingByAssignmentId.delete(active.assignmentId);
    }, this.options.drainGraceMs ?? 3_000);

    this.drainingByAssignmentId.set(active.assignmentId, {
      ...active,
      generationId: previousState?.generationId ?? active.generationId,
      preparedAt: previousState?.preparedAt ?? active.preparedAt,
      activatedAt: previousState?.activatedAt ?? active.activatedAt,
      drainTimer
    });
  }

  private cancelDraining(assignmentId: string): DrainingServiceModule | undefined {
    const draining = this.drainingByAssignmentId.get(assignmentId);
    if (!draining) {
      return undefined;
    }
    clearTimeout(draining.drainTimer);
    this.drainingByAssignmentId.delete(assignmentId);
    return draining;
  }

  private forceUnregisterDraining(assignmentId: string): void {
    const draining = this.cancelDraining(assignmentId);
    if (!draining) {
      return;
    }
    this.options.registry.unregister(draining.protocol, draining.version);
  }

  private findDrainingByProtocolVersion(protocol: string, version: string): DrainingServiceModule | undefined {
    for (const draining of this.drainingByAssignmentId.values()) {
      if (draining.protocol === protocol && draining.version === version) {
        return draining;
      }
    }
    return undefined;
  }
}

function validateBoundProtocolPackage(
  assignment: Assignment,
  serviceModule: Awaited<ReturnType<typeof loadServiceModule>>
): {
  packageId: string;
  digest: string;
  protocol: string;
  version: string;
} {
  const protocolPackage = assignment.serviceModule?.protocolPackage;
  if (!protocolPackage) {
    throw new Error(`Missing serviceModule.protocolPackage for assignment ${assignment.assignmentId}`);
  }

  verifyServiceModuleProtocolPackageDigest(protocolPackage);

  if (serviceModule.protocol !== protocolPackage.protocol || serviceModule.version !== protocolPackage.version) {
    throw new Error(
      `Service module protocol package mismatch for assignment ${assignment.assignmentId}: expected ${protocolPackage.protocol}@${protocolPackage.version}, got ${serviceModule.protocol}@${serviceModule.version}`
    );
  }

  const declaredActions = [...protocolPackage.actions].sort();
  const implementedActions = Object.keys(serviceModule.actions).sort();
  if (
    declaredActions.length !== implementedActions.length ||
    declaredActions.some((action, index) => action !== implementedActions[index])
  ) {
    throw new Error(
      `Service module action set mismatch for assignment ${assignment.assignmentId}: expected [${declaredActions.join(", ")}], got [${implementedActions.join(", ")}]`
    );
  }

  return {
    packageId: protocolPackage.packageId,
    digest: protocolPackage.digest,
    protocol: protocolPackage.protocol,
    version: protocolPackage.version
  };
}
