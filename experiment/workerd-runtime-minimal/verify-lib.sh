#!/usr/bin/env zsh

pick_port() {
  rtk bun -e 'import { createServer } from "node:net"; const server = createServer(); server.listen(0, "127.0.0.1", () => { const address = server.address(); if (!address || typeof address === "string") { console.error("failed to determine ephemeral port"); process.exit(1); } console.log(address.port); server.close(); });'
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

  for _ in {1..50}; do
    if curl -fsS "$base_url/" >/dev/null 2>&1; then
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
