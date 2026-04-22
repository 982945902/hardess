#!/usr/bin/env zsh

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")" && pwd)"
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

  local port
  local listen_address
  local resolved_model
  local runtime_summary
  local generated_config

  port="$(pick_port)"
  listen_address="127.0.0.1:${port}"
  generated_config="$(mktemp -t workerd-binding-matrix-config.XXXXXX)"

  resolved_model="$(
    cd "$ROOT_DIR" &&
      rtk bun run ./print-resolved-model.ts \
        --runtime-adapter "$adapter_path" \
        --listen-address "$listen_address"
  )"

  runtime_summary="$(
    cd "$ROOT_DIR" &&
      rtk bun run ./print-runtime-summary.ts \
        --runtime-adapter "$adapter_path" \
        --listen-address "$listen_address"
  )"

  (
    cd "$ROOT_DIR"
    rtk bun run ./generate-config.ts \
      --runtime-adapter "$adapter_path" \
      --listen-address "$listen_address" \
      --output "$generated_config" >/dev/null
  )

  assert_json_field "$resolved_model" --path runtime.listenAddress --equals "$listen_address"
  assert_json_field "$runtime_summary" --path runtime.listenAddress --equals "$listen_address"
  if [[ "$expect_route_table" == "true" ]]; then
    assert_json_field "$runtime_summary" --path compatibilityBindings --includes "HARDESS_ROUTE_TABLE"
    assert_json_field "$resolved_model" --path bindingContract.compatibilityBindings --includes "HARDESS_ROUTE_TABLE"
  else
    assert_json_field "$runtime_summary" --path compatibilityBindings --not-includes "HARDESS_ROUTE_TABLE"
    assert_json_field "$resolved_model" --path bindingContract.compatibilityBindings --not-includes "HARDESS_ROUTE_TABLE"
  fi

  if [[ "$expect_protocol_package" == "true" ]]; then
    assert_json_field "$runtime_summary" --path compatibilityBindings --includes "HARDESS_PROTOCOL_PACKAGE"
    assert_json_field "$resolved_model" --path bindingContract.compatibilityBindings --includes "HARDESS_PROTOCOL_PACKAGE"
  else
    assert_json_field "$runtime_summary" --path compatibilityBindings --not-includes "HARDESS_PROTOCOL_PACKAGE"
    assert_json_field "$resolved_model" --path bindingContract.compatibilityBindings --not-includes "HARDESS_PROTOCOL_PACKAGE"
  fi

  grep -q "address = \"$listen_address\"" "$generated_config"
  grep -q 'HARDESS_RESOLVED_RUNTIME_MODEL' "$generated_config"

  if [[ "$expect_route_table" == "true" ]]; then
    grep -q 'HARDESS_ROUTE_TABLE' "$generated_config"
  else
    if grep -q 'HARDESS_ROUTE_TABLE' "$generated_config"; then
      echo "unexpected HARDESS_ROUTE_TABLE for matrix case: $label" >&2
      cat "$generated_config" >&2
      rm -f "$generated_config"
      exit 1
    fi
  fi

  if [[ "$expect_protocol_package" == "true" ]]; then
    grep -q 'HARDESS_PROTOCOL_PACKAGE' "$generated_config"
  else
    if grep -q 'HARDESS_PROTOCOL_PACKAGE' "$generated_config"; then
      echo "unexpected HARDESS_PROTOCOL_PACKAGE for matrix case: $label" >&2
      cat "$generated_config" >&2
      rm -f "$generated_config"
      exit 1
    fi
  fi

  printf '%s\n' "Binding matrix case passed: $label"
  printf '%s\n' "$runtime_summary"
  printf '\n'

  rm -f "$generated_config"
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

printf '%s\n' 'Binding compatibility matrix verification passed.'
