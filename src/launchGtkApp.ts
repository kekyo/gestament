// gestament - TypeScript based test driver for GTK.
// Copyright (c) Kouji Matsui. (@kekyo@mi.kekyo.net)
// Under MIT.
// https://github.com/kekyo/gestament

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { delay } from 'async-primitives';

import {
  createGtkAppExitedError,
  createGtkElementNotFoundError,
  createGtkInvalidArgumentError,
  createGtkOperationFailedError,
  normalizeNativeError,
} from './errors';
import { createGtkElement } from './element';
import {
  nativeFindById,
  nativeCaptureScreen,
  nativeProcessAtspiReadiness,
  nativeTrayItems,
  nativeWindowAt,
  nativeWindowCount,
  type NativeAtspiReadiness,
} from './native';
import { createGtkTrayItem, nativeTrayItemMatchesSelector } from './tray';
import type {
  GtkApp,
  GtkAppEnvironment,
  GtkAppLauncher,
  GtkAppLauncherOptions,
  GtkCapture,
  GtkTrayItem,
  GtkTrayItemSelector,
  GtkWidgetElement,
  LaunchGtkAppOptions,
} from './types';

/////////////////////////////////////////////////////////////////////////////////////////

const appendOutput = (lines: string[], chunk: Buffer): void => {
  lines.push(chunk.toString('utf8'));
  if (lines.length > 40) {
    lines.splice(0, lines.length - 40);
  }
};

interface ProcessState {
  readonly process: ChildProcessWithoutNullStreams;
  readonly stderr: string[];
  readonly stdout: string[];
  atspiReadiness: NativeAtspiReadiness;
  atspiReady: boolean;
  exitCode: number | null;
  exitSignal: NodeJS.Signals | null;
}

interface ParsedElementPath {
  readonly id: string;
  readonly childIndexes: readonly number[];
}

interface GtkPathChildContainer {
  readonly childAt: (index: number) => Promise<GtkWidgetElement | undefined>;
}

const formatProcessOutput = (state: ProcessState): string => {
  const stdout = state.stdout.join('').trim();
  const stderr = state.stderr.join('').trim();

  if (stdout.length === 0 && stderr.length === 0) {
    return '';
  }

  return `\nstdout:\n${stdout}\nstderr:\n${stderr}`;
};

const assertProcessRunning = (state: ProcessState, command: string): number => {
  if (state.exitCode !== null || state.exitSignal !== null) {
    throw createGtkAppExitedError(
      `GTK application exited before the operation completed: ${command} ` +
        `(code=${String(state.exitCode)}, signal=${String(state.exitSignal)})` +
        formatProcessOutput(state)
    );
  }

  const processId = state.process.pid;
  if (processId === undefined) {
    throw createGtkAppExitedError(
      `GTK application did not expose a process id: ${command}`
    );
  }

  return processId;
};

const assertNonNegativeIndex = (name: string, index: number): void => {
  if (!Number.isInteger(index) || index < 0) {
    throw createGtkInvalidArgumentError(
      `${name} must be a non-negative integer.`
    );
  }
};

const parseElementPath = (path: string): ParsedElementPath => {
  const segments = path.split(/[.:;,]/u);
  const id = segments[0];
  if (id === undefined || id.length === 0) {
    throw createGtkInvalidArgumentError(
      'path must start with an accessible id.'
    );
  }

  const childIndexes: number[] = [];
  for (let index = 1; index < segments.length; index += 1) {
    const segment = segments[index];
    if (segment === undefined || !/^\d+$/u.test(segment)) {
      throw createGtkInvalidArgumentError(
        'path child indexes must be non-negative decimal integers.'
      );
    }

    const childIndex = Number(segment);
    if (!Number.isSafeInteger(childIndex)) {
      throw createGtkInvalidArgumentError(
        'path child indexes must be safe non-negative integers.'
      );
    }

    childIndexes.push(childIndex);
  }

  return { id, childIndexes };
};

const isPathChildContainer = (
  element: GtkWidgetElement
): element is GtkWidgetElement & GtkPathChildContainer => 'childAt' in element;

const waitForAtspiReady = async (
  state: ProcessState,
  command: string,
  timeoutMs: number,
  startedAt: number
): Promise<number> => {
  if (state.atspiReady) {
    return assertProcessRunning(state, command);
  }

  while (Date.now() - startedAt <= timeoutMs) {
    const processId = assertProcessRunning(state, command);
    state.atspiReadiness = nativeProcessAtspiReadiness(processId);
    if (state.atspiReadiness === 'ready') {
      state.atspiReady = true;
      return processId;
    }

    await delay(50);
  }

  assertProcessRunning(state, command);
  throw createGtkOperationFailedError(
    `AT-SPI did not become ready for GTK application: ${command} ` +
      `(last readiness: ${state.atspiReadiness})` +
      formatProcessOutput(state)
  );
};

