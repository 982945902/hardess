#!/usr/bin/env zsh

pick_port() {
  rtk bun -e 'import { createServer } from "node:net"; const server = createServer(); server.listen(0, "127.0.0.1", () => { const address = server.address(); if (!address || typeof address === "string") { console.error("failed to determine ephemeral port"); process.exit(1); } console.log(address.port); server.close(); });'
}

start_server_with_retry() {
  local label="$1"
  local log_file="$2"
  shift 2

  local attempt
  local port
  local server_pid

  for attempt in {1..8}; do
    port="$(pick_port)"
    START_SERVER_LISTEN_ADDRESS="127.0.0.1:${port}"
    START_SERVER_BASE_URL="http://${START_SERVER_LISTEN_ADDRESS}"
    START_SERVER_WS_URL="ws://${START_SERVER_LISTEN_ADDRESS}/ws"
    : >"$log_file"

    "$@" --listen-address "$START_SERVER_LISTEN_ADDRESS" >"$log_file" 2>&1 &
    server_pid=$!
    START_SERVER_PID="$server_pid"

    if wait_for_http_ready "$START_SERVER_BASE_URL" "$log_file" "$server_pid" "$label" 2>/dev/null; then
      return 0
    fi

    cleanup_server "$server_pid"

    if [[ "$attempt" -lt 8 ]]; then
      continue
    fi
  done

  echo "$label failed to acquire a listen port after 8 attempts" >&2
  cat "$log_file" >&2
  return 1
}

cleanup_server() {
  local server_pid="${1:-}"
  if [[ -z "$server_pid" ]]; then
    return 0
  fi

  kill "$server_pid" >/dev/null 2>&1 || true
  for _ in {1..20}; do
    if ! kill -0 "$server_pid" >/dev/null 2>&1; then
      break
    fi
    sleep 0.1
  done

  if kill -0 "$server_pid" >/dev/null 2>&1; then
    kill -9 "$server_pid" >/dev/null 2>&1 || true
  fi

  wait "$server_pid" >/dev/null 2>&1 || true
}

wait_for_http_ready() {
  local base_url="$1"
  local log_file="$2"
  local server_pid="$3"
  local label="${4:-server}"
  local status_code=""

  for _ in {1..60}; do
    status_code="$(curl -sS -o /dev/null -w '%{http_code}' "$base_url/" 2>/dev/null || true)"
    if [[ "$status_code" != "000" && -n "$status_code" ]]; then
      return 0
    fi

    if ! kill -0 "$server_pid" >/dev/null 2>&1; then
      echo "$label exited before becoming ready: $base_url" >&2
      cat "$log_file" >&2
      return 1
    fi

    sleep 0.2
  done

  echo "$label did not become ready in time: $base_url" >&2
  cat "$log_file" >&2
  return 1
}

assert_json_field() {
  local payload="$1"
  shift
  printf '%s\n' "$payload" | rtk bun run "$PWD/assert-json-field.ts" "$@"
}
