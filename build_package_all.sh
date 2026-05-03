#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PACKAGE_SCRIPT="${BUILD_PACKAGE_SCRIPT:-${ROOT_DIR}/build_package.sh}"
FORWARDED_ARGS=()

while [[ $# -gt 0 ]]; do
  case "$1" in
    *)
      FORWARDED_ARGS+=("$1")
      shift
      ;;
  esac
done

exec "${PACKAGE_SCRIPT}" "${FORWARDED_ARGS[@]}" --target all --with-tests --test-backend all
