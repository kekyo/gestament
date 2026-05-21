// gestament - TypeScript based test driver for GTK.
// Copyright (c) Kouji Matsui. (@kekyo@mi.kekyo.net)
// Under MIT.
// https://github.com/kekyo/gestament

import { spawnSync } from 'node:child_process';
import { access, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import {
  ensureTestArtifactDirectory,
  getTaskFullName,
} from './support/testArtifacts';

/////////////////////////////////////////////////////////////////////////////////////////

const readmeInitCommand = 'npx gestament init';
const gestamentCliPath = fileURLToPath(
  new URL('../dist/gestament.cjs', import.meta.url)
);

interface ScaffoldedPackageJson {
  readonly name: string;
  readonly private: boolean;
  readonly scripts: {
    readonly test: string;
  };
  readonly devDependencies: {
    readonly '@types/node': string;
    readonly gestament: string;
    readonly typescript: string;
    readonly vitest: string;
  };
}

describe('README gestament init example', () => {
  it('generates the documented minimal gestament test project', async (context) => {
    const readme = await readFile('README.md', 'utf8');
    expect(readme).toContain(readmeInitCommand);

    const artifactDirectory = await ensureTestArtifactDirectory(
      getTaskFullName(context.task),
      context.task.id
    );
    const initRoot = join(artifactDirectory, 'gestament-init', 'my-gtk-app');
    await rm(initRoot, { force: true, recursive: true });
    await mkdir(initRoot, { recursive: true });

    const result = spawnSync(process.execPath, [gestamentCliPath, 'init'], {
      cwd: initRoot,
      encoding: 'utf8',
      env: process.env,
      timeout: 20_000,
    });
    await writeFile(join(initRoot, 'gestament-init.stdout.log'), result.stdout);
    await writeFile(join(initRoot, 'gestament-init.stderr.log'), result.stderr);

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);

    const projectRoot = initRoot;
    const packageJson = JSON.parse(
      await readFile(join(projectRoot, 'package.json'), 'utf8')
    ) as ScaffoldedPackageJson;

    expect(packageJson).toMatchObject({
      name: 'my-gtk-app',
      private: true,
      scripts: {
        test: 'vitest run',
      },
    });
    expect(packageJson.devDependencies.gestament).toMatch(/^\^\d/u);
    expect(packageJson.devDependencies.vitest).toBeDefined();
    expect(packageJson.devDependencies.typescript).toBeDefined();
    expect(packageJson.devDependencies['@types/node']).toBeDefined();
    expect('prettier-max' in packageJson.devDependencies).toBe(false);

    await expect(access(join(projectRoot, 'tsconfig.json'))).resolves.toBe(
      undefined
    );
    await expect(access(join(projectRoot, 'vitest.config.ts'))).resolves.toBe(
      undefined
    );
    await expect(access(join(projectRoot, 'tests'))).resolves.toBe(undefined);
    await expect(
      access(join(projectRoot, '.gitignore.gestament-example'))
    ).resolves.toBe(undefined);

    await expect(access(join(projectRoot, 'index.html'))).rejects.toMatchObject(
      {
        code: 'ENOENT',
      }
    );
    await expect(access(join(projectRoot, 'public'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    await expect(
      access(join(projectRoot, 'src', 'main.ts'))
    ).rejects.toMatchObject({
      code: 'ENOENT',
    });
    await expect(access(join(projectRoot, '.gitignore'))).rejects.toMatchObject(
      {
        code: 'ENOENT',
      }
    );
    await expect(
      access(join(projectRoot, '.prettierrc'))
    ).rejects.toMatchObject({
      code: 'ENOENT',
    });
    await expect(
      access(join(projectRoot, '.prettierignore'))
    ).rejects.toMatchObject({
      code: 'ENOENT',
    });

    const vitestConfig = await readFile(
      join(projectRoot, 'vitest.config.ts'),
      'utf8'
    );
    expect(vitestConfig).not.toContain('prettier-max');
    expect(vitestConfig).not.toContain('plugins:');
  });
});
