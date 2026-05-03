#!/usr/bin/env bash
set -euo pipefail

PROJECT_ROOT="${BUILD_PACKAGE_PROJECT_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)}"
ARTIFACT_ROOT="${PROJECT_ROOT}/artifacts"
PACKAGE_BUILD_ROOT="${PROJECT_ROOT}/.build/package"
REPORT_ROOT="${PACKAGE_BUILD_ROOT}/reports"
TMP_ROOT="${PACKAGE_BUILD_ROOT}/tmp"
TEST_RESULT_ROOT="${PROJECT_ROOT}/test-results"
DEFAULT_PARALLEL_JOB_CAP=24

ARCH_MATRIX=$(cat <<'EOF'
amd64 debian bookworm linux/amd64 docker.io/amd64/debian:bookworm
i686 debian bookworm linux/386 docker.io/i386/debian:bookworm
arm64 debian bookworm linux/arm64 docker.io/arm64v8/debian:bookworm
armv7l debian bookworm linux/arm/v7 docker.io/arm32v7/debian:bookworm
riscv64 debian trixie linux/riscv64 docker.io/library/debian:trixie
EOF
)

print_usage() {
  cat <<'EOF'
Usage: ./build_package.sh [options]

Options:
  --target <target>    native, npm, or all. Defaults to all.
  --arch <list>        Comma-separated architecture filter.
  --jobs <count>       Maximum concurrent native prebuild jobs.
  --with-tests         Run platform tests in containers after native builds.
  --test-backend <b>   gtk3, gtk4, or all. Defaults to gtk3 with --with-tests.
  --help               Show this help.
EOF
}

fail() {
  printf '%s\n' "$*" >&2
  exit 1
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || fail "Missing required command: $1"
}

format_test_run_timestamp() {
  date '+%Y%m%d_%H%M%S_%3N'
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

ensure_node_dependencies() {
  cd "${PROJECT_ROOT}"
  if [[ -f package-lock.json ]]; then
    npm ci --ignore-scripts
  else
    npm install --ignore-scripts
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
    printf '\n'
    return 0
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

prebuild_dir_for_arch() {
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
      fail "Unsupported prebuild directory lookup: $1"
      ;;
  esac
}

prebuild_file_for_arch() {
  case "$1" in
    armv7l)
      printf '%s\n' 'node.napi.armv7.glibc.node'
      ;;
    amd64 | i686 | arm64 | riscv64)
      printf '%s\n' 'node.napi.glibc.node'
      ;;
    *)
      fail "Unsupported prebuild filename lookup: $1"
      ;;
  esac
}

prebuild_path_for_arch() {
  local arch=$1
  local backend=$2
  printf '%s/prebuilds/%s/%s/%s\n' \
    "${PROJECT_ROOT}" \
    "$(prebuild_dir_for_arch "${arch}")" \
    "${backend}" \
    "$(prebuild_file_for_arch "${arch}")"
}

native_backends() {
  printf '%s\n' 'gtk3 gtk4'
}

normalize_test_backend_filter() {
  case "$1" in
    gtk3 | gtk4)
      printf '%s\n' "$1"
      ;;
    all)
      printf '%s\n' 'gtk3 gtk4'
      ;;
    *)
      fail "Unsupported test backend: $1"
      ;;
  esac
}

container_image_for_backend() {
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

test_container_image_for_backend() {
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
      container_image_for_backend "${backend}" "${arch}" "${default_image}"
      ;;
    *)
      fail "Unsupported test backend image lookup: ${backend}"
      ;;
  esac
}

expected_elf_class() {
  case "$1" in
    amd64 | arm64 | riscv64)
      printf '%s\n' 'ELF64'
      ;;
    i686 | armv7l)
      printf '%s\n' 'ELF32'
      ;;
    *)
      fail "Unsupported ELF class lookup: $1"
      ;;
  esac
}

expected_elf_machine() {
  case "$1" in
    amd64)
      printf '%s\n' 'Advanced Micro Devices X86-64'
      ;;
    i686)
      printf '%s\n' 'Intel 80386'
      ;;
    arm64)
      printf '%s\n' 'AArch64'
      ;;
    armv7l)
      printf '%s\n' 'ARM'
      ;;
    riscv64)
      printf '%s\n' 'RISC-V'
      ;;
    *)
      fail "Unsupported ELF machine lookup: $1"
      ;;
  esac
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

