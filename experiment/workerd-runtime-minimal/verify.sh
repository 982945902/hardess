#!/usr/bin/env zsh

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")" && pwd)"
RUN_SCRIPT="$ROOT_DIR/run.sh"
BASE_URL="http://127.0.0.1:6285"
LOG_FILE="$(mktemp -t workerd-minimal-log.XXXXXX)"
GENERATED_CONFIG="$ROOT_DIR/.generated.config.capnp"

cleanup() {
  if [[ -n "${SERVER_PID:-}" ]]; then
    kill "$SERVER_PID" >/dev/null 2>&1 || true
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
WS_RESPONSE="$(cd "$ROOT_DIR" && bun run ./ws-smoke.ts)"

test -f "$GENERATED_CONFIG"
grep -q 'address = "127.0.0.1:6285"' "$GENERATED_CONFIG"
grep -q 'text = "hardess-workerd-secret"' "$GENERATED_CONFIG"
echo "$GET_RESPONSE" | grep -q '"runtime": "workerd"'
echo "$GET_RESPONSE" | grep -q '"secret": "hardess-workerd-secret"'
echo "$POST_RESPONSE" | grep -q '"echo": "hardess-workerd"'
echo "$POST_RESPONSE" | grep -q '"length": 15'
echo "$WS_RESPONSE" | grep -q '"type":"echo"'
echo "$WS_RESPONSE" | grep -q '"runtime":"workerd"'
echo "$WS_RESPONSE" | grep -q '"echo":"hardess-workerd-ws"'

printf '%s\n' 'GET / response:'
printf '%s\n' "$GET_RESPONSE"
printf '\n%s\n' 'POST /echo response:'
printf '%s\n' "$POST_RESPONSE"
printf '\n%s\n' 'GET /ws websocket response:'
printf '%s\n' "$WS_RESPONSE"
printf '\n%s\n' 'Verification passed.'
