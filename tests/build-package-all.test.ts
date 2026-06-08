// gestament - TypeScript based test driver for GTK.
// Copyright (c) Kouji Matsui. (@kekyo@mi.kekyo.net)
// Under MIT.
// https://github.com/kekyo/gestament

import { spawnSync } from 'node:child_process';
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { cliScriptTimeoutMs } from './support/testTimeouts';

/////////////////////////////////////////////////////////////////////////////////////////

const buildPackageAllScript = fileURLToPath(
  new URL('../build_package_all.sh', import.meta.url)
);
const buildPackageScript = fileURLToPath(
  new URL('../build_package.sh', import.meta.url)
);
const prereqScript = fileURLToPath(new URL('../prereq.sh', import.meta.url));

const canonicalCurrentArch = (): string => {
  switch (process.arch) {
    case 'x64':
      return 'amd64';
    case 'ia32':
      return 'i686';
    case 'arm64':
      return 'arm64';
    case 'arm':
      return 'armv7l';
    case 'riscv64':
      return 'riscv64';
    default:
      throw new Error(`Unsupported test host architecture: ${process.arch}`);
  }
};

const packageImageTag = (
  purpose: 'native' | 'test',
  backend: 'gtk3' | 'gtk4',
  release: string,
  arch: string
): string =>
  `localhost/gestament-pack-${purpose}-${backend}-debian-${release}-${arch}:latest`;

const gtk3NativeReleaseForArch = (arch: string): string =>
  arch === 'riscv64' ? 'trixie' : 'bookworm';

describe('build_package_all.sh', () => {
  it('runs the complete package build with container tests enabled', async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), 'gestament-package-all-'));
    const stubScript = join(tempRoot, 'build-package-stub.mjs');
    const argsPath = join(tempRoot, 'args.json');

    try {
      await writeFile(
        stubScript,
        `#!/usr/bin/env node
import { writeFileSync } from 'node:fs';

const argsPath = process.env.GESTAMENT_BUILD_PACKAGE_ARGS_PATH;
if (argsPath === undefined) {
  process.exit(2);
}
writeFileSync(argsPath, JSON.stringify(process.argv.slice(2)));
`
      );
      await chmod(stubScript, 0o755);

      const result = spawnSync(
        buildPackageAllScript,
        ['--arch', 'amd64', '--jobs', '2'],
        {
          encoding: 'utf8',
          env: {
            ...process.env,
            BUILD_PACKAGE_SCRIPT: stubScript,
            GESTAMENT_BUILD_PACKAGE_ARGS_PATH: argsPath,
          },
          timeout: cliScriptTimeoutMs,
        }
      );

      expect(result.status, result.stderr).toBe(0);

      const args = JSON.parse(await readFile(argsPath, 'utf8')) as string[];
      expect(args).toEqual([
        '--arch',
        'amd64',
        '--jobs',
        '2',
        '--target',
        'all',
        '--with-tests',
        '--test-backend',
        'all',
      ]);
    } finally {
      await rm(tempRoot, { force: true, recursive: true });
    }
  });
});

