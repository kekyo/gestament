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
  appOutputExitTimeoutMs,
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
  {
    encoding: 'utf8',
    timeout: ${JSON.stringify(xvfbLauncherChildEnvironmentTimeoutMs)},
  }
);
console.log(JSON.stringify({
  atSpiBusAddress: process.env.AT_SPI_BUS_ADDRESS ?? null,
  dbusSessionBusAddress: process.env.DBUS_SESSION_BUS_ADDRESS ?? null,
  display: process.env.DISPLAY ?? null,
  gdkBackend: process.env.GDK_BACKEND ?? null,
  gestamentXvfbActive: process.env.GESTAMENT_XVFB_ACTIVE ?? null,
  gioUseVfs: process.env.GIO_USE_VFS ?? null,
  gnomeAccessibility: process.env.GNOME_ACCESSIBILITY ?? null,
  gnomeKeyringControl: process.env.GNOME_KEYRING_CONTROL ?? null,
  gtkUsePortal: process.env.GTK_USE_PORTAL ?? null,
  noAtBridge: process.env.NO_AT_BRIDGE ?? null,
  sshAuthSock: process.env.SSH_AUTH_SOCK ?? null,
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

describe.concurrent('gestament-xvfb', () => {
  it('prints a prerequisite installation hint when Xvfb cannot start', () => {
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
          timeout: xvfbLauncherScriptTimeoutMs,
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

  it('allocates distinct displays for concurrent gestament-xvfb processes', async () => {
    const tempDirectory = mkdtempSync(
      join(tmpdir(), 'gestament-xvfb-concurrent-')
    );
    const probeWaitTimeoutMs = Math.max(
      1_000,
      Math.floor(xvfbLauncherScriptTimeoutMs * 0.9)
    );
    const probeScript = (index: number): string =>
      [
        "const { existsSync, renameSync, writeFileSync } = require('node:fs');",
        "const { join } = require('node:path');",
        `const tempDirectory = ${JSON.stringify(tempDirectory)};`,
        `const index = ${JSON.stringify(index)};`,
        'const expectedProbeCount = 2;',
        `const timeoutMs = ${JSON.stringify(probeWaitTimeoutMs)};`,
        'const probePath = join(tempDirectory, `probe-${index}.json`);',
        'const probeTempPath = `${probePath}.tmp-${process.pid}`;',
        'const probe = {',
        '  display: process.env.DISPLAY ?? null,',
        '  xauthority: process.env.XAUTHORITY ?? null,',
        '};',
        'writeFileSync(probeTempPath, JSON.stringify(probe));',
        'renameSync(probeTempPath, probePath);',
        'const startedAt = Date.now();',
        'const waitForPeers = () => {',
        '  for (let candidate = 0; candidate < expectedProbeCount; candidate += 1) {',
        '    if (!existsSync(join(tempDirectory, `probe-${candidate}.json`))) {',
        '      if (Date.now() - startedAt > timeoutMs) {',
        "        console.error('Timed out waiting for peer gestament-xvfb probe.');",
        '        process.exit(2);',
        '      }',
        '      setTimeout(waitForPeers, 25);',
        '      return;',
        '    }',
        '  }',
        '  console.log(JSON.stringify(probe));',
        '  setTimeout(() => process.exit(0), 100);',
        '};',
        'waitForPeers();',
      ].join('\n');
    const env = { ...process.env };
    delete env.AT_SPI_BUS_ADDRESS;
    delete env.DBUS_SESSION_BUS_ADDRESS;
    delete env.DISPLAY;
    delete env.GESTAMENT_XVFB_ACTIVE;
    delete env.NO_AT_BRIDGE;
    delete env.WAYLAND_DISPLAY;
    delete env.XAUTHORITY;

    try {
      const launches = await Promise.all([
        spawnText(
          process.execPath,
          [
            xvfbBin,
            '--screen=640x480x24',
            '--',
            process.execPath,
            '-e',
            probeScript(0),
          ],
          {
            env,
            timeoutMs: xvfbLauncherScriptTimeoutMs,
          }
        ),
        spawnText(
          process.execPath,
          [
            xvfbBin,
            '--screen=640x480x24',
            '--',
            process.execPath,
            '-e',
            probeScript(1),
          ],
          {
            env,
            timeoutMs: xvfbLauncherScriptTimeoutMs,
          }
        ),
      ]);

      for (const launch of launches) {
        expect(launch.status, launch.stderr).toBe(0);
      }

      const probes = launches.map((launch) => {
        const line = launch.stdout.trim().split('\n').at(-1);
        expect(line).toBeDefined();
        return JSON.parse(line as string) as {
          readonly display: string | null;
          readonly xauthority: string | null;
        };
      });

      expect(probes[0]?.display).not.toBeNull();
      expect(probes[1]?.display).not.toBeNull();
      expect(probes[0]?.display).not.toBe(probes[1]?.display);
      expect(probes[0]?.xauthority).toBeNull();
      expect(probes[1]?.xauthority).toBeNull();
    } finally {
      rmSync(tempDirectory, { force: true, recursive: true });
    }
  });

  it('starts concurrent launchers in one Node process with usable X11 displays', async () => {
    const env = { ...process.env };
    delete env.AT_SPI_BUS_ADDRESS;
    delete env.DBUS_SESSION_BUS_ADDRESS;
    delete env.DISPLAY;
    delete env.GESTAMENT_XVFB_ACTIVE;
    delete env.NO_AT_BRIDGE;
    delete env.WAYLAND_DISPLAY;
    delete env.XAUTHORITY;

    const script = `
const { createGtkAppLauncher } = require(${JSON.stringify(packageEntryPath)});
const childScript = 'setInterval(() => {}, 2147483647);';
const launchOne = async (index) => {
  const launcher = createGtkAppLauncher({
    appPath: process.execPath,
    args: ['-e', childScript],
    systemOutputBufferBytes: 4000,
    xvfbTrayHost: false,
  });
  let app;
  try {
    app = await launcher.launch();
    const environment = await app.environment();
    const capture = await app.capture();
    return {
      display: environment.DISPLAY ?? null,
      height: capture.bounds.height,
      index,
      width: capture.bounds.width,
    };
  } finally {
    if (app !== undefined) {
      await app.release().catch(() => undefined);
    }
    await launcher.release().catch(() => undefined);
  }
};
(async () => {
  const results = await Promise.all(
    Array.from({ length: 4 }, (_value, index) => launchOne(index))
  );
  console.log(JSON.stringify(results));
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
    const line = result.stdout.trim().split('\n').at(-1);
    expect(line).toBeDefined();
    const results = JSON.parse(line as string) as readonly {
      readonly display: string | null;
      readonly height: number;
      readonly width: number;
    }[];
    expect(results).toHaveLength(4);
    const displays = results.map((entry) => entry.display);
    expect(displays.every((display) => display !== null)).toBe(true);
    expect(new Set(displays).size).toBe(displays.length);
    for (const entry of results) {
      expect(entry.width).toBeGreaterThan(0);
      expect(entry.height).toBeGreaterThan(0);
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
        timeout: xvfbLauncherScriptTimeoutMs,
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

  it('starts a minimal accessibility session inside Xvfb', () => {
    const result = spawnSync(
      process.execPath,
      [
        xvfbBin,
        '--screen=640x480x24',
        '--accessibility-session=minimal',
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
          GIO_USE_VFS: 'gvfs',
          GNOME_ACCESSIBILITY: '0',
          GNOME_KEYRING_CONTROL: '/tmp/gestament-keyring',
          GTK_USE_PORTAL: '1',
          NO_AT_BRIDGE: '1',
          SSH_AUTH_SOCK: '/tmp/gestament-ssh.sock',
          WAYLAND_DISPLAY: 'wayland-host',
          XAUTHORITY: '/tmp/gestament-host-xauthority',
          XDG_SESSION_TYPE: 'wayland',
        },
        timeout: xvfbLauncherScriptTimeoutMs,
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
      readonly gioUseVfs: string | null;
      readonly gnomeAccessibility: string | null;
      readonly gnomeKeyringControl: string | null;
      readonly gtkUsePortal: string | null;
      readonly noAtBridge: string | null;
      readonly sshAuthSock: string | null;
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
    expect(probe.gioUseVfs).toBe('local');
    expect(probe.gnomeAccessibility).toBe('1');
    expect(probe.gnomeKeyringControl).toBeNull();
    expect(probe.gtkUsePortal).toBe('0');
    expect(probe.noAtBridge).toBeNull();
    expect(probe.sshAuthSock).toBeNull();
    expect(probe.waylandDisplay).toBeNull();
    expect(probe.xauthority).not.toBe('/tmp/gestament-host-xauthority');
    expect(probe.xdgSessionType).toBe('x11');
    expect(probe.stdout, probe.stderr).toContain('/at-spi/bus_');
    expect(atSpiBusNumber(probe.stdout)).toBe(
      displayNumber(probe.display as string)
    );
  });

  it('starts launcher-scoped minimal accessibility sessions', async () => {
    const env = {
      ...process.env,
      AT_SPI_BUS_ADDRESS: 'unix:path=/tmp/gestament-host-at-spi',
      DBUS_SESSION_BUS_ADDRESS: 'unix:path=/tmp/gestament-host-dbus',
      DISPLAY: ':77',
      GDK_BACKEND: 'wayland',
      GESTAMENT_XVFB_ACTIVE: 'host',
      GIO_USE_VFS: 'gvfs',
      GNOME_ACCESSIBILITY: '0',
      GNOME_KEYRING_CONTROL: '/tmp/gestament-keyring',
      GTK_USE_PORTAL: '1',
      NO_AT_BRIDGE: '1',
      SSH_AUTH_SOCK: '/tmp/gestament-ssh.sock',
      WAYLAND_DISPLAY: 'wayland-host',
      XAUTHORITY: '/tmp/gestament-host-xauthority',
      XDG_SESSION_TYPE: 'wayland',
    };
    const script = `
const { spawnSync } = require('node:child_process');
const { createGtkAppLauncher } = require(${JSON.stringify(packageEntryPath)});
const pickEnv = (env) => ({
  atSpiBusAddress: env.AT_SPI_BUS_ADDRESS ?? null,
  dbusSessionBusAddress: env.DBUS_SESSION_BUS_ADDRESS ?? null,
  display: env.DISPLAY ?? null,
  gdkBackend: env.GDK_BACKEND ?? null,
  gestamentXvfbActive: env.GESTAMENT_XVFB_ACTIVE ?? null,
  gioUseVfs: env.GIO_USE_VFS ?? null,
  gnomeAccessibility: env.GNOME_ACCESSIBILITY ?? null,
  gnomeKeyringControl: env.GNOME_KEYRING_CONTROL ?? null,
  gtkUsePortal: env.GTK_USE_PORTAL ?? null,
  noAtBridge: env.NO_AT_BRIDGE ?? null,
  sshAuthSock: env.SSH_AUTH_SOCK ?? null,
  waylandDisplay: env.WAYLAND_DISPLAY ?? null,
  xauthority: env.XAUTHORITY ?? null,
  xdgSessionType: env.XDG_SESSION_TYPE ?? null,
});
const childScript = [
  "const pickEnv = " + pickEnv.toString() + ";",
  "console.log(JSON.stringify(pickEnv(process.env)));",
  "setInterval(() => {}, 2147483647);",
].join("\\n");
const delay = (timeoutMs) => new Promise((resolve) => setTimeout(resolve, timeoutMs));
const waitForOutput = async (app) => {
  const startedAt = Date.now();
  const timeoutMs = ${JSON.stringify(xvfbLauncherChildEnvironmentTimeoutMs)};
  while (Date.now() - startedAt <= timeoutMs) {
    const stdout = (await app.output()).stdout.trim();
    if (stdout.length > 0) {
      return JSON.parse(stdout.split("\\n").at(-1));
    }
    await delay(25);
  }
  throw new Error('Timed out waiting for child environment output.');
};
(async () => {
  const launcher = createGtkAppLauncher({
    accessibilitySession: 'minimal',
    appPath: process.execPath,
    args: ['-e', childScript],
    xvfbScreen: '640x480x24',
    xvfbTrayHost: false,
  });
  try {
    const launcherEnv = await launcher.environment();
    const gdbusResult = spawnSync('gdbus', [
      'call',
      '--session',
      '--dest',
      'org.a11y.Bus',
      '--object-path',
      '/org/a11y/bus',
      '--method',
      'org.a11y.Bus.GetAddress',
    ], {
      encoding: 'utf8',
      env: launcherEnv,
      timeout: ${JSON.stringify(xvfbLauncherChildEnvironmentTimeoutMs)},
    });
    const app = await launcher.launch();
    try {
      console.log(JSON.stringify({
        childEnv: await waitForOutput(app),
        gdbusStatus: gdbusResult.status,
        gdbusStderr: gdbusResult.stderr.trim(),
        gdbusStdout: gdbusResult.stdout.trim(),
        launcherEnv: pickEnv(launcherEnv),
      }));
    } finally {
      await app.release();
    }
  } finally {
    await launcher.release();
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
      readonly childEnv: {
        readonly atSpiBusAddress: string | null;
        readonly dbusSessionBusAddress: string | null;
        readonly display: string | null;
        readonly gioUseVfs: string | null;
        readonly gnomeAccessibility: string | null;
        readonly gnomeKeyringControl: string | null;
        readonly gtkUsePortal: string | null;
        readonly noAtBridge: string | null;
        readonly sshAuthSock: string | null;
      };
      readonly gdbusStatus: number | null;
      readonly gdbusStderr: string;
      readonly gdbusStdout: string;
      readonly launcherEnv: {
        readonly atSpiBusAddress: string | null;
        readonly dbusSessionBusAddress: string | null;
        readonly display: string | null;
        readonly gioUseVfs: string | null;
        readonly gnomeAccessibility: string | null;
        readonly gnomeKeyringControl: string | null;
        readonly gtkUsePortal: string | null;
        readonly noAtBridge: string | null;
        readonly sshAuthSock: string | null;
      };
    };

    for (const sessionEnv of [output.launcherEnv, output.childEnv]) {
      expect(sessionEnv.atSpiBusAddress).toBeNull();
      expect(sessionEnv.dbusSessionBusAddress).not.toBe(
        'unix:path=/tmp/gestament-host-dbus'
      );
      expect(sessionEnv.display).not.toBeNull();
      expect(sessionEnv.display).not.toBe(':77');
      expect(sessionEnv.gioUseVfs).toBe('local');
      expect(sessionEnv.gnomeAccessibility).toBe('1');
      expect(sessionEnv.gnomeKeyringControl).toBeNull();
      expect(sessionEnv.gtkUsePortal).toBe('0');
      expect(sessionEnv.noAtBridge).toBeNull();
      expect(sessionEnv.sshAuthSock).toBeNull();
    }
    expect(output.gdbusStatus, output.gdbusStderr).toBe(0);
    expect(output.gdbusStdout).toContain('/at-spi/bus_');
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
const { existsSync, readFileSync } = require('node:fs');
const { createGtkAppLauncher } = require(${JSON.stringify(packageEntryPath)});
const childScript = (appEnvPath) => [
  "const { renameSync, writeFileSync } = require('node:fs');",
  "const appEnvPath = " + JSON.stringify(appEnvPath) + ";",
  "const appEnvTempPath = appEnvPath + '.tmp-' + process.pid;",
  "writeFileSync(appEnvTempPath, JSON.stringify({",
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
  "renameSync(appEnvTempPath, appEnvPath);",
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
  ].join("\\n")], {
    encoding: 'utf8',
    env,
    timeout: ${JSON.stringify(xvfbLauncherChildEnvironmentTimeoutMs)},
  });
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
const { closeSync, existsSync, openSync, readFileSync, rmSync, writeSync } = require('node:fs');
const { join } = require('node:path');
const { createGtkAppLauncher } = require(${JSON.stringify(packageEntryPath)});
const tempDirectory = ${JSON.stringify(tempDirectory)};
let appEnvIndex = 0;
const childScript = (appEnvPath) => [
  "const { renameSync, writeFileSync } = require('node:fs');",
  "const appEnvPath = " + JSON.stringify(appEnvPath) + ";",
  "const appEnvTempPath = appEnvPath + '.tmp-' + process.pid;",
  "writeFileSync(appEnvTempPath, JSON.stringify({",
  "  dbusSessionBusAddress: process.env.DBUS_SESSION_BUS_ADDRESS ?? null,",
  "  display: process.env.DISPLAY ?? null,",
  "}));",
  "renameSync(appEnvTempPath, appEnvPath);",
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
const displayNumber = (display) => {
  const match = /^:([0-9]+)(?:\\.|$)/.exec(display ?? '');
  if (match === null) {
    throw new Error('Unexpected DISPLAY value: ' + String(display));
  }
  return match[1];
};
const reserveDisplayNumberIfFree = (display) => {
  const lockPath = '/tmp/.X' + displayNumber(display) + '-lock';
  try {
    const fd = openSync(lockPath, 'wx');
    try {
      writeSync(fd, String(process.pid));
    } finally {
      closeSync(fd);
    }
    return () => rmSync(lockPath, { force: true });
  } catch (error) {
    if (error && error.code === 'EEXIST') {
      return () => undefined;
    }
    throw error;
  }
};
const outputChildScript = (label) => [
  "process.stdout.write(" + JSON.stringify("stdout:" + label + "\\n") + ", () => {",
  "  process.stderr.write(" + JSON.stringify("stderr:" + label + "\\n") + ", () => {",
  "    process.exit(0);",
  "  });",
  "});",
].join("\\n");
const waitForExitedOutput = async (app) => {
  const startedAt = Date.now();
  while (Date.now() - startedAt <= ${JSON.stringify(appOutputExitTimeoutMs)}) {
    const output = await app.output();
    if (output.exitCode !== null || output.exitSignal !== null) {
      return output;
    }
    await delay(25);
  }
  throw new Error('Timed out waiting for app output.');
};
const eventText = (events, stream) =>
  events
    .filter((event) => event.stream === stream)
    .map((event) => event.text)
    .join('');
const summarizeOutputLaunch = (launched) => ({
  env: launched.env,
  eventCount: launched.events.length,
  eventStderr: eventText(launched.events, 'stderr'),
  eventStdout: eventText(launched.events, 'stdout'),
  output: launched.output,
});
const launchOutputApp = async (label) => {
  const events = [];
  const launcher = createGtkAppLauncher({
    appPath: process.execPath,
    args: ['-e', outputChildScript(label)],
    xvfbPool: { type: 'all' },
    xvfbScreen: '440x315x24',
    xvfbTrayHost: false,
  });
  const env = pickSessionEnv(await launcher.environment());
  try {
    const app = await launcher.launch([], {
      onOutput: (event) => {
        events.push(event);
      },
    });
    const output = await waitForExitedOutput(app);
    return { env, events, output };
  } finally {
    await launcher.release();
  }
};
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
  const releaseTotalFirstReservation = reserveDisplayNumberIfFree(totalFirst.env.display);
  let totalFirstAgain;
  try {
    totalFirstAgain = await launchNodeApp({
      xvfbPool: { type: 'xvfb', maxIdleTotal: 1 },
      xvfbScreen: '520x310x24',
    });
  } finally {
    releaseTotalFirstReservation();
  }
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

  const firstOutputPool = await launchOutputApp('first');
  const firstOutputPoolEventCountAfterFirst = firstOutputPool.events.length;
  const secondOutputPool = await launchOutputApp('second');
  const outputPool = {
    first: summarizeOutputLaunch(firstOutputPool),
    firstEventCountAfterFirst: firstOutputPoolEventCountAfterFirst,
    firstEventCountAfterSecond: firstOutputPool.events.length,
    second: summarizeOutputLaunch(secondOutputPool),
  };

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
    outputPool,
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
          readonly outputPool: {
            readonly first: {
              readonly env: {
                readonly dbusSessionBusAddress: string | null;
                readonly display: string | null;
              };
              readonly eventCount: number;
              readonly eventStderr: string;
              readonly eventStdout: string;
              readonly output: {
                readonly exitCode: number | null;
                readonly exitSignal: string | null;
                readonly stderr: string;
                readonly stderrTruncated: boolean;
                readonly stdout: string;
                readonly stdoutTruncated: boolean;
              };
            };
            readonly firstEventCountAfterFirst: number;
            readonly firstEventCountAfterSecond: number;
            readonly second: {
              readonly env: {
                readonly dbusSessionBusAddress: string | null;
                readonly display: string | null;
              };
              readonly eventCount: number;
              readonly eventStderr: string;
              readonly eventStdout: string;
              readonly output: {
                readonly exitCode: number | null;
                readonly exitSignal: string | null;
                readonly stderr: string;
                readonly stderrTruncated: boolean;
                readonly stdout: string;
                readonly stdoutTruncated: boolean;
              };
            };
          };
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
        expect(output.outputPool.first.env.display).toBe(
          output.outputPool.second.env.display
        );
        expect(output.outputPool.first.env.dbusSessionBusAddress).toBe(
          output.outputPool.second.env.dbusSessionBusAddress
        );
        expect(output.outputPool.first.output).toMatchObject({
          exitCode: 0,
          exitSignal: null,
          stderr: 'stderr:first\n',
          stderrTruncated: false,
          stdout: 'stdout:first\n',
          stdoutTruncated: false,
        });
        expect(output.outputPool.second.output).toMatchObject({
          exitCode: 0,
          exitSignal: null,
          stderr: 'stderr:second\n',
          stderrTruncated: false,
          stdout: 'stdout:second\n',
          stdoutTruncated: false,
        });
        expect(output.outputPool.first.eventStdout).toBe('stdout:first\n');
        expect(output.outputPool.first.eventStderr).toBe('stderr:first\n');
        expect(output.outputPool.second.eventStdout).toBe('stdout:second\n');
        expect(output.outputPool.second.eventStderr).toBe('stderr:second\n');
        expect(output.outputPool.firstEventCountAfterSecond).toBe(
          output.outputPool.firstEventCountAfterFirst
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

  it(
    'allocates distinct displays for concurrent launcher processes',
    async () => {
      const launchProbe = async (
        xvfbPool: undefined | { readonly type: 'xvfb' | 'all' }
      ): Promise<readonly string[]> => {
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

        const script = `
const { createGtkAppLauncher } = require(${JSON.stringify(packageEntryPath)});
const childScript = [
  "setInterval(() => {}, 2147483647);",
].join("\\n");
(async () => {
  const launcher = createGtkAppLauncher({
    appPath: process.execPath,
    args: ['-e', childScript],
    timeoutMs: ${JSON.stringify(xvfbPoolFixtureTimeoutMs)},
    xvfbPool: ${JSON.stringify(xvfbPool)},
    xvfbScreen: '460x320x24',
    xvfbTrayHost: false,
  });
  try {
    const app = await launcher.launch();
    const environment = await app.environment();
    console.log(JSON.stringify({
      display: environment.DISPLAY ?? null,
      xauthority: environment.XAUTHORITY ?? null,
    }));
    await new Promise((resolve) => setTimeout(resolve, 1500));
  } finally {
    await launcher.release();
  }
})().catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  process.exit(1);
});
`;

        const launches = await Promise.all([
          spawnText(process.execPath, ['-e', script], {
            env,
            timeoutMs: xvfbPoolScriptTimeoutMs,
          }),
          spawnText(process.execPath, ['-e', script], {
            env,
            timeoutMs: xvfbPoolScriptTimeoutMs,
          }),
        ]);

        for (const launch of launches) {
          expect(launch.status, launch.stderr).toBe(0);
        }

        return launches.map((launch) => {
          const line = launch.stdout.trim().split('\n').at(-1);
          expect(line).toBeDefined();
          const probe = JSON.parse(line as string) as {
            readonly display: string | null;
            readonly xauthority: string | null;
          };
          expect(probe.display).not.toBeNull();
          expect(probe.xauthority).toBeNull();
          return probe.display as string;
        });
      };

      const unpooledDisplays = await launchProbe(undefined);
      expect(unpooledDisplays[0]).not.toBe(unpooledDisplays[1]);

      const xvfbPoolDisplays = await launchProbe({ type: 'xvfb' });
      expect(xvfbPoolDisplays[0]).not.toBe(xvfbPoolDisplays[1]);

      const allPoolDisplays = await launchProbe({ type: 'all' });
      expect(allPoolDisplays[0]).not.toBe(allPoolDisplays[1]);
    },
    xvfbPoolScriptTimeoutMs + 30_000
  );
});
