#!/usr/bin/env zsh

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")" && pwd)"
RUN_SCRIPT="$ROOT_DIR/run.sh"
source "$ROOT_DIR/verify-lib.sh"

assert_json_field() {
  local payload="$1"
  shift
  printf '%s\n' "$payload" | rtk bun run "$ROOT_DIR/assert-json-field.ts" "$@"
}

run_case() {
  local label="$1"
  local adapter_path="$2"
  local expect_route_table="$3"
  local expect_protocol_package="$4"

  (
    set -euo pipefail

    local port
    local listen_address
    local base_url
    local ws_url
    local log_file
    local generated_config
    local server_pid
    local get_response
    local post_response
    local invalid_method_response
    local ws_response

    port="$(pick_port)"
    listen_address="127.0.0.1:${port}"
    base_url="http://${listen_address}"
    ws_url="ws://${listen_address}/ws"
    log_file="$(mktemp -t workerd-binding-runtime-matrix-log.XXXXXX)"
    generated_config="$(mktemp -t workerd-binding-runtime-matrix-config.XXXXXX)"

    cleanup() {
      cleanup_server "${server_pid:-}"
      rm -f "$log_file" "$generated_config"
    }
    trap cleanup EXIT

    GENERATED_CONFIG="$generated_config" "$RUN_SCRIPT" \
      --runtime-adapter "$adapter_path" \
      --listen-address "$listen_address" >"$log_file" 2>&1 &
    server_pid=$!

    wait_for_http_ready "$base_url" "$log_file" "$server_pid" "$label runtime"

    get_response="$(curl -fsS "$base_url/")"
    post_response="$(curl -fsS -X POST "$base_url/echo" --data 'hardess-workerd')"
    invalid_method_response="$(curl -sS -X GET "$base_url/echo")"
    ws_response="$(cd "$ROOT_DIR" && rtk bun run ./ws-smoke.ts --url "$ws_url")"

    test -f "$generated_config"
    grep -q 'HARDESS_RESOLVED_RUNTIME_MODEL' "$generated_config"
    grep -q "address = \"$listen_address\"" "$generated_config"

    assert_json_field "$get_response" --path dispatchSource --equals "resolved_runtime_model"
    assert_json_field "$get_response" --path protocolPackageId --equals "workerd-http-ingress@v1"
    assert_json_field "$get_response" --path resolvedListenAddress --equals "$listen_address"
    assert_json_field "$get_response" --path resolvedPrimaryRuntimeBinding --equals "HARDESS_RESOLVED_RUNTIME_MODEL"
    assert_json_field "$get_response" --path resolvedMetadataBindings --includes "HARDESS_ASSIGNMENT_META"
    assert_json_field "$get_response" --path resolvedMetadataBindings --includes "HARDESS_CONFIG"

    assert_json_field "$post_response" --path echo --equals "hardess-workerd"
    assert_json_field "$post_response" --path dispatchSource --equals "resolved_runtime_model"
    assert_json_field "$invalid_method_response" --path error --equals "method_not_allowed"
    assert_json_field "$invalid_method_response" --path allowedMethods --includes "POST"
    assert_json_field "$ws_response" --path type --equals "echo"
    assert_json_field "$ws_response" --path routeId --equals "route.demo.workerd.ws"
    assert_json_field "$ws_response" --path actionId --equals "ws.echo"
    assert_json_field "$ws_response" --path echo --equals "hardess-workerd-ws"

    if [[ "$expect_route_table" == "true" ]]; then
      grep -q 'HARDESS_ROUTE_TABLE' "$generated_config"
      assert_json_field "$get_response" --path resolvedCompatibilityBindings --includes "HARDESS_ROUTE_TABLE"
    else
      if grep -q 'HARDESS_ROUTE_TABLE' "$generated_config"; then
        echo "unexpected HARDESS_ROUTE_TABLE in generated config for runtime case: $label" >&2
        cat "$generated_config" >&2
        exit 1
      fi
      assert_json_field "$get_response" --path resolvedCompatibilityBindings --not-includes "HARDESS_ROUTE_TABLE"
    fi

    if [[ "$expect_protocol_package" == "true" ]]; then
      grep -q 'HARDESS_PROTOCOL_PACKAGE' "$generated_config"
      assert_json_field "$get_response" --path resolvedCompatibilityBindings --includes "HARDESS_PROTOCOL_PACKAGE"
    else
      if grep -q 'HARDESS_PROTOCOL_PACKAGE' "$generated_config"; then
        echo "unexpected HARDESS_PROTOCOL_PACKAGE in generated config for runtime case: $label" >&2
        cat "$generated_config" >&2
        exit 1
      fi
      assert_json_field "$get_response" --path resolvedCompatibilityBindings --not-includes "HARDESS_PROTOCOL_PACKAGE"
    fi

    printf '%s\n' "Binding runtime matrix case passed: $label"
    printf '%s\n' "$get_response"
    printf '\n'
  )
}

run_case \
  "default/all-bindings" \
  "./runtime-adapter.json" \
  "true" \
  "true"

run_case \
  "route-table-only" \
  "./runtime-adapter-route-table-only.json" \
  "true" \
  "false"

run_case \
  "protocol-package-only" \
  "./runtime-adapter-protocol-package-only.json" \
  "false" \
  "true"

run_case \
  "no-compat-bindings" \
  "./runtime-adapter-no-compatibility-bindings.json" \
  "false" \
  "false"

printf '%s\n' 'Binding runtime matrix verification passed.'
