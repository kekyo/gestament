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

  it('reuses Xvfb resources only when xvfbPool opts in', () => {
    const tempDirectory = mkdtempSync(join(tmpdir(), 'gestament-xvfb-pool-'));
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
  for (let index = 0; index < 80; index += 1) {
    if (existsSync(appEnvPath)) {
      return JSON.parse(readFileSync(appEnvPath, 'utf8'));
    }
    await delay(25);
  }
  throw new Error('Timed out waiting for child environment output.');
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
  const app = await launcher.launch();
  const env = await waitForAppEnv(resolvedOptions.appEnvPath);
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
      timeoutMs: 3000,
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
      timeoutMs: 3000,
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
      const result = spawnSync(process.execPath, ['-e', script], {
        encoding: 'utf8',
        env,
        timeout: 120_000,
      });

      expect(result.status, result.stderr).toBe(0);
      const outputLine = result.stdout.trim().split('\n').at(-1);
      expect(outputLine).toBeDefined();
      const output = JSON.parse(outputLine as string) as {
        readonly coverWindowIsAbsent: boolean;
        readonly firstAll: {
          readonly bounds: { readonly height: number; readonly width: number };
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
          readonly bounds: { readonly height: number; readonly width: number };
          readonly env: {
            readonly dbusSessionBusAddress: string | null;
            readonly display: string | null;
          };
        };
        readonly invalidPoolCodes: readonly (string | null)[];
        readonly oldAllAppCode: string | null;
        readonly oldFixtureAppCode: string | null;
        readonly secondAll: {
          readonly bounds: { readonly height: number; readonly width: number };
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
          readonly bounds: { readonly height: number; readonly width: number };
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
      expect(output.firstXvfb.env.display).toBe(output.secondXvfb.env.display);
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
  });
});