fix_podman_volume_ownership() {
  if [[ "${CONTAINER_ENGINE_BIN:-}" = 'podman' ]]; then
    podman unshare chown -R 0:0 "${PROJECT_ROOT}/prebuilds" "${PROJECT_ROOT}/native/out" >/dev/null 2>&1 || true
  fi
}

count_native_builds() {
  local build_count=0
  while IFS=' ' read -r arch _distro _release _platform _image; do
    [[ -n "${arch}" ]] || continue
    matches_arch_filter "${arch}" || continue
    local backend
    for backend in $(native_backends); do
      build_count=$((build_count + 1))
    done
  done <<<"${ARCH_MATRIX}"

  printf '%s\n' "${build_count}"
}

build_native_prebuild() {
  local arch=$1
  local distro=$2
  local release=$3
  local platform=$4
  local image=$5
  local backend=$6
  local prebuild_dir
  local prebuild_file

  prebuild_dir="$(prebuild_dir_for_arch "${arch}")/${backend}"
  prebuild_file="$(prebuild_file_for_arch "${arch}")"
  image="$(container_image_for_backend "${backend}" "${arch}" "${image}")"

  printf '%s\n' "[native:${backend}] ${arch} (${distro} ${release}, ${platform})"

  "${CONTAINER_ENGINE_BIN}" run --rm \
    --platform "${platform}" \
    -v "${PROJECT_ROOT}:/workspace" \
    -w /workspace \
    -e GESTAMENT_ARCH="${arch}" \
    -e GESTAMENT_PREBUILD_DIR="${prebuild_dir}" \
    -e GESTAMENT_PREBUILD_FILE="${prebuild_file}" \
    -e GESTAMENT_MAKE_JOBS="${MAKE_JOBS}" \
    -e GESTAMENT_GTK_BACKEND="${backend}" \
    "${image}" \
    ./scripts/build_native_prebuild_container.sh

  fix_podman_volume_ownership
}

schedule_native_builds() {
  fix_podman_volume_ownership
  rm -rf "${PROJECT_ROOT}/prebuilds"

  while IFS=' ' read -r arch distro release platform image; do
    [[ -n "${arch}" ]] || continue
    matches_arch_filter "${arch}" || continue
    local backend
    for backend in $(native_backends); do
      run_parallel_job build_native_prebuild "${arch}" "${distro}" "${release}" "${platform}" "${image}" "${backend}"
    done
  done <<<"${ARCH_MATRIX}"
}

count_platform_tests() {
  local test_count=0
  while IFS=' ' read -r arch _distro _release _platform _image; do
    [[ -n "${arch}" ]] || continue
    matches_arch_filter "${arch}" || continue
    local backend
    for backend in ${TEST_BACKENDS}; do
      test_count=$((test_count + 1))
    done
  done <<<"${ARCH_MATRIX}"

  printf '%s\n' "${test_count}"
}

run_platform_test() {
  local arch=$1
  local _distro=$2
  local _release=$3
  local platform=$4
  local image=$5
  local backend=$6
  local log_dir
  local log_path

  image="$(test_container_image_for_backend "${backend}" "${arch}" "${image}")"
  printf '%s\n' "[test:${backend}] ${arch} (${platform}, ${image})"

  log_dir="${TEST_RESULT_ROOT}/${TEST_RUN_TIMESTAMP}/${arch}/platform-${backend}"
  log_path="${log_dir}/container.log"
  mkdir -p "${log_dir}" "${TEST_RESULT_ROOT}"

  "${CONTAINER_ENGINE_BIN}" run --rm \
    --platform "${platform}" \
    -v "${PROJECT_ROOT}:/workspace:ro" \
    -v "${TEST_RESULT_ROOT}:/workspace/test-results:rw" \
    -w /workspace \
    -e GESTAMENT_ARCH="${arch}" \
    -e GESTAMENT_GTK_BACKEND="${backend}" \
    -e GESTAMENT_USE_EXISTING_DIST=1 \
    -e GESTAMENT_TEST_RESULTS_ARCH="${arch}" \
    -e GESTAMENT_TEST_RESULTS_GROUP="platform-${backend}" \
    -e GESTAMENT_TEST_RESULTS_ROOT="/workspace/test-results" \
    -e GESTAMENT_TEST_RUN_TIMESTAMP="${TEST_RUN_TIMESTAMP}" \
    "${image}" \
    ./scripts/test_platform_container.sh 2>&1 | tee "${log_path}"
}