describe('build_package.sh platform test profiles', () => {
  it('passes native and cross execution profiles to platform test containers', async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), 'gestament-package-'));
    const binRoot = join(tempRoot, 'bin');
    const recordsPath = join(tempRoot, 'container-records.jsonl');
    const containerEnginePath = join(binRoot, 'container-engine-stub.mjs');
    const npmPath = join(binRoot, 'npm');
    const readelfPath = join(binRoot, 'readelf');
    const hostArch = canonicalCurrentArch();
    const crossArch = hostArch === 'amd64' ? 'arm64' : 'amd64';

    try {
      await mkdir(binRoot, { recursive: true });
      await writeFile(
        containerEnginePath,
        `#!/usr/bin/env node
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const args = process.argv.slice(2);
if (args[0] === 'image' && args[1] === 'exists') {
  process.exit(0);
}

const env = {};
let workspace = '';
let containerImage = '';

for (let index = 0; index < args.length; index += 1) {
  if (args[index] === '-e') {
    const value = args[index + 1] ?? '';
    const separatorIndex = value.indexOf('=');
    if (separatorIndex >= 0) {
      env[value.slice(0, separatorIndex)] = value.slice(separatorIndex + 1);
    }
    index += 1;
    continue;
  }

  if (args[index] === '-v') {
    const value = args[index + 1] ?? '';
    const match = /^(.*):\\/workspace(?::|$)/u.exec(value);
    if (match !== null) {
      workspace = match[1];
    }
    index += 1;
  }
}

const scriptIndex = args.findIndex((arg) => arg.startsWith('./scripts/'));
if (scriptIndex > 0) {
  containerImage = args[scriptIndex - 1] ?? '';
}
const pidsLimitIndex = args.indexOf('--pids-limit');
const pidsLimit = pidsLimitIndex < 0 ? null : args[pidsLimitIndex + 1] ?? '';

if (workspace.length === 0) {
  console.error('workspace volume was not passed to the container stub.');
  process.exit(2);
}

if (env.GESTAMENT_PREBUILD_DIR !== undefined) {
  const prebuildPath = join(
    workspace,
    'prebuilds',
    env.GESTAMENT_PREBUILD_DIR,
    env.GESTAMENT_PREBUILD_FILE
  );
  mkdirSync(dirname(prebuildPath), { recursive: true });
  writeFileSync(prebuildPath, 'native-prebuild-stub\\n');
}

if (scriptIndex > 0) {
  appendFileSync(
    process.env.GESTAMENT_CONTAINER_STUB_RECORDS,
    JSON.stringify({
      arch: env.GESTAMENT_ARCH,
      atspiProbeTimeoutMs: env.GESTAMENT_ATSPI_READINESS_PROBE_TIMEOUT_MS,
      backend: env.GESTAMENT_GTK_BACKEND,
      displayStartupTimeoutMs: env.GESTAMENT_DISPLAY_SESSION_STARTUP_TIMEOUT_MS,
      hostArch: env.GESTAMENT_TEST_HOST_ARCH,
      image: containerImage,
      pidsLimit,
      profile: env.GESTAMENT_TEST_EXECUTION_PROFILE,
      script: args[scriptIndex],
      targetArch: env.GESTAMENT_TEST_TARGET_ARCH,
      xvfbStartupTimeoutMs: env.GESTAMENT_XVFB_STARTUP_TIMEOUT_MS,
    }) + '\\n'
  );
}
`
      );
      await writeFile(
        npmPath,
        `#!/usr/bin/env node
process.exit(0);
`
      );
      await writeFile(
        readelfPath,
        `#!/usr/bin/env node
console.log('Class: ELF64');
console.log('Class: ELF32');
console.log('Machine: Advanced Micro Devices X86-64');
console.log('Machine: Intel 80386');
console.log('Machine: AArch64');
console.log('Machine: ARM');
console.log('Machine: RISC-V');
`
      );
      await Promise.all([
        chmod(containerEnginePath, 0o755),
        chmod(npmPath, 0o755),
        chmod(readelfPath, 0o755),
      ]);

      const result = spawnSync(
        buildPackageScript,
        [
          '--target',
          'native',
          '--with-tests',
          '--test-backend',
          'gtk3',
          '--arch',
          `${hostArch},${crossArch}`,
          '--jobs',
          '20',
        ],
        {
          encoding: 'utf8',
          env: {
            ...process.env,
            BUILD_PACKAGE_PROJECT_ROOT: tempRoot,
            CONTAINER_ENGINE: containerEnginePath,
            GESTAMENT_CONTAINER_STUB_RECORDS: recordsPath,
            PATH: `${binRoot}:${process.env.PATH ?? ''}`,
          },
          timeout: cliScriptTimeoutMs,
        }
      );

      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain(
        packageImageTag(
          'native',
          'gtk3',
          gtk3NativeReleaseForArch(hostArch),
          hostArch
        )
      );
      expect(result.stdout).toContain(
        packageImageTag('native', 'gtk4', 'sid', crossArch)
      );

      const records = (await readFile(recordsPath, 'utf8'))
        .trim()
        .split('\n')
        .map(
          (line) =>
            JSON.parse(line) as {
              readonly arch: string;
              readonly atspiProbeTimeoutMs?: string;
              readonly backend: string;
              readonly displayStartupTimeoutMs?: string;
              readonly hostArch?: string;
              readonly image: string;
              readonly pidsLimit: string | null;
              readonly profile?: string;
              readonly script: string;
              readonly targetArch?: string;
              readonly xvfbStartupTimeoutMs?: string;
            }
        );

      expect(records.every((record) => record.pidsLimit === '8192')).toBe(true);
      expect(
        records.some(
          (record) =>
            record.script === './scripts/build_native_prebuild_container.sh'
        )
      ).toBe(true);

      const platformRecords = records.filter(
        (record) => record.profile !== undefined
      );
      expect(platformRecords).toHaveLength(2);
      expect(platformRecords).toEqual(
        expect.arrayContaining([
          {
            arch: hostArch,
            atspiProbeTimeoutMs: '500',
            backend: 'gtk3',
            displayStartupTimeoutMs: '120000',
            hostArch,
            image: packageImageTag('test', 'gtk3', 'trixie', hostArch),
            pidsLimit: '8192',
            profile: 'native',
            script: './scripts/test_platform_container.sh',
            targetArch: hostArch,
            xvfbStartupTimeoutMs: '60000',
          },
          {
            arch: crossArch,
            atspiProbeTimeoutMs: '5000',
            backend: 'gtk3',
            displayStartupTimeoutMs: '300000',
            hostArch,
            image: packageImageTag('test', 'gtk3', 'trixie', crossArch),
            pidsLimit: '8192',
            profile: 'cross',
            script: './scripts/test_platform_container.sh',
            targetArch: crossArch,
            xvfbStartupTimeoutMs: '300000',
          },
        ])
      );

      await writeFile(recordsPath, '');
      const overrideResult = spawnSync(
        buildPackageScript,
        [
          '--target',
          'native',
          '--with-tests',
          '--test-backend',
          'gtk3',
          '--arch',
          `${hostArch},${crossArch}`,
          '--jobs',
          '20',
        ],
        {
          encoding: 'utf8',
          env: {
            ...process.env,
            BUILD_PACKAGE_PROJECT_ROOT: tempRoot,
            CONTAINER_ENGINE: containerEnginePath,
            GESTAMENT_CONTAINER_STUB_RECORDS: recordsPath,
            GESTAMENT_PACKAGE_TEST_PIDS_LIMIT: '4096',
            PATH: `${binRoot}:${process.env.PATH ?? ''}`,
          },
          timeout: cliScriptTimeoutMs,
        }
      );

      expect(overrideResult.status, overrideResult.stderr).toBe(0);
      const overrideRecords = (await readFile(recordsPath, 'utf8'))
        .trim()
        .split('\n')
        .map(
          (line) =>
            JSON.parse(line) as {
              readonly pidsLimit: string | null;
            }
        );
      expect(
        overrideRecords.every((record) => record.pidsLimit === '4096')
      ).toBe(true);
    } finally {
      await rm(tempRoot, { force: true, recursive: true });
    }
  });

  it('rejects a non-positive package test pids limit', () => {
    const result = spawnSync(buildPackageScript, ['--target', 'native'], {
      encoding: 'utf8',
      env: {
        ...process.env,
        GESTAMENT_PACKAGE_TEST_PIDS_LIMIT: '0',
      },
      timeout: cliScriptTimeoutMs,
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(
      'GESTAMENT_PACKAGE_TEST_PIDS_LIMIT must be a positive integer: 0'
    );
  });
});

