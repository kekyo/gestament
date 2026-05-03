// gestament - TypeScript based test driver for GTK.
// Copyright (c) Kouji Matsui. (@kekyo@mi.kekyo.net)
// Under MIT.
// https://github.com/kekyo/gestament

import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/////////////////////////////////////////////////////////////////////////////////////////

const xvfbBin = fileURLToPath(
  new URL('../dist/gestament-xvfb.cjs', import.meta.url)
);

const atSpiProbeScript = `
const { spawnSync } = require('node:child_process');
const result = spawnSync(
  'gdbus',
  [
    'call',
    '--session',
    '--dest',
    'org.a11y.Bus',
    '--object-path',
    '/org/a11y/bus',
    '--method',
    'org.a11y.Bus.GetAddress',
  ],
  { encoding: 'utf8' }
);
console.log(JSON.stringify({
  atSpiBusAddress: process.env.AT_SPI_BUS_ADDRESS ?? null,
  display: process.env.DISPLAY ?? null,
  status: result.status,
  stderr: result.stderr.trim(),
  stdout: result.stdout.trim(),
}));
process.exit(result.status ?? 1);
`;

const displayNumber = (display: string): string => {
  const match = /^:([0-9]+)(?:\\.[0-9]+)?$/.exec(display);
  if (match === null) {
    throw new Error(`Unexpected DISPLAY value: ${display}`);
  }
  return match[1] as string;
};

const atSpiBusNumber = (address: string): string => {
  const match = /(?:^|[/,])bus_([0-9]+)(?:,|$)/.exec(address);
  if (match === null) {
    throw new Error(`Unexpected AT-SPI bus address: ${address}`);
  }
  return match[1] as string;
};

describe('gestament-xvfb', () => {
  it('starts the session bus inside Xvfb for AT-SPI isolation', () => {
    const result = spawnSync(
      process.execPath,
      [
        xvfbBin,
        '--screen=640x480x24',
        '--',
        process.execPath,
        '-e',
        atSpiProbeScript,
      ],
      {
        encoding: 'utf8',
        env: {
          ...process.env,
          AT_SPI_BUS_ADDRESS: 'unix:path=/tmp/gestament-host-at-spi',
        },
        timeout: 30_000,
      }
    );

    expect(result.status, result.stderr).toBe(0);

    const probeOutputLine = result.stdout.trim().split('\n').at(-1);
    expect(probeOutputLine).toBeDefined();
    const probe = JSON.parse(probeOutputLine as string) as {
      readonly atSpiBusAddress: string | null;
      readonly display: string | null;
      readonly stderr: string;
      readonly stdout: string;
    };

    expect(probe.atSpiBusAddress).toBeNull();
    expect(probe.display).not.toBeNull();
    expect(probe.stdout, probe.stderr).toContain('/at-spi/bus_');
    expect(atSpiBusNumber(probe.stdout)).toBe(
      displayNumber(probe.display as string)
    );
  });
});
