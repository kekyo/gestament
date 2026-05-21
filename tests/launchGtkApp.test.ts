// gestament - TypeScript based test driver for GTK.
// Copyright (c) Kouji Matsui. (@kekyo@mi.kekyo.net)
// Under MIT.
// https://github.com/kekyo/gestament

import { describe, expect, it } from 'vitest';
import { delay } from 'async-primitives';
import { fileURLToPath } from 'node:url';

import {
  createGtkAppEnvironment,
  createGtkAppLauncher,
  launchGtkApp,
} from '../src/launchGtkApp';
import type {
  GtkApp,
  GtkAppOutput,
  GtkAppOutputEvent,
  GtkSystemOutput,
  GtkSystemOutputEvent,
  GtkSystemOutputSource,
} from '../src/types';
import { spawnText } from './support/process';

/////////////////////////////////////////////////////////////////////////////////////////

const nodeOutputScript = (
  stdout: string,
  stderr: string,
  exitCode: number
): string => `
process.stdout.write(${JSON.stringify(stdout)}, () => {
  process.stderr.write(${JSON.stringify(stderr)}, () => {
    process.exit(${JSON.stringify(exitCode)});
  });
});
`;

const packageEntryPath = fileURLToPath(
  new URL('../dist/index.cjs', import.meta.url)
);

const waitForExitedOutput = async (app: GtkApp): Promise<GtkAppOutput> => {
  const startedAt = Date.now();
  let output = await app.output();

  while (Date.now() - startedAt <= 5_000) {
    output = await app.output();
    if (output.exitCode !== null || output.exitSignal !== null) {
      return output;
    }
    await delay(25);
  }

  throw new Error(
    `Timed out waiting for app output: ${JSON.stringify(output)}`
  );
};

const outputText = (
  events: readonly GtkAppOutputEvent[],
  stream: 'stdout' | 'stderr'
): string =>
  events
    .filter((event) => event.stream === stream)
    .map((event) => event.text)
    .join('');

const expectOutputSequences = (events: readonly GtkAppOutputEvent[]): void => {
  expect(events.map((event) => event.sequence)).toEqual(
    events.map((_event, index) => index)
  );
  expect(events.every((event) => Number.isFinite(event.timestampMs))).toBe(
    true
  );
};

const systemSourceSnapshot = (
  output: GtkSystemOutput,
  source: GtkSystemOutputSource
) => output.sources.find((entry) => entry.source === source);

const expectSystemOutputSequences = (
  events: readonly GtkSystemOutputEvent[]
): void => {
  expect(events.map((event) => event.sequence)).toEqual(
    events.map((_event, index) => index)
  );
  expect(events.every((event) => Number.isFinite(event.timestampMs))).toBe(
    true
  );
};

describe('GTK application launch environment', () => {
  it('adds the gestament default GTK test environment', () => {
    expect(createGtkAppEnvironment({}, undefined)).toEqual({
      GDK_BACKEND: 'x11',
      GSETTINGS_BACKEND: 'memory',
      GTK_THEME: 'Adwaita',
    });
  });

  it('allows explicit overrides except NO_AT_BRIDGE', () => {
    expect(
      createGtkAppEnvironment(
        {
          GDK_BACKEND: 'wayland',
          GSETTINGS_BACKEND: 'dconf',
          GTK_THEME: 'HighContrast',
          NO_AT_BRIDGE: '1',
          PATH: '/usr/bin',
        },
        {
          CUSTOM_VALUE: 'custom',
          GDK_BACKEND: 'wayland',
          GSETTINGS_BACKEND: 'dconf',
          GTK_THEME: 'Yaru',
          NO_AT_BRIDGE: '1',
        }
      )
    ).toEqual({
      CUSTOM_VALUE: 'custom',
      GDK_BACKEND: 'wayland',
      GSETTINGS_BACKEND: 'dconf',
      GTK_THEME: 'Yaru',
      PATH: '/usr/bin',
    });
  });

  it('removes environment values explicitly set to undefined', () => {
    expect(
      createGtkAppEnvironment(
        {
          GSETTINGS_BACKEND: 'dconf',
          GTK_THEME: 'Yaru',
        },
        {
          GSETTINGS_BACKEND: undefined,
          GTK_THEME: undefined,
        }
      )
    ).toEqual({
      GDK_BACKEND: 'x11',
    });
  });
});