schedule_platform_tests() {
  while IFS=' ' read -r arch distro release platform image; do
    [[ -n "${arch}" ]] || continue
    matches_arch_filter "${arch}" || continue
    local backend
    for backend in ${TEST_BACKENDS}; do
      run_parallel_job run_platform_test "${arch}" "${distro}" "${release}" "${platform}" "${image}" "${backend}"
    done
  done <<<"${ARCH_MATRIX}"
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

  [[ "${JOB_FAILURE}" -eq 0 ]] || fail 'One or more package builds failed'

  "$@" &
  ACTIVE_JOB_PIDS="${ACTIVE_JOB_PIDS}${ACTIVE_JOB_PIDS:+ }$!"
  ACTIVE_JOB_COUNT=$((ACTIVE_JOB_COUNT + 1))
}

wait_for_all_jobs() {
  while [[ "${ACTIVE_JOB_COUNT}" -gt 0 ]]; do
    wait_for_oldest_job
  done

  [[ "${JOB_FAILURE}" -eq 0 ]] || fail 'One or more package builds failed'
}

assert_contains() {
  local target_path=$1
  local expected_text=$2
  grep -F "${expected_text}" "${target_path}" >/dev/null 2>&1 ||
    fail "Missing expected text in ${target_path}: ${expected_text}"
}

validate_native_artifacts() {
  require_command readelf
  mkdir -p "${REPORT_ROOT}"

  local expected_count=0
  while IFS=' ' read -r arch _distro _release _platform _image; do
    [[ -n "${arch}" ]] || continue
    matches_arch_filter "${arch}" || continue
    local backend
    for backend in $(native_backends); do
      expected_count=$((expected_count + 1))

      local prebuild_path
      local readelf_output
      prebuild_path="$(prebuild_path_for_arch "${arch}" "${backend}")"
      readelf_output="${REPORT_ROOT}/readelf-${arch}-${backend}.txt"
      [[ -f "${prebuild_path}" ]] || fail "Missing expected prebuild: ${prebuild_path}"

      readelf -h "${prebuild_path}" >"${readelf_output}"
      assert_contains "${readelf_output}" "$(expected_elf_class "${arch}")"
      assert_contains "${readelf_output}" "$(expected_elf_machine "${arch}")"
    done
  done <<<"${ARCH_MATRIX}"

  [[ "${expected_count}" -gt 0 ]] || fail 'No native prebuild targets matched'
}

build_npm_package() {
  build_javascript_artifacts
  rm -f "${ARTIFACT_ROOT}"/gestament-*.tgz
  npx screw-up pack --pack-destination ./artifacts
}

build_javascript_artifacts() {
  cd "${PROJECT_ROOT}"
  npm run build:internal
}

