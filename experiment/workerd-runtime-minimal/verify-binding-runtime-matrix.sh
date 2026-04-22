#!/usr/bin/env zsh

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")" && pwd)"
RUN_SCRIPT="$ROOT_DIR/run.sh"
cd "$ROOT_DIR"
source "$ROOT_DIR/verify-lib.sh"

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
    local runtime_response
    local runtime_stats_response
    local runtime_routes_response
    local runtime_invalid_method_status
    local runtime_invalid_method_response
    local runtime_not_found_status
    local runtime_not_found_response
    local runtime_invalid_method_body
    local runtime_not_found_body

    port="$(pick_port)"
    listen_address="127.0.0.1:${port}"
    base_url="http://${listen_address}"
    ws_url="ws://${listen_address}/ws"
    log_file="$(mktemp -t workerd-binding-runtime-matrix-log.XXXXXX)"
    generated_config="$(mktemp -t workerd-binding-runtime-matrix-config.XXXXXX)"
    runtime_invalid_method_body="$(mktemp -t workerd-binding-runtime-invalid-method.XXXXXX)"
    runtime_not_found_body="$(mktemp -t workerd-binding-runtime-not-found.XXXXXX)"

    cleanup() {
      cleanup_server "${server_pid:-}"
      rm -f "$log_file" "$generated_config"
      rm -f "$runtime_invalid_method_body"
      rm -f "$runtime_not_found_body"
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
    runtime_response="$(curl -fsS "$base_url/_hardess/runtime")"
    runtime_stats_response="$(curl -fsS "$base_url/_hardess/runtime/stats")"
    runtime_routes_response="$(curl -fsS "$base_url/_hardess/runtime/routes")"
    runtime_invalid_method_status="$(curl -sS -o "$runtime_invalid_method_body" -w '%{http_code}' -X POST "$base_url/_hardess/runtime")"
    runtime_invalid_method_response="$(cat "$runtime_invalid_method_body")"
    runtime_not_found_status="$(curl -sS -o "$runtime_not_found_body" -w '%{http_code}' "$base_url/_hardess/runtime/unknown")"
    runtime_not_found_response="$(cat "$runtime_not_found_body")"

    test -f "$generated_config"
    grep -q 'HARDESS_RESOLVED_RUNTIME_MODEL' "$generated_config"
    grep -q "address = \"$listen_address\"" "$generated_config"

    assert_json_field "$get_response" --path dispatchSource --equals "resolved_runtime_model"
    assert_json_field "$get_response" --path protocolPackageId --equals "workerd-http-ingress@v1"
    assert_json_field "$get_response" --path resolvedListenAddress --equals "$listen_address"
    assert_json_field "$get_response" --path resolvedPrimaryRuntimeBinding --equals "HARDESS_RESOLVED_RUNTIME_MODEL"
    assert_json_field "$get_response" --path resolvedMetadataBindings --includes "HARDESS_ASSIGNMENT_META"
    assert_json_field "$get_response" --path resolvedMetadataBindings --includes "HARDESS_CONFIG"
    assert_json_field "$get_response" --path workerRuntime.runtimeName --equals "hardess.workerd.worker-runtime.v1"
    assert_json_field "$get_response" --path workerRuntime.requestSequence --equals-json "2"
    assert_json_field "$get_response" --path workerRuntime.totalRequests --equals-json "2"

    assert_json_field "$post_response" --path echo --equals "hardess-workerd"
    assert_json_field "$post_response" --path dispatchSource --equals "resolved_runtime_model"
    assert_json_field "$post_response" --path workerRuntime.runtimeName --equals "hardess.workerd.worker-runtime.v1"
    assert_json_field "$post_response" --path workerRuntime.requestSequence --equals-json "3"
    assert_json_field "$post_response" --path workerRuntime.totalRequests --equals-json "3"
    assert_json_field "$invalid_method_response" --path error --equals "method_not_allowed"
    assert_json_field "$invalid_method_response" --path allowedMethods --includes "POST"
    assert_json_field "$invalid_method_response" --path workerRuntime.requestSequence --equals-json "4"
    assert_json_field "$invalid_method_response" --path workerRuntime.routeHitCount --equals-json "2"
    assert_json_field "$ws_response" --path type --equals "echo"
    assert_json_field "$ws_response" --path routeId --equals "route.demo.workerd.ws"
    assert_json_field "$ws_response" --path actionId --equals "ws.echo"
    assert_json_field "$ws_response" --path echo --equals "hardess-workerd-ws"
    assert_json_field "$ws_response" --path workerRuntime.requestSequence --equals-json "5"
    assert_json_field "$ws_response" --path workerRuntime.websocketSessionCount --equals-json "1"
    assert_json_field "$runtime_response" --path endpoint --equals "/_hardess/runtime"
    assert_json_field "$runtime_response" --path schemaVersion --equals "hardess.workerd.worker-runtime-admin.v1"
    assert_json_field "$runtime_response" --path dispatchSource --equals "worker_runtime_admin"
    assert_json_field "$runtime_response" --path registeredActionIds --includes "http.info"
    assert_json_field "$runtime_response" --path registeredActionIds --includes "http.echo"
    assert_json_field "$runtime_response" --path workerRuntime.requestSequence --equals-json "6"
    assert_json_field "$runtime_response" --path workerRuntime.totalRequests --equals-json "6"
    assert_json_field "$runtime_stats_response" --path view --equals "stats"
    assert_json_field "$runtime_stats_response" --path schemaVersion --equals "hardess.workerd.worker-runtime-admin.v1"
    assert_json_field "$runtime_stats_response" --path workerRuntime.requestSequence --equals-json "7"
    assert_json_field "$runtime_routes_response" --path view --equals "routes"
    assert_json_field "$runtime_routes_response" --path schemaVersion --equals "hardess.workerd.worker-runtime-admin.v1"
    assert_json_field "$runtime_routes_response" --path routeCount --equals-json "3"
    assert_json_field "$runtime_routes_response" --path workerRuntime.requestSequence --equals-json "8"
    test "$runtime_invalid_method_status" = "405"
    assert_json_field "$runtime_invalid_method_response" --path error --equals "method_not_allowed"
    assert_json_field "$runtime_invalid_method_response" --path schemaVersion --equals "hardess.workerd.worker-runtime-admin.v1"
    assert_json_field "$runtime_invalid_method_response" --path endpoint --equals "/_hardess/runtime"
    assert_json_field "$runtime_invalid_method_response" --path workerRuntime.requestSequence --equals-json "9"
    test "$runtime_not_found_status" = "404"
    assert_json_field "$runtime_not_found_response" --path error --equals "runtime_admin_endpoint_not_found"
    assert_json_field "$runtime_not_found_response" --path schemaVersion --equals "hardess.workerd.worker-runtime-admin.v1"
    assert_json_field "$runtime_not_found_response" --path endpoint --equals "/_hardess/runtime/unknown"
    assert_json_field "$runtime_not_found_response" --path workerRuntime.requestSequence --equals-json "10"

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
