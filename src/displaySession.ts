// gestament - TypeScript based test driver for GTK.
// Copyright (c) Kouji Matsui. (@kekyo@mi.kekyo.net)
// Under MIT.
// https://github.com/kekyo/gestament

import { spawn, type ChildProcessByStdio } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import type { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';

import {
  createGtkAppExitedError,
  createGtkInvalidArgumentError,
  createGtkOperationFailedError,
} from './errors';
import type {
  DriverAppRef,
  DriverCommand,
  DriverElementRef,
  DriverErrorResponse,
  DriverLaunchPayload,
  DriverReadyMessage,
  DriverRequest,
  DriverResponse,
  DriverSuccessResponse,
  DriverTrayItemRef,
  SerializedDriverError,
  WireCapture,
  WireGtkAppEnvironment,
  WireImageInfo,
} from './launcherDriverProtocol';
import type {
  GtkApp,
  GtkAppDisplay,
  GtkAppLauncher,
  GtkAppLauncherOptions,
  GtkCapture,
  GtkElementInfo,
  GtkImageInfo,
  GtkTrayItem,
  GtkTrayItemMetadata,
  GtkTrayItemSelector,
  GtkValueInfo,
  GtkWidgetElement,
} from './types';

/////////////////////////////////////////////////////////////////////////////////////////

interface XvfbSessionOptions {
  readonly screen: string;
  readonly trayHost: boolean;
}

interface EffectiveDisplay {
  readonly kind: 'host' | 'xvfb';
  readonly hostDisplay: string | undefined;
  readonly hostWaylandDisplay: string | undefined;
  readonly xvfb: XvfbSessionOptions | undefined;
}

interface HostDisplayState {
  readonly display: string | undefined;
  readonly waylandDisplay: string | undefined;
}

interface DriverSession {
  readonly request: <Result>(
    command: DriverCommand,
    payload: unknown
  ) => Promise<Result>;
  readonly release: () => Promise<void>;
}

interface StartupConnection {
  readonly socket: Socket;
  readonly bufferedInput: string;
}

interface PendingRequest {
  readonly reject: (error: Error) => void;
  readonly resolve: (value: unknown) => void;
}

interface DriverProcess {
  readonly child: ChildProcessByStdio<null, Readable, Readable>;
  readonly commandLine: string;
  readonly stderr: string[];
  readonly stdout: string[];
}

const defaultDisplay: GtkAppDisplay = 'xvfb';
const defaultGSettings = 'memory';
const defaultTheme = 'Adwaita';
const defaultXvfbScreen = '1280x720x24';
const defaultXvfbTrayHost = true;
const screenPattern = /^[1-9][0-9]*x[1-9][0-9]*x[1-9][0-9]*$/;
const sessionStartupTimeoutMs = 30_000;
const sessionReleaseTimeoutMs = 5_000;

let socketCounter = 0;

const hasValue = (value: string | undefined): value is string =>
  value !== undefined && value.length > 0;

const delay = (timeoutMs: number): Promise<void> =>
  new Promise<void>((resolveDelay) => {
    setTimeout(resolveDelay, timeoutMs);
  });

const appendOutput = (lines: string[], chunk: Buffer): void => {
  lines.push(chunk.toString('utf8'));
  if (lines.length > 40) {
    lines.splice(0, lines.length - 40);
  }
};

const unrefHandle = (handle: unknown): void => {
  const maybeRefHandle = handle as { readonly unref?: unknown };
  if (typeof maybeRefHandle.unref === 'function') {
    maybeRefHandle.unref();
  }
};

const formatOutputTail = (
  stdout: readonly string[],
  stderr: readonly string[]
): string => {
  const stdoutText = stdout.join('').trim();
  const stderrText = stderr.join('').trim();
  if (stdoutText.length === 0 && stderrText.length === 0) {
    return '';
  }
  return `\nstdout:\n${stdoutText}\nstderr:\n${stderrText}`;
};

const getHostDisplayState = (): HostDisplayState => ({
  display: process.env.DISPLAY,
  waylandDisplay: process.env.WAYLAND_DISPLAY,
});

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

const resolveEffectiveDisplay = (
  display: GtkAppDisplay,
  xvfb: XvfbSessionOptions
): EffectiveDisplay => {
  if (display === 'xvfb') {
    return {
      hostDisplay: undefined,
      hostWaylandDisplay: undefined,
      kind: 'xvfb',
      xvfb,
    };
  }

  const hostDisplay = getHostDisplayState();
  if (resolveHostDisplayKind(hostDisplay) !== undefined) {
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

const resolveGdkBackend = (effective: EffectiveDisplay): string | undefined => {
  if (effective.kind === 'xvfb') {
    return 'x11';
  }
  if (process.env.GDK_BACKEND !== undefined) {
    return undefined;
  }
  if (hasValue(effective.hostDisplay)) {
    return 'x11';
  }
  if (hasValue(effective.hostWaylandDisplay)) {
    return 'wayland';
  }
  return undefined;
};

const toWireEnvironment = (
  env: Record<string, string | undefined>
): WireGtkAppEnvironment => {
  const wireEnv: Record<string, string | null> = {};
  for (const [key, value] of Object.entries(env)) {
    wireEnv[key] = value ?? null;
  }
  return wireEnv;
};

const resolveLauncherEnvironment = (
  options: GtkAppLauncherOptions,
  effective: EffectiveDisplay
): WireGtkAppEnvironment =>
  toWireEnvironment({
    GDK_BACKEND: resolveGdkBackend(effective),
    GSETTINGS_BACKEND:
      options.gsettings === null
        ? undefined
        : (options.gsettings ?? defaultGSettings),
    GTK_THEME:
      options.theme === null ? undefined : (options.theme ?? defaultTheme),
    ...options.env,
  });

const resolveDriverPath = (): string => {
  const driverPath = resolve(
    dirname(fileURLToPath(import.meta.url)),
    '..',
    'dist',
    'gestament-launcher-driver.cjs'
  );
  if (!existsSync(driverPath)) {
    throw createGtkOperationFailedError(
      `Internal launcher driver was not found: ${driverPath}`
    );
  }
  return driverPath;
};

const createDriverEnvironment = (
  effective: EffectiveDisplay
): NodeJS.ProcessEnv => {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.AT_SPI_BUS_ADDRESS;
  delete env.NO_AT_BRIDGE;

  if (effective.kind === 'xvfb') {
    env.GDK_BACKEND = 'x11';
    env.GESTAMENT_XVFB_ACTIVE = '1';
  }

  return env;
};

const spawnDriverProcess = (
  driverPath: string,
  socketPath: string,
  effective: EffectiveDisplay
): DriverProcess => {
  const driverArgs = [
    '--socket',
    socketPath,
    ...(effective.kind === 'xvfb' && effective.xvfb?.trayHost === true
      ? ['--with-tray-host']
      : []),
  ];
  const env = createDriverEnvironment(effective);
  const stdout: string[] = [];
  const stderr: string[] = [];

  const command =
    effective.kind === 'xvfb'
      ? {
          args: [
            '-a',
            '-s',
            `-screen 0 ${effective.xvfb?.screen ?? defaultXvfbScreen}`,
            '--',
            'dbus-run-session',
            '--',
            process.execPath,
            driverPath,
            ...driverArgs,
          ],
          bin: 'xvfb-run',
        }
      : {
          args: [driverPath, ...driverArgs],
          bin: process.execPath,
        };

  const child = spawn(command.bin, command.args, {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  child.stdout.on('data', (chunk: Buffer) => {
    appendOutput(stdout, chunk);
  });
  child.stderr.on('data', (chunk: Buffer) => {
    appendOutput(stderr, chunk);
  });

  const commandLine = [command.bin, ...command.args].join(' ');
  return { child, commandLine, stderr, stdout };
};

const listenOnSocket = (server: Server, socketPath: string): Promise<void> =>
  new Promise<void>((resolveListen, rejectListen) => {
    const rejectFromError = (error: Error): void => {
      server.removeListener('listening', resolveFromListening);
      rejectListen(error);
    };
    const resolveFromListening = (): void => {
      server.removeListener('error', rejectFromError);
      resolveListen();
    };

    server.once('error', rejectFromError);
    server.once('listening', resolveFromListening);
    server.listen(socketPath);
  });

const parseReadyMessage = (line: string): DriverReadyMessage | undefined => {
  const value = JSON.parse(line) as unknown;
  if (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    'type' in value &&
    value.type === 'ready'
  ) {
    return value as DriverReadyMessage;
  }
  return undefined;
};

const waitForDriverReady = (
  server: Server,
  processState: DriverProcess
): Promise<StartupConnection> =>
  new Promise<StartupConnection>((resolveReady, rejectReady) => {
    let socket: Socket | undefined;
    let input = '';
    let settled = false;

    const cleanup = (): void => {
      clearTimeout(timeout);
      server.removeListener('connection', acceptConnection);
      server.removeListener('error', rejectFromError);
      processState.child.removeListener('error', rejectFromError);
      processState.child.removeListener('exit', rejectFromExit);
      socket?.removeListener('data', readReadyData);
      socket?.removeListener('error', rejectFromError);
      socket?.removeListener('close', rejectFromSocketClose);
    };

    const rejectOnce = (error: Error): void => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      socket?.destroy();
      rejectReady(error);
    };

    const rejectFromError = (error: Error): void => {
      rejectOnce(
        createGtkOperationFailedError(
          `Launcher driver failed to start: ${error.message}` +
            formatOutputTail(processState.stdout, processState.stderr)
        )
      );
    };

    const rejectFromExit = (
      code: number | null,
      signal: NodeJS.Signals | null
    ): void => {
      rejectOnce(
        createGtkOperationFailedError(
          `Launcher driver exited before ready: code=${String(
            code
          )}, signal=${String(signal)}` +
            formatOutputTail(processState.stdout, processState.stderr)
        )
      );
    };

    const rejectFromSocketClose = (): void => {
      rejectOnce(
        createGtkOperationFailedError(
          'Launcher driver socket closed before ready.' +
            formatOutputTail(processState.stdout, processState.stderr)
        )
      );
    };

    const readReadyData = (chunk: Buffer): void => {
      input += chunk.toString('utf8');
      let newlineIndex = input.indexOf('\n');
      while (newlineIndex >= 0) {
        const line = input.slice(0, newlineIndex);
        input = input.slice(newlineIndex + 1);
        try {
          if (parseReadyMessage(line) !== undefined) {
            if (settled) {
              return;
            }
            settled = true;
            cleanup();
            if (socket === undefined) {
              rejectReady(
                createGtkOperationFailedError(
                  'Launcher driver reported ready without a socket.'
                )
              );
              return;
            }
            resolveReady({ bufferedInput: input, socket });
            return;
          }
        } catch (error) {
          const message =
            error instanceof Error ? error.message : String(error);
          rejectOnce(
            createGtkOperationFailedError(
              `Launcher driver sent invalid ready message: ${message}` +
                formatOutputTail(processState.stdout, processState.stderr)
            )
          );
          return;
        }

        newlineIndex = input.indexOf('\n');
      }
    };

    const acceptConnection = (acceptedSocket: Socket): void => {
      if (socket !== undefined) {
        acceptedSocket.destroy();
        return;
      }

      socket = acceptedSocket;
      acceptedSocket.on('data', readReadyData);
      acceptedSocket.once('error', rejectFromError);
      acceptedSocket.once('close', rejectFromSocketClose);
    };

    const timeout = setTimeout(() => {
      rejectOnce(
        createGtkOperationFailedError(
          `Timed out waiting for launcher driver: ${processState.commandLine}` +
            formatOutputTail(processState.stdout, processState.stderr)
        )
      );
    }, sessionStartupTimeoutMs);

    server.on('connection', acceptConnection);
    server.once('error', rejectFromError);
    processState.child.once('error', rejectFromError);
    processState.child.once('exit', rejectFromExit);
  });

const serializeRequest = (
  id: number,
  command: DriverCommand,
  payload: unknown
): string => {
  const request: DriverRequest = { command, id, payload };
  return `${JSON.stringify(request)}\n`;
};

const reconstructDriverError = (error: SerializedDriverError): Error => {
  const reconstructed = new Error(error.message) as Error & {
    code?: string;
  };
  reconstructed.name = error.name;
  if (error.stack !== undefined) {
    reconstructed.stack = error.stack;
  }
  if (error.code !== undefined) {
    Object.defineProperty(reconstructed, 'code', {
      enumerable: true,
      value: error.code,
    });
  }
  return reconstructed;
};

const decodeCapture = (capture: WireCapture): GtkCapture => ({
  bounds: capture.bounds,
  clipped: capture.clipped,
  image: Buffer.from(capture.imageBase64, 'base64'),
  visibleBounds: capture.visibleBounds,
});

const createDriverSession = (
  socket: Socket,
  bufferedInput: string,
  processState: DriverProcess,
  tempDirectory: string
): DriverSession => {
  const pending = new Map<number, PendingRequest>();
  let input = bufferedInput;
  let nextRequestId = 1;
  let closed = false;

  const rejectPending = (error: Error): void => {
    const entries = [...pending.values()];
    pending.clear();
    for (const entry of entries) {
      entry.reject(error);
    }
    socket.unref();
  };

  const markClosed = (): void => {
    if (closed) {
      return;
    }
    closed = true;
    rejectPending(createGtkAppExitedError('Launcher driver has exited.'));
  };

  const handleResponse = (line: string): void => {
    const response = JSON.parse(line) as DriverResponse;
    const entry = pending.get(response.id);
    if (entry === undefined) {
      return;
    }

    pending.delete(response.id);
    if (pending.size === 0) {
      socket.unref();
    }

    if (response.ok) {
      entry.resolve((response as DriverSuccessResponse).value);
    } else {
      entry.reject(
        reconstructDriverError((response as DriverErrorResponse).error)
      );
    }
  };

  const readData = (chunk: Buffer): void => {
    input += chunk.toString('utf8');
    let newlineIndex = input.indexOf('\n');
    while (newlineIndex >= 0) {
      const line = input.slice(0, newlineIndex);
      input = input.slice(newlineIndex + 1);
      try {
        handleResponse(line);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        rejectPending(
          createGtkOperationFailedError(
            `Launcher driver sent an invalid response: ${message}`
          )
        );
      }
      newlineIndex = input.indexOf('\n');
    }
  };

  socket.on('data', readData);
  socket.once('close', markClosed);
  socket.once('error', markClosed);
  processState.child.once('exit', markClosed);
  processState.child.unref();
  unrefHandle(processState.child.stdout);
  unrefHandle(processState.child.stderr);
  socket.unref();

  const request = <Result>(
    command: DriverCommand,
    payload: unknown
  ): Promise<Result> => {
    if (closed) {
      return Promise.reject(
        createGtkAppExitedError('Launcher driver has exited.')
      );
    }

    const id = nextRequestId;
    nextRequestId += 1;
    socket.ref();

    return new Promise<Result>((resolveRequest, rejectRequest) => {
      pending.set(id, {
        reject: rejectRequest,
        resolve: (value: unknown): void => {
          resolveRequest(value as Result);
        },
      });
      socket.write(serializeRequest(id, command, payload), (error) => {
        if (error != null) {
          pending.delete(id);
          if (pending.size === 0) {
            socket.unref();
          }
          rejectRequest(
            createGtkOperationFailedError(
              `Failed to write launcher driver request: ${error.message}`
            )
          );
        }
      });
    });
  };

  const waitForExit = async (): Promise<void> => {
    const startedAt = Date.now();
    while (
      processState.child.exitCode === null &&
      processState.child.signalCode === null
    ) {
      if (Date.now() - startedAt > sessionReleaseTimeoutMs) {
        processState.child.kill('SIGKILL');
        break;
      }
      await delay(25);
    }
  };

  const release = async (): Promise<void> => {
    if (!closed) {
      try {
        await request<null>('launcher.release', null);
      } catch (error) {
        if (!closed) {
          throw error;
        }
      }
    }

    closed = true;
    socket.destroy();
    await waitForExit();
    rmSync(tempDirectory, { force: true, recursive: true });
  };

  return { release, request };
};

const startDriverSession = async (
  options: GtkAppLauncherOptions
): Promise<DriverSession> => {
  const display = resolveDisplay(options.display);
  const xvfb = resolveXvfbOptions(options);
  const effective = resolveEffectiveDisplay(display, xvfb);
  const driverPath = resolveDriverPath();
  const tempDirectory = mkdtempSync(
    join(tmpdir(), `gestament-launcher-${process.pid}-${socketCounter}-`)
  );
  socketCounter += 1;
  const socketPath = join(tempDirectory, 'driver.sock');
  const server = createServer();
  let processState: DriverProcess | undefined;

  try {
    await listenOnSocket(server, socketPath);
    server.unref();

    processState = spawnDriverProcess(driverPath, socketPath, effective);
    const connection = await waitForDriverReady(server, processState);
    server.close();
    return createDriverSession(
      connection.socket,
      connection.bufferedInput,
      processState,
      tempDirectory
    );
  } catch (error) {
    server.close();
    if (
      processState !== undefined &&
      processState.child.exitCode === null &&
      processState.child.signalCode === null
    ) {
      processState.child.kill('SIGTERM');
    }
    rmSync(tempDirectory, { force: true, recursive: true });
    throw error;
  }
};

const createLaunchPayload = (
  options: GtkAppLauncherOptions,
  args: readonly string[]
): DriverLaunchPayload => {
  const display = resolveDisplay(options.display);
  const xvfb = resolveXvfbOptions(options);
  const effective = resolveEffectiveDisplay(display, xvfb);

  return {
    appPath: options.appPath,
    args: [...(options.args ?? []), ...args],
    env: resolveLauncherEnvironment(options, effective),
    timeoutMs: options.timeoutMs ?? null,
  };
};

const elementRefToProxy = (
  session: DriverSession,
  ref: DriverElementRef | null
): GtkWidgetElement | undefined =>
  ref === null ? undefined : createProxyGtkElement(session, ref);

const trayRefToProxy = (
  session: DriverSession,
  ref: DriverTrayItemRef | null
): GtkTrayItem | undefined =>
  ref === null ? undefined : createProxyGtkTrayItem(session, ref);

const createProxyGtkApp = (
  session: DriverSession,
  ref: DriverAppRef
): GtkApp => {
  let released = false;

  const assertNotReleased = (): void => {
    if (released) {
      throw createGtkAppExitedError('GTK application has been released.');
    }
  };

  const appRequest = <Result>(
    command: DriverCommand,
    payload: object = {}
  ): Promise<Result> => {
    assertNotReleased();
    return session.request<Result>(command, {
      appId: ref.appId,
      ...payload,
    });
  };

  const release = async (): Promise<void> => {
    if (released) {
      return;
    }
    released = true;
    await session.request<null>('app.release', { appId: ref.appId });
  };

  const app: GtkApp = {
    capture: async (): Promise<GtkCapture> =>
      decodeCapture(await appRequest<WireCapture>('app.capture')),
    findById: async (id: string): Promise<GtkWidgetElement | undefined> =>
      elementRefToProxy(
        session,
        await appRequest<DriverElementRef | null>('app.findById', { id })
      ),
    getById: async (id: string): Promise<GtkWidgetElement> =>
      createProxyGtkElement(
        session,
        await appRequest<DriverElementRef>('app.getById', { id })
      ),
    findByPath: async (path: string): Promise<GtkWidgetElement | undefined> =>
      elementRefToProxy(
        session,
        await appRequest<DriverElementRef | null>('app.findByPath', { path })
      ),
    getByPath: async (path: string): Promise<GtkWidgetElement> =>
      createProxyGtkElement(
        session,
        await appRequest<DriverElementRef>('app.getByPath', { path })
      ),
    windowAt: async (index: number): Promise<GtkWidgetElement | undefined> =>
      elementRefToProxy(
        session,
        await appRequest<DriverElementRef | null>('app.windowAt', { index })
      ),
    getWindowCount: (): Promise<number> =>
      appRequest<number>('app.getWindowCount'),
    findTrayItem: async (
      selector: GtkTrayItemSelector
    ): Promise<GtkTrayItem | undefined> =>
      trayRefToProxy(
        session,
        await appRequest<DriverTrayItemRef | null>('app.findTrayItem', {
          selector,
        })
      ),
    getTrayItem: async (selector: GtkTrayItemSelector): Promise<GtkTrayItem> =>
      createProxyGtkTrayItem(
        session,
        await appRequest<DriverTrayItemRef>('app.getTrayItem', { selector })
      ),
    trayItemAt: async (index: number): Promise<GtkTrayItem | undefined> =>
      trayRefToProxy(
        session,
        await appRequest<DriverTrayItemRef | null>('app.trayItemAt', {
          index,
        })
      ),
    getTrayItemCount: (): Promise<number> =>
      appRequest<number>('app.getTrayItemCount'),
    release,
    [Symbol.asyncDispose]: release,
  };
  return app;
};

const addChildContainerProxyOperations = (
  session: DriverSession,
  elementId: string,
  target: Record<string, unknown>
): void => {
  target.childAt = async (
    index: number
  ): Promise<GtkWidgetElement | undefined> =>
    elementRefToProxy(
      session,
      await session.request<DriverElementRef | null>('element.childAt', {
        elementId,
        index,
      })
    );
  target.getChildCount = (): Promise<number> =>
    session.request<number>('element.getChildCount', { elementId });
};

const addSelectableChildContainerProxyOperations = (
  session: DriverSession,
  elementId: string,
  target: Record<string, unknown>
): void => {
  addChildContainerProxyOperations(session, elementId, target);
  target.getSelectedChildCount = (): Promise<number> =>
    session.request<number>('element.getSelectedChildCount', { elementId });
  target.selectedChildAt = async (
    selectedIndex: number
  ): Promise<GtkWidgetElement | undefined> =>
    elementRefToProxy(
      session,
      await session.request<DriverElementRef | null>(
        'element.selectedChildAt',
        {
          elementId,
          selectedIndex,
        }
      )
    );
  target.isChildSelected = (index: number): Promise<boolean> =>
    session.request<boolean>('element.isChildSelected', { elementId, index });
  target.selectChildAt = (index: number): Promise<void> =>
    session
      .request<null>('element.selectChildAt', { elementId, index })
      .then(() => undefined);
  target.deselectChildAt = (index: number): Promise<void> =>
    session
      .request<null>('element.deselectChildAt', { elementId, index })
      .then(() => undefined);
  target.selectAllChildren = (): Promise<void> =>
    session
      .request<null>('element.selectAllChildren', { elementId })
      .then(() => undefined);
  target.clearSelection = (): Promise<void> =>
    session
      .request<null>('element.clearSelection', { elementId })
      .then(() => undefined);
};

const addClickableProxyOperation = (
  session: DriverSession,
  elementId: string,
  target: Record<string, unknown>
): void => {
  target.click = (): Promise<void> =>
    session.request<null>('element.click', { elementId }).then(() => undefined);
};

const addCheckableProxyOperations = (
  session: DriverSession,
  elementId: string,
  target: Record<string, unknown>
): void => {
  target.isChecked = (): Promise<boolean> =>
    session.request<boolean>('element.isChecked', { elementId });
  target.toggle = (): Promise<void> =>
    session
      .request<null>('element.toggle', { elementId })
      .then(() => undefined);
};

const addTextProxyOperation = (
  session: DriverSession,
  elementId: string,
  target: Record<string, unknown>
): void => {
  target.text = (): Promise<string> =>
    session.request<string>('element.text', { elementId });
};

const addValueProxyOperations = (
  session: DriverSession,
  elementId: string,
  target: Record<string, unknown>,
  writable: boolean
): void => {
  target.value = (): Promise<number> =>
    session.request<number>('element.value', { elementId });
  target.valueInfo = (): Promise<GtkValueInfo> =>
    session.request<GtkValueInfo>('element.valueInfo', { elementId });
  if (writable) {
    target.setValue = (value: number): Promise<void> =>
      session
        .request<null>('element.setValue', { elementId, value })
        .then(() => undefined);
  }
};

const createProxyImageInfo = (
  session: DriverSession,
  info: WireImageInfo
): GtkImageInfo => ({
  bounds: info.bounds,
  capture: async (): Promise<GtkCapture> =>
    decodeCapture(
      await session.request<WireCapture>('imageInfo.capture', {
        imageInfoId: info.imageInfoId,
      })
    ),
  description: info.description,
  locale: info.locale,
  position: info.position,
  size: info.size,
});

const createProxyGtkElement = (
  session: DriverSession,
  ref: DriverElementRef
): GtkWidgetElement => {
  const elementId = ref.elementId;
  const target: Record<string, unknown> = {
    capture: async (): Promise<GtkCapture> =>
      decodeCapture(
        await session.request<WireCapture>('element.capture', { elementId })
      ),
    info: (): Promise<GtkElementInfo> =>
      session.request<GtkElementInfo>('element.info', { elementId }),
    kind: ref.kind,
  };

  switch (ref.kind) {
    case 'window':
    case 'container':
    case 'menu':
      addChildContainerProxyOperations(session, elementId, target);
      break;
    case 'button':
    case 'listItem':
    case 'menuItem':
      addClickableProxyOperation(session, elementId, target);
      break;
    case 'label':
    case 'text':
      addTextProxyOperation(session, elementId, target);
      break;
    case 'entry':
      addTextProxyOperation(session, elementId, target);
      target.setText = (text: string): Promise<void> =>
        session
          .request<null>('element.setText', { elementId, text })
          .then(() => undefined);
      break;
    case 'checkbox':
    case 'switch':
    case 'radio':
    case 'toggleButton':
      addClickableProxyOperation(session, elementId, target);
      addCheckableProxyOperations(session, elementId, target);
      break;
    case 'slider':
      addValueProxyOperations(session, elementId, target, true);
      break;
    case 'spinButton':
      addValueProxyOperations(session, elementId, target, true);
      target.increment = (): Promise<void> =>
        session
          .request<null>('element.increment', { elementId })
          .then(() => undefined);
      target.decrement = (): Promise<void> =>
        session
          .request<null>('element.decrement', { elementId })
          .then(() => undefined);
      break;
    case 'progressBar':
      addValueProxyOperations(session, elementId, target, false);
      break;
    case 'comboBox':
      addClickableProxyOperation(session, elementId, target);
      addSelectableChildContainerProxyOperations(session, elementId, target);
      break;
    case 'list':
      addSelectableChildContainerProxyOperations(session, elementId, target);
      break;
    case 'table':
      target.getRowCount = (): Promise<number> =>
        session.request<number>('element.getRowCount', { elementId });
      target.getColumnCount = (): Promise<number> =>
        session.request<number>('element.getColumnCount', { elementId });
      target.cellAt = async (
        row: number,
        column: number
      ): Promise<GtkWidgetElement | undefined> =>
        elementRefToProxy(
          session,
          await session.request<DriverElementRef | null>('element.cellAt', {
            column,
            elementId,
            row,
          })
        );
      target.selectedRows = (): Promise<readonly number[]> =>
        session.request<readonly number[]>('element.selectedRows', {
          elementId,
        });
      target.selectedColumns = (): Promise<readonly number[]> =>
        session.request<readonly number[]>('element.selectedColumns', {
          elementId,
        });
      target.isRowSelected = (row: number): Promise<boolean> =>
        session.request<boolean>('element.isRowSelected', { elementId, row });
      target.isColumnSelected = (column: number): Promise<boolean> =>
        session.request<boolean>('element.isColumnSelected', {
          column,
          elementId,
        });
      target.isCellSelected = (row: number, column: number): Promise<boolean> =>
        session.request<boolean>('element.isCellSelected', {
          column,
          elementId,
          row,
        });
      target.selectRow = (row: number): Promise<void> =>
        session
          .request<null>('element.selectRow', { elementId, row })
          .then(() => undefined);
      target.deselectRow = (row: number): Promise<void> =>
        session
          .request<null>('element.deselectRow', { elementId, row })
          .then(() => undefined);
      target.selectColumn = (column: number): Promise<void> =>
        session
          .request<null>('element.selectColumn', { column, elementId })
          .then(() => undefined);
      target.deselectColumn = (column: number): Promise<void> =>
        session
          .request<null>('element.deselectColumn', { column, elementId })
          .then(() => undefined);
      break;
    case 'image':
      target.imageInfo = async (): Promise<GtkImageInfo> =>
        createProxyImageInfo(
          session,
          await session.request<WireImageInfo>('element.imageInfo', {
            elementId,
          })
        );
      break;
    case 'tableCell':
    case 'unknown':
      break;
  }

  return target as unknown as GtkWidgetElement;
};

const createProxyGtkTrayItem = (
  session: DriverSession,
  ref: DriverTrayItemRef
): GtkTrayItem => {
  const trayItemId = ref.trayItemId;
  return {
    capture: async (): Promise<GtkCapture> =>
      decodeCapture(
        await session.request<WireCapture>('tray.capture', { trayItemId })
      ),
    click: (): Promise<void> =>
      session.request<null>('tray.click', { trayItemId }).then(() => undefined),
    element: async (): Promise<GtkWidgetElement | undefined> =>
      elementRefToProxy(
        session,
        await session.request<DriverElementRef | null>('tray.element', {
          trayItemId,
        })
      ),
    metadata: (): Promise<GtkTrayItemMetadata> =>
      session.request<GtkTrayItemMetadata>('tray.metadata', { trayItemId }),
    openMenu: async (): Promise<GtkWidgetElement | undefined> =>
      elementRefToProxy(
        session,
        await session.request<DriverElementRef | null>('tray.openMenu', {
          trayItemId,
        })
      ),
  };
};

/**
 * Creates a driver-backed launcher that owns a display session per launcher.
 * @param options Launcher options.
 * @returns GtkAppLauncher instance.
 */
export const createDriverBackedGtkAppLauncher = (
  options: GtkAppLauncherOptions
): GtkAppLauncher => {
  let sessionPromise: Promise<DriverSession> | undefined;

  const ensureSession = (): Promise<DriverSession> => {
    sessionPromise ??= startDriverSession(options);
    return sessionPromise;
  };

  const launch = async (args?: readonly string[]): Promise<GtkApp> => {
    const session = await ensureSession();
    const appRef = await session.request<DriverAppRef>(
      'launcher.launch',
      createLaunchPayload(options, args ?? [])
    );
    return createProxyGtkApp(session, appRef);
  };

  const release = async (): Promise<void> => {
    const releasingSession = sessionPromise;
    sessionPromise = undefined;
    if (releasingSession === undefined) {
      return;
    }
    const session = await releasingSession;
    await session.release();
  };

  return {
    launch,
    release,
    [Symbol.asyncDispose]: release,
  };
};
