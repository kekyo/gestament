// gestament - TypeScript based test driver for GTK.
// Copyright (c) Kouji Matsui. (@kekyo@mi.kekyo.net)
// Under MIT.
// https://github.com/kekyo/gestament

import { describe, expect, it } from 'vitest';

import { spawnText } from './process';

describe('spawnText', () => {
  it('captures text output and exit status', async () => {
    const result = await spawnText(
      process.execPath,
      [
        '-e',
        'process.stdout.write("out"); process.stderr.write("err"); process.exit(3);',
      ],
      {
        env: process.env,
        timeoutMs: 5000,
      }
    );

    expect(result).toMatchObject({
      signal: null,
      status: 3,
      stderr: 'err',
      stdout: 'out',
      timedOut: false,
    });
  });

  it('kills the child process when the timeout expires', async () => {
    const result = await spawnText(
      process.execPath,
      ['-e', 'setInterval(() => {}, 1000);'],
      {
        env: process.env,
        timeoutMs: 50,
      }
    );

    expect(result).toMatchObject({
      signal: 'SIGKILL',
      status: null,
      timedOut: true,
    });
    expect(result.stderr).toContain('Timed out after 50ms.');
  });
});
