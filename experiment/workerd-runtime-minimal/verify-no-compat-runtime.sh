#!/usr/bin/env zsh

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")" && pwd)"
RUN_SCRIPT="$ROOT_DIR/run.sh"
cd "$ROOT_DIR"
source "$ROOT_DIR/verify-lib.sh"
LOG_FILE="$(mktemp -t workerd-minimal-no-compat-runtime-log.XXXXXX)"
GENERATED_CONFIG="$(mktemp -t workerd-minimal-no-compat-runtime-config.XXXXXX)"
RUNTIME_INVALID_METHOD_BODY="$(mktemp -t workerd-no-compat-invalid-method.XXXXXX)"
RUNTIME_NOT_FOUND_BODY="$(mktemp -t workerd-no-compat-not-found.XXXXXX)"
WS_UPGRADE_REQUIRED_BODY="$(mktemp -t workerd-no-compat-ws-upgrade.XXXXXX)"
RUNTIME_ADAPTER="./runtime-adapter-no-compatibility-bindings.json"

LISTEN_ADDRESS=""
BASE_URL=""
WS_URL=""

cleanup() {
  cleanup_server "${SERVER_PID:-}"
  rm -f "$LOG_FILE" "$GENERATED_CONFIG"
  rm -f "$RUNTIME_INVALID_METHOD_BODY"
  rm -f "$RUNTIME_NOT_FOUND_BODY"
  rm -f "$WS_UPGRADE_REQUIRED_BODY"
}
trap cleanup EXIT

start_server_with_retry "no-compat runtime" "$LOG_FILE" env GENERATED_CONFIG="$GENERATED_CONFIG" "$RUN_SCRIPT" --runtime-adapter "$RUNTIME_ADAPTER"
SERVER_PID="$START_SERVER_PID"
LISTEN_ADDRESS="$START_SERVER_LISTEN_ADDRESS"
BASE_URL="$START_SERVER_BASE_URL"
WS_URL="$START_SERVER_WS_URL"

GET_RESPONSE="$(curl -fsS "$BASE_URL/")"
POST_RESPONSE="$(curl -fsS -X POST "$BASE_URL/echo" --data 'hardess-workerd')"
INVALID_METHOD_RESPONSE="$(curl -sS -X GET "$BASE_URL/echo")"
WS_UPGRADE_REQUIRED_STATUS="$(curl -sS -o "$WS_UPGRADE_REQUIRED_BODY" -w '%{http_code}' "$BASE_URL/ws")"
WS_UPGRADE_REQUIRED_RESPONSE="$(cat "$WS_UPGRADE_REQUIRED_BODY")"
WS_RESPONSE="$(cd "$ROOT_DIR" && rtk bun run ./ws-smoke.ts --url "$WS_URL")"
RUNTIME_RESPONSE="$(curl -fsS "$BASE_URL/_hardess/runtime")"
RUNTIME_STATS_RESPONSE="$(curl -fsS "$BASE_URL/_hardess/runtime/stats")"
RUNTIME_ROUTES_RESPONSE="$(curl -fsS "$BASE_URL/_hardess/runtime/routes")"
RUNTIME_INVALID_METHOD_STATUS="$(curl -sS -o "$RUNTIME_INVALID_METHOD_BODY" -w '%{http_code}' -X POST "$BASE_URL/_hardess/runtime")"
RUNTIME_INVALID_METHOD_RESPONSE="$(cat "$RUNTIME_INVALID_METHOD_BODY")"
RUNTIME_NOT_FOUND_STATUS="$(curl -sS -o "$RUNTIME_NOT_FOUND_BODY" -w '%{http_code}' "$BASE_URL/_hardess/runtime/unknown")"
RUNTIME_NOT_FOUND_RESPONSE="$(cat "$RUNTIME_NOT_FOUND_BODY")"

test -f "$GENERATED_CONFIG"
grep -q 'HARDESS_RESOLVED_RUNTIME_MODEL' "$GENERATED_CONFIG"
grep -q 'name = "worker-error-contract.ts"' "$GENERATED_CONFIG"
if grep -q 'HARDESS_ROUTE_TABLE' "$GENERATED_CONFIG"; then
  echo 'unexpected HARDESS_ROUTE_TABLE in no-compat runtime config' >&2
  exit 1
fi
if grep -q 'HARDESS_PROTOCOL_PACKAGE' "$GENERATED_CONFIG"; then
  echo 'unexpected HARDESS_PROTOCOL_PACKAGE in no-compat runtime config' >&2
  exit 1
fi

