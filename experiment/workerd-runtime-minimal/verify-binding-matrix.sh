#!/usr/bin/env zsh

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$ROOT_DIR/verify-lib.sh"

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

  grep -q "\"listenAddress\": \"$listen_address\"" <<<"$resolved_model"
  grep -q "\"listenAddress\": \"$listen_address\"" <<<"$runtime_summary"
  if [[ "$expect_route_table" == "true" ]]; then
    grep -q 'HARDESS_ROUTE_TABLE' <<<"$runtime_summary"
    grep -q 'HARDESS_ROUTE_TABLE' <<<"$resolved_model"
  else
    if grep -q 'HARDESS_ROUTE_TABLE' <<<"$runtime_summary"; then
      echo "unexpected HARDESS_ROUTE_TABLE in runtime summary for matrix case: $label" >&2
      printf '%s\n' "$runtime_summary" >&2
      rm -f "$generated_config"
      exit 1
    fi
    if grep -q 'HARDESS_ROUTE_TABLE' <<<"$resolved_model"; then
      echo "unexpected HARDESS_ROUTE_TABLE in resolved model for matrix case: $label" >&2
      printf '%s\n' "$resolved_model" >&2
      rm -f "$generated_config"
      exit 1
    fi
  fi

  if [[ "$expect_protocol_package" == "true" ]]; then
    grep -q 'HARDESS_PROTOCOL_PACKAGE' <<<"$runtime_summary"
    grep -q 'HARDESS_PROTOCOL_PACKAGE' <<<"$resolved_model"
  else
    if grep -q 'HARDESS_PROTOCOL_PACKAGE' <<<"$runtime_summary"; then
      echo "unexpected HARDESS_PROTOCOL_PACKAGE in runtime summary for matrix case: $label" >&2
      printf '%s\n' "$runtime_summary" >&2
      rm -f "$generated_config"
      exit 1
    fi
    if grep -q 'HARDESS_PROTOCOL_PACKAGE' <<<"$resolved_model"; then
      echo "unexpected HARDESS_PROTOCOL_PACKAGE in resolved model for matrix case: $label" >&2
      printf '%s\n' "$resolved_model" >&2
      rm -f "$generated_config"
      exit 1
    fi
  fi

  if [[ "$expect_route_table" == "false" && "$expect_protocol_package" == "false" ]]; then
    grep -q '"compatibilityBindings": \[\]' <<<"$runtime_summary"
    grep -q '"compatibilityBindings": \[\]' <<<"$resolved_model"
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
