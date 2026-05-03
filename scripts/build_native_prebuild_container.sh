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

detect_package_version() {
  if [ ! -e /workspace/.git ]; then
    printf '%s\n' \
      'Container cannot access /workspace/.git for screw-up version lookup.' >&2
    return 1
  fi
  require_command npx

  detected_version=$(
    cd /workspace &&
      printf '%s\n' '{version}' | npx screw-up format | tr -d '\r' | head -n 1
  )
  [ -n "$detected_version" ] || {
    printf '%s\n' 'screw-up did not return a package version.' >&2
    return 1
  }
  printf '%s\n' "$detected_version"
}

validate_package_version() {
  case "$1" in
    '' | *[!0-9A-Za-z.+:~\-]*)
      printf '%s\n' "Invalid package version: $1" >&2
      return 1
      ;;
  esac
}

require_env GESTAMENT_ARCH
require_env GESTAMENT_PREBUILD_DIR
require_env GESTAMENT_PREBUILD_FILE
require_env GESTAMENT_GTK_BACKEND

GESTAMENT_MAKE_JOBS=${GESTAMENT_MAKE_JOBS:-1}

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
  binutils \
  build-essential \
  ca-certificates \
  file \
  libatspi2.0-dev \
  libgdk-pixbuf-2.0-dev \
  libglib2.0-dev \
  libxtst-dev \
  libnode-dev \
  libx11-dev \
  make \
  nodejs \
  npm \
  pkg-config

case "$GESTAMENT_GTK_BACKEND" in
  gtk3)
    apt-get install -y --no-install-recommends libgtk-3-dev
    ;;
  gtk4)
    apt-get install -y --no-install-recommends libgtk-4-dev
    pkg-config --atleast-version=4.22 gtk4 || {
      printf '%s\n' "GTK4 backend requires gtk4 >= 4.22." >&2
      pkg-config --modversion gtk4 >&2 || true
      exit 1
    }
    ;;
  *)
    printf '%s\n' "Unsupported GESTAMENT_GTK_BACKEND: $GESTAMENT_GTK_BACKEND" >&2
    exit 2
    ;;
esac

require_command make
require_command node
require_command readelf

package_version=$(detect_package_version)
validate_package_version "$package_version"
node_include_dir=$(detect_node_include_dir)
prebuild_root="/workspace/prebuilds/$GESTAMENT_PREBUILD_DIR"
prebuild_path="$prebuild_root/$GESTAMENT_PREBUILD_FILE"
out_dir="/workspace/native/out/$GESTAMENT_PREBUILD_DIR"

rm -rf "$out_dir" "$prebuild_root"
make -C /workspace/native clean OUT_DIR="$out_dir"
make -C /workspace/native -j"$GESTAMENT_MAKE_JOBS" \
  NODE_INCLUDE_DIR="$node_include_dir" \
  GESTAMENT_PACKAGE_VERSION="$package_version" \
  GESTAMENT_NATIVE_ARCH="$GESTAMENT_ARCH" \
  GESTAMENT_GTK_BACKEND="$GESTAMENT_GTK_BACKEND" \
  OUT_DIR="$out_dir"

mkdir -p "$prebuild_root"
cp "$out_dir/gestament_native.node" "$prebuild_path"

file "$prebuild_path"
readelf -h "$prebuild_path" >/dev/null
