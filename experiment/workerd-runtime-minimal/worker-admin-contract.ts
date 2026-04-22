export const WORKER_RUNTIME_ADMIN_SCHEMA_VERSION = "hardess.workerd.worker-runtime-admin.v1";

export const WORKER_RUNTIME_ADMIN_OVERVIEW_ENDPOINT = "/_hardess/runtime";
export const WORKER_RUNTIME_ADMIN_STATS_ENDPOINT = "/_hardess/runtime/stats";
export const WORKER_RUNTIME_ADMIN_ROUTES_ENDPOINT = "/_hardess/runtime/routes";

export const WORKER_RUNTIME_ADMIN_ENDPOINTS = [
  WORKER_RUNTIME_ADMIN_OVERVIEW_ENDPOINT,
  WORKER_RUNTIME_ADMIN_STATS_ENDPOINT,
  WORKER_RUNTIME_ADMIN_ROUTES_ENDPOINT,
] as const;
