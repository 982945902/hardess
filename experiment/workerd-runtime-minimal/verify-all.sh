#!/usr/bin/env zsh

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")" && pwd)"

printf '%s\n' 'Running standard runtime verification...'
"$ROOT_DIR/verify.sh"
printf '\n%s\n' 'Running binding matrix verification...'
"$ROOT_DIR/verify-binding-matrix.sh"
printf '\n%s\n' 'Running binding runtime matrix verification...'
"$ROOT_DIR/verify-binding-runtime-matrix.sh"
printf '\n%s\n' 'Running no-compat runtime verification...'
"$ROOT_DIR/verify-no-compat-runtime.sh"
printf '\n%s\n' 'Running negative verification...'
"$ROOT_DIR/verify-negative.sh"
printf '\n%s\n' 'All verification suites passed.'
