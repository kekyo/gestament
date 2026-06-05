#!/usr/bin/env bash
set -euo pipefail

PROJECT_ROOT="${GESTAMENT_PREREQ_PROJECT_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)}"
PACKAGE_BUILD_ROOT="${PROJECT_ROOT}/.build/package"
DEFAULT_PARALLEL_JOB_CAP=4

ARCH_MATRIX=$(cat <<'EOF'
arm64 debian bookworm linux/arm64 docker.io/arm64v8/debian:bookworm
armv7l debian bookworm linux/arm/v7 docker.io/arm32v7/debian:bookworm
riscv64 debian trixie linux/riscv64 docker.io/library/debian:trixie
i686 debian bookworm linux/386 docker.io/i386/debian:bookworm
amd64 debian bookworm linux/amd64 docker.io/amd64/debian:bookworm
EOF
)

print_usage() {
  cat <<'EOF'
Usage: ./prereq.sh [options]

Options:
  --arch <list>       Comma-separated architecture filter.
  --backend <list>    Comma-separated backend filter: gtk3, gtk4, or all. Defaults to all.
  --purpose <list>    Comma-separated purpose filter: native, test, or all. Defaults to all.
  --jobs <count>      Maximum concurrent image builds. Defaults to auto (up to 4).
  --force             Rebuild images even when a tagged image already exists.
  --help              Show this help.
EOF
}

fail() {
  printf '%s\n' "$*" >&2
  exit 1
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || fail "Missing required command: $1"
}

validate_positive_integer() {
  local value_name=$1
  local value=$2

  case "${value}" in
    '' | *[!0-9]*)
      fail "${value_name} must be a positive integer: ${value}"
      ;;
  esac

  [[ "${value}" -gt 0 ]] || fail "${value_name} must be a positive integer: ${value}"
}

detect_processor_count() {
  local detected_count=''

  if command -v getconf >/dev/null 2>&1; then
    detected_count="$(getconf _NPROCESSORS_ONLN 2>/dev/null || true)"
  fi
  if [[ -z "${detected_count}" ]] && command -v nproc >/dev/null 2>&1; then
    detected_count="$(nproc 2>/dev/null || true)"
  fi

  case "${detected_count}" in
    '' | *[!0-9]*)
      detected_count=1
      ;;
  esac

  if [[ "${detected_count}" -lt 1 ]]; then
    detected_count=1
  fi

  printf '%s\n' "${detected_count}"
}

min_int() {
  if [[ "$1" -le "$2" ]]; then
    printf '%s\n' "$1"
  else
    printf '%s\n' "$2"
  fi
}

canonical_arch() {
  local value
  value="$(printf '%s' "$1" | tr '[:upper:]' '[:lower:]' | tr -d '[:space:]')"

  case "${value}" in
    amd64 | x86_64 | x64)
      printf '%s\n' 'amd64'
      ;;
    i686 | i386 | i486 | i586 | ia32 | x86)
      printf '%s\n' 'i686'
      ;;
    arm64 | aarch64)
      printf '%s\n' 'arm64'
      ;;
    armv7l | armv7 | armhf | arm)
      printf '%s\n' 'armv7l'
      ;;
    riscv64)
      printf '%s\n' 'riscv64'
      ;;
    *)
      fail "Unsupported architecture filter: $1"
      ;;
  esac
}

normalize_arch_filter() {
  local filter_value=$1
  if [[ -z "${filter_value}" ]]; then
    fail 'Architecture filter must not be empty'
  fi

  local previous_ifs=$IFS
  IFS=','
  local normalized=''
  local filter_item
  for filter_item in ${filter_value}; do
    local resolved_filter
    resolved_filter="$(canonical_arch "${filter_item}")"
    normalized="${normalized}${normalized:+,}${resolved_filter}"
  done
  IFS=${previous_ifs}

  printf '%s\n' "${normalized}"
}

matches_arch_filter() {
  local actual_value=$1
  if [[ -z "${ARCH_FILTER}" ]]; then
    return 0
  fi

  local previous_ifs=$IFS
  IFS=','
  local allowed_value
  for allowed_value in ${ARCH_FILTER}; do
    if [[ "${allowed_value}" = "${actual_value}" ]]; then
      IFS=${previous_ifs}
      return 0
    fi
  done
  IFS=${previous_ifs}
  return 1
}

