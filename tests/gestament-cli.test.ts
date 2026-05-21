// gestament - TypeScript based test driver for GTK.
// Copyright (c) Kouji Matsui. (@kekyo@mi.kekyo.net)
// Under MIT.
// https://github.com/kekyo/gestament

import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { runGestamentCli } from '../src/gestament';

/////////////////////////////////////////////////////////////////////////////////////////

const tempRoots: string[] = [];

const createTempRoot = async (): Promise<string> => {
  const tempRoot = await mkdtemp(join(tmpdir(), 'gestament-cli-'));
  tempRoots.push(tempRoot);
  return tempRoot;
};

afterEach(async () => {
  await Promise.all(
    tempRoots.splice(0).map((tempRoot) =>
      rm(tempRoot, {
        force: true,
        recursive: true,
      })
    )
  );
});

describe('gestament CLI', () => {
  it('prints init usage', async () => {
    const tempRoot = await createTempRoot();
    const output = await runGestamentCli(['init', '--help'], tempRoot);

    expect(output.exitCode).toBe(0);
    expect(output.stderr).toBe('');
    expect(output.stdout).toContain('gestament init [directory]');
  });

  it('rejects unknown init options', async () => {
    const tempRoot = await createTempRoot();
    const output = await runGestamentCli(['init', '--unknown'], tempRoot);

    expect(output.exitCode).toBe(2);
    expect(output.stdout).toBe('');
    expect(output.stderr).toContain('unknown option: --unknown');
  });

  it('rejects invalid package names', async () => {
    const tempRoot = await createTempRoot();
    const output = await runGestamentCli(
      ['init', 'project', '--name', 'Bad Name'],
      tempRoot
    );

    expect(output.exitCode).toBe(2);
    expect(output.stdout).toBe('');
    expect(output.stderr).toContain('invalid package name: Bad Name');
  });

  it('refuses to overwrite existing scaffold files', async () => {
    const tempRoot = await createTempRoot();
    const projectRoot = join(tempRoot, 'project');
    const packageJsonPath = join(projectRoot, 'package.json');
    const gitIgnoreExamplePath = join(
      projectRoot,
      '.gitignore.gestament-example'
    );
    await mkdir(projectRoot);
    await writeFile(packageJsonPath, '{"name":"existing"}\n');
    await writeFile(gitIgnoreExamplePath, 'existing\n');

    const output = await runGestamentCli(['init', 'project'], tempRoot);

    expect(output.exitCode).toBe(2);
    expect(output.stdout).toBe('');
    expect(output.stderr).toContain('project/package.json');
    expect(output.stderr).toContain('project/.gitignore.gestament-example');
    await expect(readFile(packageJsonPath, 'utf8')).resolves.toBe(
      '{"name":"existing"}\n'
    );
    await expect(readFile(gitIgnoreExamplePath, 'utf8')).resolves.toBe(
      'existing\n'
    );
  });

  it('overwrites scaffold files when force is specified', async () => {
    const tempRoot = await createTempRoot();
    const projectRoot = join(tempRoot, 'project');
    await mkdir(projectRoot);
    await writeFile(join(projectRoot, 'package.json'), '{"name":"existing"}\n');
    await writeFile(
      join(projectRoot, '.gitignore.gestament-example'),
      'existing\n'
    );

    const output = await runGestamentCli(
      ['init', 'project', '--force', '--name', 'gtk-tests'],
      tempRoot
    );

    expect(output.exitCode).toBe(0);
    expect(output.stderr).toBe('');

    const packageJson = JSON.parse(
      await readFile(join(projectRoot, 'package.json'), 'utf8')
    ) as {
      readonly devDependencies: Record<string, string>;
      readonly name: string;
      readonly private: boolean;
      readonly scripts: Record<string, string>;
    };
    expect(packageJson).toMatchObject({
      name: 'gtk-tests',
      private: true,
      scripts: {
        test: 'vitest run',
      },
    });
    expect(packageJson.devDependencies.gestament).toMatch(/^\^\d/u);
    expect(packageJson.devDependencies.vitest).toBeDefined();
    expect(packageJson.devDependencies['prettier-max']).toBeUndefined();

    const vitestConfig = await readFile(
      join(projectRoot, 'vitest.config.ts'),
      'utf8'
    );
    expect(vitestConfig).not.toContain('prettier-max');
    expect(vitestConfig).not.toContain('plugins:');

    await expect(access(join(projectRoot, 'tests'))).resolves.toBe(undefined);
    await expect(access(join(projectRoot, 'vitest.config.ts'))).resolves.toBe(
      undefined
    );
    await expect(
      access(join(projectRoot, '.gitignore.gestament-example'))
    ).resolves.toBe(undefined);
    await expect(
      readFile(join(projectRoot, '.gitignore.gestament-example'), 'utf8')
    ).resolves.toBe(
      ['node_modules/', 'test-results/', 'coverage/', '*.log', ''].join('\n')
    );
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
  });
});
