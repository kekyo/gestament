// gestament - TypeScript based test driver for GTK.
// Copyright (c) Kouji Matsui. (@kekyo@mi.kekyo.net)
// Under MIT.
// https://github.com/kekyo/gestament

import { describe, expect, it } from 'vitest';
import { delay } from 'async-primitives';

import {
  createGtkAppEnvironment,
  createGtkAppLauncher,
  launchGtkApp,
} from '../src/launchGtkApp';
import type { GtkApp, GtkAppOutput, GtkAppOutputEvent } from '../src/types';

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
