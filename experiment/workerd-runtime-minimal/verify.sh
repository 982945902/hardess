#!/usr/bin/env zsh

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")" && pwd)"
RUN_SCRIPT="$ROOT_DIR/run.sh"
BASE_URL="http://127.0.0.1:6285"
LOG_FILE="$(mktemp -t workerd-minimal-log.XXXXXX)"
GENERATED_CONFIG="$ROOT_DIR/.generated.config.capnp"
RESOLVED_MODEL="$(cd "$ROOT_DIR" && rtk bun run ./print-resolved-model.ts)"
RUNTIME_SUMMARY="$(cd "$ROOT_DIR" && rtk bun run ./print-runtime-summary.ts)"

cleanup() {
  if [[ -n "${SERVER_PID:-}" ]]; then
    kill "$SERVER_PID" >/dev/null 2>&1 || true
    for _ in {1..20}; do
      if ! kill -0 "$SERVER_PID" >/dev/null 2>&1; then
        break
      fi
      sleep 0.1
    done
    if kill -0 "$SERVER_PID" >/dev/null 2>&1; then
      kill -9 "$SERVER_PID" >/dev/null 2>&1 || true
    fi
    wait "$SERVER_PID" >/dev/null 2>&1 || true
  fi
  rm -f "$LOG_FILE"
}
trap cleanup EXIT

"$RUN_SCRIPT" >"$LOG_FILE" 2>&1 &
SERVER_PID=$!

for _ in {1..50}; do
  if curl -fsS "$BASE_URL/" >/dev/null 2>&1; then
    break
  fi
  sleep 0.2
done

GET_RESPONSE="$(curl -fsS "$BASE_URL/")"
POST_RESPONSE="$(curl -fsS -X POST "$BASE_URL/echo" --data 'hardess-workerd')"
INVALID_METHOD_RESPONSE="$(curl -sS -X GET "$BASE_URL/echo")"
WS_RESPONSE="$(cd "$ROOT_DIR" && bun run ./ws-smoke.ts)"

