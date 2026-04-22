#!/usr/bin/env zsh

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")" && pwd)"

TOTAL_START_SECONDS="${EPOCHSECONDS:-$(date +%s)}"

run_suite() {
  local label="$1"
  local script="$2"
  local start_seconds
  local end_seconds
  local elapsed_seconds

  start_seconds="${EPOCHSECONDS:-$(date +%s)}"
  printf '\n%s\n' "Running $label..."

  if ! "$script"; then
    end_seconds="${EPOCHSECONDS:-$(date +%s)}"
    elapsed_seconds=$((end_seconds - start_seconds))
    printf '\n%s\n' "Verification suite failed: $label (${elapsed_seconds}s)" >&2
    return 1
  fi

  end_seconds="${EPOCHSECONDS:-$(date +%s)}"
  elapsed_seconds=$((end_seconds - start_seconds))
  printf '%s\n' "Verification suite passed: $label (${elapsed_seconds}s)"
}

run_suite "standard runtime verification" "$ROOT_DIR/verify.sh"
run_suite "binding matrix verification" "$ROOT_DIR/verify-binding-matrix.sh"
run_suite "binding runtime matrix verification" "$ROOT_DIR/verify-binding-runtime-matrix.sh"
run_suite "no-compat runtime verification" "$ROOT_DIR/verify-no-compat-runtime.sh"
run_suite "negative verification" "$ROOT_DIR/verify-negative.sh"

TOTAL_END_SECONDS="${EPOCHSECONDS:-$(date +%s)}"
printf '\n%s\n' "All verification suites passed ($((TOTAL_END_SECONDS - TOTAL_START_SECONDS))s total)."
