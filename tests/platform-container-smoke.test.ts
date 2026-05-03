// gestament - TypeScript based test driver for GTK.
// Copyright (c) Kouji Matsui. (@kekyo@mi.kekyo.net)
// Under MIT.
// https://github.com/kekyo/gestament

import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/////////////////////////////////////////////////////////////////////////////////////////

const platformContainerSmokeScript = fileURLToPath(
  new URL('../scripts/platform_container_smoke.mjs', import.meta.url)
);

describe('platform_container_smoke.mjs', () => {
  it('requires the platform environment', () => {
    const result = spawnSync(process.execPath, [platformContainerSmokeScript], {
      encoding: 'utf8',
      env: {},
      timeout: 10_000,
    });

    expect(result.status).toBe(2);
    expect(result.stderr).toContain(
      'Missing required environment variable: GESTAMENT_ARCH'
    );
  });

  it('requires the container-resolved package version', () => {
    const result = spawnSync(process.execPath, [platformContainerSmokeScript], {
      encoding: 'utf8',
      env: {
        GESTAMENT_ARCH: 'amd64',
        GESTAMENT_GTK_BACKEND: 'gtk3',
      },
      timeout: 10_000,
    });

    expect(result.status).toBe(2);
    expect(result.stderr).toContain(
      'Missing required environment variable: GESTAMENT_PACKAGE_VERSION'
    );
  });

  it('resolves the expected prebuild path for the requested platform', async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), 'gestament-platform-smoke-'));

    try {
      await writeFile(
        join(tempRoot, 'package.json'),
        JSON.stringify(
          {
            name: 'gestament',
            version: '0.0.36',
            type: 'module',
          },
          null,
          2
        ) + '\n'
      );

      const result = spawnSync(
        process.execPath,
        [platformContainerSmokeScript],
        {
          cwd: tempRoot,
          encoding: 'utf8',
          env: {
            GESTAMENT_ARCH: 'armv7l',
            GESTAMENT_GTK_BACKEND: 'gtk3',
            GESTAMENT_PACKAGE_VERSION: '0.0.36',
          },
          timeout: 10_000,
        }
      );

      expect(result.status).toBe(1);
      expect(result.stderr).toContain(
        'prebuilds/linux-arm/gtk3/node.napi.armv7.glibc.node'
      );
    } finally {
      await rm(tempRoot, { force: true, recursive: true });
    }
  });

  it('rejects invalid smoke timeout values', async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), 'gestament-platform-smoke-'));

    try {
      const result = spawnSync(
        process.execPath,
        [platformContainerSmokeScript],
        {
          cwd: tempRoot,
          encoding: 'utf8',
          env: {
            GESTAMENT_ARCH: 'amd64',
            GESTAMENT_GTK_BACKEND: 'gtk4',
            GESTAMENT_PACKAGE_VERSION: '0.0.36',
            GESTAMENT_PLATFORM_SMOKE_TIMEOUT_MS: '0',
          },
          timeout: 10_000,
        }
      );

      expect(result.status).toBe(2);
      expect(result.stderr).toContain(
        'GESTAMENT_PLATFORM_SMOKE_TIMEOUT_MS must be a positive integer: 0'
      );
    } finally {
      await rm(tempRoot, { force: true, recursive: true });
    }
  });
});
