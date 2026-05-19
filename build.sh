#!/usr/bin/env bash
set -euo pipefail

root_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "${root_dir}"

mode="${1:-build}"
if [[ "$#" -gt 1 ]]; then
  echo 'Usage: ./build.sh [build|test]' >&2
  exit 2
fi

case "${mode}" in
  build | test)
    ;;
  *)
    echo "Unsupported build mode: ${mode}" >&2
    echo 'Usage: ./build.sh [build|test]' >&2
    exit 2
    ;;
esac

if [[ -f package-lock.json ]]; then
  npm ci --ignore-scripts
else
  npm install --ignore-scripts
fi

detect_package_version() {
  local detected_version
  detected_version="$(printf '%s\n' '{version}' | npx screw-up format | tr -d '\r' | head -n 1)"
  [[ -n "${detected_version}" ]] || {
    echo 'screw-up did not return a package version.' >&2
    return 1
  }
  printf '%s\n' "${detected_version}"
}

validate_package_version() {
  case "$1" in
    '' | *[!0-9A-Za-z.+:~\-]*)
      echo "Invalid package version: $1" >&2
      return 1
      ;;
  esac
}

detect_node_include_dir() {
  if [[ -n "${NODE_INCLUDE_DIR:-}" && -f "${NODE_INCLUDE_DIR}/node_api.h" ]]; then
    printf '%s\n' "${NODE_INCLUDE_DIR}"
    return 0
  fi

  local nvm_include_dir
  nvm_include_dir="$(node -p "const path = require('node:path'); path.resolve(path.dirname(process.execPath), '..', 'include', 'node')")"
  if [[ -f "${nvm_include_dir}/node_api.h" ]]; then
    printf '%s\n' "${nvm_include_dir}"
    return 0
  fi

  if [[ -f /usr/include/node/node_api.h ]]; then
    printf '%s\n' /usr/include/node
    return 0
  fi

  if [[ -f /usr/local/include/node/node_api.h ]]; then
    printf '%s\n' /usr/local/include/node
    return 0
  fi

  echo "Could not find node_api.h. Set NODE_INCLUDE_DIR to a Node include directory." >&2
  return 1
}

prebuild_path_for_current_arch() {
  local backend=$1
  local node_arch
  node_arch="$(node -p "process.arch")"

  case "${node_arch}" in
    x64)
      printf '%s\n' "prebuilds/linux-x64/${backend}/node.napi.glibc.node"
      ;;
    ia32)
      printf '%s\n' "prebuilds/linux-ia32/${backend}/node.napi.glibc.node"
      ;;
    arm64)
      printf '%s\n' "prebuilds/linux-arm64/${backend}/node.napi.glibc.node"
      ;;
    arm)
      printf '%s\n' "prebuilds/linux-arm/${backend}/node.napi.armv7.glibc.node"
      ;;
    riscv64)
      printf '%s\n' "prebuilds/linux-riscv64/${backend}/node.napi.glibc.node"
      ;;
    *)
      echo "Unsupported current Node architecture: ${node_arch}" >&2
      return 1
      ;;
  esac
}

normalize_test_backends() {
  local value="${GESTAMENT_TEST_BACKENDS:-gtk3}"
  if [[ "${value}" = 'all' ]]; then
    printf '%s\n' 'gtk3 gtk4'
    return 0
  fi

  local previous_ifs=$IFS
  IFS=','
  local normalized=()
  local backend
  for backend in ${value}; do
    case "${backend}" in
      gtk3 | gtk4)
        normalized+=("${backend}")
        ;;
      *)
        echo "Unsupported GESTAMENT_TEST_BACKENDS item: ${backend}" >&2
        echo "Expected gtk3, gtk4, gtk3,gtk4, or all." >&2
        IFS=${previous_ifs}
        return 1
        ;;
    esac
  done
  IFS=${previous_ifs}

  [[ "${#normalized[@]}" -gt 0 ]] || {
    echo 'GESTAMENT_TEST_BACKENDS must not be empty.' >&2
    return 1
  }

  printf '%s\n' "${normalized[*]}"
}

