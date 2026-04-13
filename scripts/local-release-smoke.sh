#!/usr/bin/env bash

set -euo pipefail

HTTP_BASE_URL="${HTTP_BASE_URL:-http://127.0.0.1:3000}"
WS_URL="${WS_URL:-ws://127.0.0.1:3000/ws}"
RUNS="${RUNS:-5}"
HTTP_CONCURRENCY="${HTTP_CONCURRENCY:-4}"
HTTP_REQUESTS="${HTTP_REQUESTS:-50}"
WS_SENDERS="${WS_SENDERS:-2}"
WS_RECEIVERS="${WS_RECEIVERS:-2}"
WS_MESSAGES_PER_SENDER="${WS_MESSAGES_PER_SENDER:-20}"
WS_SEND_INTERVAL_MS="${WS_SEND_INTERVAL_MS:-20}"
WS_COMPLETION_TIMEOUT_MS="${WS_COMPLETION_TIMEOUT_MS:-15000}"
ENABLE_RELEASE_GATE="${ENABLE_RELEASE_GATE:-0}"
DURATION_MINUTES="${DURATION_MINUTES:-0}"
PAUSE_BETWEEN_RUNS_SECONDS="${PAUSE_BETWEEN_RUNS_SECONDS:-0}"
AUTO_START_RUNTIME="${AUTO_START_RUNTIME:-1}"
AUTO_START_UPSTREAM="${AUTO_START_UPSTREAM:-1}"
RUNTIME_CMD="${RUNTIME_CMD:-bun run src/runtime/server.ts}"
UPSTREAM_CMD="${UPSTREAM_CMD:-bun run src/demo/upstream.ts}"
UPSTREAM_BASE_URL="${UPSTREAM_BASE_URL:-http://127.0.0.1:9000}"

runtime_pid=""
upstream_pid=""

cleanup() {
  if [[ -n "$runtime_pid" ]]; then
    kill "$runtime_pid" >/dev/null 2>&1 || true
    wait "$runtime_pid" >/dev/null 2>&1 || true
  fi

  if [[ -n "$upstream_pid" ]]; then
    kill "$upstream_pid" >/dev/null 2>&1 || true
    wait "$upstream_pid" >/dev/null 2>&1 || true
  fi
}

trap cleanup EXIT

wait_for_url() {
  local url="$1"
  local timeout_seconds="${2:-10}"
  local started_at
  started_at="$(date +%s)"

  while true; do
    if curl -fsS "$url" >/dev/null 2>&1; then
      return 0
    fi

    if (( "$(date +%s)" - started_at >= timeout_seconds )); then
      return 1
    fi

    sleep 0.2
  done
}

start_if_needed() {
  local name="$1"
  local url="$2"
  local auto_start="$3"
  local command="$4"
  local pid_var_name="$5"

  if curl -fsS "$url" >/dev/null 2>&1; then
    echo "[smoke] ${name} already running"
    return 0
  fi

  if [[ "$auto_start" != "1" ]]; then
    echo "[smoke] ${name} not reachable at ${url}" >&2
    exit 1
  fi

  echo "[smoke] starting ${name}"
  bash -lc "$command" >/tmp/hardess-${name}.log 2>&1 &
  local pid=$!
  printf -v "$pid_var_name" '%s' "$pid"

  if ! wait_for_url "$url" 15; then
    echo "[smoke] failed to start ${name}, log follows:" >&2
    cat "/tmp/hardess-${name}.log" >&2 || true
    exit 1
  fi
}

print_json() {
  local url="$1"
  local body
  body="$(curl -fsS "$url")"
  if command -v jq >/dev/null 2>&1; then
    printf '%s\n' "$body" | jq
  else
    printf '%s\n' "$body"
  fi
}

start_if_needed "upstream" "${UPSTREAM_BASE_URL}" "$AUTO_START_UPSTREAM" "$UPSTREAM_CMD" upstream_pid
start_if_needed "runtime" "${HTTP_BASE_URL}/__admin/ready" "$AUTO_START_RUNTIME" "$RUNTIME_CMD" runtime_pid

echo "[smoke] health"
print_json "${HTTP_BASE_URL}/__admin/health"

echo "[smoke] ready"
print_json "${HTTP_BASE_URL}/__admin/ready"

echo "[smoke] metrics"
print_json "${HTTP_BASE_URL}/__admin/metrics"

echo "[smoke] http"
HTTP_LOAD_BASE_URL="$HTTP_BASE_URL" \
HTTP_LOAD_ADMIN_BASE_URL="$HTTP_BASE_URL" \
HTTP_LOAD_CONCURRENCY="$HTTP_CONCURRENCY" \
HTTP_LOAD_REQUESTS="$HTTP_REQUESTS" \
bun run load:http

run_index=1
deadline_epoch=0
if [[ "$DURATION_MINUTES" != "0" ]]; then
  deadline_epoch=$(( $(date +%s) + DURATION_MINUTES * 60 ))
  echo "[smoke] duration mode enabled: ${DURATION_MINUTES} minutes"
fi

while true; do
  if [[ "$DURATION_MINUTES" == "0" ]]; then
    if (( run_index > RUNS )); then
      break
    fi
    run_label="${run_index}/${RUNS}"
  else
    if (( $(date +%s) >= deadline_epoch )); then
      break
    fi
    remaining_seconds=$(( deadline_epoch - $(date +%s) ))
    run_label="${run_index} remaining=${remaining_seconds}s"
  fi

  echo "[smoke] ws run ${run_label}"
  WS_LOAD_WS_URL="$WS_URL" \
  WS_LOAD_ADMIN_BASE_URL="$HTTP_BASE_URL" \
  WS_LOAD_SENDER_COUNT="$WS_SENDERS" \
  WS_LOAD_RECEIVER_COUNT="$WS_RECEIVERS" \
  WS_LOAD_MESSAGES_PER_SENDER="$WS_MESSAGES_PER_SENDER" \
  WS_LOAD_SEND_INTERVAL_MS="$WS_SEND_INTERVAL_MS" \
  WS_LOAD_COMPLETION_TIMEOUT_MS="$WS_COMPLETION_TIMEOUT_MS" \
  bun run load:ws

  run_index=$((run_index + 1))
  if [[ "$PAUSE_BETWEEN_RUNS_SECONDS" != "0" ]]; then
    sleep "$PAUSE_BETWEEN_RUNS_SECONDS"
  fi
done

if [[ "$ENABLE_RELEASE_GATE" == "1" ]]; then
  echo "[smoke] release gate local"
  bun run release:gate:local
fi

echo "[smoke] done"
