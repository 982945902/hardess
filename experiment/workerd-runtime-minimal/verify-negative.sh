#!/usr/bin/env zsh

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")" && pwd)"
BAD_FIXTURES_DIR="$ROOT_DIR/bad-fixtures"

run_expect_failure() {
  local command_name="$1"
  local label="$2"
  local expected_message="$3"
  shift 3

  local log_file
  local output_file
  log_file="$(mktemp -t workerd-minimal-negative-log.XXXXXX)"
  output_file="$(mktemp -t workerd-minimal-negative-config.XXXXXX)"

  set +e
  (
    cd "$ROOT_DIR"
    if [[ "$command_name" == "generate-config" ]]; then
      rtk bun run "$ROOT_DIR/generate-config.ts" --output "$output_file" "$@"
    elif [[ "$command_name" == "print-runtime-summary" ]]; then
      rtk bun run "$ROOT_DIR/print-runtime-summary.ts" "$@"
    else
      rtk bun run "$ROOT_DIR/print-resolved-model.ts" "$@"
    fi
  ) >"$log_file" 2>&1
  local exit_code=$?
  set -e

  if [[ "$exit_code" -eq 0 ]]; then
    echo "expected failure for $command_name case: $label" >&2
    cat "$log_file" >&2
    rm -f "$log_file" "$output_file"
    exit 1
  fi

  grep -q "$expected_message" "$log_file"
  if [[ "$command_name" == "generate-config" && -s "$output_file" ]]; then
    echo "unexpected generated config for case: $label" >&2
    cat "$output_file" >&2
    rm -f "$log_file" "$output_file"
    exit 1
  fi

  printf '%s\n' "Negative case passed: $command_name / $label"
  cat "$log_file"
  printf '\n'

  rm -f "$log_file" "$output_file"
}

run_expect_failure \
  "generate-config" \
  "duplicate assignment routeRef" \
  "duplicate assignment routeRef: route.demo.workerd.echo" \
  --assignment "$BAD_FIXTURES_DIR/assignment-duplicate-route-ref.json"

run_expect_failure \
  "print-resolved-model" \
  "duplicate assignment routeRef" \
  "duplicate assignment routeRef: route.demo.workerd.echo" \
  --assignment "$BAD_FIXTURES_DIR/assignment-duplicate-route-ref.json"

run_expect_failure \
  "generate-config" \
  "assignment unrecognized field" \
  "unexpectedAssignmentField" \
  --assignment "$BAD_FIXTURES_DIR/assignment-unrecognized-field.json"

run_expect_failure \
  "print-resolved-model" \
  "assignment unrecognized field" \
  "unexpectedAssignmentField" \
  --assignment "$BAD_FIXTURES_DIR/assignment-unrecognized-field.json"

run_expect_failure \
  "generate-config" \
  "duplicate runtime compatibility flag" \
  "duplicate runtime-adapter compatibilityFlag: typescript_strip_types" \
  --runtime-adapter "$BAD_FIXTURES_DIR/runtime-adapter-duplicate-compat-flag.json"

run_expect_failure \
  "print-resolved-model" \
  "duplicate runtime compatibility flag" \
  "duplicate runtime-adapter compatibilityFlag: typescript_strip_types" \
  --runtime-adapter "$BAD_FIXTURES_DIR/runtime-adapter-duplicate-compat-flag.json"

run_expect_failure \
  "generate-config" \
  "runtime adapter unrecognized field" \
  "unexpectedBindingKey" \
  --runtime-adapter "$BAD_FIXTURES_DIR/runtime-adapter-unrecognized-field.json"

run_expect_failure \
  "print-resolved-model" \
  "runtime adapter unrecognized field" \
  "unexpectedBindingKey" \
  --runtime-adapter "$BAD_FIXTURES_DIR/runtime-adapter-unrecognized-field.json"

run_expect_failure \
  "generate-config" \
  "invalid runtime port" \
  "runtime-adapter port must be between 1 and 65535: 127.0.0.1:70000" \
  --runtime-adapter "$BAD_FIXTURES_DIR/runtime-adapter-invalid-port.json"

