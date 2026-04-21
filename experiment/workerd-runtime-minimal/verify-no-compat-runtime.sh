#!/usr/bin/env zsh

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")" && pwd)"
RUN_SCRIPT="$ROOT_DIR/run.sh"
source "$ROOT_DIR/verify-lib.sh"
LOG_FILE="$(mktemp -t workerd-minimal-no-compat-runtime-log.XXXXXX)"
GENERATED_CONFIG="$(mktemp -t workerd-minimal-no-compat-runtime-config.XXXXXX)"
RUNTIME_ADAPTER="./runtime-adapter-no-compatibility-bindings.json"

PORT="${PORT:-$(pick_port)}"
LISTEN_ADDRESS="127.0.0.1:${PORT}"
BASE_URL="http://${LISTEN_ADDRESS}"
WS_URL="ws://${LISTEN_ADDRESS}/ws"

cleanup() {
  cleanup_server "${SERVER_PID:-}"
  rm -f "$LOG_FILE" "$GENERATED_CONFIG"
}
trap cleanup EXIT

GENERATED_CONFIG="$GENERATED_CONFIG" "$RUN_SCRIPT" --runtime-adapter "$RUNTIME_ADAPTER" --listen-address "$LISTEN_ADDRESS" >"$LOG_FILE" 2>&1 &
SERVER_PID=$!

wait_for_http_ready "$BASE_URL" "$LOG_FILE" "$SERVER_PID" "no-compat runtime"

GET_RESPONSE="$(curl -fsS "$BASE_URL/")"
POST_RESPONSE="$(curl -fsS -X POST "$BASE_URL/echo" --data 'hardess-workerd')"
INVALID_METHOD_RESPONSE="$(curl -sS -X GET "$BASE_URL/echo")"
WS_RESPONSE="$(cd "$ROOT_DIR" && rtk bun run ./ws-smoke.ts --url "$WS_URL")"

test -f "$GENERATED_CONFIG"
grep -q 'HARDESS_RESOLVED_RUNTIME_MODEL' "$GENERATED_CONFIG"
if grep -q 'HARDESS_ROUTE_TABLE' "$GENERATED_CONFIG"; then
  echo 'unexpected HARDESS_ROUTE_TABLE in no-compat runtime config' >&2
  exit 1
fi
if grep -q 'HARDESS_PROTOCOL_PACKAGE' "$GENERATED_CONFIG"; then
  echo 'unexpected HARDESS_PROTOCOL_PACKAGE in no-compat runtime config' >&2
  exit 1
fi

echo "$GET_RESPONSE" | grep -q '"dispatchSource": "resolved_runtime_model"'
echo "$GET_RESPONSE" | grep -q '"protocolPackageId": "workerd-http-ingress@v1"'
echo "$GET_RESPONSE" | grep -q '"resolvedCompatibilityBindings": \[\]'
echo "$GET_RESPONSE" | grep -q '"resolvedPrimaryRuntimeBinding": "HARDESS_RESOLVED_RUNTIME_MODEL"'
echo "$GET_RESPONSE" | grep -q '"resolvedMetadataBindings": \['
echo "$GET_RESPONSE" | grep -q '"resolvedRouteCount": 3'
echo "$GET_RESPONSE" | grep -q '"resolvedProtocolActionCount": 3'
if echo "$GET_RESPONSE" | grep -q '"HARDESS_ROUTE_TABLE"'; then
  echo 'unexpected HARDESS_ROUTE_TABLE marker in no-compat runtime response' >&2
  exit 1
fi
if echo "$GET_RESPONSE" | grep -q '"HARDESS_PROTOCOL_PACKAGE"'; then
  echo 'unexpected HARDESS_PROTOCOL_PACKAGE marker in no-compat runtime response' >&2
  exit 1
fi
echo "$POST_RESPONSE" | grep -q '"echo": "hardess-workerd"'
echo "$POST_RESPONSE" | grep -q '"dispatchSource": "resolved_runtime_model"'
echo "$INVALID_METHOD_RESPONSE" | grep -q '"error": "method_not_allowed"'
echo "$INVALID_METHOD_RESPONSE" | grep -q '"allowedMethods": \['
echo "$WS_RESPONSE" | grep -q '"type":"echo"'
echo "$WS_RESPONSE" | grep -q '"routeId":"route.demo.workerd.ws"'
echo "$WS_RESPONSE" | grep -q '"actionId":"ws.echo"'
echo "$WS_RESPONSE" | grep -q '"echo":"hardess-workerd-ws"'

printf '%s\n' 'GET / response without compatibility bindings:'
printf '%s\n' "$GET_RESPONSE"
printf '\n%s\n' 'POST /echo response without compatibility bindings:'
printf '%s\n' "$POST_RESPONSE"
printf '\n%s\n' 'GET /echo invalid method response without compatibility bindings:'
printf '%s\n' "$INVALID_METHOD_RESPONSE"
printf '\n%s\n' 'GET /ws websocket response without compatibility bindings:'
printf '%s\n' "$WS_RESPONSE"
printf '\n%s\n' 'No-compat runtime verification passed.'