normalize_backend_filter() {
  local filter_value=$1
  local previous_ifs=$IFS
  IFS=','
  local normalized=''
  local filter_item
  for filter_item in ${filter_value}; do
    local value
    value="$(printf '%s' "${filter_item}" | tr '[:upper:]' '[:lower:]' | tr -d '[:space:]')"
    case "${value}" in
      all)
        normalized="${normalized}${normalized:+ }gtk3 gtk4"
        ;;
      gtk3 | gtk4)
        normalized="${normalized}${normalized:+ }${value}"
        ;;
      *)
        fail "Unsupported backend filter: ${filter_item}"
        ;;
    esac
  done
  IFS=${previous_ifs}

  [[ -n "${normalized}" ]] || fail 'Backend filter must not be empty'
  printf '%s\n' "${normalized}"
}

normalize_purpose_filter() {
  local filter_value=$1
  local previous_ifs=$IFS
  IFS=','
  local normalized=''
  local filter_item
  for filter_item in ${filter_value}; do
    local value
    value="$(printf '%s' "${filter_item}" | tr '[:upper:]' '[:lower:]' | tr -d '[:space:]')"
    case "${value}" in
      all)
        normalized="${normalized}${normalized:+ }native test"
        ;;
      native | test)
        normalized="${normalized}${normalized:+ }${value}"
        ;;
      *)
        fail "Unsupported purpose filter: ${filter_item}"
        ;;
    esac
  done
  IFS=${previous_ifs}

  [[ -n "${normalized}" ]] || fail 'Purpose filter must not be empty'
  printf '%s\n' "${normalized}"
}

base_container_image_for_backend() {
  local backend=$1
  local arch=$2
  local default_image=$3
  case "${backend}" in
    gtk3)
      printf '%s\n' "${default_image}"
      ;;
    gtk4)
      case "${arch}" in
        amd64)
          printf '%s\n' 'docker.io/amd64/debian:sid'
          ;;
        i686)
          printf '%s\n' 'docker.io/i386/debian:sid'
          ;;
        arm64)
          printf '%s\n' 'docker.io/arm64v8/debian:sid'
          ;;
        armv7l)
          printf '%s\n' 'docker.io/arm32v7/debian:sid'
          ;;
        riscv64)
          printf '%s\n' 'docker.io/library/debian:sid'
          ;;
        *)
          fail "Unsupported GTK4 backend image lookup: ${arch}"
          ;;
      esac
      ;;
    *)
      fail "Unsupported backend image lookup: ${backend}"
      ;;
  esac
}

base_test_container_image_for_backend() {
  local backend=$1
  local arch=$2
  local default_image=$3
  case "${backend}" in
    gtk3)
      case "${arch}" in
        amd64)
          printf '%s\n' 'docker.io/amd64/debian:trixie'
          ;;
        i686)
          printf '%s\n' 'docker.io/i386/debian:trixie'
          ;;
        arm64)
          printf '%s\n' 'docker.io/arm64v8/debian:trixie'
          ;;
        armv7l)
          printf '%s\n' 'docker.io/arm32v7/debian:trixie'
          ;;
        riscv64)
          printf '%s\n' "${default_image}"
          ;;
        *)
          fail "Unsupported GTK3 test image lookup: ${arch}"
          ;;
      esac
      ;;
    gtk4)
      base_container_image_for_backend "${backend}" "${arch}" "${default_image}"
      ;;
    *)
      fail "Unsupported test backend image lookup: ${backend}"
      ;;
  esac
}

prereq_image_for_base_image() {
  local purpose=$1
  local backend=$2
  local arch=$3
  local base_image=$4
  local image_name
  local distro
  local release

  image_name="${base_image##*/}"
  distro="${image_name%%:*}"
  release="${base_image##*:}"

  printf 'localhost/gestament-pack-%s-%s-%s-%s-%s:latest\n' \
    "${purpose}" \
    "${backend}" \
    "${distro}" \
    "${release}" \
    "${arch}"
}

