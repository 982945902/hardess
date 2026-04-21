#!/usr/bin/env zsh

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")" && pwd)"
WORKERD_BIN="${WORKERD_BIN:-/Users/renchong/workspace/workerd/bazel-bin/src/workerd/server/workerd}"
GENERATED_CONFIG="${GENERATED_CONFIG:-$ROOT_DIR/.generated.config.capnp}"

if [[ ! -x "$WORKERD_BIN" ]]; then
  echo "workerd binary not found: $WORKERD_BIN" >&2
  exit 1
fi

cd "$ROOT_DIR"
rtk bun run "$ROOT_DIR/generate-config.ts" --output "$GENERATED_CONFIG" "$@" >/dev/null
exec "$WORKERD_BIN" serve --experimental "$GENERATED_CONFIG"
