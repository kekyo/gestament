// gestament - TypeScript based test driver for GTK.
// Copyright (c) Kouji Matsui. (@kekyo@mi.kekyo.net)
// Under MIT.
// https://github.com/kekyo/gestament

import { spawnSync } from 'node:child_process';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/////////////////////////////////////////////////////////////////////////////////////////

const buildPackageAllScript = fileURLToPath(
  new URL('../build_package_all.sh', import.meta.url)
);

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
          timeout: 10_000,
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