validate_npm_package() {
  require_command tar
  mkdir -p "${REPORT_ROOT}" "${TMP_ROOT}"

  local package_paths=()
  local found_package_path
  while IFS= read -r found_package_path; do
    package_paths+=("${found_package_path}")
  done < <(find "${ARTIFACT_ROOT}" -maxdepth 1 -type f -name 'gestament-*.tgz' | sort)

  [[ "${#package_paths[@]}" -eq 1 ]] ||
    fail "Expected exactly one generated npm package artifact, found ${#package_paths[@]}"

  local package_path="${package_paths[0]}"

  local listing_path="${REPORT_ROOT}/npm-pack-list.txt"
  tar -tzf "${package_path}" >"${listing_path}"
  assert_contains "${listing_path}" 'package/package.json'
  assert_contains "${listing_path}" 'package/dist/index.mjs'
  assert_contains "${listing_path}" 'package/dist/index.cjs'
  assert_contains "${listing_path}" 'package/dist/index.d.ts'
  assert_contains "${listing_path}" 'package/dist/gestament-config.mjs'
  assert_contains "${listing_path}" 'package/dist/gestament-config.cjs'
  assert_contains "${listing_path}" 'package/dist/gestament-config.d.ts'
  assert_contains "${listing_path}" 'package/dist/gestament-xvfb.mjs'
  assert_contains "${listing_path}" 'package/dist/gestament-xvfb.cjs'
  assert_contains "${listing_path}" 'package/dist/gestament-xvfb.d.ts'
  assert_contains "${listing_path}" 'package/include/gestament/gtk.h'

  while IFS=' ' read -r arch _distro _release _platform _image; do
    [[ -n "${arch}" ]] || continue
    matches_arch_filter "${arch}" || continue
    local backend
    for backend in $(native_backends); do
      assert_contains "${listing_path}" "package/prebuilds/$(prebuild_dir_for_arch "${arch}")/${backend}/$(prebuild_file_for_arch "${arch}")"
    done
  done <<<"${ARCH_MATRIX}"

  if matches_arch_filter "$(canonical_arch "$(node -p "process.arch")")"; then
    local tmp_dir
    tmp_dir="$(mktemp -d "${TMP_ROOT}/npm-install.XXXXXX")"
    (
      cd "${tmp_dir}"
      node -e 'require("node:fs").writeFileSync("package.json", "{\"private\":true,\"type\":\"module\"}\n")'
      npm install "${package_path}" --ignore-scripts >/dev/null
      PREBUILDS_ONLY=1 node --input-type=module <<'EOF'
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const packageRoot = resolve('node_modules/gestament');
const packageJson = JSON.parse(
  readFileSync(resolve(packageRoot, 'package.json'), 'utf8')
);
if (packageJson.bin?.["gestament-xvfb"] !== "./dist/gestament-xvfb.cjs") {
  console.error("gestament-xvfb bin entry is missing or invalid.");
  process.exit(1);
}
if (packageJson.bin?.["gestament-config"] !== "./dist/gestament-config.cjs") {
  console.error("gestament-config bin entry is missing or invalid.");
  process.exit(1);
}
const xvfbBin = readFileSync(
  resolve(packageRoot, "dist/gestament-xvfb.cjs"),
  "utf8"
);
if (!xvfbBin.startsWith("#!/usr/bin/env node")) {
  console.error("gestament-xvfb executable is missing its shebang.");
  process.exit(1);
}
const configBinSource = readFileSync(
  resolve(packageRoot, "dist/gestament-config.cjs"),
  "utf8"
);
if (!configBinSource.startsWith("#!/usr/bin/env node")) {
  console.error("gestament-config executable is missing its shebang.");
  process.exit(1);
}

const configCommand = resolve("node_modules/.bin/gestament-config");
const expectedIncludeDir = resolve(packageRoot, "include");
const includeDir = execFileSync(configCommand, ["--includedir"], {
  encoding: "utf8",
}).trim();
if (includeDir !== expectedIncludeDir) {
  console.error(`gestament-config --includedir returned ${includeDir}.`);
  process.exit(1);
}
const cflags = execFileSync(configCommand, ["--cflags"], {
  encoding: "utf8",
}).trim();
if (cflags !== `-I${expectedIncludeDir}`) {
  console.error(`gestament-config --cflags returned ${cflags}.`);
  process.exit(1);
}
try {
  execFileSync(configCommand, ["--unknown"], { stdio: "pipe" });
  console.error("gestament-config accepted an unknown option.");
  process.exit(1);
} catch (error) {
  const status =
    error !== null && typeof error === "object" && "status" in error
      ? error.status
      : undefined;
  if (status !== 2) {
    console.error("gestament-config did not return exit code 2 for an unknown option.");
    process.exit(1);
  }
}

const requireFromPackage = createRequire(resolve(packageRoot, 'package.json'));
const arch = process.arch;
const prebuildDir = {
  x64: 'linux-x64',
  ia32: 'linux-ia32',
  arm64: 'linux-arm64',
  arm: 'linux-arm',
  riscv64: 'linux-riscv64',
}[arch];
if (prebuildDir === undefined) {
  console.error(`Unsupported smoke-test arch: ${arch}`);
  process.exit(1);
}
const prebuildFile = arch === 'arm'
  ? 'node.napi.armv7.glibc.node'
  : 'node.napi.glibc.node';
const gtk3Addon = requireFromPackage(
  resolve(packageRoot, 'prebuilds', prebuildDir, 'gtk3', prebuildFile)
);
const gtk3NativeInfo = gtk3Addon.nativeInfo();
if (gtk3NativeInfo.gtkBackend !== 'gtk3') {
  console.error(`GTK3 native prebuild did not report gtk3: ${gtk3NativeInfo.gtkBackend}.`);
  process.exit(1);
}
if (gtk3NativeInfo.version !== packageJson.version) {
  console.error(`GTK3 native prebuild version mismatch: native=${gtk3NativeInfo.version} package=${packageJson.version}.`);
  process.exit(1);
}

const module = await import('gestament');
if (typeof module.launchGtkApp !== 'function') {
  console.error('gestament does not export launchGtkApp.');
  process.exit(1);
}
if (typeof module.createGtkAppLauncher !== 'function') {
  console.error('gestament does not export createGtkAppLauncher.');
  process.exit(1);
}
EOF
      if pkg-config --atleast-version=4.22 gtk4 >/dev/null 2>&1; then
        GESTAMENT_GTK_BACKEND=gtk4 node --input-type=module <<'EOF'
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';

const packageRoot = resolve('node_modules/gestament');
const packageJson = JSON.parse(
  readFileSync(resolve(packageRoot, 'package.json'), 'utf8')
);
const requireFromPackage = createRequire(resolve(packageRoot, 'package.json'));
const arch = process.arch;
const prebuildDir = {
  x64: 'linux-x64',
  ia32: 'linux-ia32',
  arm64: 'linux-arm64',
  arm: 'linux-arm',
  riscv64: 'linux-riscv64',
}[arch];
if (prebuildDir === undefined) {
  console.error(`Unsupported GTK4 smoke-test arch: ${arch}`);
  process.exit(1);
}
const prebuildFile = arch === 'arm'
  ? 'node.napi.armv7.glibc.node'
  : 'node.napi.glibc.node';
const gtk4Addon = requireFromPackage(
  resolve(packageRoot, 'prebuilds', prebuildDir, 'gtk4', prebuildFile)
);
const gtk4NativeInfo = gtk4Addon.nativeInfo();
if (gtk4NativeInfo.gtkBackend !== 'gtk4') {
  console.error(`GTK4 native prebuild did not report gtk4: ${gtk4NativeInfo.gtkBackend}.`);
  process.exit(1);
}
if (gtk4NativeInfo.version !== packageJson.version) {
  console.error(`GTK4 native prebuild version mismatch: native=${gtk4NativeInfo.version} package=${packageJson.version}.`);
  process.exit(1);
}

const module = await import('gestament');
if (typeof module.launchGtkApp !== 'function') {
  console.error('gestament does not export launchGtkApp under the GTK4 backend selection.');
  process.exit(1);
}
if (typeof module.createGtkAppLauncher !== 'function') {
  console.error('gestament does not export createGtkAppLauncher under the GTK4 backend selection.');
  process.exit(1);
}
EOF
      else
        printf '%s\n' 'Skipping GTK4 package runtime smoke test because gtk4 >= 4.22 is unavailable on this host.'
      fi
    )
    rm -rf "${tmp_dir}"
  else
    printf '%s\n' 'Skipping current-architecture npm import smoke test because the arch filter excludes this host.'
  fi
}

