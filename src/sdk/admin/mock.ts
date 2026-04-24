import {
  parseRuntimeSummaryReadModel,
  parseRuntimeSummaryReadModelQuery,
  parseArtifactManifest,
  parseArtifactManifestQuery,
  parseDesiredHostState,
  parseDesiredHostStateQuery,
  parseHeartbeatHostInput,
  parseHostRegistration,
  parseObservedHostState,
  type ArtifactManifest,
  type DesiredHostState,
  type HostRegistration,
  type ObservedHostState,
  type RuntimeSummaryReadModel
} from "../../shared/index.ts";
import { buildRuntimeSummaryReadModel } from "./planning.ts";
import {
  ADMIN_TRANSPORT_OPERATIONS,
  type AdminTransport,
  type AdminTransportOperation
} from "./transport.ts";

export interface MockAdminTransportOptions {
  pollAfterMs?: number;
  nextPollAfterMs?: number;
  now?: () => number;
}

export class MockAdminTransport implements AdminTransport {
  private readonly registeredHosts = new Map<string, HostRegistration>();
  private readonly desiredHostStates = new Map<string, DesiredHostState>();
  private readonly observedHostStates = new Map<string, ObservedHostState>();
  private readonly artifactManifests = new Map<string, ArtifactManifest>();
  private readonly pollAfterMs: number;
  private readonly nextPollAfterMs: number;
  private readonly now: () => number;

  constructor(options: MockAdminTransportOptions = {}) {
    this.pollAfterMs = options.pollAfterMs ?? 5_000;
    this.nextPollAfterMs = options.nextPollAfterMs ?? 5_000;
    this.now = options.now ?? Date.now;
  }

  async request(operation: AdminTransportOperation, payload: unknown): Promise<unknown> {
    switch (operation) {
      case ADMIN_TRANSPORT_OPERATIONS.REGISTER_HOST:
        return this.handleRegisterHost(payload);
      case ADMIN_TRANSPORT_OPERATIONS.HEARTBEAT_HOST:
        return this.handleHeartbeatHost(payload);
      case ADMIN_TRANSPORT_OPERATIONS.GET_DESIRED_HOST_STATE:
        return this.handleGetDesiredHostState(payload);
      case ADMIN_TRANSPORT_OPERATIONS.REPORT_OBSERVED_HOST_STATE:
        return this.handleReportObservedHostState(payload);
      case ADMIN_TRANSPORT_OPERATIONS.FETCH_ARTIFACT_MANIFEST:
        return this.handleFetchArtifactManifest(payload);
      case ADMIN_TRANSPORT_OPERATIONS.GET_RUNTIME_SUMMARY_READ_MODEL:
        return this.handleGetRuntimeSummaryReadModel(payload);
      default:
        throw new Error(`Unsupported admin operation: ${operation satisfies never}`);
    }
  }

  setDesiredHostState(value: DesiredHostState): DesiredHostState {
    const desired = parseDesiredHostState(value);
    this.desiredHostStates.set(desired.hostId, desired);
    return desired;
  }

  putArtifactManifest(value: ArtifactManifest): ArtifactManifest {
    const manifest = parseArtifactManifest(value);
    this.artifactManifests.set(manifest.manifestId, manifest);
    return manifest;
  }

  getRegisteredHost(hostId: string): HostRegistration | undefined {
    return this.registeredHosts.get(hostId);
  }

  getObservedHostState(hostId: string): ObservedHostState | undefined {
    return this.observedHostStates.get(hostId);
  }

  getDesiredHostStateSnapshot(hostId: string): DesiredHostState {
    return this.ensureDesiredHostState(hostId);
  }

  listRegisteredHosts(): HostRegistration[] {
    return Array.from(this.registeredHosts.values());
  }

  private handleRegisterHost(payload: unknown): {
    hostId: string;
    accepted: boolean;
    pollAfterMs: number;
  } {
    const registration = parseHostRegistration(payload);
    this.registeredHosts.set(registration.hostId, registration);
    this.ensureDesiredHostState(registration.hostId);
    return {
      hostId: registration.hostId,
      accepted: true,
      pollAfterMs: this.pollAfterMs
    };
  }

  private handleHeartbeatHost(payload: unknown): {
    accepted: boolean;
    nextPollAfterMs: number;
  } {
    const input = parseHeartbeatHostInput(payload);
    this.observedHostStates.set(input.hostId, input.observed);
    this.ensureDesiredHostState(input.hostId);
    return {
      accepted: true,
      nextPollAfterMs: this.nextPollAfterMs
    };
  }

  private handleGetDesiredHostState(payload: unknown): {
    changed: boolean;
    desired?: DesiredHostState;
  } {
    const query = parseDesiredHostStateQuery(payload);
    const desired = this.ensureDesiredHostState(query.hostId);
    if (query.ifRevision && query.ifRevision === desired.revision) {
      return { changed: false };
    }
    return {
      changed: true,
      desired
    };
  }

  private handleReportObservedHostState(payload: unknown): {
    accepted: boolean;
  } {
    const observed = parseObservedHostState(payload);
    this.observedHostStates.set(observed.hostId, observed);
    this.ensureDesiredHostState(observed.hostId);
    return {
      accepted: true
    };
  }

  private handleFetchArtifactManifest(payload: unknown): ArtifactManifest {
    const query = parseArtifactManifestQuery(payload);
    const manifest = this.artifactManifests.get(query.manifestId);
    if (!manifest) {
      throw new Error(`Artifact manifest not found: ${query.manifestId}`);
    }
    return manifest;
  }

  private handleGetRuntimeSummaryReadModel(payload: unknown): RuntimeSummaryReadModel {
    const query = parseRuntimeSummaryReadModelQuery(payload);
    const desiredHostStates = Array.from(this.desiredHostStates.values());
    const observedHostStates = Array.from(this.observedHostStates.values());
    return parseRuntimeSummaryReadModel(
      buildRuntimeSummaryReadModel(
        desiredHostStates,
        observedHostStates,
        query
      )
    );
  }

  private ensureDesiredHostState(hostId: string): DesiredHostState {
    const existing = this.desiredHostStates.get(hostId);
    if (existing) {
      return existing;
    }

    const initial: DesiredHostState = {
      hostId,
      revision: `initial:${hostId}`,
      generatedAt: this.now(),
      assignments: []
    };
    this.desiredHostStates.set(hostId, initial);
    return initial;
  }
}
