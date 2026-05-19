// gestament - TypeScript based test driver for GTK.
// Copyright (c) Kouji Matsui. (@kekyo@mi.kekyo.net)
// Under MIT.
// https://github.com/kekyo/gestament

import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  createGtkInvalidArgumentError,
  createGtkOperationFailedError,
} from './errors';
import type {
  GtkAppDisplay,
  GtkAppEnvironment,
  GtkAppLauncherOptions,
} from './types';

/////////////////////////////////////////////////////////////////////////////////////////

interface XvfbSessionOptions {
  readonly screen: string;
  readonly trayHost: boolean;
}

interface ActiveDisplay {
  readonly kind: 'host' | 'xvfb';
  readonly hostDisplay: string | undefined;
  readonly hostWaylandDisplay: string | undefined;
  readonly xvfb: XvfbSessionOptions | undefined;
}

interface HostDisplayState {
  readonly display: string | undefined;
  readonly waylandDisplay: string | undefined;
}

interface DisplaySessionReady {
  readonly dbusSessionBusAddress: string | null;
  readonly display: string | null;
  readonly xauthority: string | null;
}

interface PreparedGtkAppDisplay {
  readonly env: GtkAppEnvironment;
}

interface ProtocolPipe extends NodeJS.ReadableStream {
  readonly destroy: () => void;
  readonly unref?: () => void;
}

const defaultDisplay: GtkAppDisplay = 'xvfb';
const defaultGSettings = 'memory';
const defaultTheme = 'Adwaita';
const defaultXvfbScreen = '1280x720x24';
const defaultXvfbTrayHost = true;
const screenPattern = /^[1-9][0-9]*x[1-9][0-9]*x[1-9][0-9]*$/;
const readyPrefix = 'gestament-display-session-ready:';
const sessionStartupTimeoutMs = 30_000;

let activeDisplay: ActiveDisplay | undefined;
let activeSessionProcess: ChildProcess | undefined;
let activeSessionStart: Promise<void> | undefined;
let hostDisplayState: HostDisplayState | undefined;

const hasValue = (value: string | undefined): value is string =>
  value !== undefined && value.length > 0;

const getHostDisplayState = (): HostDisplayState => {
  if (hostDisplayState === undefined) {
    hostDisplayState = {
      display: process.env.DISPLAY,
      waylandDisplay: process.env.WAYLAND_DISPLAY,
    };
  }
  return hostDisplayState;
};

const resolveHostDisplayKind = (
  state: HostDisplayState
): 'x11' | 'wayland' | undefined => {
  if (hasValue(state.waylandDisplay)) {
    return 'wayland';
  }
  if (hasValue(state.display)) {
    return 'x11';
  }
  return undefined;
};

const resolveDisplay = (display: GtkAppDisplay | undefined): GtkAppDisplay => {
  if (display === undefined) {
    return defaultDisplay;
  }
  if (display === 'xvfb' || display === 'host') {
    return display;
  }
  throw createGtkInvalidArgumentError(
    `display must be "xvfb" or "host": ${String(display)}`
  );
};

const resolveXvfbOptions = (
  options: GtkAppLauncherOptions
): XvfbSessionOptions => {
  const screen = options.xvfbScreen ?? defaultXvfbScreen;
  if (!screenPattern.test(screen)) {
    throw createGtkInvalidArgumentError(
      `xvfbScreen must be WIDTHxHEIGHTxDEPTH: ${screen}`
    );
  }

  return {
    screen,
    trayHost: options.xvfbTrayHost ?? defaultXvfbTrayHost,
  };
};

const resolveActiveDisplay = (
  display: GtkAppDisplay,
  xvfb: XvfbSessionOptions
): ActiveDisplay => {
  const hostDisplay = getHostDisplayState();
  if (display === 'xvfb') {
    return {
      hostDisplay: undefined,
      hostWaylandDisplay: undefined,
      kind: 'xvfb',
      xvfb,
    };
  }

  const hostKind = resolveHostDisplayKind(hostDisplay);
  if (hostKind !== undefined) {
    return {
      hostDisplay: hostDisplay.display,
      hostWaylandDisplay: hostDisplay.waylandDisplay,
      kind: 'host',
      xvfb: undefined,
    };
  }

  return {
    hostDisplay: undefined,
    hostWaylandDisplay: undefined,
    kind: 'xvfb',
    xvfb,
  };
};

