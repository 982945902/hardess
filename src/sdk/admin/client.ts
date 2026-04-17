import {
  parseArtifactManifest,
  parseArtifactManifestQuery,
  parseDesiredHostStateQuery,
  parseDesiredHostStateResult,
  parseHeartbeatHostInput,
  parseHeartbeatHostResult,
  parseHostRegistration,
  parseObservedHostState,
  parseRegisterHostResult,
  parseReportObservedHostStateResult,
  type ArtifactManifest,
  type ArtifactManifestQuery,
  type DesiredHostStateQuery,
  type DesiredHostStateResult,
  type HeartbeatHostInput,
  type HeartbeatHostResult,
  type HostRegistration,
  type ObservedHostState,
  type RegisterHostResult,
  type ReportObservedHostStateResult
} from "../../shared/index.ts";
import { ADMIN_TRANSPORT_OPERATIONS, type AdminTransport } from "./transport.ts";

export class HardessAdminClient {
  constructor(private readonly transport: AdminTransport) {}

  async registerHost(input: HostRegistration): Promise<RegisterHostResult> {
    const payload = parseHostRegistration(input);
    const response = await this.transport.request(ADMIN_TRANSPORT_OPERATIONS.REGISTER_HOST, payload);
    return parseRegisterHostResult(response);
  }

  async heartbeatHost(input: HeartbeatHostInput): Promise<HeartbeatHostResult> {
    const payload = parseHeartbeatHostInput(input);
    const response = await this.transport.request(ADMIN_TRANSPORT_OPERATIONS.HEARTBEAT_HOST, payload);
    return parseHeartbeatHostResult(response);
  }

  async getDesiredHostState(input: DesiredHostStateQuery): Promise<DesiredHostStateResult> {
    const payload = parseDesiredHostStateQuery(input);
    const response = await this.transport.request(ADMIN_TRANSPORT_OPERATIONS.GET_DESIRED_HOST_STATE, payload);
    return parseDesiredHostStateResult(response);
  }

  async reportObservedHostState(input: ObservedHostState): Promise<ReportObservedHostStateResult> {
    const payload = parseObservedHostState(input);
    const response = await this.transport.request(
      ADMIN_TRANSPORT_OPERATIONS.REPORT_OBSERVED_HOST_STATE,
      payload
    );
    return parseReportObservedHostStateResult(response);
  }

  async fetchArtifactManifest(input: ArtifactManifestQuery): Promise<ArtifactManifest> {
    const payload = parseArtifactManifestQuery(input);
    const response = await this.transport.request(
      ADMIN_TRANSPORT_OPERATIONS.FETCH_ARTIFACT_MANIFEST,
      payload
    );
    return parseArtifactManifest(response);
  }
}
