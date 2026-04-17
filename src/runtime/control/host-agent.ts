import type {
  ArtifactManifest,
  DesiredHostState,
  HeartbeatHostResult,
  HostRegistration,
  ObservedHostState
} from "../../shared/index.ts";
import { HardessAdminClient } from "../../sdk/admin/client.ts";
import { ConsoleLogger, type Logger } from "../observability/logger.ts";

type TimeoutHandle = ReturnType<typeof globalThis.setTimeout> | number;

export interface HostRuntimeAdapter {
  getHostRegistration(): Promise<HostRegistration> | HostRegistration;
  applyDesiredHostState(
    desired: DesiredHostState,
    artifacts?: Map<string, ArtifactManifest>
  ): Promise<void> | void;
  collectObservedHostState(): Promise<ObservedHostState> | ObservedHostState;
}

export interface HostAgentOptions {
  logger?: Logger;
  defaultPollAfterMs?: number;
  retryPollAfterMs?: number;
  reportObservedAfterApply?: boolean;
  timers?: {
    setTimeout: (callback: () => void, delay: number) => TimeoutHandle;
    clearTimeout: (timeout: TimeoutHandle) => void;
  };
}

export interface HostAgentSnapshot {
  running: boolean;
  registered: boolean;
  hostId?: string;
  desiredRevision?: string;
  lastPollAfterMs?: number;
  lastError?: string;
}

export class HostAgent {
  private running = false;
  private registered = false;
  private hostId?: string;
  private desiredRevision?: string;
  private lastPollAfterMs?: number;
  private lastError?: string;
  private pollTimer?: TimeoutHandle;
  private cycleInFlight?: Promise<void>;
  private readonly logger: Logger;
  private readonly defaultPollAfterMs: number;
  private readonly retryPollAfterMs: number;
  private readonly reportObservedAfterApply: boolean;
  private readonly timers: {
    setTimeout: (callback: () => void, delay: number) => TimeoutHandle;
    clearTimeout: (timeout: TimeoutHandle) => void;
  };

  constructor(
    private readonly adminClient: HardessAdminClient,
    private readonly runtime: HostRuntimeAdapter,
    options: HostAgentOptions = {}
  ) {
    this.logger = options.logger ?? new ConsoleLogger();
    this.defaultPollAfterMs = options.defaultPollAfterMs ?? 5_000;
    this.retryPollAfterMs = options.retryPollAfterMs ?? 1_000;
    this.reportObservedAfterApply = options.reportObservedAfterApply ?? true;
    this.timers = {
      setTimeout: options.timers?.setTimeout ?? setTimeout,
      clearTimeout: options.timers?.clearTimeout ?? clearTimeout
    };
  }

  start(): void {
    if (this.running) {
      return;
    }

    this.running = true;
    void this.reconcileOnce();
  }

  stop(): void {
    this.running = false;
    if (this.pollTimer) {
      this.timers.clearTimeout(this.pollTimer);
      this.pollTimer = undefined;
    }
  }

  getSnapshot(): HostAgentSnapshot {
    return {
      running: this.running,
      registered: this.registered,
      hostId: this.hostId,
      desiredRevision: this.desiredRevision,
      lastPollAfterMs: this.lastPollAfterMs,
      lastError: this.lastError
    };
  }

  async reconcileOnce(): Promise<void> {
    if (this.cycleInFlight) {
      return this.cycleInFlight;
    }

    this.cycleInFlight = this.performReconcileCycle();
    try {
      await this.cycleInFlight;
    } finally {
      this.cycleInFlight = undefined;
    }
  }