const assertCompatibleDisplay = (next: ActiveDisplay): void => {
  if (activeDisplay === undefined) {
    activeDisplay = next;
    return;
  }

  if (activeDisplay.kind !== next.kind) {
    throw createGtkInvalidArgumentError(
      `Cannot mix GTK display sessions in one process: ` +
        `${activeDisplay.kind} is already active, but ${next.kind} was requested.`
    );
  }

  if (next.kind === 'host') {
    if (
      activeDisplay.hostDisplay !== next.hostDisplay ||
      activeDisplay.hostWaylandDisplay !== next.hostWaylandDisplay
    ) {
      throw createGtkInvalidArgumentError(
        'Cannot change the host GTK display session after it is active.'
      );
    }
    return;
  }

  if (
    activeDisplay.xvfb?.screen !== next.xvfb?.screen ||
    activeDisplay.xvfb?.trayHost !== next.xvfb?.trayHost
  ) {
    throw createGtkInvalidArgumentError(
      'Cannot change the Xvfb GTK display session after it is active.'
    );
  }
};

const resolveSessionHostPath = (): string => {
  const hostPath = resolve(
    dirname(fileURLToPath(import.meta.url)),
    '..',
    'dist',
    'gestament-display-session-host.cjs'
  );
  if (!existsSync(hostPath)) {
    throw createGtkOperationFailedError(
      `Internal display session host was not found: ${hostPath}`
    );
  }
  return hostPath;
};

const parseReadyLine = (line: string): DisplaySessionReady | undefined => {
  if (!line.startsWith(readyPrefix)) {
    return undefined;
  }

  const value = JSON.parse(line.slice(readyPrefix.length)) as unknown;
  if (
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value) ||
    !('display' in value) ||
    !('dbusSessionBusAddress' in value)
  ) {
    throw new Error('Invalid display session ready payload.');
  }

  const display = value.display;
  const dbusSessionBusAddress = value.dbusSessionBusAddress;
  const xauthority = 'xauthority' in value ? value.xauthority : null;

  if (
    (typeof display !== 'string' && display !== null) ||
    (typeof dbusSessionBusAddress !== 'string' &&
      dbusSessionBusAddress !== null) ||
    (typeof xauthority !== 'string' && xauthority !== null)
  ) {
    throw new Error('Invalid display session ready payload.');
  }

  return {
    dbusSessionBusAddress,
    display,
    xauthority,
  };
};

const applyReadyEnvironment = (ready: DisplaySessionReady): void => {
  const display = ready.display ?? undefined;
  const dbusSessionBusAddress = ready.dbusSessionBusAddress ?? undefined;
  if (!hasValue(display)) {
    throw createGtkOperationFailedError(
      'Internal Xvfb session did not report DISPLAY.'
    );
  }
  if (!hasValue(dbusSessionBusAddress)) {
    throw createGtkOperationFailedError(
      'Internal Xvfb session did not report DBUS_SESSION_BUS_ADDRESS.'
    );
  }

  process.env.DISPLAY = display;
  process.env.DBUS_SESSION_BUS_ADDRESS = dbusSessionBusAddress;
  process.env.GDK_BACKEND = 'x11';
  process.env.GESTAMENT_XVFB_ACTIVE = '1';
  delete process.env.AT_SPI_BUS_ADDRESS;
  delete process.env.NO_AT_BRIDGE;
  if (ready.xauthority === null) {
    delete process.env.XAUTHORITY;
  } else {
    process.env.XAUTHORITY = ready.xauthority;
  }
};

const stopActiveSession = (): void => {
  if (
    activeSessionProcess !== undefined &&
    activeSessionProcess.exitCode === null &&
    activeSessionProcess.signalCode === null
  ) {
    activeSessionProcess.kill('SIGTERM');
  }
};