require_gtk_backend() {
  local backend=$1
  case "${backend}" in
    gtk3)
      pkg-config --exists gtk+-3.0 || {
        echo 'GTK3 backend requires gtk+-3.0 development files.' >&2
        return 1
      }
      ;;
    gtk4)
      pkg-config --atleast-version=4.22 gtk4 || {
        local detected
        detected="$(pkg-config --modversion gtk4 2>/dev/null || printf '%s' 'not installed')"
        echo "GTK4 backend requires gtk4 >= 4.22. Detected: ${detected}" >&2
        return 1
      }
      ;;
  esac
}

build_native_backend() {
  local backend=$1
  local prebuild_path
  prebuild_path="$(prebuild_path_for_current_arch "${backend}")"

  require_gtk_backend "${backend}"
  make -C native clean
  make -C native \
    NODE_INCLUDE_DIR="${node_include_dir}" \
    GESTAMENT_PACKAGE_VERSION="${package_version}" \
    GESTAMENT_NATIVE_ARCH="${node_arch}" \
    GESTAMENT_GTK_BACKEND="${backend}"
  mkdir -p "$(dirname "${prebuild_path}")"
  cp native/out/gestament_native.node "${prebuild_path}"
}

build_fixture_backend() {
  local backend=$1
  local build_dir=''
  local source_dir=''
  case "${backend}" in
    gtk3)
      build_dir='.build/gtk3-test-app'
      source_dir='fixtures/gtk3-test-app'
      ;;
    gtk4)
      build_dir='.build/gtk4-test-app'
      source_dir='fixtures/gtk4-test-app'
      ;;
  esac

  if [[ -f "${build_dir}/build.ninja" ]]; then
    meson setup --reconfigure "${build_dir}" "${source_dir}"
  else
    meson setup "${build_dir}" "${source_dir}"
  fi
  meson compile -C "${build_dir}"
}

format_test_run_timestamp() {
  date '+%Y%m%d_%H%M%S_%3N'
}

run_tests_backend() {
  local backend=$1
  local display_backend="${GESTAMENT_DISPLAY_BACKEND:-x11}"

  case "${display_backend}" in
    current)
      env \
        -u NO_AT_BRIDGE \
        GESTAMENT_GTK_BACKEND="${backend}" \
        GESTAMENT_TEST_BACKEND="${backend}" \
        GSETTINGS_BACKEND=memory \
        GTK_THEME="${GTK_THEME:-Adwaita}" \
        dbus-run-session -- npm run test:internal
      ;;
    x11)
      env \
        GESTAMENT_GTK_BACKEND="${backend}" \
        GESTAMENT_TEST_BACKEND="${backend}" \
        GTK_THEME="${GTK_THEME:-Adwaita}" \
        npm run test:internal
      ;;
    *)
      echo "Unsupported GESTAMENT_DISPLAY_BACKEND: ${display_backend}" >&2
      echo "Expected one of: current, x11" >&2
      exit 2
      ;;
  esac
}

node_include_dir="$(detect_node_include_dir)"
package_version="$(detect_package_version)"
validate_package_version "${package_version}"
node_arch="$(node -p "process.arch")"
test_backends="$(normalize_test_backends)"
GESTAMENT_TEST_RUN_TIMESTAMP="${GESTAMENT_TEST_RUN_TIMESTAMP:-$(format_test_run_timestamp)}"
export GESTAMENT_TEST_RUN_TIMESTAMP
export GESTAMENT_TEST_RESULTS_ARCH=host

for backend in ${test_backends}; do
  build_native_backend "${backend}"
done

npm run build:internal

if [[ "${mode}" = 'build' ]]; then
  exit 0
fi

for backend in ${test_backends}; do
  build_fixture_backend "${backend}"
  run_tests_backend "${backend}"
done