run_expect_failure \
  "print-resolved-model" \
  "invalid runtime port" \
  "runtime-adapter port must be between 1 and 65535: 127.0.0.1:70000" \
  --runtime-adapter "$BAD_FIXTURES_DIR/runtime-adapter-invalid-port.json"

run_expect_failure \
  "generate-config" \
  "missing runtime port" \
  "runtime-adapter listenAddress must be host:port: 127.0.0.1" \
  --runtime-adapter "$BAD_FIXTURES_DIR/runtime-adapter-missing-port.json"

run_expect_failure \
  "print-resolved-model" \
  "missing runtime port" \
  "runtime-adapter listenAddress must be host:port: 127.0.0.1" \
  --runtime-adapter "$BAD_FIXTURES_DIR/runtime-adapter-missing-port.json"

run_expect_failure \
  "generate-config" \
  "unbracketed ipv6 listenAddress" \
  "runtime-adapter IPv6 listenAddress must use brackets: ::1:6285" \
  --runtime-adapter "$BAD_FIXTURES_DIR/runtime-adapter-unbracketed-ipv6.json"

run_expect_failure \
  "print-resolved-model" \
  "unbracketed ipv6 listenAddress" \
  "runtime-adapter IPv6 listenAddress must use brackets: ::1:6285" \
  --runtime-adapter "$BAD_FIXTURES_DIR/runtime-adapter-unbracketed-ipv6.json"

run_expect_failure \
  "generate-config" \
  "invalid compatibilityDate format" \
  "runtime-adapter compatibilityDate must be YYYY-MM-DD: 2025/08/01" \
  --runtime-adapter "$BAD_FIXTURES_DIR/runtime-adapter-invalid-compatibility-date-format.json"

run_expect_failure \
  "print-resolved-model" \
  "invalid compatibilityDate format" \
  "runtime-adapter compatibilityDate must be YYYY-MM-DD: 2025/08/01" \
  --runtime-adapter "$BAD_FIXTURES_DIR/runtime-adapter-invalid-compatibility-date-format.json"

run_expect_failure \
  "generate-config" \
  "invalid compatibilityDate calendar value" \
  "runtime-adapter compatibilityDate must be real calendar date: 2025-02-30" \
  --runtime-adapter "$BAD_FIXTURES_DIR/runtime-adapter-invalid-compatibility-date-calendar.json"

run_expect_failure \
  "print-resolved-model" \
  "invalid compatibilityDate calendar value" \
  "runtime-adapter compatibilityDate must be real calendar date: 2025-02-30" \
  --runtime-adapter "$BAD_FIXTURES_DIR/runtime-adapter-invalid-compatibility-date-calendar.json"

run_expect_failure \
  "generate-config" \
  "invalid listen-address override" \
  "runtime-adapter port must be between 1 and 65535: 127.0.0.1:70000" \
  --listen-address "127.0.0.1:70000"

run_expect_failure \
  "print-resolved-model" \
  "invalid listen-address override" \
  "runtime-adapter port must be between 1 and 65535: 127.0.0.1:70000" \
  --listen-address "127.0.0.1:70000"

run_expect_failure \
  "generate-config" \
  "unknown cli option" \
  "unknown option: --listen-adress" \
  --listen-adress "127.0.0.1:6285"

run_expect_failure \
  "print-resolved-model" \
  "duplicate cli option" \
  "duplicate option: --listen-address" \
  --listen-address "127.0.0.1:6285" \
  --listen-address "127.0.0.1:6286"

run_expect_failure \
  "print-runtime-summary" \
  "unexpected positional cli argument" \
  "unexpected positional argument: extra-positional" \
  extra-positional

run_expect_failure \
  "generate-config" \
  "missing routeRef" \
  "routeRef not found in planning fragment: route.demo.workerd.missing" \
  --assignment "$BAD_FIXTURES_DIR/assignment-missing-route.json"

run_expect_failure \
  "print-resolved-model" \
  "missing routeRef" \
  "routeRef not found in planning fragment: route.demo.workerd.missing" \
  --assignment "$BAD_FIXTURES_DIR/assignment-missing-route.json"