  private async performReconcileCycle(): Promise<void> {
    let nextPollAfterMs = this.defaultPollAfterMs;
    let shouldReportObserved = false;
    let cycleFailed = false;
    let registration: HostRegistration | undefined;
    let observed: ObservedHostState | undefined;

    try {
      registration = await this.runtime.getHostRegistration();
      this.assertStableHostIdentity(registration);

      if (!this.registered) {
        const ack = await this.adminClient.registerHost(registration);
        this.registered = ack.accepted;
        this.hostId = ack.hostId;
        nextPollAfterMs = ack.pollAfterMs ?? nextPollAfterMs;
        this.logger.info("host agent registered", {
          hostId: this.hostId,
          pollAfterMs: nextPollAfterMs
        });
      }

      const desired = await this.adminClient.getDesiredHostState({
        hostId: registration.hostId,
        ifRevision: this.desiredRevision
      });

      if (desired.changed && desired.desired) {
        const artifacts = await this.resolveArtifactManifests(desired.desired);
        await this.runtime.applyDesiredHostState(desired.desired, artifacts);
        this.desiredRevision = desired.desired.revision;
        shouldReportObserved = this.reportObservedAfterApply;
        this.logger.info("host agent applied desired state", {
          hostId: registration.hostId,
          revision: desired.desired.revision,
          assignments: desired.desired.assignments.length
        });
      }
    } catch (error) {
      cycleFailed = true;
      this.lastError = error instanceof Error ? error.message : String(error);
      this.logger.error("host agent reconcile step failed", {
        hostId: registration?.hostId ?? this.hostId,
        error: this.lastError
      });
    }

    try {
      observed = await this.runtime.collectObservedHostState();
      if (registration && observed.hostId !== registration.hostId) {
        throw new Error(
          `Observed hostId ${observed.hostId} does not match registered hostId ${registration.hostId}`
        );
      }
    } catch (error) {
      cycleFailed = true;
      this.lastError = error instanceof Error ? error.message : String(error);
      this.logger.error("host agent failed to collect observed state", {
        hostId: registration?.hostId ?? this.hostId,
        error: this.lastError
      });
    }

    if (observed && shouldReportObserved) {
      try {
        await this.adminClient.reportObservedHostState(observed);
      } catch (error) {
        cycleFailed = true;
        this.lastError = error instanceof Error ? error.message : String(error);
        this.logger.error("host agent failed to report observed state", {
          hostId: observed.hostId,
          error: this.lastError
        });
      }
    }

    if (observed) {
      try {
        const heartbeat = await this.adminClient.heartbeatHost({
          hostId: observed.hostId,
          observed
        });
        nextPollAfterMs = this.resolveNextPollAfterMs(heartbeat, nextPollAfterMs);
      } catch (error) {
        cycleFailed = true;
        this.lastError = error instanceof Error ? error.message : String(error);
        this.logger.error("host agent heartbeat failed", {
          hostId: observed.hostId,
          error: this.lastError
        });
      }
    }

    if (!cycleFailed) {
      this.lastError = undefined;
    } else {
      nextPollAfterMs = this.retryPollAfterMs;
    }

    this.scheduleNextPoll(nextPollAfterMs);
  }

  private resolveNextPollAfterMs(
    heartbeat: HeartbeatHostResult,
    fallbackPollAfterMs: number
  ): number {
    return heartbeat.nextPollAfterMs ?? fallbackPollAfterMs;
  }

  private assertStableHostIdentity(registration: HostRegistration): void {
    if (this.hostId && registration.hostId !== this.hostId) {
      throw new Error(
        `HostRegistration hostId changed from ${this.hostId} to ${registration.hostId}`
      );
    }
  }

  private scheduleNextPoll(delayMs: number): void {
    this.lastPollAfterMs = delayMs;
    if (!this.running) {
      return;
    }

    if (this.pollTimer) {
      this.timers.clearTimeout(this.pollTimer);
    }

    this.pollTimer = this.timers.setTimeout(() => {
      this.pollTimer = undefined;
      void this.reconcileOnce();
    }, delayMs);
  }

  private async resolveArtifactManifests(
    desired: DesiredHostState
  ): Promise<Map<string, ArtifactManifest>> {
    const manifestIds = Array.from(
      new Set(desired.assignments.map((assignment) => assignment.artifact.manifestId))
    );
    const manifests = await Promise.all(
      manifestIds.map(async (manifestId) => {
        const manifest = await this.adminClient.fetchArtifactManifest({ manifestId });
        return [manifestId, manifest] as const;
      })
    );
    return new Map(manifests);
  }
}
