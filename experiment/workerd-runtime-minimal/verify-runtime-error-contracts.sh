#!/usr/bin/env zsh

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")" && pwd)"
RUN_SCRIPT="$ROOT_DIR/run.sh"
cd "$ROOT_DIR"
source "$ROOT_DIR/verify-lib.sh"

run_case() {
  local label="$1"
  local expected_path="$2"
  local expected_status="$3"
  local expected_error="$4"
  local expected_route_id="$5"
  local expected_action_id="$6"
  shift 6

  (
    set -euo pipefail

    local log_file
    local generated_config
    local response_body
    local server_pid
    local listen_address
    local base_url
    local response_status
    local response
    local runtime_response

    log_file="$(mktemp -t workerd-runtime-error-log.XXXXXX)"
    generated_config="$(mktemp -t workerd-runtime-error-config.XXXXXX)"
    response_body="$(mktemp -t workerd-runtime-error-body.XXXXXX)"

    cleanup() {
      cleanup_server "${server_pid:-}"
      rm -f "$log_file" "$generated_config" "$response_body"
    }
    trap cleanup EXIT

    start_server_with_retry "$label" "$log_file" env GENERATED_CONFIG="$generated_config" "$RUN_SCRIPT" "$@"
    server_pid="$START_SERVER_PID"
    listen_address="$START_SERVER_LISTEN_ADDRESS"
    base_url="$START_SERVER_BASE_URL"

    response_status="$(curl -sS -o "$response_body" -w '%{http_code}' "$base_url$expected_path")"
    response="$(cat "$response_body")"
    runtime_response="$(curl -fsS "$base_url/_hardess/runtime")"

    test "$response_status" = "$expected_status"
    test -f "$generated_config"
    grep -q "address = \"$listen_address\"" "$generated_config"

    assert_json_field "$response" --path ok --equals-json "false"
    assert_json_field "$response" --path schemaVersion --equals "hardess.workerd.worker-error.v1"
    assert_json_field "$response" --path dispatchSource --equals "worker_runtime"
    assert_json_field "$response" --path runtime --equals "workerd"
    assert_json_field "$response" --path path --equals "$expected_path"
    assert_json_field "$response" --path error --equals "$expected_error"
    assert_json_field "$response" --path workerRuntime.runtimeName --equals "hardess.workerd.worker-runtime.v1"
    assert_json_field "$response" --path workerRuntime.requestSequence --equals-json "2"
    assert_json_field "$response" --path workerRuntime.totalRequests --equals-json "2"

    if [[ -n "$expected_route_id" ]]; then
      assert_json_field "$response" --path routeId --equals "$expected_route_id"
    fi

    if [[ -n "$expected_action_id" ]]; then
      assert_json_field "$response" --path actionId --equals "$expected_action_id"
    fi

    if [[ "$expected_error" == "no_route" ]]; then
      assert_json_field "$response" --path method --equals "GET"
      assert_json_field "$response" --path workerRuntime.routeHitCount --equals-json "0"
      assert_json_field "$response" --path workerRuntime.routeHits --equals-json "[]"
      assert_json_field "$runtime_response" --path unhandledActionIds --equals-json "[]"
      assert_json_field "$runtime_response" --path unhandledRouteIds --equals-json "[]"
    fi

    if [[ "$expected_error" == "unhandled_action" ]]; then
      assert_json_field "$response" --path workerRuntime.routeHitCount --equals-json "1"
      assert_json_field "$response" --path workerRuntime.routeHits.0.routeId --equals "$expected_route_id"
      assert_json_field "$response" --path workerRuntime.routeHits.0.count --equals-json "1"
      assert_json_field "$runtime_response" --path registeredActionIds --not-includes "$expected_action_id"
      assert_json_field "$runtime_response" --path dispatchableActionIds --equals-json "[]"
      assert_json_field "$runtime_response" --path unhandledActionIds --includes "$expected_action_id"
      assert_json_field "$runtime_response" --path unhandledRouteIds --includes "$expected_route_id"
    fi

    printf '%s\n' "Runtime error case passed: $label"
    printf '%s\n' "$response"
    printf '\n'
  )
}

run_case \
  "runtime error no_route" \
  "/missing" \
  "404" \
  "no_route" \
  "" \
  "" \
  --assignment ./runtime-error-fixtures/assignment-no-root.json

run_case \
  "runtime error unhandled_action" \
  "/unhandled" \
  "500" \
  "unhandled_action" \
  "route.demo.workerd.unhandled" \
  "http.unhandled" \
  --assignment ./runtime-error-fixtures/assignment-unhandled-action.json \
  --planning-fragment ./runtime-error-fixtures/planning-fragment-unhandled-action.json \
  --protocol-package ./runtime-error-fixtures/protocol-package-unhandled-action.json

printf '%s\n' 'Runtime error contract verification passed.'
