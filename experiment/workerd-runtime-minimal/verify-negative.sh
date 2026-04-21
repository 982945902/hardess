#!/usr/bin/env zsh

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")" && pwd)"
BAD_FIXTURES_DIR="$ROOT_DIR/bad-fixtures"

run_expect_failure() {
  local label="$1"
  local expected_message="$2"
  shift 2

  local log_file
  local output_file
  log_file="$(mktemp -t workerd-minimal-negative-log.XXXXXX)"
  output_file="$(mktemp -t workerd-minimal-negative-config.XXXXXX)"

  set +e
  (
    cd "$ROOT_DIR"
    rtk bun run "$ROOT_DIR/generate-config.ts" --output "$output_file" "$@"
  ) >"$log_file" 2>&1
  local exit_code=$?
  set -e

  if [[ "$exit_code" -eq 0 ]]; then
    echo "expected generator failure for case: $label" >&2
    cat "$log_file" >&2
    rm -f "$log_file" "$output_file"
    exit 1
  fi

  grep -q "$expected_message" "$log_file"
  if [[ -s "$output_file" ]]; then
    echo "unexpected generated config for case: $label" >&2
    cat "$output_file" >&2
    rm -f "$log_file" "$output_file"
    exit 1
  fi

  printf '%s\n' "Negative case passed: $label"
  cat "$log_file"
  printf '\n'

  rm -f "$log_file" "$output_file"
}

run_expect_failure \
  "duplicate assignment routeRef" \
  "duplicate assignment routeRef: route.demo.workerd.echo" \
  --assignment "$BAD_FIXTURES_DIR/assignment-duplicate-route-ref.json"

run_expect_failure \
  "duplicate runtime compatibility flag" \
  "duplicate runtime-adapter compatibilityFlag: typescript_strip_types" \
  --runtime-adapter "$BAD_FIXTURES_DIR/runtime-adapter-duplicate-compat-flag.json"

run_expect_failure \
  "invalid runtime port" \
  "runtime-adapter port must be between 1 and 65535: 127.0.0.1:70000" \
  --runtime-adapter "$BAD_FIXTURES_DIR/runtime-adapter-invalid-port.json"

run_expect_failure \
  "missing routeRef" \
  "routeRef not found in planning fragment: route.demo.workerd.missing" \
  --assignment "$BAD_FIXTURES_DIR/assignment-missing-route.json"

run_expect_failure \
  "missing actionId" \
  "actionId not found in protocol package: ws.echo" \
  --protocol-package "$BAD_FIXTURES_DIR/protocol-package-missing-action.json"

run_expect_failure \
  "duplicate planning routeId" \
  "duplicate planning routeId: route.demo.workerd.echo" \
  --planning-fragment "$BAD_FIXTURES_DIR/planning-fragment-duplicate-route.json"

run_expect_failure \
  "trailing slash pathPrefix" \
  "planning pathPrefix must not end with /: route.demo.workerd.echo" \
  --planning-fragment "$BAD_FIXTURES_DIR/planning-fragment-trailing-slash.json"

run_expect_failure \
  "double slash pathPrefix" \
  "planning pathPrefix must not contain //: route.demo.workerd.echo" \
  --planning-fragment "$BAD_FIXTURES_DIR/planning-fragment-double-slash.json"

run_expect_failure \
  "duplicate planning pathPrefix" \
  "duplicate planning pathPrefix: /echo" \
  --planning-fragment "$BAD_FIXTURES_DIR/planning-fragment-duplicate-path-prefix.json"

run_expect_failure \
  "invalid websocket action flag" \
  "websocket action must declare websocket=true: ws.echo" \
  --protocol-package "$BAD_FIXTURES_DIR/protocol-package-invalid-websocket-action.json"

run_expect_failure \
  "websocket non-get method" \
  "websocket action must use exactly GET method: ws.echo" \
  --protocol-package "$BAD_FIXTURES_DIR/protocol-package-websocket-non-get.json"

run_expect_failure \
  "duplicate action method" \
  "duplicate protocol-package methods for action http.echo: POST" \
  --protocol-package "$BAD_FIXTURES_DIR/protocol-package-duplicate-method.json"

run_expect_failure \
  "lowercase action method" \
  "protocol-package method must be uppercase token: http.info:get" \
  --protocol-package "$BAD_FIXTURES_DIR/protocol-package-lowercase-method.json"

run_expect_failure \
  "http action with websocket flag" \
  "http action cannot declare websocket=true: http.info" \
  --protocol-package "$BAD_FIXTURES_DIR/protocol-package-http-action-with-websocket.json"

run_expect_failure \
  "websocket route without upstream websocket" \
  "websocket route must enable upstream websocket: route.demo.workerd.ws" \
  --planning-fragment "$BAD_FIXTURES_DIR/planning-fragment-websocket-disabled.json"

run_expect_failure \
  "http route with websocket upstream" \
  "http route must use http/https upstream: route.demo.workerd.root" \
  --planning-fragment "$BAD_FIXTURES_DIR/planning-fragment-http-route-with-ws-upstream.json"

run_expect_failure \
  "websocket route with http upstream" \
  "websocket route must use ws/wss upstream: route.demo.workerd.ws" \
  --planning-fragment "$BAD_FIXTURES_DIR/planning-fragment-ws-route-with-http-upstream.json"

printf '%s\n' 'Negative verification passed.'
