export const ADMIN_TRANSPORT_OPERATIONS = {
  REGISTER_HOST: "registerHost",
  HEARTBEAT_HOST: "heartbeatHost",
  GET_DESIRED_HOST_STATE: "getDesiredHostState",
  REPORT_OBSERVED_HOST_STATE: "reportObservedHostState",
  FETCH_ARTIFACT_MANIFEST: "fetchArtifactManifest"
} as const;

export type AdminTransportOperation =
  (typeof ADMIN_TRANSPORT_OPERATIONS)[keyof typeof ADMIN_TRANSPORT_OPERATIONS];

export interface AdminTransport {
  request(operation: AdminTransportOperation, payload: unknown): Promise<unknown>;
}