describe('GTK application output capture', () => {
  it('captures direct stdout and stderr with output callbacks', async () => {
    const events: GtkAppOutputEvent[] = [];
    const app = await launchGtkApp(
      process.execPath,
      ['-e', nodeOutputScript('direct-out', 'direct-err', 7)],
      {
        onOutput: (event) => {
          events.push(event);
        },
      }
    );

    const output = await waitForExitedOutput(app);

    expect(output).toEqual({
      exitCode: 7,
      exitSignal: null,
      stderr: 'direct-err',
      stderrTruncated: false,
      stdout: 'direct-out',
      stdoutTruncated: false,
    });
    expect(outputText(events, 'stdout')).toBe('direct-out');
    expect(outputText(events, 'stderr')).toBe('direct-err');
    expectOutputSequences(events);
  });

  it('captures driver-backed stdout and stderr with output callbacks', async () => {
    const events: GtkAppOutputEvent[] = [];
    const launcher = createGtkAppLauncher({
      appPath: process.execPath,
      args: ['-e', nodeOutputScript('driver-out', 'driver-err', 5)],
      xvfbTrayHost: false,
    });

    try {
      const app = await launcher.launch([], {
        onOutput: (event) => {
          events.push(event);
        },
      });
      const output = await waitForExitedOutput(app);

      expect(output).toEqual({
        exitCode: 5,
        exitSignal: null,
        stderr: 'driver-err',
        stderrTruncated: false,
        stdout: 'driver-out',
        stdoutTruncated: false,
      });
      expect(outputText(events, 'stdout')).toBe('driver-out');
      expect(outputText(events, 'stderr')).toBe('driver-err');
      expectOutputSequences(events);
    } finally {
      await launcher.release();
    }
  });

  it('retains complete output by default', async () => {
    const stdout = 'x'.repeat(50_000);
    const stderr = 'y'.repeat(50_000);
    const app = await launchGtkApp(process.execPath, [
      '-e',
      nodeOutputScript(stdout, stderr, 0),
    ]);

    const output = await waitForExitedOutput(app);

    expect(output.stdout).toBe(stdout);
    expect(output.stderr).toBe(stderr);
    expect(output.stdoutTruncated).toBe(false);
    expect(output.stderrTruncated).toBe(false);
  });

  it('retains bounded output tails when outputBufferBytes is specified', async () => {
    const app = await launchGtkApp(
      process.execPath,
      ['-e', nodeOutputScript('abcdef', 'uvwxyz', 0)],
      { outputBufferBytes: 3 }
    );

    const output = await waitForExitedOutput(app);

    expect(output.stdout).toBe('def');
    expect(output.stderr).toBe('xyz');
    expect(output.stdoutTruncated).toBe(true);
    expect(output.stderrTruncated).toBe(true);
  });

  it('can disable retained output text while preserving truncation flags', async () => {
    const app = await launchGtkApp(
      process.execPath,
      ['-e', nodeOutputScript('stdout', 'stderr', 0)],
      { outputBufferBytes: 0 }
    );

    const output = await waitForExitedOutput(app);

    expect(output.stdout).toBe('');
    expect(output.stderr).toBe('');
    expect(output.stdoutTruncated).toBe(true);
    expect(output.stderrTruncated).toBe(true);
  });

  it('rejects output snapshots after direct app release', async () => {
    const app = await launchGtkApp(process.execPath, [
      '-e',
      nodeOutputScript('before-release', '', 0),
    ]);
    await waitForExitedOutput(app);
    await app.release();

    await expect(app.output()).rejects.toMatchObject({
      code: 'APP_EXITED',
    });
  });

  it('separates output callbacks across driver session scopes', async () => {
    const launcher = createGtkAppLauncher({
      appPath: process.execPath,
      xvfbScreen: '360x240x24',
      xvfbTrayHost: false,
    });
    const firstEvents: GtkAppOutputEvent[] = [];
    const secondEvents: GtkAppOutputEvent[] = [];

    try {
      const firstApp = await launcher.launch(
        ['-e', nodeOutputScript('first-app', '', 0)],
        {
          onOutput: (event) => {
            firstEvents.push(event);
          },
        }
      );
      await waitForExitedOutput(firstApp);
      await firstApp.release();
      const firstEventCountAfterRelease = firstEvents.length;

      const secondApp = await launcher.launch(
        ['-e', nodeOutputScript('second-app', '', 0)],
        {
          onOutput: (event) => {
            secondEvents.push(event);
          },
        }
      );
      await waitForExitedOutput(secondApp);
      await secondApp.release();

      expect(firstEvents.length).toBe(firstEventCountAfterRelease);
      expect(outputText(firstEvents, 'stdout')).toBe('first-app');
      expect(outputText(secondEvents, 'stdout')).toBe('second-app');
    } finally {
      await launcher.release();
    }
  });
});

