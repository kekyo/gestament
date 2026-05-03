#!/bin/sh
set -eu

require_env() {
  var_name=$1
  eval "var_value=\${$var_name:-}"
  [ -n "$var_value" ] || {
    printf '%s\n' "Missing required environment variable: $var_name" >&2
    exit 1
  }
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || {
    printf '%s\n' "Missing required command: $1" >&2
    exit 1
  }
}

format_test_run_timestamp() {
  date '+%Y%m%d_%H%M%S_%3N'
}

setup_meson_build() {
  build_dir=$1
  source_dir=$2

  if [ -f "$build_dir/build.ninja" ]; then
    meson setup --reconfigure "$build_dir" "$source_dir"
  else
    meson setup "$build_dir" "$source_dir"
  fi
}

link_git_metadata() {
  if [ ! -e /workspace/.git ]; then
    printf '%s\n' \
      'Container cannot access /workspace/.git for screw-up version lookup.' >&2
    return 1
  fi
  if [ ! -e .git ]; then
    ln -s /workspace/.git .git
  fi
}

detect_package_version() {
  require_command npx

  detected_version=$(
    printf '%s\n' '{version}' | npx screw-up format | tr -d '\r' | head -n 1
  )
  [ -n "$detected_version" ] || {
    printf '%s\n' 'screw-up did not return a package version.' >&2
    return 1
  }
  printf '%s\n' "$detected_version"
}

# HACK riscv64:
# When using Vite/Vitest with Rollup in a RISC-64 container,
# an “Error: unreachable” error was occurring on the WASM fallback side,
# causing test collection to fail.
# To resolve this, you need to explicitly install the native Rollup package for RISC-64 GNU.
install_native_rollup_for_riscv64() {
  [ "$GESTAMENT_ARCH" = 'riscv64' ] || return 0

  if node -e "require.resolve('@rollup/rollup-linux-riscv64-gnu')" >/dev/null 2>&1; then
    return 0
  fi

  rollup_version=$(
    node -e "console.log(require('./node_modules/rollup/package.json').version)"
  )
  [ -n "$rollup_version" ] || {
    printf '%s\n' 'Could not resolve the installed Rollup version.' >&2
    return 1
  }

  npm install \
    --ignore-scripts \
    --no-save \
    --package-lock=false \
    "rollup@$rollup_version" \
    "@rollup/rollup-linux-riscv64-gnu@$rollup_version"
}

validate_package_version() {
  case "$1" in
    '' | *[!0-9A-Za-z.+:~\-]*)
      printf '%s\n' "Invalid package version: $1" >&2
      return 1
      ;;
  esac
}

expected_dpkg_architecture() {
  case "$1" in
    amd64)
      printf '%s\n' 'amd64'
      ;;
    i686)
      printf '%s\n' 'i386'
      ;;
    arm64)
      printf '%s\n' 'arm64'
      ;;
    armv7l)
      printf '%s\n' 'armhf'
      ;;
    riscv64)
      printf '%s\n' 'riscv64'
      ;;
    *)
      printf '%s\n' "Unsupported GESTAMENT_ARCH: $1" >&2
      return 1
      ;;
  esac
}

require_env GESTAMENT_ARCH
require_env GESTAMENT_GTK_BACKEND
export GESTAMENT_TEST_RESULTS_ARCH="${GESTAMENT_TEST_RESULTS_ARCH:-$GESTAMENT_ARCH}"
export GESTAMENT_TEST_RUN_TIMESTAMP="${GESTAMENT_TEST_RUN_TIMESTAMP:-$(format_test_run_timestamp)}"
export GESTAMENT_TEST_RESULTS_GROUP="${GESTAMENT_TEST_RESULTS_GROUP:-platform-$GESTAMENT_GTK_BACKEND}"
if [ -n "${GESTAMENT_TEST_RESULTS_ROOT:-}" ]; then
  mkdir -p "$GESTAMENT_TEST_RESULTS_ROOT"
fi

actual_dpkg_architecture=$(dpkg --print-architecture)
expected_dpkg_architecture=$(expected_dpkg_architecture "$GESTAMENT_ARCH")
if [ "$actual_dpkg_architecture" != "$expected_dpkg_architecture" ]; then
  printf '%s\n' \
    "Container architecture mismatch: expected $expected_dpkg_architecture for $GESTAMENT_ARCH, got $actual_dpkg_architecture." >&2
  exit 1
fi

export DEBIAN_FRONTEND=noninteractive

apt-get update
apt-get install -y --no-install-recommends \
  at-spi2-core \
  build-essential \
  ca-certificates \
  dbus-x11 \
  libatspi2.0-dev \
  libgdk-pixbuf-2.0-dev \
  libglib2.0-dev \
  libnode-dev \
  libxtst-dev \
  libx11-dev \
  make \
  meson \
  ninja-build \
  nodejs \
  npm \
  pkg-config \
  xauth \
  xvfb