assert_json_field "$GET_RESPONSE" --path dispatchSource --equals "resolved_runtime_model"
assert_json_field "$GET_RESPONSE" --path schemaVersion --equals "hardess.workerd.worker-action.v1"
assert_json_field "$GET_RESPONSE" --path protocolPackageId --equals "workerd-http-ingress@v1"
assert_json_field "$GET_RESPONSE" --path resolvedCompatibilityBindings --equals-json "[]"
assert_json_field "$GET_RESPONSE" --path resolvedPrimaryRuntimeBinding --equals "HARDESS_RESOLVED_RUNTIME_MODEL"
assert_json_field "$GET_RESPONSE" --path resolvedMetadataBindings --includes "HARDESS_ASSIGNMENT_META"
assert_json_field "$GET_RESPONSE" --path resolvedMetadataBindings --includes "HARDESS_CONFIG"
assert_json_field "$GET_RESPONSE" --path resolvedRouteCount --equals-json "3"
assert_json_field "$GET_RESPONSE" --path resolvedProtocolActionCount --equals-json "3"
assert_json_field "$GET_RESPONSE" --path resolvedCompatibilityBindings --not-includes "HARDESS_ROUTE_TABLE"
assert_json_field "$GET_RESPONSE" --path resolvedCompatibilityBindings --not-includes "HARDESS_PROTOCOL_PACKAGE"
assert_json_field "$GET_RESPONSE" --path runtimeRegisteredActionIds --includes "http.info"
assert_json_field "$GET_RESPONSE" --path runtimeDispatchableActionIds --includes "ws.echo"
assert_json_field "$GET_RESPONSE" --path runtimeUnhandledActionIds --equals-json "[]"
assert_json_field "$GET_RESPONSE" --path runtimeUnhandledRouteIds --equals-json "[]"
assert_json_field "$GET_RESPONSE" --path workerRuntime.runtimeName --equals "hardess.workerd.worker-runtime.v1"
assert_json_field "$GET_RESPONSE" --path workerRuntime.requestSequence --equals-json "2"
assert_json_field "$GET_RESPONSE" --path workerRuntime.totalRequests --equals-json "2"
assert_json_field "$POST_RESPONSE" --path echo --equals "hardess-workerd"
assert_json_field "$POST_RESPONSE" --path schemaVersion --equals "hardess.workerd.worker-action.v1"
assert_json_field "$POST_RESPONSE" --path dispatchSource --equals "resolved_runtime_model"
assert_json_field "$POST_RESPONSE" --path workerRuntime.requestSequence --equals-json "3"
assert_json_field "$INVALID_METHOD_RESPONSE" --path error --equals "method_not_allowed"
assert_json_field "$INVALID_METHOD_RESPONSE" --path schemaVersion --equals "hardess.workerd.worker-error.v1"
assert_json_field "$INVALID_METHOD_RESPONSE" --path dispatchSource --equals "worker_runtime"
assert_json_field "$INVALID_METHOD_RESPONSE" --path allowedMethods --includes "POST"
assert_json_field "$INVALID_METHOD_RESPONSE" --path workerRuntime.requestSequence --equals-json "4"
test "$WS_UPGRADE_REQUIRED_STATUS" = "426"
assert_json_field "$WS_UPGRADE_REQUIRED_RESPONSE" --path error --equals "upgrade_required"
assert_json_field "$WS_UPGRADE_REQUIRED_RESPONSE" --path schemaVersion --equals "hardess.workerd.worker-error.v1"
assert_json_field "$WS_UPGRADE_REQUIRED_RESPONSE" --path dispatchSource --equals "worker_runtime"
assert_json_field "$WS_UPGRADE_REQUIRED_RESPONSE" --path routeId --equals "route.demo.workerd.ws"
assert_json_field "$WS_UPGRADE_REQUIRED_RESPONSE" --path actionId --equals "ws.echo"
assert_json_field "$WS_UPGRADE_REQUIRED_RESPONSE" --path upgrade --equals "websocket"
assert_json_field "$WS_UPGRADE_REQUIRED_RESPONSE" --path receivedUpgradeHeader --equals-json "null"
assert_json_field "$WS_UPGRADE_REQUIRED_RESPONSE" --path workerRuntime.requestSequence --equals-json "5"
assert_json_field "$WS_RESPONSE" --path type --equals "echo"
assert_json_field "$WS_RESPONSE" --path schemaVersion --equals "hardess.workerd.worker-action.v1"
assert_json_field "$WS_RESPONSE" --path routeId --equals "route.demo.workerd.ws"
assert_json_field "$WS_RESPONSE" --path actionId --equals "ws.echo"
assert_json_field "$WS_RESPONSE" --path echo --equals "hardess-workerd-ws"
assert_json_field "$WS_RESPONSE" --path workerRuntime.requestSequence --equals-json "6"
assert_json_field "$WS_RESPONSE" --path workerRuntime.websocketSessionCount --equals-json "1"
assert_json_field "$RUNTIME_RESPONSE" --path endpoint --equals "/_hardess/runtime"
assert_json_field "$RUNTIME_RESPONSE" --path schemaVersion --equals "hardess.workerd.worker-runtime-admin.v1"
assert_json_field "$RUNTIME_RESPONSE" --path dispatchSource --equals "worker_runtime_admin"
assert_json_field "$RUNTIME_RESPONSE" --path registeredActionIds --includes "http.info"
assert_json_field "$RUNTIME_RESPONSE" --path registeredActionIds --includes "http.echo"
assert_json_field "$RUNTIME_RESPONSE" --path dispatchableActionIds --includes "ws.echo"
assert_json_field "$RUNTIME_RESPONSE" --path unhandledActionIds --equals-json "[]"
assert_json_field "$RUNTIME_RESPONSE" --path unhandledRouteIds --equals-json "[]"
assert_json_field "$RUNTIME_RESPONSE" --path workerRuntime.requestSequence --equals-json "7"
assert_json_field "$RUNTIME_RESPONSE" --path workerRuntime.totalRequests --equals-json "7"
assert_json_field "$RUNTIME_RESPONSE" --path workerRuntime.websocketSessionCount --equals-json "1"
assert_json_field "$RUNTIME_STATS_RESPONSE" --path view --equals "stats"
assert_json_field "$RUNTIME_STATS_RESPONSE" --path schemaVersion --equals "hardess.workerd.worker-runtime-admin.v1"
assert_json_field "$RUNTIME_STATS_RESPONSE" --path workerRuntime.requestSequence --equals-json "8"
assert_json_field "$RUNTIME_ROUTES_RESPONSE" --path view --equals "routes"
assert_json_field "$RUNTIME_ROUTES_RESPONSE" --path schemaVersion --equals "hardess.workerd.worker-runtime-admin.v1"
assert_json_field "$RUNTIME_ROUTES_RESPONSE" --path routeCount --equals-json "3"
assert_json_field "$RUNTIME_ROUTES_RESPONSE" --path workerRuntime.requestSequence --equals-json "9"
test "$RUNTIME_INVALID_METHOD_STATUS" = "405"
assert_json_field "$RUNTIME_INVALID_METHOD_RESPONSE" --path error --equals "method_not_allowed"
assert_json_field "$RUNTIME_INVALID_METHOD_RESPONSE" --path schemaVersion --equals "hardess.workerd.worker-runtime-admin.v1"
assert_json_field "$RUNTIME_INVALID_METHOD_RESPONSE" --path endpoint --equals "/_hardess/runtime"
assert_json_field "$RUNTIME_INVALID_METHOD_RESPONSE" --path allowedMethods --includes "GET"
assert_json_field "$RUNTIME_INVALID_METHOD_RESPONSE" --path workerRuntime.requestSequence --equals-json "10"
test "$RUNTIME_NOT_FOUND_STATUS" = "404"
assert_json_field "$RUNTIME_NOT_FOUND_RESPONSE" --path error --equals "runtime_admin_endpoint_not_found"
assert_json_field "$RUNTIME_NOT_FOUND_RESPONSE" --path schemaVersion --equals "hardess.workerd.worker-runtime-admin.v1"
assert_json_field "$RUNTIME_NOT_FOUND_RESPONSE" --path endpoint --equals "/_hardess/runtime/unknown"
assert_json_field "$RUNTIME_NOT_FOUND_RESPONSE" --path allowedEndpoints --includes "/_hardess/runtime/stats"
assert_json_field "$RUNTIME_NOT_FOUND_RESPONSE" --path workerRuntime.requestSequence --equals-json "11"