base_image_for_purpose_backend() {
  local purpose=$1
  local backend=$2
  local arch=$3
  local default_image=$4

  case "${purpose}" in
    native)
      base_container_image_for_backend "${backend}" "${arch}" "${default_image}"
      ;;
    test)
      base_test_container_image_for_backend "${backend}" "${arch}" "${default_image}"
      ;;
    *)
      fail "Unsupported image purpose: ${purpose}"
      ;;
  esac
}

container_packages_for_purpose_backend() {
  local purpose=$1
  local backend=$2

  case "${purpose}" in
    native)
      cat <<'EOF'
binutils
build-essential
ca-certificates
file
libatspi2.0-dev
libgdk-pixbuf-2.0-dev
libglib2.0-dev
libxtst-dev
libnode-dev
libx11-dev
make
nodejs
npm
pkg-config
EOF
      ;;
    test)
      cat <<'EOF'
at-spi2-core
build-essential
ca-certificates
dbus-x11
libatspi2.0-dev
libgdk-pixbuf-2.0-dev
libglib2.0-dev
libnode-dev
libxtst-dev
libx11-dev
make
meson
ninja-build
nodejs
npm
pkg-config
xauth
xvfb
EOF
      ;;
    *)
      fail "Unsupported image purpose: ${purpose}"
      ;;
  esac

  case "${backend}" in
    gtk3)
      printf '%s\n' 'libgtk-3-dev'
      ;;
    gtk4)
      printf '%s\n' 'libgtk-4-dev'
      ;;
    *)
      fail "Unsupported backend package lookup: ${backend}"
      ;;
  esac
}

