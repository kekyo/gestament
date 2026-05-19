// gestament - TypeScript based test driver for GTK.
// Copyright (c) Kouji Matsui. (@kekyo@mi.kekyo.net)
// Under MIT.
// https://github.com/kekyo/gestament

import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/////////////////////////////////////////////////////////////////////////////////////////

const xvfbBin = fileURLToPath(
  new URL('../dist/gestament-xvfb.cjs', import.meta.url)
);
const packageEntryPath = fileURLToPath(
  new URL('../dist/index.cjs', import.meta.url)
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

  it('starts launcher-scoped Xvfb sessions from createGtkAppLauncher', () => {
    const tempDirectory = mkdtempSync(join(tmpdir(), 'gestament-xvfb-'));
    const firstAppEnvPath = join(tempDirectory, 'first-app-env.json');
    const secondAppEnvPath = join(tempDirectory, 'second-app-env.json');
    const hostFallbackAppEnvPath = join(
      tempDirectory,
      'host-fallback-app-env.json'
    );
    const env = { ...process.env };
    delete env.AT_SPI_BUS_ADDRESS;
    delete env.DBUS_SESSION_BUS_ADDRESS;
    delete env.DISPLAY;
    delete env.GESTAMENT_XVFB_ACTIVE;
    delete env.GSETTINGS_BACKEND;
    delete env.GTK_THEME;
    delete env.WAYLAND_DISPLAY;

    try {
      const script = `
const { existsSync, readFileSync, writeFileSync } = require('node:fs');
const { createGtkAppLauncher } = require(${JSON.stringify(packageEntryPath)});
const childScript = (appEnvPath) => [
  "const { writeFileSync } = require('node:fs');",
  "writeFileSync(" + JSON.stringify(appEnvPath) + ", JSON.stringify({",
  "  dbusSessionBusAddress: process.env.DBUS_SESSION_BUS_ADDRESS ?? null,",
  "  display: process.env.DISPLAY ?? null,",
  "  gdkBackend: process.env.GDK_BACKEND ?? null,",
  "  gsettingsBackend: process.env.GSETTINGS_BACKEND ?? null,",
  "  gtkTheme: process.env.GTK_THEME ?? null,",
  "}));",
  "setInterval(() => {}, 2147483647);",
].join("\\n");
const delay = (timeoutMs) => new Promise((resolve) => setTimeout(resolve, timeoutMs));
const waitForAppEnv = async (appEnvPath) => {
  for (let index = 0; index < 40; index += 1) {
    if (existsSync(appEnvPath)) {
      return JSON.parse(readFileSync(appEnvPath, 'utf8'));
    }
    await delay(25);
  }
  throw new Error('Timed out waiting for child environment output.');
};
const firstLauncher = createGtkAppLauncher({
  appPath: process.execPath,
  args: ['-e', childScript(${JSON.stringify(firstAppEnvPath)})],
  gsettings: null,
  theme: null,
  xvfbScreen: '640x480x24',
  xvfbTrayHost: false,
});
const secondLauncher = createGtkAppLauncher({
  appPath: process.execPath,
  args: ['-e', childScript(${JSON.stringify(secondAppEnvPath)})],
  xvfbScreen: '800x600x24',
  xvfbTrayHost: false,
});
(async () => {
  const [firstApp, secondApp] = await Promise.all([
    firstLauncher.launch(),
    secondLauncher.launch(),
  ]);
  try {
    const [firstCapture, secondCapture, firstAppEnv, secondAppEnv] =
      await Promise.all([
        firstApp.capture(),
        secondApp.capture(),
        waitForAppEnv(${JSON.stringify(firstAppEnvPath)}),
        waitForAppEnv(${JSON.stringify(secondAppEnvPath)}),
      ]);
    const invalidIndexCode = await firstApp.windowAt(-1).then(
      () => null,
      (error) => error && error.code ? error.code : null
    );
    await Promise.all([firstLauncher.release(), secondLauncher.release()]);
    const hostFallbackLauncher = createGtkAppLauncher({
      appPath: process.execPath,
      args: ['-e', childScript(${JSON.stringify(hostFallbackAppEnvPath)})],
      display: 'host',
      xvfbScreen: '320x240x24',
      xvfbTrayHost: false,
    });
    try {
      const hostFallbackApp = await hostFallbackLauncher.launch();
      const hostFallbackCapture = await hostFallbackApp.capture();
      const hostFallbackAppEnv = await waitForAppEnv(${JSON.stringify(
        hostFallbackAppEnvPath
      )});
      console.log(JSON.stringify({
        firstAppEnv,
        firstBounds: firstCapture.bounds,
        hostFallbackAppEnv,
        hostFallbackBounds: hostFallbackCapture.bounds,
        invalidIndexCode,
        parentDbusSessionBusAddress: process.env.DBUS_SESSION_BUS_ADDRESS ?? null,
        parentDisplay: process.env.DISPLAY ?? null,
        secondAppEnv,
        secondBounds: secondCapture.bounds,
        sessionsAreDifferent:
          firstAppEnv.display !== secondAppEnv.display &&
          firstAppEnv.dbusSessionBusAddress !== secondAppEnv.dbusSessionBusAddress,
      }));
    } finally {
      await hostFallbackLauncher.release();
    }
  } finally {
    await Promise.all([firstLauncher.release(), secondLauncher.release()]);
  }
})().catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  process.exit(1);
});
`;
      const result = spawnSync(process.execPath, ['-e', script], {
        encoding: 'utf8',
        env,
        timeout: 60_000,
      });

      expect(result.status, result.stderr).toBe(0);
      const outputLine = result.stdout.trim().split('\n').at(-1);
      expect(outputLine).toBeDefined();
      const output = JSON.parse(outputLine as string) as {
        readonly firstAppEnv: {
          readonly dbusSessionBusAddress: string | null;
          readonly display: string | null;
          readonly gdkBackend: string | null;
          readonly gsettingsBackend: string | null;
          readonly gtkTheme: string | null;
        };
        readonly firstBounds: {
          readonly height: number;
          readonly width: number;
        };
        readonly hostFallbackAppEnv: {
          readonly dbusSessionBusAddress: string | null;
          readonly display: string | null;
        };
        readonly hostFallbackBounds: {
          readonly height: number;
          readonly width: number;
        };
        readonly invalidIndexCode: string | null;
        readonly parentDbusSessionBusAddress: string | null;
        readonly parentDisplay: string | null;
        readonly secondAppEnv: {
          readonly dbusSessionBusAddress: string | null;
          readonly display: string | null;
        };
        readonly secondBounds: {
          readonly height: number;
          readonly width: number;
        };
        readonly sessionsAreDifferent: boolean;
      };

      expect(output.firstAppEnv).toMatchObject({
        gdkBackend: 'x11',
        gsettingsBackend: null,
        gtkTheme: null,
      });
      expect(output.firstBounds).toMatchObject({
        height: 480,
        width: 640,
      });
      expect(output.secondBounds).toMatchObject({
        height: 600,
        width: 800,
      });
      expect(output.hostFallbackBounds).toMatchObject({
        height: 240,
        width: 320,
      });
      expect(output.invalidIndexCode).toBe('INVALID_ARGUMENT');
      expect(output.parentDbusSessionBusAddress).toBeNull();
      expect(output.parentDisplay).toBeNull();
      expect(output.firstAppEnv.display).toMatch(/^:[0-9]+(?:\\.[0-9]+)?$/u);
      expect(output.secondAppEnv.display).toMatch(/^:[0-9]+(?:\\.[0-9]+)?$/u);
      expect(output.hostFallbackAppEnv.display).toMatch(
        /^:[0-9]+(?:\\.[0-9]+)?$/u
      );
      expect(output.firstAppEnv.dbusSessionBusAddress).not.toBeNull();
      expect(output.secondAppEnv.dbusSessionBusAddress).not.toBeNull();
      expect(output.sessionsAreDifferent).toBe(true);
    } finally {
      rmSync(tempDirectory, { force: true, recursive: true });
    }
  });
});