main() {
  TARGET='all'
  ARCH_FILTER=''
  PARALLEL_JOBS=''
  WITH_TESTS=0
  TEST_BACKENDS='gtk3'

  while [[ "$#" -gt 0 ]]; do
    case "$1" in
      --target)
        [[ "$#" -ge 2 ]] || fail 'Missing value for --target'
        TARGET=$2
        shift 2
        ;;
      --arch)
        [[ "$#" -ge 2 ]] || fail 'Missing value for --arch'
        ARCH_FILTER="$(normalize_arch_filter "$2")"
        shift 2
        ;;
      --jobs)
        [[ "$#" -ge 2 ]] || fail 'Missing value for --jobs'
        PARALLEL_JOBS=$2
        shift 2
        ;;
      --with-tests)
        WITH_TESTS=1
        shift
        ;;
      --test-backend)
        [[ "$#" -ge 2 ]] || fail 'Missing value for --test-backend'
        TEST_BACKENDS="$(normalize_test_backend_filter "$2")"
        shift 2
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

  case "${TARGET}" in
    native | npm | all)
      ;;
    *)
      fail "Unsupported target: ${TARGET}"
      ;;
  esac

  ensure_node_dependencies

  if [[ -n "${PARALLEL_JOBS}" ]]; then
    validate_positive_integer 'Parallel job count' "${PARALLEL_JOBS}"
  fi

  mkdir -p "${ARTIFACT_ROOT}" "${REPORT_ROOT}" "${TMP_ROOT}"
  rm -rf "${REPORT_ROOT}" "${TMP_ROOT}"
  mkdir -p "${REPORT_ROOT}" "${TMP_ROOT}"
  rm -f \
    "${ARTIFACT_ROOT}"/readelf-*.txt \
    "${ARTIFACT_ROOT}/npm-pack-list.txt" \
    "${ARTIFACT_ROOT}/npm-package-json.json"

  CPU_COUNT="$(detect_processor_count)"
  TEST_RUN_TIMESTAMP="${GESTAMENT_TEST_RUN_TIMESTAMP:-$(format_test_run_timestamp)}"
  export TEST_RUN_TIMESTAMP
  export GESTAMENT_TEST_RUN_TIMESTAMP="${TEST_RUN_TIMESTAMP}"
  if [[ -z "${PARALLEL_JOBS}" ]]; then
    PARALLEL_JOBS="$(min_int "${CPU_COUNT}" "${DEFAULT_PARALLEL_JOB_CAP}")"
  fi

  BUILD_TASK_COUNT=0
  if [[ "${TARGET}" = 'all' || "${TARGET}" = 'native' ]]; then
    BUILD_TASK_COUNT="$(count_native_builds)"
  fi
  if [[ "${WITH_TESTS}" -eq 1 ]]; then
    BUILD_TASK_COUNT=$((BUILD_TASK_COUNT + $(count_platform_tests)))
  fi
  if [[ "${BUILD_TASK_COUNT}" -gt 0 ]]; then
    EFFECTIVE_BUILD_JOBS="$(min_int "${PARALLEL_JOBS}" "${BUILD_TASK_COUNT}")"
  else
    EFFECTIVE_BUILD_JOBS=1
  fi
  MAKE_JOBS=$((CPU_COUNT / EFFECTIVE_BUILD_JOBS))
  if [[ "${MAKE_JOBS}" -lt 1 ]]; then
    MAKE_JOBS=1
  fi

  ACTIVE_JOB_PIDS=''
  ACTIVE_JOB_COUNT=0
  JOB_FAILURE=0

  printf '%s\n' "Using up to ${PARALLEL_JOBS} native package jobs with make -j${MAKE_JOBS}"

  if [[ "${TARGET}" = 'all' || "${TARGET}" = 'native' || "${WITH_TESTS}" -eq 1 ]]; then
    CONTAINER_ENGINE_BIN="$(choose_container_engine)"
  fi

  if [[ "${TARGET}" = 'all' || "${TARGET}" = 'native' ]]; then
    schedule_native_builds
    wait_for_all_jobs
    validate_native_artifacts
  fi

  if [[ "${WITH_TESTS}" -eq 1 ]]; then
    validate_native_artifacts
    build_javascript_artifacts
    ACTIVE_JOB_PIDS=''
    ACTIVE_JOB_COUNT=0
    JOB_FAILURE=0
    schedule_platform_tests
    wait_for_all_jobs
  fi

  if [[ "${TARGET}" = 'all' || "${TARGET}" = 'npm' ]]; then
    validate_native_artifacts
    build_npm_package
    validate_npm_package
  fi

  printf '%s\n' "Artifacts generated in ${ARTIFACT_ROOT}"
}

main "$@"