describe('GTK launcher system output capture', () => {
  it('captures launcher-driver and tray-host output with system callbacks', async () => {
    const previousDriverStdout =
      process.env.GESTAMENT_TEST_DRIVER_SYSTEM_STDOUT;
    const previousDriverStderr =
      process.env.GESTAMENT_TEST_DRIVER_SYSTEM_STDERR;
    const previousTrayStdout =
      process.env.GESTAMENT_TEST_TRAY_HOST_SYSTEM_STDOUT;
    const previousTrayStderr =
      process.env.GESTAMENT_TEST_TRAY_HOST_SYSTEM_STDERR;
    const restoreEnv = (name: string, value: string | undefined): void => {
      if (value === undefined) {
        delete process.env[name];
        return;
      }
      process.env[name] = value;
    };
    process.env.GESTAMENT_TEST_DRIVER_SYSTEM_STDOUT = 'driver-start-out';
    process.env.GESTAMENT_TEST_DRIVER_SYSTEM_STDERR = 'driver-start-err';
    process.env.GESTAMENT_TEST_TRAY_HOST_SYSTEM_STDOUT = 'tray-start-out';
    process.env.GESTAMENT_TEST_TRAY_HOST_SYSTEM_STDERR = 'tray-start-err';

    const events: GtkSystemOutputEvent[] = [];
    const launcher = createGtkAppLauncher({
      appPath: process.execPath,
      args: ['-e', nodeOutputScript('', '', 0)],
      onSystemOutput: (event) => {
        events.push(event);
      },
      xvfbTrayHost: true,
    });

    try {
      const app = await launcher.launch();
      await waitForExitedOutput(app);

      const output = await launcher.systemOutput();
      const driverOutput = systemSourceSnapshot(output, 'launcher-driver');
      expect(driverOutput).toMatchObject({
        stderrTruncated: false,
        stdoutTruncated: false,
      });
      expect(
        `${driverOutput?.stdout ?? ''}${driverOutput?.stderr ?? ''}`
      ).toContain('driver-start-out');
      expect(
        `${driverOutput?.stdout ?? ''}${driverOutput?.stderr ?? ''}`
      ).toContain('driver-start-err');
      const trayOutput = systemSourceSnapshot(output, 'tray-host');
      expect(trayOutput).toMatchObject({
        stderrTruncated: false,
        stdoutTruncated: false,
      });
      expect(
        `${trayOutput?.stdout ?? ''}${trayOutput?.stderr ?? ''}`
      ).toContain('tray-start-out');
      expect(
        `${trayOutput?.stdout ?? ''}${trayOutput?.stderr ?? ''}`
      ).toContain('tray-start-err');
      expect(systemSourceSnapshot(output, 'tray-host')?.stdout).not.toContain(
        'gestament-tray-host-ready'
      );
      expectSystemOutputSequences(events);
    } finally {
      await launcher.release();
      restoreEnv('GESTAMENT_TEST_DRIVER_SYSTEM_STDOUT', previousDriverStdout);
      restoreEnv('GESTAMENT_TEST_DRIVER_SYSTEM_STDERR', previousDriverStderr);
      restoreEnv('GESTAMENT_TEST_TRAY_HOST_SYSTEM_STDOUT', previousTrayStdout);
      restoreEnv('GESTAMENT_TEST_TRAY_HOST_SYSTEM_STDERR', previousTrayStderr);
    }
  });

  it('keeps the last system output snapshot after release and resets on the next lease', async () => {
    const launcher = createGtkAppLauncher({
      appPath: process.execPath,
      env: {
        GESTAMENT_TEST_DRIVER_COMMAND_SYSTEM_STDOUT: 'lease-output',
      },
      xvfbTrayHost: false,
    });

    try {
      await launcher.environment();
      await launcher.release();
      const firstOutput = await launcher.systemOutput();

      await launcher.environment();
      const secondOutput = await launcher.systemOutput();

      expect(systemSourceSnapshot(firstOutput, 'launcher-driver')?.stdout).toBe(
        'lease-output'
      );
      expect(
        systemSourceSnapshot(secondOutput, 'launcher-driver')?.stdout
      ).toBe('lease-output');
    } finally {
      await launcher.release();
    }
  });

  it('separates system output across pooled launcher leases', async () => {
    const firstEvents: GtkSystemOutputEvent[] = [];
    const secondEvents: GtkSystemOutputEvent[] = [];
    const launchWithSystemOutput = async (
      label: string,
      events: GtkSystemOutputEvent[]
    ): Promise<{
      readonly dbusSessionBusAddress: string | undefined;
      readonly display: string | undefined;
      readonly output: GtkSystemOutput;
    }> => {
      const launcher = createGtkAppLauncher({
        appPath: process.execPath,
        env: {
          GESTAMENT_TEST_DRIVER_COMMAND_SYSTEM_STDOUT: `system:${label}\n`,
        },
        onSystemOutput: (event) => {
          events.push(event);
        },
        xvfbPool: { type: 'all' },
        xvfbScreen: '450x320x24',
        xvfbTrayHost: false,
      });
      const env = await launcher.environment();
      await launcher.release();
      return {
        dbusSessionBusAddress: env.DBUS_SESSION_BUS_ADDRESS,
        display: env.DISPLAY,
        output: await launcher.systemOutput(),
      };
    };

    const first = await launchWithSystemOutput('first', firstEvents);
    const firstEventCountAfterFirst = firstEvents.length;
    const second = await launchWithSystemOutput('second', secondEvents);

    expect(first.display).toBe(second.display);
    expect(first.dbusSessionBusAddress).toBe(second.dbusSessionBusAddress);
    expect(systemSourceSnapshot(first.output, 'launcher-driver')?.stdout).toBe(
      'system:first\n'
    );
    expect(systemSourceSnapshot(second.output, 'launcher-driver')?.stdout).toBe(
      'system:second\n'
    );
    expect(firstEvents.length).toBe(firstEventCountAfterFirst);
    expect(firstEvents.map((event) => event.text).join('')).not.toContain(
      'system:second'
    );
    expect(secondEvents.map((event) => event.text).join('')).toContain(
      'system:second'
    );
  });

  it('keeps the launcher session usable when system output callbacks throw', async () => {
    const script = `
const { createGtkAppLauncher } = require(${JSON.stringify(packageEntryPath)});
const delay = (timeoutMs) => new Promise((resolve) => setTimeout(resolve, timeoutMs));
(async () => {
  const events = [];
  let thrown = false;
  const uncaughtPromise = new Promise((resolve) => {
    process.once('uncaughtException', (error) => {
      resolve(error && error.message ? error.message : String(error));
    });
  });
  const launcher = createGtkAppLauncher({
    appPath: process.execPath,
    env: {
      GESTAMENT_TEST_DRIVER_COMMAND_SYSTEM_STDOUT: 'throw-output',
    },
    onSystemOutput: (event) => {
      events.push(event);
      if (!thrown) {
        thrown = true;
        throw new Error('system-output-callback-error');
      }
    },
    xvfbTrayHost: false,
  });
  await launcher.environment();
  const beforeRelease = await launcher.systemOutput();
  await launcher.release();
  const afterRelease = await launcher.systemOutput();
  const uncaught = await Promise.race([
    uncaughtPromise,
    delay(1000).then(() => null),
  ]);
  console.log(JSON.stringify({
    afterRelease,
    beforeRelease,
    eventCount: events.length,
    uncaught,
  }));
})().catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  process.exit(1);
});
`;
    const result = await spawnText(process.execPath, ['-e', script], {
      env: process.env,
      timeoutMs: 20_000,
    });

    expect(result.status, result.stderr).toBe(0);
    const output = JSON.parse(result.stdout.trim()) as {
      readonly afterRelease: GtkSystemOutput;
      readonly beforeRelease: GtkSystemOutput;
      readonly eventCount: number;
      readonly uncaught: string | null;
    };

    expect(output.uncaught).toBe('system-output-callback-error');
    expect(output.eventCount).toBeGreaterThan(0);
    expect(
      systemSourceSnapshot(output.beforeRelease, 'launcher-driver')?.stdout
    ).toBe('throw-output');
    expect(
      systemSourceSnapshot(output.afterRelease, 'launcher-driver')?.stdout
    ).toBe('throw-output');
  });
});
