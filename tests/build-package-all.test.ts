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
const env = {};
let workspace = '';

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

if (env.GESTAMENT_TEST_EXECUTION_PROFILE !== undefined) {
  appendFileSync(
    process.env.GESTAMENT_CONTAINER_STUB_RECORDS,
    JSON.stringify({
      arch: env.GESTAMENT_ARCH,
      atspiProbeTimeoutMs: env.GESTAMENT_ATSPI_READINESS_PROBE_TIMEOUT_MS,
      backend: env.GESTAMENT_GTK_BACKEND,
      displayStartupTimeoutMs: env.GESTAMENT_DISPLAY_SESSION_STARTUP_TIMEOUT_MS,
      hostArch: env.GESTAMENT_TEST_HOST_ARCH,
      profile: env.GESTAMENT_TEST_EXECUTION_PROFILE,
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

      const records = (await readFile(recordsPath, 'utf8'))
        .trim()
        .split('\n')
        .map(
          (line) =>
            JSON.parse(line) as {
              readonly arch: string;
              readonly atspiProbeTimeoutMs: string;
              readonly backend: string;
              readonly displayStartupTimeoutMs: string;
              readonly hostArch: string;
              readonly profile: string;
              readonly targetArch: string;
              readonly xvfbStartupTimeoutMs: string;
            }
        );

      expect(records).toHaveLength(2);
      expect(records).toEqual(
        expect.arrayContaining([
          {
            arch: hostArch,
            atspiProbeTimeoutMs: '500',
            backend: 'gtk3',
            displayStartupTimeoutMs: '120000',
            hostArch,
            profile: 'native',
            targetArch: hostArch,
            xvfbStartupTimeoutMs: '60000',
          },
          {
            arch: crossArch,
            atspiProbeTimeoutMs: '5000',
            backend: 'gtk3',
            displayStartupTimeoutMs: '300000',
            hostArch,
            profile: 'cross',
            targetArch: crossArch,
            xvfbStartupTimeoutMs: '300000',
          },
        ])
      );
    } finally {
      await rm(tempRoot, { force: true, recursive: true });
    }
  });
});