describe('prereq.sh', () => {
  it('documents prerequisite image filters', () => {
    const result = spawnSync(prereqScript, ['--help'], {
      encoding: 'utf8',
      timeout: cliScriptTimeoutMs,
    });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('--backend <list>');
    expect(result.stdout).toContain('--purpose <list>');
    expect(result.stdout).toContain('--force');
  });

  it('rejects a non-positive image job count', () => {
    const result = spawnSync(prereqScript, ['--jobs', '0'], {
      encoding: 'utf8',
      timeout: cliScriptTimeoutMs,
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(
      'Parallel job count must be a positive integer: 0'
    );
  });

  it('builds selected prerequisite images with backend dependencies', async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), 'gestament-prereq-'));
    const binRoot = join(tempRoot, 'bin');
    const recordsPath = join(tempRoot, 'prereq-records.jsonl');
    const podmanPath = join(binRoot, 'podman');

    try {
      await mkdir(binRoot, { recursive: true });
      await writeFile(
        podmanPath,
        `#!/usr/bin/env node
import { appendFileSync, readFileSync } from 'node:fs';

const args = process.argv.slice(2);
if (args[0] === 'image' && args[1] === 'exists') {
  process.exit(1);
}
if (args[0] !== 'build') {
  console.error('unexpected podman command: ' + args.join(' '));
  process.exit(2);
}

const valueAfter = (name) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] ?? '' : '';
};
const buildArgIndex = args.indexOf('--build-arg');
const baseImage = buildArgIndex >= 0
  ? (args[buildArgIndex + 1] ?? '').replace(/^BASE_IMAGE=/u, '')
  : '';
const containerfile = valueAfter('-f');

appendFileSync(
  process.env.GESTAMENT_PREREQ_RECORDS,
  JSON.stringify({
    baseImage,
    containerfile: readFileSync(containerfile, 'utf8'),
    platform: valueAfter('--platform'),
    tag: valueAfter('-t'),
  }) + '\\n'
);
`
      );
      await chmod(podmanPath, 0o755);

      const result = spawnSync(
        prereqScript,
        [
          '--arch',
          'amd64',
          '--backend',
          'gtk4',
          '--purpose',
          'native,test',
          '--jobs',
          '1',
        ],
        {
          encoding: 'utf8',
          env: {
            ...process.env,
            GESTAMENT_PREREQ_RECORDS: recordsPath,
            PATH: `${binRoot}:${process.env.PATH ?? ''}`,
          },
          timeout: cliScriptTimeoutMs,
        }
      );

      expect(result.status, result.stderr).toBe(0);

      const records = (await readFile(recordsPath, 'utf8'))
        .trim()
        .split('\n')
        .map(
          (line) =>
            JSON.parse(line) as {
              readonly baseImage: string;
              readonly containerfile: string;
              readonly platform: string;
              readonly tag: string;
            }
        );
      const native = records.find((record) =>
        record.tag.includes('gestament-pack-native-gtk4')
      );
      const test = records.find((record) =>
        record.tag.includes('gestament-pack-test-gtk4')
      );

      expect(records).toHaveLength(2);
      expect(native).toMatchObject({
        baseImage: 'docker.io/amd64/debian:sid',
        platform: 'linux/amd64',
        tag: packageImageTag('native', 'gtk4', 'sid', 'amd64'),
      });
      expect(test).toMatchObject({
        baseImage: 'docker.io/amd64/debian:sid',
        platform: 'linux/amd64',
        tag: packageImageTag('test', 'gtk4', 'sid', 'amd64'),
      });
      expect(native?.containerfile).toContain('binutils');
      expect(native?.containerfile).toContain('libgtk-4-dev');
      expect(native?.containerfile).not.toContain('meson');
      expect(test?.containerfile).toContain('meson');
      expect(test?.containerfile).toContain('xvfb');
      expect(test?.containerfile).toContain('libgtk-4-dev');
      expect(test?.containerfile).toContain(
        'pkg-config --atleast-version=4.22 gtk4'
      );
    } finally {
      await rm(tempRoot, { force: true, recursive: true });
    }
  });
});