run_expect_failure \
  "generate-config" \
  "missing actionId" \
  "actionId not found in protocol package: ws.echo" \
  --protocol-package "$BAD_FIXTURES_DIR/protocol-package-missing-action.json"

run_expect_failure \
  "print-resolved-model" \
  "missing actionId" \
  "actionId not found in protocol package: ws.echo" \
  --protocol-package "$BAD_FIXTURES_DIR/protocol-package-missing-action.json"

run_expect_failure \
  "generate-config" \
  "protocol package unrecognized field" \
  "unexpectedActionField" \
  --protocol-package "$BAD_FIXTURES_DIR/protocol-package-unrecognized-field.json"

run_expect_failure \
  "print-resolved-model" \
  "protocol package unrecognized field" \
  "unexpectedActionField" \
  --protocol-package "$BAD_FIXTURES_DIR/protocol-package-unrecognized-field.json"

run_expect_failure \
  "generate-config" \
  "duplicate planning routeId" \
  "duplicate planning routeId: route.demo.workerd.echo" \
  --planning-fragment "$BAD_FIXTURES_DIR/planning-fragment-duplicate-route.json"

run_expect_failure \
  "generate-config" \
  "planning fragment unrecognized field" \
  "unexpectedRouteField" \
  --planning-fragment "$BAD_FIXTURES_DIR/planning-fragment-unrecognized-field.json"

run_expect_failure \
  "generate-config" \
  "trailing slash pathPrefix" \
  "planning pathPrefix must not end with /: route.demo.workerd.echo" \
  --planning-fragment "$BAD_FIXTURES_DIR/planning-fragment-trailing-slash.json"

run_expect_failure \
  "generate-config" \
  "double slash pathPrefix" \
  "planning pathPrefix must not contain //: route.demo.workerd.echo" \
  --planning-fragment "$BAD_FIXTURES_DIR/planning-fragment-double-slash.json"

run_expect_failure \
  "generate-config" \
  "duplicate planning pathPrefix" \
  "duplicate planning pathPrefix: /echo" \
  --planning-fragment "$BAD_FIXTURES_DIR/planning-fragment-duplicate-path-prefix.json"

run_expect_failure \
  "generate-config" \
  "invalid websocket action flag" \
  "websocket action must declare websocket=true: ws.echo" \
  --protocol-package "$BAD_FIXTURES_DIR/protocol-package-invalid-websocket-action.json"

run_expect_failure \
  "generate-config" \
  "websocket non-get method" \
  "websocket action must use exactly GET method: ws.echo" \
  --protocol-package "$BAD_FIXTURES_DIR/protocol-package-websocket-non-get.json"

run_expect_failure \
  "generate-config" \
  "duplicate action method" \
  "duplicate protocol-package methods for action http.echo: POST" \
  --protocol-package "$BAD_FIXTURES_DIR/protocol-package-duplicate-method.json"

run_expect_failure \
  "generate-config" \
  "lowercase action method" \
  "protocol-package method must be uppercase token: http.info:get" \
  --protocol-package "$BAD_FIXTURES_DIR/protocol-package-lowercase-method.json"

run_expect_failure \
  "generate-config" \
  "http action with websocket flag" \
  "http action cannot declare websocket=true: http.info" \
  --protocol-package "$BAD_FIXTURES_DIR/protocol-package-http-action-with-websocket.json"

run_expect_failure \
  "generate-config" \
  "websocket route without upstream websocket" \
  "websocket route must enable upstream websocket: route.demo.workerd.ws" \
  --planning-fragment "$BAD_FIXTURES_DIR/planning-fragment-websocket-disabled.json"

run_expect_failure \
  "generate-config" \
  "http route with websocket upstream" \
  "http route must use http/https upstream: route.demo.workerd.root" \
  --planning-fragment "$BAD_FIXTURES_DIR/planning-fragment-http-route-with-ws-upstream.json"

run_expect_failure \
  "generate-config" \
  "websocket route with http upstream" \
  "websocket route must use ws/wss upstream: route.demo.workerd.ws" \
  --planning-fragment "$BAD_FIXTURES_DIR/planning-fragment-ws-route-with-http-upstream.json"

printf '%s\n' 'Negative verification passed.'