const startXvfbSession = async (xvfb: XvfbSessionOptions): Promise<void> => {
  if (
    process.env.GESTAMENT_XVFB_ACTIVE === '1' &&
    hasValue(process.env.DISPLAY) &&
    hasValue(process.env.DBUS_SESSION_BUS_ADDRESS)
  ) {
    process.env.GDK_BACKEND = 'x11';
    delete process.env.AT_SPI_BUS_ADDRESS;
    delete process.env.NO_AT_BRIDGE;
    return;
  }

  if (activeSessionStart !== undefined) {
    return activeSessionStart;
  }

  activeSessionStart = new Promise<void>((resolveStart, rejectStart) => {
    const hostPath = resolveSessionHostPath();
    const args = [
      '-a',
      '-s',
      `-screen 0 ${xvfb.screen}`,
      '--',
      'dbus-run-session',
      '--',
      process.execPath,
      hostPath,
      ...(xvfb.trayHost ? ['--with-tray-host'] : []),
    ];

    const child = spawn('xvfb-run', args, {
      env: {
        ...process.env,
        GDK_BACKEND: 'x11',
      },
      stdio: ['ignore', 'ignore', 'ignore', 'pipe'],
    });
    activeSessionProcess = child;

    const protocol = child.stdio[3] as ProtocolPipe | null | undefined;
    if (protocol === null || protocol === undefined) {
      rejectStart(
        createGtkOperationFailedError(
          'Internal Xvfb session did not expose its protocol pipe.'
        )
      );
      return;
    }

    let output = '';
    let settled = false;

    const cleanup = (): void => {
      clearTimeout(timeout);
      protocol.removeAllListeners('data');
      protocol.removeAllListeners('error');
      child.removeListener('error', rejectFromError);
      child.removeListener('exit', rejectFromExit);
    };

    const rejectOnce = (error: Error): void => {
      if (!settled) {
        settled = true;
        cleanup();
        stopActiveSession();
        rejectStart(error);
      }
    };

    const rejectFromError = (error: Error): void => {
      rejectOnce(
        createGtkOperationFailedError(
          `Internal Xvfb session failed to start: ${error.message}`
        )
      );
    };

    const rejectFromExit = (
      code: number | null,
      signal: NodeJS.Signals | null
    ): void => {
      rejectOnce(
        createGtkOperationFailedError(
          `Internal Xvfb session exited before ready: code=${String(
            code
          )}, signal=${String(signal)}`
        )
      );
    };

    const timeout = setTimeout(() => {
      rejectOnce(
        createGtkOperationFailedError(
          'Timed out waiting for internal Xvfb session.'
        )
      );
    }, sessionStartupTimeoutMs);

    protocol.on('data', (chunk: Buffer) => {
      output += chunk.toString('utf8');
      let newlineIndex = output.indexOf('\n');
      while (newlineIndex >= 0) {
        const line = output.slice(0, newlineIndex);
        output = output.slice(newlineIndex + 1);
        let ready: DisplaySessionReady | undefined;
        try {
          ready = parseReadyLine(line);
        } catch (error) {
          const message =
            error instanceof Error ? error.message : String(error);
          rejectOnce(
            createGtkOperationFailedError(
              `Invalid internal Xvfb session response: ${message}`
            )
          );
          return;
        }
        if (ready !== undefined) {
          settled = true;
          cleanup();
          protocol.unref?.();
          protocol.destroy();
          applyReadyEnvironment(ready);
          child.unref();
          process.once('exit', stopActiveSession);
          resolveStart();
          return;
        }
        newlineIndex = output.indexOf('\n');
      }
    });
    protocol.on('error', rejectFromError);
    child.on('error', rejectFromError);
    child.on('exit', rejectFromExit);
  });

  return activeSessionStart;
};

const resolveGdkBackend = (active: ActiveDisplay): string | undefined => {
  if (active.kind === 'xvfb') {
    return 'x11';
  }
  if (process.env.GDK_BACKEND !== undefined) {
    return undefined;
  }
  if (hasValue(active.hostDisplay)) {
    return 'x11';
  }
  if (hasValue(active.hostWaylandDisplay)) {
    return 'wayland';
  }
  return undefined;
};

const resolveLauncherEnvironment = (
  options: GtkAppLauncherOptions,
  active: ActiveDisplay
): GtkAppEnvironment => {
  const env: Record<string, string | undefined> = {
    GDK_BACKEND: resolveGdkBackend(active),
    GSETTINGS_BACKEND:
      options.gsettings === null
        ? undefined
        : (options.gsettings ?? defaultGSettings),
    GTK_THEME:
      options.theme === null ? undefined : (options.theme ?? defaultTheme),
    ...options.env,
  };
  return env;
};

/**
 * Prepares the process display session used by GtkAppLauncher.
 * @param options Launcher options.
 * @returns Environment overrides passed to launched GTK applications.
 */
export const prepareGtkAppDisplay = async (
  options: GtkAppLauncherOptions
): Promise<PreparedGtkAppDisplay> => {
  const display = resolveDisplay(options.display);
  const xvfb = resolveXvfbOptions(options);
  const nextActiveDisplay = resolveActiveDisplay(display, xvfb);
  assertCompatibleDisplay(nextActiveDisplay);

  if (nextActiveDisplay.kind === 'xvfb') {
    await startXvfbSession(xvfb);
  }

  return {
    env: resolveLauncherEnvironment(options, nextActiveDisplay),
  };
};