printf '%s\n' 'GET / response without compatibility bindings:'
printf '%s\n' "$GET_RESPONSE"
printf '\n%s\n' 'POST /echo response without compatibility bindings:'
printf '%s\n' "$POST_RESPONSE"
printf '\n%s\n' 'GET /echo invalid method response without compatibility bindings:'
printf '%s\n' "$INVALID_METHOD_RESPONSE"
printf '\n%s\n' 'GET /ws websocket response without compatibility bindings:'
printf '%s\n' "$WS_RESPONSE"
printf '\n%s\n' 'GET /_hardess/runtime response without compatibility bindings:'
printf '%s\n' "$RUNTIME_RESPONSE"
printf '\n%s\n' 'GET /_hardess/runtime/stats response without compatibility bindings:'
printf '%s\n' "$RUNTIME_STATS_RESPONSE"
printf '\n%s\n' 'GET /_hardess/runtime/routes response without compatibility bindings:'
printf '%s\n' "$RUNTIME_ROUTES_RESPONSE"
printf '\n%s\n' 'POST /_hardess/runtime response without compatibility bindings:'
printf '%s\n' "$RUNTIME_INVALID_METHOD_RESPONSE"
printf '\n%s\n' 'GET /_hardess/runtime/unknown response without compatibility bindings:'
printf '%s\n' "$RUNTIME_NOT_FOUND_RESPONSE"
printf '\n%s\n' 'No-compat runtime verification passed.'