/**
 * Creates the child process environment used for gestament GTK automation.
 *
 * @param baseEnv Base environment, usually process.env.
 * @param overrides Optional environment overrides supplied by the caller.
 * @returns Environment object passed to child_process.spawn.
 * @remarks
 * gestament defaults to X11 and in-memory GSettings for stable visual tests.
 * NO_AT_BRIDGE is always removed because it disables AT-SPI automation.
 */
export const createGtkAppEnvironment = (
  baseEnv: GtkAppEnvironment,
  overrides: GtkAppEnvironment | undefined
): NodeJS.ProcessEnv => {
  const env: NodeJS.ProcessEnv = {
    ...baseEnv,
    GDK_BACKEND: baseEnv.GDK_BACKEND ?? 'x11',
    GSETTINGS_BACKEND: baseEnv.GSETTINGS_BACKEND ?? 'memory',
    GTK_THEME: baseEnv.GTK_THEME ?? 'Adwaita',
    ...overrides,
  };
  delete env.NO_AT_BRIDGE;
  return env;
};

/////////////////////////////////////////////////////////////////////////////////////////

/**
 * Launches a GTK application and returns an AT-SPI automation handle.
 * @param appPath - Target GTK application path.
 * @param args - Target GTK application arguments.
 * @param options - Options.
 * @returns GtkApp instanced.
 */
