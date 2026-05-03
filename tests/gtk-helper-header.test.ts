// gestament - TypeScript based test driver for GTK.
// Copyright (c) Kouji Matsui. (@kekyo@mi.kekyo.net)
// Under MIT.
// https://github.com/kekyo/gestament

import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

/////////////////////////////////////////////////////////////////////////////////////////

const execFileAsync = promisify(execFile);
const includeDir = resolve('include');

const pkgConfigExists = async (name: string): Promise<boolean> => {
  try {
    await execFileAsync('pkg-config', ['--exists', name]);
    return true;
  } catch {
    return false;
  }
};

const pkgConfigCflags = async (name: string): Promise<string[]> => {
  const { stdout } = await execFileAsync('pkg-config', ['--cflags', name]);
  return stdout.trim().length === 0 ? [] : stdout.trim().split(/\s+/);
};

const compileHeader = async (
  pkgConfigName: string,
  language: 'c' | 'c++'
): Promise<void> => {
  const tempDir = await mkdtemp(join(tmpdir(), 'gestament-gtk-helper-'));
  try {
    const sourcePath = join(
      tempDir,
      language === 'c' ? 'sample.c' : 'sample.cpp'
    );
    await writeFile(
      sourcePath,
      [
        '#include <gestament/gtk.h>',
        '',
        'int main(void) {',
        '  GtkBuilder *builder = NULL;',
        '  GtkWidget *widget = NULL;',
        '  gestament_gtk_assign_accessible_id(widget, "example_widget");',
        '  (void)gestament_gtk_assign_accessible_id_from_buildable(widget);',
        '  (void)gestament_gtk_assign_accessible_ids_from_builder(builder);',
        '  return 0;',
        '}',
        '',
      ].join('\n')
    );

    const compiler =
      language === 'c' ? (process.env.CC ?? 'cc') : (process.env.CXX ?? 'c++');
    const standard = language === 'c' ? '-std=c11' : '-std=c++17';
    const cflags = await pkgConfigCflags(pkgConfigName);

    await execFileAsync(compiler, [
      '-x',
      language,
      standard,
      '-fsyntax-only',
      '-I',
      includeDir,
      ...cflags,
      sourcePath,
    ]);
  } finally {
    await rm(tempDir, { force: true, recursive: true });
  }
};

/////////////////////////////////////////////////////////////////////////////////////////

describe('gestament GTK helper header', () => {
  it('compiles as C and C++ against GTK3', async () => {
    if (!(await pkgConfigExists('gtk+-3.0'))) {
      return;
    }

    await expect(compileHeader('gtk+-3.0', 'c')).resolves.toBeUndefined();
    await expect(compileHeader('gtk+-3.0', 'c++')).resolves.toBeUndefined();
  });

  it('compiles as C and C++ against GTK4 when GTK4 is installed', async () => {
    if (!(await pkgConfigExists('gtk4'))) {
      return;
    }

    await expect(compileHeader('gtk4', 'c')).resolves.toBeUndefined();
    await expect(compileHeader('gtk4', 'c++')).resolves.toBeUndefined();
  });
});
