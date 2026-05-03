// gestament - TypeScript based test driver for GTK.
// Copyright (c) Kouji Matsui. (@kekyo@mi.kekyo.net)
// Under MIT.
// https://github.com/kekyo/gestament

import { describe, expect, it } from 'vitest';

import { createGestamentConfigOutput } from '../src/gestament-config';

/////////////////////////////////////////////////////////////////////////////////////////

describe('gestament-config output', () => {
  const includeDir = '/tmp/project/node_modules/gestament/include';

  it('prints the include directory', () => {
    expect(createGestamentConfigOutput(['--includedir'], includeDir)).toEqual({
      exitCode: 0,
      stderr: '',
      stdout: `${includeDir}\n`,
    });
  });

  it('prints compiler flags', () => {
    expect(createGestamentConfigOutput(['--cflags'], includeDir)).toEqual({
      exitCode: 0,
      stderr: '',
      stdout: `-I${includeDir}\n`,
    });
  });

  it('prints usage text', () => {
    const output = createGestamentConfigOutput(['--help'], includeDir);

    expect(output.exitCode).toBe(0);
    expect(output.stderr).toBe('');
    expect(output.stdout).toContain('gestament-config --includedir');
  });

  it('rejects unknown options', () => {
    const output = createGestamentConfigOutput(['--unknown'], includeDir);

    expect(output.exitCode).toBe(2);
    expect(output.stdout).toBe('');
    expect(output.stderr).toContain('unknown option: --unknown');
  });
});