case "$GESTAMENT_GTK_BACKEND" in
  gtk3)
    apt-get install -y --no-install-recommends libgtk-3-dev
    ;;
  gtk4)
    apt-get install -y --no-install-recommends libgtk-4-dev
    pkg-config --atleast-version=4.22 gtk4 || {
      printf '%s\n' "GTK4 tests require gtk4 >= 4.22." >&2
      pkg-config --modversion gtk4 >&2 || true
      exit 1
    }
    ;;
  *)
    printf '%s\n' "Unsupported GESTAMENT_GTK_BACKEND: $GESTAMENT_GTK_BACKEND" >&2
    exit 2
    ;;
esac

require_command npm
require_command node

workspace="/tmp/gestament-platform-test"
rm -rf "$workspace"
mkdir -p "$workspace"

cd /workspace
tar \
  --exclude='./.git' \
  --exclude='./.build' \
  --exclude='./artifacts' \
  --exclude='./build' \
  --exclude='./native/out' \
  --exclude='./node_modules' \
  --exclude='./test-results' \
  -cf - . | tar -C "$workspace" -xf -

cd "$workspace"
link_git_metadata
if [ -f package-lock.json ]; then
  npm ci --ignore-scripts
else
  npm install --ignore-scripts
fi
install_native_rollup_for_riscv64
package_version=$(detect_package_version)
validate_package_version "$package_version"
./node_modules/.bin/screw-up metadata

detect_node_include_dir() {
  if [ -f /usr/include/node/node_api.h ]; then
    printf '%s\n' /usr/include/node
    return 0
  fi

  if [ -f /usr/local/include/node/node_api.h ]; then
    printf '%s\n' /usr/local/include/node
    return 0
  fi

  printf '%s\n' 'Could not find node_api.h in /usr/include/node or /usr/local/include/node.' >&2
  return 1
}

prebuild_directory_for_arch() {
  case "$1" in
    amd64)
      printf '%s\n' 'linux-x64'
      ;;
    i686)
      printf '%s\n' 'linux-ia32'
      ;;
    arm64)
      printf '%s\n' 'linux-arm64'
      ;;
    armv7l)
      printf '%s\n' 'linux-arm'
      ;;
    riscv64)
      printf '%s\n' 'linux-riscv64'
      ;;
    *)
      printf '%s\n' "Unsupported GESTAMENT_ARCH: $1" >&2
      return 1
      ;;
  esac
}

prebuild_file_for_arch() {
  case "$1" in
    armv7l)
      printf '%s\n' 'node.napi.armv7.glibc.node'
      ;;
    *)
      printf '%s\n' 'node.napi.glibc.node'
      ;;
  esac
}

build_native_backend() {
  node_include_dir=$(detect_node_include_dir)
  prebuild_directory=$(prebuild_directory_for_arch "$GESTAMENT_ARCH")
  prebuild_file=$(prebuild_file_for_arch "$GESTAMENT_ARCH")
  prebuild_path="prebuilds/$prebuild_directory/$GESTAMENT_GTK_BACKEND/$prebuild_file"
  out_dir="out/$prebuild_directory/$GESTAMENT_GTK_BACKEND"

  make -C native clean OUT_DIR="$out_dir"
  make -C native \
    NODE_INCLUDE_DIR="$node_include_dir" \
    GESTAMENT_PACKAGE_VERSION="$package_version" \
    GESTAMENT_NATIVE_ARCH="$GESTAMENT_ARCH" \
    GESTAMENT_GTK_BACKEND="$GESTAMENT_GTK_BACKEND" \
    OUT_DIR="$out_dir"
  mkdir -p "$(dirname "$prebuild_path")"
  cp "native/$out_dir/gestament_native.node" "$prebuild_path"
}

build_native_backend
if [ "${GESTAMENT_USE_EXISTING_DIST:-0}" = '1' ]; then
  if [ ! -f dist/gestament-xvfb.cjs ]; then
    printf '%s\n' 'GESTAMENT_USE_EXISTING_DIST=1 requires dist/gestament-xvfb.cjs.' >&2
    exit 1
  fi
else
  npm run build:internal
fi

case "$GESTAMENT_GTK_BACKEND" in
  gtk3)
    setup_meson_build .build/gtk3-test-app fixtures/gtk3-test-app
    meson compile -C .build/gtk3-test-app
    ;;
  gtk4)
    setup_meson_build .build/gtk4-test-app fixtures/gtk4-test-app
    meson compile -C .build/gtk4-test-app
    ;;
esac

GESTAMENT_GTK_BACKEND="$GESTAMENT_GTK_BACKEND" \
GESTAMENT_PACKAGE_VERSION="$package_version" \
GESTAMENT_TEST_BACKEND="$GESTAMENT_GTK_BACKEND" \
GESTAMENT_UPDATE_VISUAL_MASTERS="${GESTAMENT_UPDATE_VISUAL_MASTERS:-1}" \
node dist/gestament-xvfb.cjs --with-tray-host -- \
  npm run test:internal