export const launchGtkApp = (
  appPath: string,
  args?: readonly string[],
  options?: LaunchGtkAppOptions
): Promise<GtkApp> => {
  const _args = args ?? [];
  const _timeoutMs = options?.timeoutMs ?? 10_000;

  const child = spawn(appPath, [..._args], {
    env: createGtkAppEnvironment(process.env, options?.env),
    stdio: 'pipe',
  });

  const state: ProcessState = {
    atspiReadiness: 'missing-bus-name',
    atspiReady: false,
    exitCode: null,
    exitSignal: null,
    process: child,
    stderr: [],
    stdout: [],
  };

  child.stdout.on('data', (chunk: Buffer) => {
    appendOutput(state.stdout, chunk);
  });
  child.stderr.on('data', (chunk: Buffer) => {
    appendOutput(state.stderr, chunk);
  });
  child.on('exit', (code, signal) => {
    state.exitCode = code;
    state.exitSignal = signal;
  });

  const release = async (): Promise<void> => {
    if (state.exitCode !== null || state.exitSignal !== null) {
      return;
    }

    child.kill('SIGTERM');

    const startedAt = Date.now();
    while (state.exitCode === null && state.exitSignal === null) {
      if (Date.now() - startedAt > 2_000) {
        child.kill('SIGKILL');
        break;
      }
      await delay(25);
    }
  };

  const findById = async (
    id: string
  ): Promise<GtkWidgetElement | undefined> => {
    const startedAt = Date.now();
    await waitForAtspiReady(state, appPath, _timeoutMs, startedAt);

    while (Date.now() - startedAt <= _timeoutMs) {
      const processId = assertProcessRunning(state, appPath);

      try {
        const handle = nativeFindById(processId, id);
        if (handle !== undefined) {
          return createGtkElement(handle);
        }
      } catch (error) {
        throw normalizeNativeError(error);
      }

      await delay(50);
    }

    assertProcessRunning(state, appPath);
    return undefined;
  };

  const getById = async (id: string): Promise<GtkWidgetElement> => {
    const element = await findById(id);
    if (element === undefined) {
      throw createGtkElementNotFoundError(`Accessible id was not found: ${id}`);
    }

    return element;
  };

  const findByPath = async (
    path: string
  ): Promise<GtkWidgetElement | undefined> => {
    const parsedPath = parseElementPath(path);
    const startedAt = Date.now();
    await waitForAtspiReady(state, appPath, _timeoutMs, startedAt);

    while (Date.now() - startedAt <= _timeoutMs) {
      const processId = assertProcessRunning(state, appPath);

      try {
        const handle = nativeFindById(processId, parsedPath.id);
        if (handle !== undefined) {
          let element = createGtkElement(handle);
          let resolved = true;

          for (const childIndex of parsedPath.childIndexes) {
            if (!isPathChildContainer(element)) {
              resolved = false;
              break;
            }

            const child = await element.childAt(childIndex);
            if (child === undefined) {
              resolved = false;
              break;
            }

            element = child;
          }

          if (resolved) {
            return element;
          }
        }
      } catch (error) {
        throw normalizeNativeError(error);
      }

      await delay(50);
    }

    assertProcessRunning(state, appPath);
    return undefined;
  };

  const getByPath = async (path: string): Promise<GtkWidgetElement> => {
    const element = await findByPath(path);
    if (element === undefined) {
      throw createGtkElementNotFoundError(
        `Element path was not found: ${path}`
      );
    }

    return element;
  };

  const findTrayItem = async (
    selector: GtkTrayItemSelector
  ): Promise<GtkTrayItem | undefined> => {
    const startedAt = Date.now();

    while (Date.now() - startedAt <= _timeoutMs) {
      const processId = assertProcessRunning(state, appPath);

      try {
        const item = nativeTrayItems(processId).find((candidate) =>
          nativeTrayItemMatchesSelector(candidate, selector)
        );
        if (item !== undefined) {
          return createGtkTrayItem(processId, item);
        }
      } catch (error) {
        const normalizedError = normalizeNativeError(error);
        if (
          normalizedError.code === 'OPERATION_FAILED' &&
          normalizedError.message.includes('Timeout was reached')
        ) {
          await delay(50);
          continue;
        }
        throw normalizedError;
      }

      await delay(50);
    }

    assertProcessRunning(state, appPath);
    return undefined;
  };

  const getTrayItem = async (
    selector: GtkTrayItemSelector
  ): Promise<GtkTrayItem> => {
    const trayItem = await findTrayItem(selector);
    if (trayItem === undefined) {
      throw createGtkElementNotFoundError(
        `StatusNotifier tray item was not found: ${JSON.stringify(selector)}`
      );
    }

    return trayItem;
  };

  const app: GtkApp = {
    capture: async (): Promise<GtkCapture> => {
      assertProcessRunning(state, appPath);

      try {
        return nativeCaptureScreen();
      } catch (error) {
        throw normalizeNativeError(error);
      }
    },
    findById,
    findByPath,
    getById,
    getByPath,
    windowAt: async (index: number): Promise<GtkWidgetElement | undefined> => {
      assertNonNegativeIndex('index', index);
      const processId = await waitForAtspiReady(
        state,
        appPath,
        _timeoutMs,
        Date.now()
      );

      try {
        const handle = nativeWindowAt(processId, index);
        return handle === undefined ? undefined : createGtkElement(handle);
      } catch (error) {
        throw normalizeNativeError(error);
      }
    },
    getWindowCount: async (): Promise<number> => {
      const processId = await waitForAtspiReady(
        state,
        appPath,
        _timeoutMs,
        Date.now()
      );

      try {
        return nativeWindowCount(processId);
      } catch (error) {
        throw normalizeNativeError(error);
      }
    },
    findTrayItem,
    getTrayItem,
    trayItemAt: async (index: number): Promise<GtkTrayItem | undefined> => {
      assertNonNegativeIndex('index', index);
      const processId = assertProcessRunning(state, appPath);

      try {
        const item = nativeTrayItems(processId)[index];
        return item === undefined
          ? undefined
          : createGtkTrayItem(processId, item);
      } catch (error) {
        throw normalizeNativeError(error);
      }
    },
    getTrayItemCount: async (): Promise<number> => {
      const processId = assertProcessRunning(state, appPath);

      try {
        return nativeTrayItems(processId).length;
      } catch (error) {
        throw normalizeNativeError(error);
      }
    },
    release,
    [Symbol.asyncDispose]: release,
  };

  child.on('error', (error) => {
    appendOutput(state.stderr, Buffer.from(error.message));
  });

  return Promise.resolve(app);
};

/**
 * Creates a reusable GTK application launcher.
 * @param options - Options.
 * @returns GtkAppLauncher instance.
 */
export const createGtkAppLauncher = (
  options: GtkAppLauncherOptions
): GtkAppLauncher => {
  const launchedApps: GtkApp[] = [];

  const launch = async (args?: readonly string[]): Promise<GtkApp> => {
    const launchOptions: LaunchGtkAppOptions = {
      env: options.env,
      timeoutMs: options.timeoutMs,
    };

    const app = await launchGtkApp(
      options.appPath,
      [...(options.args ?? []), ...(args ?? [])],
      launchOptions
    );
    launchedApps.push(app);
    return app;
  };

  const release = async (): Promise<void> => {
    const apps = launchedApps.splice(0);
    await Promise.all(apps.map((app) => app.release()));
  };

  return {
    launch,
    release,
    [Symbol.asyncDispose]: release,
  };
};