write_containerfile() {
  local containerfile=$1
  local purpose=$2
  local backend=$3

  {
    cat <<'EOF'
ARG BASE_IMAGE
FROM ${BASE_IMAGE}

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update && \
    apt-get install -y --no-install-recommends \
EOF
    while IFS= read -r package_name; do
      [[ -n "${package_name}" ]] || continue
      printf '      %s \\\n' "${package_name}"
    done < <(container_packages_for_purpose_backend "${purpose}" "${backend}")
    if [[ "${backend}" = 'gtk4' ]]; then
      cat <<'EOF'
    && pkg-config --atleast-version=4.22 gtk4 \
    && rm -rf /var/lib/apt/lists/*
EOF
    else
      cat <<'EOF'
    && rm -rf /var/lib/apt/lists/*
EOF
    fi
  } >"${containerfile}"
}

choose_container_engine() {
  if [[ -n "${CONTAINER_ENGINE:-}" ]]; then
    require_command "${CONTAINER_ENGINE}"
    printf '%s\n' "${CONTAINER_ENGINE}"
    return 0
  fi

  require_command podman
  printf '%s\n' 'podman'
}

build_image() {
  local purpose=$1
  local backend=$2
  local arch=$3
  local platform=$4
  local default_image=$5
  local base_image
  local prereq_image
  local work_dir
  local containerfile
  local build_args=()

  base_image="$(base_image_for_purpose_backend "${purpose}" "${backend}" "${arch}" "${default_image}")"
  prereq_image="$(prereq_image_for_base_image "${purpose}" "${backend}" "${arch}" "${base_image}")"
  work_dir="${TMP_ROOT}/${purpose}/${backend}/${arch}"
  containerfile="${work_dir}/Containerfile"

  if [[ "${FORCE}" -eq 0 ]] && "${CONTAINER_ENGINE_BIN}" image exists "${prereq_image}" >/dev/null 2>&1; then
    printf '%s\n' "[prereq:${purpose}:${backend}] exists ${prereq_image}"
    return 0
  fi

  printf '%s\n' "[prereq:${purpose}:${backend}] build ${prereq_image} (${platform}, ${base_image})"
  rm -rf "${work_dir}"
  mkdir -p "${work_dir}"
  write_containerfile "${containerfile}" "${purpose}" "${backend}"

  if [[ "${FORCE}" -eq 1 ]]; then
    build_args+=(--no-cache)
  fi

  "${CONTAINER_ENGINE_BIN}" build "${build_args[@]}" \
    --platform "${platform}" \
    --pull=missing \
    --build-arg "BASE_IMAGE=${base_image}" \
    -t "${prereq_image}" \
    -f "${containerfile}" \
    "${work_dir}"
}

wait_for_oldest_job() {
  [[ "${ACTIVE_JOB_COUNT}" -gt 0 ]] || return 0

  set -- ${ACTIVE_JOB_PIDS}
  local wait_pid=$1
  shift

  if wait "${wait_pid}"; then
    :
  else
    JOB_FAILURE=1
  fi

  ACTIVE_JOB_PIDS=$*
  ACTIVE_JOB_COUNT=$((ACTIVE_JOB_COUNT - 1))
}

run_parallel_job() {
  while [[ "${ACTIVE_JOB_COUNT}" -ge "${PARALLEL_JOBS}" ]]; do
    wait_for_oldest_job
  done

  [[ "${JOB_FAILURE}" -eq 0 ]] || fail 'One or more prerequisite image builds failed'

  "$@" &
  ACTIVE_JOB_PIDS="${ACTIVE_JOB_PIDS}${ACTIVE_JOB_PIDS:+ }$!"
  ACTIVE_JOB_COUNT=$((ACTIVE_JOB_COUNT + 1))
}

wait_for_all_jobs() {
  while [[ "${ACTIVE_JOB_COUNT}" -gt 0 ]]; do
    wait_for_oldest_job
  done

  [[ "${JOB_FAILURE}" -eq 0 ]] || fail 'One or more prerequisite image builds failed'
}

schedule_image_builds() {
  while IFS=' ' read -r arch _distro _release platform image; do
    [[ -n "${arch}" ]] || continue
    matches_arch_filter "${arch}" || continue
    local purpose
    for purpose in ${PURPOSES}; do
      local backend
      for backend in ${BACKENDS}; do
        SCHEDULED_TASK_COUNT=$((SCHEDULED_TASK_COUNT + 1))
        run_parallel_job build_image "${purpose}" "${backend}" "${arch}" "${platform}" "${image}"
      done
    done
  done <<<"${ARCH_MATRIX}"
}

ARCH_FILTER=''
BACKENDS='gtk3 gtk4'
PURPOSES='native test'
PARALLEL_JOBS=''
FORCE=0

while [[ "$#" -gt 0 ]]; do
  case "$1" in
    --arch)
      [[ "$#" -ge 2 ]] || fail 'Missing value for --arch'
      ARCH_FILTER="$(normalize_arch_filter "$2")"
      shift 2
      ;;
    --backend)
      [[ "$#" -ge 2 ]] || fail 'Missing value for --backend'
      BACKENDS="$(normalize_backend_filter "$2")"
      shift 2
      ;;
    --purpose)
      [[ "$#" -ge 2 ]] || fail 'Missing value for --purpose'
      PURPOSES="$(normalize_purpose_filter "$2")"
      shift 2
      ;;
    --jobs)
      [[ "$#" -ge 2 ]] || fail 'Missing value for --jobs'
      PARALLEL_JOBS=$2
      shift 2
      ;;
    --force)
      FORCE=1
      shift
      ;;
    --help)
      print_usage
      exit 0
      ;;
    *)
      fail "Unknown argument: $1"
      ;;
  esac
done

if [[ -n "${PARALLEL_JOBS}" ]]; then
  validate_positive_integer 'Parallel job count' "${PARALLEL_JOBS}"
else
  PARALLEL_JOBS="$(min_int "$(detect_processor_count)" "${DEFAULT_PARALLEL_JOB_CAP}")"
fi

CONTAINER_ENGINE_BIN="$(choose_container_engine)"
RUN_ID="prereq-$(date +%Y%m%d%H%M%S)-$$"
TMP_ROOT="${PACKAGE_BUILD_ROOT}/tmp/${RUN_ID}"
ACTIVE_JOB_PIDS=''
ACTIVE_JOB_COUNT=0
JOB_FAILURE=0
SCHEDULED_TASK_COUNT=0

mkdir -p "${TMP_ROOT}"

printf '%s\n' "Using up to ${PARALLEL_JOBS} prerequisite image jobs"
schedule_image_builds
[[ "${SCHEDULED_TASK_COUNT}" -gt 0 ]] || fail 'No prerequisite image targets matched'
wait_for_all_jobs

printf '%s\n' 'Prerequisite images are ready.'