test -f "$GENERATED_CONFIG"
grep -q 'address = "127.0.0.1:6285"' "$GENERATED_CONFIG"
grep -q 'text = "hardess-workerd-secret"' "$GENERATED_CONFIG"
grep -q 'text = "hardess-workerd-token"' "$GENERATED_CONFIG"
grep -q 'HARDESS_ASSIGNMENT_META' "$GENERATED_CONFIG"
grep -q 'exp-workerd-minimal-http-worker-v2' "$GENERATED_CONFIG"
grep -q 'HARDESS_ROUTE_TABLE' "$GENERATED_CONFIG"
grep -q 'HARDESS_RESOLVED_RUNTIME_MODEL' "$GENERATED_CONFIG"
grep -q 'route.demo.workerd.ws' "$GENERATED_CONFIG"
grep -q 'HARDESS_PROTOCOL_PACKAGE' "$GENERATED_CONFIG"
grep -q 'workerd-http-ingress@v1' "$GENERATED_CONFIG"
echo "$RESOLVED_MODEL" | grep -q '"listenAddress": "127.0.0.1:6285"'
echo "$RESOLVED_MODEL" | grep -q '"actionCount": 3'
echo "$RESOLVED_MODEL" | grep -q '"actionIds": \['
echo "$RESOLVED_MODEL" | grep -q '"http.info"'
echo "$RESOLVED_MODEL" | grep -q '"primaryRuntimeBinding": "HARDESS_RESOLVED_RUNTIME_MODEL"'
echo "$RESOLVED_MODEL" | grep -q '"compatibilityBindings": \['
echo "$RESOLVED_MODEL" | grep -q '"metadataBindings": \['
echo "$RUNTIME_SUMMARY" | grep -q '"primaryRuntimeBinding": "HARDESS_RESOLVED_RUNTIME_MODEL"'
echo "$RUNTIME_SUMMARY" | grep -q '"routeCount": 3'
echo "$RUNTIME_SUMMARY" | grep -q '"highestAdvisorySeverity": "warning"'
echo "$RUNTIME_SUMMARY" | grep -q '"routeId": "route.demo.workerd.ws"'
echo "$RUNTIME_SUMMARY" | grep -q '"code": "non_tls_websocket_upstream"'
echo "$RESOLVED_MODEL" | grep -q '"routeCount": 3'
echo "$RESOLVED_MODEL" | grep -q '"httpRouteCount": 2'
echo "$RESOLVED_MODEL" | grep -q '"websocketRouteCount": 1'
echo "$RESOLVED_MODEL" | grep -q '"rootRouteId": "route.demo.workerd.root"'
echo "$RESOLVED_MODEL" | grep -q '"bindingNames": \['
echo "$RESOLVED_MODEL" | grep -q '"DEMO_SECRET"'
echo "$RESOLVED_MODEL" | grep -q '"advisoryCount": 4'
echo "$RESOLVED_MODEL" | grep -q '"info": 1'
echo "$RESOLVED_MODEL" | grep -q '"warning": 3'
echo "$RESOLVED_MODEL" | grep -q '"highestAdvisorySeverity": "warning"'
echo "$RESOLVED_MODEL" | grep -q '"severity": "info"'
echo "$RESOLVED_MODEL" | grep -q '"severity": "warning"'
echo "$RESOLVED_MODEL" | grep -q '"code": "root_catch_all_route"'
echo "$RESOLVED_MODEL" | grep -q '"code": "non_tls_http_upstream"'
echo "$RESOLVED_MODEL" | grep -q '"code": "non_tls_websocket_upstream"'
echo "$RESOLVED_MODEL" | grep -q '"routeId": "route.demo.workerd.echo"'
echo "$RESOLVED_MODEL" | grep -q '"upstreamBaseUrl": "ws://workerd.local/ws"'
echo "$RESOLVED_MODEL" | grep -q '"secrets": \['
echo "$RESOLVED_MODEL" | grep -q '"DEMO_TOKEN"'
echo "$GET_RESPONSE" | grep -q '"runtime": "workerd"'
echo "$GET_RESPONSE" | grep -q '"secret": "hardess-workerd-secret"'
echo "$GET_RESPONSE" | grep -q '"tokenPresent": true'
echo "$GET_RESPONSE" | grep -q '"assignmentId": "exp-workerd-minimal-http-worker-v2"'
echo "$GET_RESPONSE" | grep -q '"deploymentId": "demo-workerd-http-worker"'
echo "$GET_RESPONSE" | grep -q '"routeId": "route.demo.workerd.root"'
echo "$GET_RESPONSE" | grep -q '"actionId": "http.info"'
echo "$GET_RESPONSE" | grep -q '"protocolPackageId": "workerd-http-ingress@v1"'
echo "$GET_RESPONSE" | grep -q '"dispatchSource": "resolved_runtime_model"'
echo "$GET_RESPONSE" | grep -q '"resolvedRouteCount": 3'
echo "$GET_RESPONSE" | grep -q '"resolvedListenAddress": "127.0.0.1:6285"'
echo "$GET_RESPONSE" | grep -q '"resolvedProtocolActionCount": 3'
echo "$GET_RESPONSE" | grep -q '"resolvedProtocolActionIds": \['
echo "$GET_RESPONSE" | grep -q '"resolvedPrimaryRuntimeBinding": "HARDESS_RESOLVED_RUNTIME_MODEL"'
echo "$GET_RESPONSE" | grep -q '"resolvedCompatibilityBindings": \['
echo "$GET_RESPONSE" | grep -q '"resolvedMetadataBindings": \['
echo "$GET_RESPONSE" | grep -q '"resolvedHttpRouteCount": 2'
echo "$GET_RESPONSE" | grep -q '"resolvedWebsocketRouteCount": 1'
echo "$GET_RESPONSE" | grep -q '"resolvedRootRouteId": "route.demo.workerd.root"'
echo "$GET_RESPONSE" | grep -q '"resolvedBindingNames": \['
echo "$GET_RESPONSE" | grep -q '"resolvedSecretNames": \['
echo "$GET_RESPONSE" | grep -q '"resolvedAdvisoryCount": 4'
echo "$GET_RESPONSE" | grep -q '"resolvedAdvisorySeverityCounts": {'
echo "$GET_RESPONSE" | grep -q '"resolvedHighestAdvisorySeverity": "warning"'
echo "$GET_RESPONSE" | grep -q '"resolvedAdvisoryCodes": \['
echo "$GET_RESPONSE" | grep -q '"resolvedAdvisorySeverities": \['
echo "$GET_RESPONSE" | grep -q '"HARDESS_ROUTE_TABLE"'
echo "$GET_RESPONSE" | grep -q '"HARDESS_PROTOCOL_PACKAGE"'
echo "$GET_RESPONSE" | grep -q '"HARDESS_ASSIGNMENT_META"'
echo "$GET_RESPONSE" | grep -q '"HARDESS_CONFIG"'
echo "$GET_RESPONSE" | grep -q '"root_catch_all_route"'
echo "$GET_RESPONSE" | grep -q '"warning"'
echo "$GET_RESPONSE" | grep -q '"allowedMethods": \['
echo "$GET_RESPONSE" | grep -q '"GET"'
echo "$POST_RESPONSE" | grep -q '"echo": "hardess-workerd"'
echo "$POST_RESPONSE" | grep -q '"length": 15'
echo "$POST_RESPONSE" | grep -q '"assignmentId": "exp-workerd-minimal-http-worker-v2"'
echo "$POST_RESPONSE" | grep -q '"routeId": "route.demo.workerd.echo"'
echo "$POST_RESPONSE" | grep -q '"actionId": "http.echo"'
echo "$POST_RESPONSE" | grep -q '"dispatchSource": "resolved_runtime_model"'
echo "$INVALID_METHOD_RESPONSE" | grep -q '"error": "method_not_allowed"'
echo "$INVALID_METHOD_RESPONSE" | grep -q '"routeId": "route.demo.workerd.echo"'
echo "$INVALID_METHOD_RESPONSE" | grep -q '"actionId": "http.echo"'
echo "$INVALID_METHOD_RESPONSE" | grep -q '"allowedMethods": \['
echo "$INVALID_METHOD_RESPONSE" | grep -q '"POST"'
echo "$WS_RESPONSE" | grep -q '"type":"echo"'
echo "$WS_RESPONSE" | grep -q '"runtime":"workerd"'
echo "$WS_RESPONSE" | grep -q '"assignmentId":"exp-workerd-minimal-http-worker-v2"'
echo "$WS_RESPONSE" | grep -q '"routeId":"route.demo.workerd.ws"'
echo "$WS_RESPONSE" | grep -q '"actionId":"ws.echo"'
echo "$WS_RESPONSE" | grep -q '"echo":"hardess-workerd-ws"'

printf '%s\n' 'GET / response:'
printf '%s\n' "$GET_RESPONSE"
printf '\n%s\n' 'POST /echo response:'
printf '%s\n' "$POST_RESPONSE"
printf '\n%s\n' 'Resolved runtime model:'
printf '%s\n' "$RESOLVED_MODEL"
printf '\n%s\n' 'Runtime summary:'
printf '%s\n' "$RUNTIME_SUMMARY"
printf '\n%s\n' 'GET /echo invalid method response:'
printf '%s\n' "$INVALID_METHOD_RESPONSE"
printf '\n%s\n' 'GET /ws websocket response:'
printf '%s\n' "$WS_RESPONSE"
printf '\n%s\n' 'Verification passed.'
