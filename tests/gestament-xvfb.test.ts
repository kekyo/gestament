// gestament - TypeScript based test driver for GTK.
// Copyright (c) Kouji Matsui. (@kekyo@mi.kekyo.net)
// Under MIT.
// https://github.com/kekyo/gestament

import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { spawnText } from './support/process';
import {
  xvfbLauncherChildEnvironmentTimeoutMs,
  xvfbLauncherScriptTimeoutMs,
  xvfbPoolChildEnvironmentTimeoutMs,
  xvfbPoolFixtureTimeoutMs,
  xvfbPoolScriptTimeoutMs,
} from './support/testTimeouts';

/////////////////////////////////////////////////////////////////////////////////////////

const xvfbBin = fileURLToPath(
  new URL('../dist/gestament-xvfb.cjs', import.meta.url)
);
const packageEntryPath = fileURLToPath(
  new URL('../dist/index.cjs', import.meta.url)
);
const testBackend = process.env.GESTAMENT_TEST_BACKEND ?? 'gtk3';
const fixtureAppPath = fileURLToPath(
  new URL(
    `../.build/${testBackend}-test-app/${testBackend}-test-app`,
    import.meta.url
  )
);
const fixtureAppExists = existsSync(fixtureAppPath);

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
  dbusSessionBusAddress: process.env.DBUS_SESSION_BUS_ADDRESS ?? null,
  display: process.env.DISPLAY ?? null,
  gdkBackend: process.env.GDK_BACKEND ?? null,
  gestamentXvfbActive: process.env.GESTAMENT_XVFB_ACTIVE ?? null,
  noAtBridge: process.env.NO_AT_BRIDGE ?? null,
  status: result.status,
  stderr: result.stderr.trim(),
  stdout: result.stdout.trim(),
  waylandDisplay: process.env.WAYLAND_DISPLAY ?? null,
  xauthority: process.env.XAUTHORITY ?? null,
  xdgSessionType: process.env.XDG_SESSION_TYPE ?? null,
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
  it('prints a prerequisite installation hint when xvfb-run cannot start', () => {
    const tempDirectory = mkdtempSync(join(tmpdir(), 'gestament-empty-path-'));
    try {
      const result = spawnSync(
        process.execPath,
        [xvfbBin, '--screen=640x480x24', '--', process.execPath, '-e', ''],
        {
          encoding: 'utf8',
          env: {
            ...process.env,
            PATH: tempDirectory,
          },
          timeout: 30_000,
        }
      );

      expect(result.status, result.stderr).toBe(1);
      expect(result.stderr).toContain('gestament-xvfb failed to start');
      expect(result.stderr).toContain('sudo apt-get update');
      expect(result.stderr).toContain('at-spi2-core dbus dbus-x11');
      expect(result.stderr).toContain('xauth xvfb');
    } finally {
      rmSync(tempDirectory, { force: true, recursive: true });
    }
  });

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
          DBUS_SESSION_BUS_ADDRESS: 'unix:path=/tmp/gestament-host-dbus',
          DISPLAY: ':77',
          GDK_BACKEND: 'wayland',
          GESTAMENT_XVFB_ACTIVE: 'host',
          NO_AT_BRIDGE: '1',
          WAYLAND_DISPLAY: 'wayland-host',
          XAUTHORITY: '/tmp/gestament-host-xauthority',
          XDG_SESSION_TYPE: 'wayland',
        },
        timeout: 30_000,
      }
    );

    expect(result.status, result.stderr).toBe(0);

    const probeOutputLine = result.stdout.trim().split('\n').at(-1);
    expect(probeOutputLine).toBeDefined();
    const probe = JSON.parse(probeOutputLine as string) as {
      readonly atSpiBusAddress: string | null;
      readonly dbusSessionBusAddress: string | null;
      readonly display: string | null;
      readonly gdkBackend: string | null;
      readonly gestamentXvfbActive: string | null;
      readonly noAtBridge: string | null;
      readonly stderr: string;
      readonly stdout: string;
      readonly waylandDisplay: string | null;
      readonly xauthority: string | null;
      readonly xdgSessionType: string | null;
    };

    expect(probe.atSpiBusAddress).toBeNull();
    expect(probe.dbusSessionBusAddress).not.toBe(
      'unix:path=/tmp/gestament-host-dbus'
    );
    expect(probe.display).not.toBeNull();
    expect(probe.display).not.toBe(':77');
    expect(probe.gdkBackend).toBe('x11');
    expect(probe.gestamentXvfbActive).toBe('1');
    expect(probe.noAtBridge).toBeNull();
    expect(probe.waylandDisplay).toBeNull();
    expect(probe.xauthority).not.toBe('/tmp/gestament-host-xauthority');
    expect(probe.xdgSessionType).toBe('x11');
    expect(probe.stdout, probe.stderr).toContain('/at-spi/bus_');
    expect(atSpiBusNumber(probe.stdout)).toBe(
      displayNumber(probe.display as string)
    );
  });

  it(
    'starts launcher-scoped Xvfb sessions from createGtkAppLauncher',
    async () => {
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
      delete env.NO_AT_BRIDGE;
      delete env.WAYLAND_DISPLAY;
      delete env.XAUTHORITY;
      delete env.XDG_SESSION_TYPE;

      try {
        const script = `
const { spawnSync } = require('node:child_process');
const { existsSync, readFileSync, writeFileSync } = require('node:fs');
const { createGtkAppLauncher } = require(${JSON.stringify(packageEntryPath)});
const childScript = (appEnvPath) => [
  "const { writeFileSync } = require('node:fs');",
  "writeFileSync(" + JSON.stringify(appEnvPath) + ", JSON.stringify({",
  "  atSpiBusAddress: process.env.AT_SPI_BUS_ADDRESS ?? null,",
  "  dbusSessionBusAddress: process.env.DBUS_SESSION_BUS_ADDRESS ?? null,",
  "  display: process.env.DISPLAY ?? null,",
  "  gdkBackend: process.env.GDK_BACKEND ?? null,",
  "  gestamentXvfbActive: process.env.GESTAMENT_XVFB_ACTIVE ?? null,",
  "  gsettingsBackend: process.env.GSETTINGS_BACKEND ?? null,",
  "  gtkTheme: process.env.GTK_THEME ?? null,",
  "  noAtBridge: process.env.NO_AT_BRIDGE ?? null,",
  "  waylandDisplay: process.env.WAYLAND_DISPLAY ?? null,",
  "  xauthority: process.env.XAUTHORITY ?? null,",
  "  xdgSessionType: process.env.XDG_SESSION_TYPE ?? null,",
  "}));",
  "setInterval(() => {}, 2147483647);",
].join("\\n");
const delay = (timeoutMs) => new Promise((resolve) => setTimeout(resolve, timeoutMs));
const waitForAppEnv = async (appEnvPath) => {
  const startedAt = Date.now();
  const timeoutMs = ${JSON.stringify(xvfbLauncherChildEnvironmentTimeoutMs)};
  while (Date.now() - startedAt <= timeoutMs) {
    if (existsSync(appEnvPath)) {
      return JSON.parse(readFileSync(appEnvPath, 'utf8'));
    }
    await delay(25);
  }
  throw new Error('Timed out waiting for child environment output.');
};
const pickSessionEnv = (env) => ({
  atSpiBusAddress: env.AT_SPI_BUS_ADDRESS ?? null,
  dbusSessionBusAddress: env.DBUS_SESSION_BUS_ADDRESS ?? null,
  display: env.DISPLAY ?? null,
  gdkBackend: env.GDK_BACKEND ?? null,
  gestamentXvfbActive: env.GESTAMENT_XVFB_ACTIVE ?? null,
  gsettingsBackend: env.GSETTINGS_BACKEND ?? null,
  gtkTheme: env.GTK_THEME ?? null,
  noAtBridge: env.NO_AT_BRIDGE ?? null,
  waylandDisplay: env.WAYLAND_DISPLAY ?? null,
  xauthority: env.XAUTHORITY ?? null,
  xdgSessionType: env.XDG_SESSION_TYPE ?? null,
});
const probeEnvironment = (env) => {
  const result = spawnSync(process.execPath, ['-e', [
    "console.log(JSON.stringify({",
    "  dbusSessionBusAddress: process.env.DBUS_SESSION_BUS_ADDRESS ?? null,",
    "  display: process.env.DISPLAY ?? null,",
    "}));",
  ].join("\\n")], { encoding: 'utf8', env });
  if (result.status !== 0) {
    throw new Error(result.stderr);
  }
  return JSON.parse(result.stdout.trim());
};
Object.assign(process.env, {
  AT_SPI_BUS_ADDRESS: 'unix:path=/tmp/gestament-host-at-spi',
  DBUS_SESSION_BUS_ADDRESS: 'unix:path=/tmp/gestament-host-dbus',
  DISPLAY: ':77',
  GESTAMENT_XVFB_ACTIVE: 'host',
  NO_AT_BRIDGE: '1',
  WAYLAND_DISPLAY: 'wayland-host',
  XAUTHORITY: '/tmp/gestament-host-xauthority',
  XDG_SESSION_TYPE: 'wayland',
});
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
    const [firstLauncherApiEnv, firstAppApiEnv] = await Promise.all([
      firstLauncher.environment(),
      firstApp.environment(),
    ]);
    const firstLauncherEnv = pickSessionEnv(firstLauncherApiEnv);
    const firstAppReportedEnv = pickSessionEnv(firstAppApiEnv);
    const firstLauncherProbeEnv = probeEnvironment(firstLauncherApiEnv);
    const firstAppProbeEnv = probeEnvironment(firstAppApiEnv);
    const invalidSessionEnvCodes = await Promise.all(
      [
        'DISPLAY',
        'WAYLAND_DISPLAY',
        'GDK_BACKEND',
        'DBUS_SESSION_BUS_ADDRESS',
        'AT_SPI_BUS_ADDRESS',
        'NO_AT_BRIDGE',
        'XAUTHORITY',
        'GESTAMENT_XVFB_ACTIVE',
        'XDG_SESSION_TYPE',
      ].map(async (key) => {
        const launcher = createGtkAppLauncher({
          appPath: process.execPath,
          env: { [key]: 'invalid' },
          xvfbTrayHost: false,
        });
        try {
          await launcher.environment();
          return null;
        } catch (error) {
          return error && error.code ? error.code : null;
        } finally {
          await launcher.release();
        }
      })
    );
    const invalidIndexCode = await firstApp.windowAt(-1).then(
      () => null,
      (error) => error && error.code ? error.code : null
    );
    await Promise.all([firstLauncher.release(), secondLauncher.release()]);
    delete process.env.AT_SPI_BUS_ADDRESS;
    delete process.env.DBUS_SESSION_BUS_ADDRESS;
    delete process.env.DISPLAY;
    delete process.env.GESTAMENT_XVFB_ACTIVE;
    delete process.env.NO_AT_BRIDGE;
    delete process.env.WAYLAND_DISPLAY;
    delete process.env.XAUTHORITY;
    delete process.env.XDG_SESSION_TYPE;
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
        firstAppProbeEnv,
        firstAppReportedEnv,
        firstBounds: firstCapture.bounds,
        firstLauncherEnv,
        firstLauncherProbeEnv,
        hostFallbackAppEnv,
        hostFallbackBounds: hostFallbackCapture.bounds,
        invalidSessionEnvCodes,
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
        const result = await spawnText(process.execPath, ['-e', script], {
          env,
          timeoutMs: xvfbLauncherScriptTimeoutMs,
        });

        expect(result.status, result.stderr).toBe(0);
        const outputLine = result.stdout.trim().split('\n').at(-1);
        expect(outputLine).toBeDefined();
        const output = JSON.parse(outputLine as string) as {
          readonly firstAppEnv: {
            readonly atSpiBusAddress: string | null;
            readonly dbusSessionBusAddress: string | null;
            readonly display: string | null;
            readonly gdkBackend: string | null;
            readonly gestamentXvfbActive: string | null;
            readonly gsettingsBackend: string | null;
            readonly gtkTheme: string | null;
            readonly noAtBridge: string | null;
            readonly waylandDisplay: string | null;
            readonly xauthority: string | null;
            readonly xdgSessionType: string | null;
          };
          readonly firstAppProbeEnv: {
            readonly dbusSessionBusAddress: string | null;
            readonly display: string | null;
          };
          readonly firstAppReportedEnv: {
            readonly atSpiBusAddress: string | null;
            readonly dbusSessionBusAddress: string | null;
            readonly display: string | null;
            readonly gdkBackend: string | null;
            readonly gestamentXvfbActive: string | null;
            readonly noAtBridge: string | null;
            readonly waylandDisplay: string | null;
            readonly xauthority: string | null;
            readonly xdgSessionType: string | null;
          };
          readonly firstBounds: {
            readonly height: number;
            readonly width: number;
          };
          readonly firstLauncherEnv: {
            readonly atSpiBusAddress: string | null;
            readonly dbusSessionBusAddress: string | null;
            readonly display: string | null;
            readonly gdkBackend: string | null;
            readonly gestamentXvfbActive: string | null;
            readonly noAtBridge: string | null;
            readonly waylandDisplay: string | null;
            readonly xauthority: string | null;
            readonly xdgSessionType: string | null;
          };
          readonly firstLauncherProbeEnv: {
            readonly dbusSessionBusAddress: string | null;
            readonly display: string | null;
          };
          readonly hostFallbackAppEnv: {
            readonly dbusSessionBusAddress: string | null;
            readonly display: string | null;
          };
          readonly hostFallbackBounds: {
            readonly height: number;
            readonly width: number;
          };
          readonly invalidSessionEnvCodes: readonly (string | null)[];
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
          atSpiBusAddress: null,
          gdkBackend: 'x11',
          gestamentXvfbActive: '1',
          gsettingsBackend: null,
          gtkTheme: null,
          noAtBridge: null,
          waylandDisplay: null,
          xdgSessionType: 'x11',
        });
        expect(output.firstLauncherEnv).toMatchObject({
          atSpiBusAddress: null,
          display: output.firstAppEnv.display,
          gdkBackend: 'x11',
          gestamentXvfbActive: '1',
          noAtBridge: null,
          waylandDisplay: null,
          xdgSessionType: 'x11',
        });
        expect(output.firstAppReportedEnv).toMatchObject({
          atSpiBusAddress: null,
          display: output.firstAppEnv.display,
          gdkBackend: 'x11',
          gestamentXvfbActive: '1',
          noAtBridge: null,
          waylandDisplay: null,
          xdgSessionType: 'x11',
        });
        expect(output.firstAppEnv.xauthority).not.toBe(
          '/tmp/gestament-host-xauthority'
        );
        expect(output.firstLauncherEnv.xauthority).not.toBe(
          '/tmp/gestament-host-xauthority'
        );
        expect(output.firstAppReportedEnv.xauthority).not.toBe(
          '/tmp/gestament-host-xauthority'
        );
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
        expect(output.firstAppReportedEnv.dbusSessionBusAddress).toBe(
          output.firstAppEnv.dbusSessionBusAddress
        );
        expect(output.firstLauncherEnv.dbusSessionBusAddress).toBe(
          output.firstAppEnv.dbusSessionBusAddress
        );
        expect(output.firstAppProbeEnv).toEqual({
          dbusSessionBusAddress: output.firstAppEnv.dbusSessionBusAddress,
          display: output.firstAppEnv.display,
        });
        expect(output.firstLauncherProbeEnv).toEqual({
          dbusSessionBusAddress: output.firstAppEnv.dbusSessionBusAddress,
          display: output.firstAppEnv.display,
        });
        expect(output.secondAppEnv.display).toMatch(/^:[0-9]+(?:\\.[0-9]+)?$/u);
        expect(output.hostFallbackAppEnv.display).toMatch(
          /^:[0-9]+(?:\\.[0-9]+)?$/u
        );
        expect(output.firstAppEnv.dbusSessionBusAddress).not.toBeNull();
        expect(output.secondAppEnv.dbusSessionBusAddress).not.toBeNull();
        expect(output.invalidSessionEnvCodes).toEqual([
          'INVALID_ARGUMENT',
          'INVALID_ARGUMENT',
          'INVALID_ARGUMENT',
          'INVALID_ARGUMENT',
          'INVALID_ARGUMENT',
          'INVALID_ARGUMENT',
          'INVALID_ARGUMENT',
          'INVALID_ARGUMENT',
          'INVALID_ARGUMENT',
        ]);
        expect(output.sessionsAreDifferent).toBe(true);
      } finally {
        rmSync(tempDirectory, { force: true, recursive: true });
      }
    },
    xvfbLauncherScriptTimeoutMs + 30_000
  );

  it(
    'reuses Xvfb resources only when xvfbPool opts in',
    async () => {
      const tempDirectory = mkdtempSync(join(tmpdir(), 'gestament-xvfb-pool-'));
      const env = { ...process.env };
      delete env.AT_SPI_BUS_ADDRESS;
      delete env.DBUS_SESSION_BUS_ADDRESS;
      delete env.DISPLAY;
      delete env.GESTAMENT_XVFB_ACTIVE;
      delete env.GSETTINGS_BACKEND;
      delete env.GTK_THEME;
      delete env.NO_AT_BRIDGE;
      delete env.WAYLAND_DISPLAY;
      delete env.XAUTHORITY;
      delete env.XDG_SESSION_TYPE;

      try {
        const script = `
const { existsSync, readFileSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const { createGtkAppLauncher } = require(${JSON.stringify(packageEntryPath)});
const tempDirectory = ${JSON.stringify(tempDirectory)};
let appEnvIndex = 0;
const childScript = (appEnvPath) => [
  "const { writeFileSync } = require('node:fs');",
  "writeFileSync(" + JSON.stringify(appEnvPath) + ", JSON.stringify({",
  "  dbusSessionBusAddress: process.env.DBUS_SESSION_BUS_ADDRESS ?? null,",
  "  display: process.env.DISPLAY ?? null,",
  "}));",
  "setInterval(() => {}, 2147483647);",
].join("\\n");
const delay = (timeoutMs) => new Promise((resolve) => setTimeout(resolve, timeoutMs));
const waitForAppEnv = async (appEnvPath) => {
  const startedAt = Date.now();
  const timeoutMs = ${JSON.stringify(xvfbPoolChildEnvironmentTimeoutMs)};
  while (Date.now() - startedAt <= timeoutMs) {
    if (existsSync(appEnvPath)) {
      return JSON.parse(readFileSync(appEnvPath, 'utf8'));
    }
    await delay(25);
  }
  throw new Error('Timed out waiting for child environment output.');
};
const pickSessionEnv = (env) => ({
  dbusSessionBusAddress: env.DBUS_SESSION_BUS_ADDRESS ?? null,
  display: env.DISPLAY ?? null,
});
const assertSameSessionEnv = (label, actual, expected) => {
  if (
    actual.dbusSessionBusAddress !== expected.dbusSessionBusAddress ||
    actual.display !== expected.display
  ) {
    throw new Error(label + ' did not match the launched application environment.');
  }
};
const nodeAppOptions = (options) => {
  const appEnvPath = join(tempDirectory, "app-env-" + appEnvIndex + ".json");
  appEnvIndex += 1;
  return {
    appEnvPath,
    launcherOptions: {
      ...options,
      appPath: process.execPath,
      args: ['-e', childScript(appEnvPath)],
      xvfbTrayHost: false,
    },
  };
};
const launchNodeApp = async (options) => {
  const resolvedOptions = nodeAppOptions(options);
  const launcher = createGtkAppLauncher(resolvedOptions.launcherOptions);
  const launcherEnv = pickSessionEnv(await launcher.environment());
  const app = await launcher.launch();
  const env = await waitForAppEnv(resolvedOptions.appEnvPath);
  const appEnv = pickSessionEnv(await app.environment());
  assertSameSessionEnv('launcher.environment()', launcherEnv, env);
  assertSameSessionEnv('app.environment()', appEnv, env);
  const capture = await app.capture();
  return { app, bounds: capture.bounds, env, launcher };
};
const releaseNodeApp = async (options) => {
  const launched = await launchNodeApp(options);
  await launched.launcher.release();
  return { bounds: launched.bounds, env: launched.env };
};
const errorCode = async (operation) => operation().then(
  () => null,
  (error) => error && error.code ? error.code : null
);
const invalidPoolCode = async (xvfbPool) => {
  const launcher = createGtkAppLauncher({
    appPath: process.execPath,
    xvfbPool,
  });
  return errorCode(() => launcher.launch());
};
const displaySet = (launched) =>
  launched.map((entry) => entry.env.display).sort().join('|');
(async () => {
  const invalidPoolCodes = await Promise.all([
    invalidPoolCode('invalid'),
    invalidPoolCode('xvfb'),
    invalidPoolCode({}),
    invalidPoolCode({ type: 'none' }),
    invalidPoolCode({ type: 'xvfb', maxIdlePerKey: -1 }),
    invalidPoolCode({ type: 'xvfb', maxIdleTotal: 1.5 }),
  ]);

  const firstXvfb = await releaseNodeApp({
    xvfbPool: { type: 'xvfb' },
    xvfbScreen: '360x240x24',
  });
  const secondXvfb = await releaseNodeApp({
    xvfbPool: { type: 'xvfb' },
    xvfbScreen: '360x240x24',
  });
  const thirdXvfb = await releaseNodeApp({
    xvfbPool: { type: 'xvfb' },
    xvfbScreen: '390x260x24',
  });

  const firstNoRetain = await releaseNodeApp({
    xvfbPool: { type: 'all', maxIdleTotal: 0 },
    xvfbScreen: '370x250x24',
  });
  const secondNoRetain = await releaseNodeApp({
    xvfbPool: { type: 'all', maxIdleTotal: 0 },
    xvfbScreen: '370x250x24',
  });
  const firstNoRetainPerKey = await releaseNodeApp({
    xvfbPool: { type: 'all', maxIdlePerKey: 0 },
    xvfbScreen: '380x260x24',
  });
  const secondNoRetainPerKey = await releaseNodeApp({
    xvfbPool: { type: 'all', maxIdlePerKey: 0 },
    xvfbScreen: '380x260x24',
  });

  const firstPair = await Promise.all([
    launchNodeApp({
      xvfbPool: { type: 'xvfb', maxIdlePerKey: 2, maxIdleTotal: 4 },
      xvfbScreen: '410x280x24',
    }),
    launchNodeApp({
      xvfbPool: { type: 'xvfb', maxIdlePerKey: 2, maxIdleTotal: 4 },
      xvfbScreen: '410x280x24',
    }),
  ]);
  const firstPairDisplays = displaySet(firstPair);
  await Promise.all(firstPair.map((entry) => entry.launcher.release()));
  const secondPair = await Promise.all([
    launchNodeApp({
      xvfbPool: { type: 'xvfb', maxIdlePerKey: 2, maxIdleTotal: 4 },
      xvfbScreen: '410x280x24',
    }),
    launchNodeApp({
      xvfbPool: { type: 'xvfb', maxIdlePerKey: 2, maxIdleTotal: 4 },
      xvfbScreen: '410x280x24',
    }),
  ]);
  const secondPairDisplays = displaySet(secondPair);
  await Promise.all(secondPair.map((entry) => entry.launcher.release()));

  const totalFirst = await releaseNodeApp({
    xvfbPool: { type: 'xvfb', maxIdleTotal: 1 },
    xvfbScreen: '520x310x24',
  });
  const totalSecond = await releaseNodeApp({
    xvfbPool: { type: 'xvfb', maxIdleTotal: 1 },
    xvfbScreen: '530x320x24',
  });
  const totalFirstAgain = await launchNodeApp({
    xvfbPool: { type: 'xvfb', maxIdleTotal: 1 },
    xvfbScreen: '520x310x24',
  });
  const totalSecondAgain = await launchNodeApp({
    xvfbPool: { type: 'xvfb', maxIdleTotal: 1 },
    xvfbScreen: '530x320x24',
  });
  const totalPoolResults = {
    firstWasEvicted: totalFirstAgain.env.display !== totalFirst.env.display,
    secondWasRetained: totalSecondAgain.env.display === totalSecond.env.display,
  };
  await Promise.all([
    totalFirstAgain.launcher.release(),
    totalSecondAgain.launcher.release(),
  ]);

  const firstAll = await launchNodeApp({
    xvfbPool: { type: 'all' },
    xvfbScreen: '430x310x24',
  });
  await firstAll.launcher.release();
  const oldAllAppCode = await errorCode(() => firstAll.app.capture());
  const secondAll = await releaseNodeApp({
    xvfbPool: { type: 'all' },
    xvfbScreen: '430x310x24',
  });

  let coverWindowIsAbsent = true;
  let firstFixtureWindowCount = 0;
  let oldFixtureAppCode = 'SKIPPED';
  let secondFixtureWindowCount = 0;
  let staleElementCode = 'SKIPPED';
  if (${JSON.stringify(fixtureAppExists)}) {
    const fixtureLauncher = createGtkAppLauncher({
      appPath: ${JSON.stringify(fixtureAppPath)},
      args: ['--cover-submit-button'],
      timeoutMs: ${JSON.stringify(xvfbPoolFixtureTimeoutMs)},
      xvfbPool: { type: 'all' },
      xvfbScreen: '500x350x24',
      xvfbTrayHost: false,
    });
    const fixtureApp = await fixtureLauncher.launch();
    const heldElement = await fixtureApp.getById('main_window');
    firstFixtureWindowCount = await fixtureApp.getWindowCount();
    await fixtureLauncher.release();
    oldFixtureAppCode = await errorCode(() => fixtureApp.getWindowCount());
    staleElementCode = await errorCode(() => heldElement.info());

    const nextFixtureLauncher = createGtkAppLauncher({
      appPath: ${JSON.stringify(fixtureAppPath)},
      timeoutMs: ${JSON.stringify(xvfbPoolFixtureTimeoutMs)},
      xvfbPool: { type: 'all' },
      xvfbScreen: '500x350x24',
      xvfbTrayHost: false,
    });
    try {
      const nextFixtureApp = await nextFixtureLauncher.launch();
      secondFixtureWindowCount = await nextFixtureApp.getWindowCount();
      coverWindowIsAbsent = (await nextFixtureApp.findById('cover_window')) === undefined;
    } finally {
      await nextFixtureLauncher.release();
    }
  }
  console.log(JSON.stringify({
    coverWindowIsAbsent,
    firstAll,
    firstFixtureWindowCount,
    firstNoRetain,
    firstNoRetainPerKey,
    firstPairDisplays,
    firstXvfb,
    invalidPoolCodes,
    oldAllAppCode,
    oldFixtureAppCode,
    secondAll,
    secondFixtureWindowCount,
    secondNoRetain,
    secondNoRetainPerKey,
    secondPairDisplays,
    secondXvfb,
    staleElementCode,
    thirdXvfb,
    totalPoolResults,
  }));
})().catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  process.exit(1);
});
`;
        const result = await spawnText(process.execPath, ['-e', script], {
          env,
          timeoutMs: xvfbPoolScriptTimeoutMs,
        });

        expect(result.status, result.stderr).toBe(0);
        const outputLine = result.stdout.trim().split('\n').at(-1);
        expect(outputLine).toBeDefined();
        const output = JSON.parse(outputLine as string) as {
          readonly coverWindowIsAbsent: boolean;
          readonly firstAll: {
            readonly bounds: {
              readonly height: number;
              readonly width: number;
            };
            readonly env: {
              readonly dbusSessionBusAddress: string | null;
              readonly display: string | null;
            };
          };
          readonly firstFixtureWindowCount: number;
          readonly firstNoRetain: {
            readonly env: {
              readonly dbusSessionBusAddress: string | null;
              readonly display: string | null;
            };
          };
          readonly firstNoRetainPerKey: {
            readonly env: {
              readonly dbusSessionBusAddress: string | null;
              readonly display: string | null;
            };
          };
          readonly firstPairDisplays: string;
          readonly firstXvfb: {
            readonly bounds: {
              readonly height: number;
              readonly width: number;
            };
            readonly env: {
              readonly dbusSessionBusAddress: string | null;
              readonly display: string | null;
            };
          };
          readonly invalidPoolCodes: readonly (string | null)[];
          readonly oldAllAppCode: string | null;
          readonly oldFixtureAppCode: string | null;
          readonly secondAll: {
            readonly bounds: {
              readonly height: number;
              readonly width: number;
            };
            readonly env: {
              readonly dbusSessionBusAddress: string | null;
              readonly display: string | null;
            };
          };
          readonly secondFixtureWindowCount: number;
          readonly secondNoRetain: {
            readonly env: {
              readonly dbusSessionBusAddress: string | null;
              readonly display: string | null;
            };
          };
          readonly secondNoRetainPerKey: {
            readonly env: {
              readonly dbusSessionBusAddress: string | null;
              readonly display: string | null;
            };
          };
          readonly secondPairDisplays: string;
          readonly secondXvfb: {
            readonly env: {
              readonly dbusSessionBusAddress: string | null;
              readonly display: string | null;
            };
          };
          readonly staleElementCode: string | null;
          readonly thirdXvfb: {
            readonly bounds: {
              readonly height: number;
              readonly width: number;
            };
            readonly env: {
              readonly display: string | null;
            };
          };
          readonly totalPoolResults: {
            readonly firstWasEvicted: boolean;
            readonly secondWasRetained: boolean;
          };
        };

        expect(output.invalidPoolCodes).toEqual([
          'INVALID_ARGUMENT',
          'INVALID_ARGUMENT',
          'INVALID_ARGUMENT',
          'INVALID_ARGUMENT',
          'INVALID_ARGUMENT',
          'INVALID_ARGUMENT',
        ]);
        expect(output.firstXvfb.bounds).toMatchObject({
          height: 240,
          width: 360,
        });
        expect(output.thirdXvfb.bounds).toMatchObject({
          height: 260,
          width: 390,
        });
        expect(output.firstXvfb.env.display).toBe(
          output.secondXvfb.env.display
        );
        expect(output.firstXvfb.env.dbusSessionBusAddress).not.toBe(
          output.secondXvfb.env.dbusSessionBusAddress
        );
        expect(output.thirdXvfb.env.display).not.toBe(
          output.firstXvfb.env.display
        );
        expect(output.firstNoRetain.env.dbusSessionBusAddress).not.toBe(
          output.secondNoRetain.env.dbusSessionBusAddress
        );
        expect(output.firstNoRetainPerKey.env.dbusSessionBusAddress).not.toBe(
          output.secondNoRetainPerKey.env.dbusSessionBusAddress
        );
        expect(output.firstPairDisplays).toBe(output.secondPairDisplays);
        expect(output.totalPoolResults).toMatchObject({
          firstWasEvicted: true,
          secondWasRetained: true,
        });

        expect(output.firstAll.bounds).toMatchObject({
          height: 310,
          width: 430,
        });
        expect(output.firstAll.env.display).toBe(output.secondAll.env.display);
        expect(output.firstAll.env.dbusSessionBusAddress).toBe(
          output.secondAll.env.dbusSessionBusAddress
        );
        expect(output.oldAllAppCode).toBe('APP_EXITED');
        if (fixtureAppExists) {
          expect(output.oldFixtureAppCode).toBe('APP_EXITED');
          expect(output.staleElementCode).toBe('STALE_ELEMENT');
          expect(output.firstFixtureWindowCount).toBeGreaterThanOrEqual(1);
          expect(output.secondFixtureWindowCount).toBeGreaterThanOrEqual(1);
          expect(output.coverWindowIsAbsent).toBe(true);
        } else {
          expect(output.oldFixtureAppCode).toBe('SKIPPED');
          expect(output.staleElementCode).toBe('SKIPPED');
        }
      } finally {
        rmSync(tempDirectory, { force: true, recursive: true });
      }
    },
    xvfbPoolScriptTimeoutMs + 30_000
  );
});
