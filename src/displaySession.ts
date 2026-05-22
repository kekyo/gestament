// gestament - TypeScript based test driver for GTK.
// Copyright (c) Kouji Matsui. (@kekyo@mi.kekyo.net)
// Under MIT.
// https://github.com/kekyo/gestament

import { spawn, type ChildProcessByStdio } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import {
  createConnection,
  createServer,
  type Server,
  type Socket,
} from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import type { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';

import {
  createGtkAppExitedError,
  createGtkInvalidArgumentError,
  createGtkOperationFailedError,
} from './errors';
import { currentWaitDeadlineMs } from './wait';
import {
  createGtkSystemOutputRecorder,
  notifyGtkSystemOutput,
  normalizeOutputBufferBytes,
  type GtkSystemOutputRecorder,
} from './output';
import { appendPrerequisiteInstallHint } from './prerequisites';
import type {
  DriverAppRef,
  DriverCommand,
  DriverEnvironmentPayload,
  DriverElementRef,
  DriverEventChannel,
  DriverEventMessage,
  DriverErrorResponse,
  DriverLaunchPayload,
  DriverMessage,
  DriverReadyMessage,
  DriverRequest,
  DriverResponse,
  DriverSuccessResponse,
  DriverTrayItemRef,
  SerializedDriverError,
  WireCapture,
  WireGtkAppEnvironment,
  WireGtkAppOutput,
  WireGtkSystemOutput,
  WireImageInfo,
} from './launcherDriverProtocol';
import type {
  GtkApp,
  GtkAppDisplay,
  GtkAppEnvironment,
  GtkAppLauncher,
  GtkAppLauncherLaunchOptions,
  GtkAppLauncherOptions,
  GtkAppOutputEvent,
  GtkCapture,
  GtkCaptureBounds,
  GtkElementInfo,
  GtkImageInfo,
  GtkSystemOutput,
  GtkSystemOutputEvent,
  GtkSystemOutputSource,
  GtkTrayItem,
  GtkTrayItemMetadata,
  GtkTrayItemSelector,
  GtkValueInfo,
  GtkWidgetElement,
  GtkWindowResizeHints,
  GtkX11WindowInfo,
  GtkXvfbPool,
} from './types';

/////////////////////////////////////////////////////////////////////////////////////////

interface XvfbSessionOptions {
  readonly screen: string;
  readonly trayHost: boolean;
  readonly pool: ResolvedXvfbPool | undefined;
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
  readonly setSystemOutputSink: (sink: SystemOutputSink | undefined) => void;
  readonly subscribe: (
    channel: DriverEventChannel,
    scopeId: string,
    handler: (value: unknown) => void
  ) => DriverEventSubscription;
  readonly terminate: () => Promise<void>;
}

interface DriverEventSubscription {
  readonly dispose: () => void;
}

interface PooledXvfb {
  readonly child: ChildProcessByStdio<null, Readable, Readable>;
  readonly display: string;
  readonly displayNumber: number;
  readonly key: string;
  readonly screen: string;
  readonly stderr: string[];
  readonly stdout: string[];
  lastUsedAt: number;
  systemOutputSink: SystemOutputSink | undefined;
}

interface PooledAllSession {
  readonly key: string;
  readonly session: DriverSession;
  readonly xvfb: PooledXvfb;
  lastUsedAt: number;
}

interface XvfbPoolLimits {
  readonly maxIdlePerKey: number;
  readonly maxIdleTotal: number;
}

interface ResolvedXvfbPool extends XvfbPoolLimits {
  readonly type: 'xvfb' | 'all';
}

interface XvfbProbeResult {
  readonly bounds: {
    readonly height: number;
    readonly width: number;
    readonly x: number;
    readonly y: number;
  };
  readonly mappedWindowCount: number;
}

interface XvfbProbeErrorPayload {
  readonly code: string | undefined;
  readonly message: string | undefined;
}

interface DriverResetResult {
  readonly appCount: number;
  readonly elementCount: number;
  readonly imageInfoCount: number;
  readonly trayItemCount: number;
}

interface DriverSessionPoolOptions {
  readonly allKey: string | undefined;
  readonly limits: XvfbPoolLimits;
  readonly mode: 'none' | 'xvfb' | 'all';
  readonly xvfb: PooledXvfb | undefined;
  readonly allowedMappedWindowCount: number;
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
  systemOutputSink: SystemOutputSink | undefined;
}

interface SystemOutputSink {
  readonly append: (
    source: GtkSystemOutputSource,
    stream: 'stdout' | 'stderr',
    chunk: Buffer
  ) => void;
  readonly flush: (
    source: GtkSystemOutputSource,
    stream: 'stdout' | 'stderr'
  ) => void;
}

interface XvfbProbeError extends Error {
  readonly retryable: boolean;
}

const defaultDisplay: GtkAppDisplay = 'xvfb';
const defaultGSettings = 'memory';
const defaultTheme = 'Adwaita';
const defaultXvfbScreen = '1280x720x24';
const defaultXvfbTrayHost = true;
const defaultXvfbPoolMaxIdlePerKey = 1;
const defaultXvfbPoolMaxIdleTotal = 4;
const screenPattern = /^[1-9][0-9]*x[1-9][0-9]*x[1-9][0-9]*$/;
const sessionStartupTimeoutMs = 30_000;
const sessionReleaseTimeoutMs = 5_000;
const xvfbStartupTimeoutMs = 10_000;
const xvfbPoolProbeTimeoutMs = 5_000;
const xvfbPoolProbeRetryIntervalMs = 50;
const xvfbPoolProbePrefix = 'gestament-xvfb-pool-probe: ';
const x11DisplayOpenFailureMessage =
  'Failed to open the X11 display. Ensure DISPLAY points to an X11 display.';
const firstPooledDisplayNumber = 90;
const lastPooledDisplayNumber = 590;
const sessionOwnedEnvironmentKeys = [
  'DISPLAY',
  'WAYLAND_DISPLAY',
  'GDK_BACKEND',
  'DBUS_SESSION_BUS_ADDRESS',
  'AT_SPI_BUS_ADDRESS',
  'NO_AT_BRIDGE',
  'XAUTHORITY',
  'GESTAMENT_XVFB_ACTIVE',
  'XDG_SESSION_TYPE',
] as const;

let outputScopeCounter = 0;
let socketCounter = 0;
const leasedDisplayNumbers = new Set<number>();
const idleXvfbByKey = new Map<string, PooledXvfb[]>();
const idleAllByKey = new Map<string, PooledAllSession[]>();
const directXvfbs = new Set<PooledXvfb>();
let poolCleanupInstalled = false;

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

const appendSystemOutput = (
  sink: SystemOutputSink | undefined,
  source: GtkSystemOutputSource,
  stream: 'stdout' | 'stderr',
  chunk: Buffer
): void => {
  sink?.append(source, stream, chunk);
};

const flushSystemOutput = (
  sink: SystemOutputSink | undefined,
  source: GtkSystemOutputSource,
  stream: 'stdout' | 'stderr'
): void => {
  sink?.flush(source, stream);
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

const createXvfbProbeError = (
  message: string,
  retryable: boolean
): XvfbProbeError => {
  const error = createGtkOperationFailedError(message) as unknown as Error & {
    retryable?: boolean;
  };
  Object.defineProperty(error, 'retryable', {
    value: retryable,
  });
  return error as XvfbProbeError;
};

const parseXvfbProbeErrorPayload = (
  stderrText: string
): XvfbProbeErrorPayload | undefined => {
  const lines = stderrText.trim().split('\n').reverse();
  for (const line of lines) {
    if (!line.startsWith(xvfbPoolProbePrefix)) {
      continue;
    }

    try {
      const value = JSON.parse(
        line.slice(xvfbPoolProbePrefix.length)
      ) as unknown;
      if (!isRecord(value)) {
        return undefined;
      }
      return {
        code: typeof value.code === 'string' ? value.code : undefined,
        message: typeof value.message === 'string' ? value.message : undefined,
      };
    } catch {
      return undefined;
    }
  }
  return undefined;
};

const isRetryableXvfbProbeExit = (stderrText: string): boolean => {
  const payload = parseXvfbProbeErrorPayload(stderrText);
  return (
    payload?.code === 'OPERATION_FAILED' &&
    payload.message === x11DisplayOpenFailureMessage
  );
};

const isRetryableXvfbProbeError = (error: unknown): error is XvfbProbeError =>
  isRecord(error) && typeof error.retryable === 'boolean' && error.retryable;

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

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const createDriverEventKey = (
  channel: DriverEventChannel,
  scopeId: string
): string => `${channel}\n${scopeId}`;

const createOutputScopeId = (): string => {
  const scopeId = `output-${process.pid}-${outputScopeCounter}`;
  outputScopeCounter += 1;
  return scopeId;
};

const isDriverEventMessage = (
  message: DriverMessage
): message is DriverEventMessage =>
  isRecord(message) &&
  message.type === 'event' &&
  typeof message.channel === 'string' &&
  typeof message.scopeId === 'string';

const resolveOutputBufferBytes = (
  launcherValue: number | undefined,
  launchValue: number | undefined
): number | null => {
  const value = launchValue ?? launcherValue;
  if (value === undefined) {
    return null;
  }
  if (!Number.isSafeInteger(value) || value < 0) {
    throw createGtkInvalidArgumentError(
      'outputBufferBytes must be a non-negative safe integer.'
    );
  }
  return value;
};

const createSystemOutputSink = (
  recorder: GtkSystemOutputRecorder,
  callback: ((event: GtkSystemOutputEvent) => void) | undefined
): SystemOutputSink => ({
  append: (
    source: GtkSystemOutputSource,
    stream: 'stdout' | 'stderr',
    chunk: Buffer
  ): void => {
    notifyGtkSystemOutput(callback, recorder.append(source, stream, chunk));
  },
  flush: (source: GtkSystemOutputSource, stream: 'stdout' | 'stderr'): void => {
    notifyGtkSystemOutput(callback, recorder.flush(source, stream));
  },
});

const isGtkSystemOutputSource = (
  value: unknown
): value is GtkSystemOutputSource =>
  value === 'xvfb' || value === 'launcher-driver' || value === 'tray-host';

const isGtkAppOutputStream = (value: unknown): value is 'stdout' | 'stderr' =>
  value === 'stdout' || value === 'stderr';

const isWireGtkSystemOutput = (
  value: unknown
): value is WireGtkSystemOutput => {
  if (!isRecord(value)) {
    return false;
  }
  if (
    !isGtkSystemOutputSource(value.source) ||
    !isGtkAppOutputStream(value.stream)
  ) {
    return false;
  }
  if (value.type === 'flush') {
    return true;
  }
  return value.type === 'chunk' && typeof value.chunkBase64 === 'string';
};

const routeWireSystemOutput = (
  sink: SystemOutputSink | undefined,
  value: unknown
): void => {
  if (!isWireGtkSystemOutput(value)) {
    return;
  }
  if (value.type === 'flush') {
    flushSystemOutput(sink, value.source, value.stream);
    return;
  }
  appendSystemOutput(
    sink,
    value.source,
    value.stream,
    Buffer.from(value.chunkBase64, 'base64')
  );
};

const resolvePoolLimit = (
  name: string,
  value: number | undefined,
  defaultValue: number
): number => {
  if (value === undefined) {
    return defaultValue;
  }
  if (!Number.isInteger(value) || value < 0) {
    throw createGtkInvalidArgumentError(`${name} must be an integer >= 0.`);
  }
  return value;
};

const resolveXvfbPool = (
  pool: GtkXvfbPool | undefined
): ResolvedXvfbPool | undefined => {
  if (pool === undefined) {
    return undefined;
  }
  if (!isRecord(pool)) {
    throw createGtkInvalidArgumentError(
      'xvfbPool must be an object with type "xvfb" or "all".'
    );
  }

  const { type } = pool;
  if (type !== 'xvfb' && type !== 'all') {
    throw createGtkInvalidArgumentError(
      `xvfbPool.type must be "xvfb" or "all": ${String(type)}`
    );
  }

  return {
    maxIdlePerKey: resolvePoolLimit(
      'xvfbPool.maxIdlePerKey',
      pool.maxIdlePerKey,
      defaultXvfbPoolMaxIdlePerKey
    ),
    maxIdleTotal: resolvePoolLimit(
      'xvfbPool.maxIdleTotal',
      pool.maxIdleTotal,
      defaultXvfbPoolMaxIdleTotal
    ),
    type,
  };
};

const nonePoolLimits = (): XvfbPoolLimits => ({
  maxIdlePerKey: 0,
  maxIdleTotal: 0,
});

const poolLimits = (pool: ResolvedXvfbPool): XvfbPoolLimits => ({
  maxIdlePerKey: pool.maxIdlePerKey,
  maxIdleTotal: pool.maxIdleTotal,
});

const shouldRetainIdlePool = (limits: XvfbPoolLimits): boolean =>
  limits.maxIdlePerKey > 0 && limits.maxIdleTotal > 0;

const removeArrayEntry = <Entry>(
  map: Map<string, Entry[]>,
  key: string,
  entry: Entry
): void => {
  const entries = map.get(key);
  if (entries === undefined) {
    return;
  }

  const index = entries.indexOf(entry);
  if (index >= 0) {
    entries.splice(index, 1);
  }
  if (entries.length === 0) {
    map.delete(key);
  }
};

const pushArrayEntry = <Entry>(
  map: Map<string, Entry[]>,
  key: string,
  entry: Entry
): void => {
  const entries = map.get(key);
  if (entries === undefined) {
    map.set(key, [entry]);
    return;
  }
  entries.push(entry);
};

const popArrayEntry = <Entry>(
  map: Map<string, Entry[]>,
  key: string
): Entry | undefined => {
  const entries = map.get(key);
  if (entries === undefined) {
    return undefined;
  }

  const entry = entries.pop();
  if (entries.length === 0) {
    map.delete(key);
  }
  return entry;
};

const totalArrayEntryCount = <Entry>(map: Map<string, Entry[]>): number =>
  [...map.values()].reduce((total, entries) => total + entries.length, 0);

const oldestEntry = <Entry extends { readonly lastUsedAt: number }>(
  entries: readonly Entry[]
): Entry | undefined =>
  [...entries].sort((first, second) => first.lastUsedAt - second.lastUsedAt)[0];

const allIdleXvfbs = (): PooledXvfb[] => [...idleXvfbByKey.values()].flat();

const allIdleAllSessions = (): PooledAllSession[] =>
  [...idleAllByKey.values()].flat();

const totalIdlePoolSize = (): number =>
  totalArrayEntryCount(idleXvfbByKey) + totalArrayEntryCount(idleAllByKey);

const candidateOldestIdlePool = ():
  | { readonly kind: 'all'; readonly session: PooledAllSession }
  | { readonly kind: 'xvfb'; readonly xvfb: PooledXvfb }
  | undefined => {
  const candidates = [
    ...allIdleXvfbs().map((xvfb) => ({
      kind: 'xvfb' as const,
      lastUsedAt: xvfb.lastUsedAt,
      xvfb,
    })),
    ...allIdleAllSessions().map((session) => ({
      kind: 'all' as const,
      lastUsedAt: session.lastUsedAt,
      session,
    })),
  ].sort((first, second) => first.lastUsedAt - second.lastUsedAt);
  const candidate = candidates[0];
  if (candidate === undefined) {
    return undefined;
  }
  return candidate.kind === 'xvfb'
    ? { kind: 'xvfb', xvfb: candidate.xvfb }
    : { kind: 'all', session: candidate.session };
};

const evictIdleXvfb = async (xvfb: PooledXvfb): Promise<void> => {
  removeArrayEntry(idleXvfbByKey, xvfb.key, xvfb);
  await terminateXvfb(xvfb);
};

const evictIdleAllSession = async (
  session: PooledAllSession
): Promise<void> => {
  removeArrayEntry(idleAllByKey, session.key, session);
  await session.session.terminate();
};

const evictIdlePools = async (maxIdleTotal: number): Promise<void> => {
  while (totalIdlePoolSize() > maxIdleTotal) {
    const candidate = candidateOldestIdlePool();
    if (candidate === undefined) {
      return;
    }
    if (candidate.kind === 'xvfb') {
      await evictIdleXvfb(candidate.xvfb);
    } else {
      await evictIdleAllSession(candidate.session);
    }
  }
};

const trimIdleXvfbKey = async (
  key: string,
  maxIdlePerKey: number
): Promise<void> => {
  while ((idleXvfbByKey.get(key)?.length ?? 0) > maxIdlePerKey) {
    const entry = oldestEntry(idleXvfbByKey.get(key) ?? []);
    if (entry === undefined) {
      return;
    }
    await evictIdleXvfb(entry);
  }
};

const trimIdleAllKey = async (
  key: string,
  maxIdlePerKey: number
): Promise<void> => {
  while ((idleAllByKey.get(key)?.length ?? 0) > maxIdlePerKey) {
    const entry = oldestEntry(idleAllByKey.get(key) ?? []);
    if (entry === undefined) {
      return;
    }
    await evictIdleAllSession(entry);
  }
};

const retainIdleXvfb = async (
  xvfb: PooledXvfb,
  limits: XvfbPoolLimits
): Promise<void> => {
  if (!shouldRetainIdlePool(limits)) {
    await terminateXvfb(xvfb);
    return;
  }

  xvfb.systemOutputSink = undefined;
  xvfb.lastUsedAt = Date.now();
  pushArrayEntry(idleXvfbByKey, xvfb.key, xvfb);
  await trimIdleXvfbKey(xvfb.key, limits.maxIdlePerKey);
  await evictIdlePools(limits.maxIdleTotal);
};

const retainIdleAllSession = async (
  session: PooledAllSession,
  limits: XvfbPoolLimits
): Promise<void> => {
  if (!shouldRetainIdlePool(limits)) {
    await session.session.terminate();
    return;
  }

  session.session.setSystemOutputSink(undefined);
  session.xvfb.systemOutputSink = undefined;
  session.lastUsedAt = Date.now();
  session.xvfb.lastUsedAt = session.lastUsedAt;
  pushArrayEntry(idleAllByKey, session.key, session);
  await trimIdleAllKey(session.key, limits.maxIdlePerKey);
  await evictIdlePools(limits.maxIdleTotal);
};

const emptyDriverSessionPoolOptions = (): DriverSessionPoolOptions => ({
  allKey: undefined,
  allowedMappedWindowCount: 0,
  limits: nonePoolLimits(),
  mode: 'none',
  xvfb: undefined,
});

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
    pool: resolveXvfbPool(options.xvfbPool),
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

const wireEnvironmentToGtkAppEnvironment = (
  env: WireGtkAppEnvironment
): GtkAppEnvironment => {
  const appEnv: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(env)) {
    appEnv[key] = value === null ? undefined : value;
  }
  return appEnv;
};

const assertNoSessionOwnedEnvironmentOverrides = (
  options: GtkAppLauncherOptions,
  effective: EffectiveDisplay
): void => {
  if (effective.kind !== 'xvfb' || options.env === undefined) {
    return;
  }

  for (const key of sessionOwnedEnvironmentKeys) {
    if (Object.hasOwn(options.env, key)) {
      throw createGtkInvalidArgumentError(
        `options.env must not override ${key} when using internal Xvfb.`
      );
    }
  }
};

const resolveLauncherEnvironment = (
  options: GtkAppLauncherOptions,
  effective: EffectiveDisplay
): WireGtkAppEnvironment => {
  assertNoSessionOwnedEnvironmentOverrides(options, effective);
  return toWireEnvironment({
    GDK_BACKEND: resolveGdkBackend(effective),
    GSETTINGS_BACKEND:
      options.gsettings === null
        ? undefined
        : (options.gsettings ?? defaultGSettings),
    GTK_THEME:
      options.theme === null ? undefined : (options.theme ?? defaultTheme),
    ...options.env,
  });
};

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

const resolveXvfbPoolProbePath = (): string => {
  const probePath = resolve(
    dirname(fileURLToPath(import.meta.url)),
    '..',
    'dist',
    'gestament-xvfb-pool-probe.cjs'
  );
  if (!existsSync(probePath)) {
    throw createGtkOperationFailedError(
      `Internal Xvfb pool probe was not found: ${probePath}`
    );
  }
  return probePath;
};

const createDriverEnvironment = (
  effective: EffectiveDisplay,
  xvfb: PooledXvfb | undefined
): NodeJS.ProcessEnv => {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.AT_SPI_BUS_ADDRESS;
  delete env.NO_AT_BRIDGE;

  if (effective.kind === 'xvfb') {
    delete env.DBUS_SESSION_BUS_ADDRESS;
    delete env.DISPLAY;
    delete env.WAYLAND_DISPLAY;
    delete env.AT_SPI_BUS_ADDRESS;
    delete env.NO_AT_BRIDGE;
    delete env.XAUTHORITY;
    env.GDK_BACKEND = 'x11';
    env.GESTAMENT_XVFB_ACTIVE = '1';
    env.XDG_SESSION_TYPE = 'x11';
    if (xvfb !== undefined) {
      env.DISPLAY = xvfb.display;
    }
  }

  return env;
};

const xvfbSocketPath = (displayNumber: number): string =>
  `/tmp/.X11-unix/X${displayNumber}`;

const isDisplayNumberAvailable = (displayNumber: number): boolean =>
  !leasedDisplayNumbers.has(displayNumber) &&
  !existsSync(xvfbSocketPath(displayNumber));

const connectUnixSocket = (path: string, timeoutMs: number): Promise<void> =>
  new Promise<void>((resolveConnect, rejectConnect) => {
    const socket = createConnection(path);
    let settled = false;

    const settle = (callback: () => void): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      socket.destroy();
      callback();
    };

    const timeout = setTimeout(() => {
      settle(() => {
        rejectConnect(
          createGtkOperationFailedError(`Timed out connecting to ${path}.`)
        );
      });
    }, timeoutMs);

    socket.once('connect', () => {
      settle(resolveConnect);
    });
    socket.once('error', (error) => {
      settle(() => {
        rejectConnect(error);
      });
    });
  });

const waitForXvfbReady = async (displayNumber: number): Promise<void> => {
  const startedAt = Date.now();
  const path = xvfbSocketPath(displayNumber);
  while (Date.now() - startedAt <= xvfbStartupTimeoutMs) {
    if (existsSync(path)) {
      try {
        await connectUnixSocket(path, 250);
        return;
      } catch {
        // Keep polling until the X server accepts local connections.
      }
    }
    await delay(25);
  }

  throw createGtkOperationFailedError(
    `Timed out waiting for Xvfb display :${displayNumber}.`
  );
};

const killXvfbNow = (xvfb: PooledXvfb): void => {
  if (xvfb.child.exitCode === null && xvfb.child.signalCode === null) {
    xvfb.child.kill('SIGTERM');
  }
};

const installPoolCleanup = (): void => {
  if (poolCleanupInstalled) {
    return;
  }
  poolCleanupInstalled = true;
  process.once('exit', () => {
    for (const xvfb of directXvfbs) {
      killXvfbNow(xvfb);
    }
  });
};

const spawnDirectXvfb = async (
  screen: string,
  systemOutputSink: SystemOutputSink | undefined
): Promise<PooledXvfb> => {
  installPoolCleanup();
  for (
    let displayNumber = firstPooledDisplayNumber;
    displayNumber <= lastPooledDisplayNumber;
    displayNumber += 1
  ) {
    if (!isDisplayNumberAvailable(displayNumber)) {
      continue;
    }

    leasedDisplayNumbers.add(displayNumber);
    const stdout: string[] = [];
    const stderr: string[] = [];
    const child = spawn(
      'Xvfb',
      [`:${displayNumber}`, '-screen', '0', screen, '-nolisten', 'tcp'],
      {
        env: process.env,
        stdio: ['ignore', 'pipe', 'pipe'],
      }
    );
    const xvfb: PooledXvfb = {
      child,
      display: `:${displayNumber}`,
      displayNumber,
      key: screen,
      lastUsedAt: Date.now(),
      screen,
      stderr,
      stdout,
      systemOutputSink,
    };
    child.stdout.on('data', (chunk: Buffer) => {
      appendOutput(stdout, chunk);
      appendSystemOutput(xvfb.systemOutputSink, 'xvfb', 'stdout', chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      appendOutput(stderr, chunk);
      appendSystemOutput(xvfb.systemOutputSink, 'xvfb', 'stderr', chunk);
    });
    child.stdout.once('end', () => {
      flushSystemOutput(xvfb.systemOutputSink, 'xvfb', 'stdout');
    });
    child.stderr.once('end', () => {
      flushSystemOutput(xvfb.systemOutputSink, 'xvfb', 'stderr');
    });
    child.unref();
    unrefHandle(child.stdout);
    unrefHandle(child.stderr);

    try {
      await Promise.race([
        waitForXvfbReady(displayNumber),
        new Promise<never>((_resolve, reject) => {
          child.once('error', reject);
        }),
        new Promise<never>((_resolve, reject) => {
          child.once('exit', (code, signal) => {
            reject(
              createGtkOperationFailedError(
                `Xvfb exited before ready: code=${String(
                  code
                )}, signal=${String(signal)}` + formatOutputTail(stdout, stderr)
              )
            );
          });
        }),
      ]);
      directXvfbs.add(xvfb);
      return xvfb;
    } catch (error) {
      killXvfbNow(xvfb);
      leasedDisplayNumbers.delete(displayNumber);
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes('ENOENT')) {
        throw createGtkOperationFailedError(
          appendPrerequisiteInstallHint(`Failed to start Xvfb: ${message}`)
        );
      }
    }
  }

  throw createGtkOperationFailedError(
    `Failed to allocate a pooled Xvfb display for screen ${screen}.`
  );
};

const terminateXvfb = async (xvfb: PooledXvfb): Promise<void> => {
  removeArrayEntry(idleXvfbByKey, xvfb.key, xvfb);
  directXvfbs.delete(xvfb);
  if (xvfb.child.exitCode === null && xvfb.child.signalCode === null) {
    xvfb.child.kill('SIGTERM');
    const startedAt = Date.now();
    while (xvfb.child.exitCode === null && xvfb.child.signalCode === null) {
      if (Date.now() - startedAt > sessionReleaseTimeoutMs) {
        xvfb.child.kill('SIGKILL');
        break;
      }
      await delay(25);
    }
  }
  xvfb.systemOutputSink = undefined;
  leasedDisplayNumbers.delete(xvfb.displayNumber);
};

const leaseXvfb = async (
  screen: string,
  systemOutputSink: SystemOutputSink | undefined
): Promise<PooledXvfb> => {
  for (;;) {
    const idle = popArrayEntry(idleXvfbByKey, screen);
    if (idle === undefined) {
      return spawnDirectXvfb(screen, systemOutputSink);
    }

    if (idle.child.exitCode === null && idle.child.signalCode === null) {
      idle.lastUsedAt = Date.now();
      idle.systemOutputSink = systemOutputSink;
      return idle;
    }

    await terminateXvfb(idle);
  }
};

const runXvfbProbeOnce = (
  xvfb: PooledXvfb,
  timeoutMs: number
): Promise<XvfbProbeResult> =>
  new Promise<XvfbProbeResult>((resolveProbe, rejectProbe) => {
    const probePath = resolveXvfbPoolProbePath();
    const stdout: string[] = [];
    const stderr: string[] = [];
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      DISPLAY: xvfb.display,
      GDK_BACKEND: 'x11',
      GESTAMENT_XVFB_ACTIVE: '1',
      XDG_SESSION_TYPE: 'x11',
    };
    delete env.AT_SPI_BUS_ADDRESS;
    delete env.DBUS_SESSION_BUS_ADDRESS;
    delete env.NO_AT_BRIDGE;
    delete env.WAYLAND_DISPLAY;
    delete env.XAUTHORITY;
    const child = spawn(process.execPath, [probePath], {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let settled = false;
    let timeout: ReturnType<typeof setTimeout> | undefined;

    const rejectOnce = (error: Error): void => {
      if (settled) {
        return;
      }
      settled = true;
      if (timeout !== undefined) {
        clearTimeout(timeout);
      }
      rejectProbe(error);
    };

    const resolveOnce = (result: XvfbProbeResult): void => {
      if (settled) {
        return;
      }
      settled = true;
      if (timeout !== undefined) {
        clearTimeout(timeout);
      }
      resolveProbe(result);
    };

    timeout = setTimeout(() => {
      child.kill('SIGKILL');
      rejectOnce(createXvfbProbeError('Timed out probing Xvfb pool.', false));
    }, timeoutMs);

    child.stdout.on('data', (chunk: Buffer) => {
      appendOutput(stdout, chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      appendOutput(stderr, chunk);
    });
    child.once('error', (error) => {
      rejectOnce(error);
    });
    child.once('exit', (code, signal) => {
      if (code !== 0) {
        const stderrText = stderr.join('');
        rejectOnce(
          createXvfbProbeError(
            `Xvfb pool probe failed: code=${String(code)}, signal=${String(
              signal
            )}` + formatOutputTail(stdout, stderr),
            isRetryableXvfbProbeExit(stderrText)
          )
        );
        return;
      }

      const output = stdout.join('').trim().split('\n').at(-1);
      if (output === undefined || output.length === 0) {
        rejectOnce(
          createXvfbProbeError(
            'Xvfb pool probe did not return a result.' +
              formatOutputTail(stdout, stderr),
            false
          )
        );
        return;
      }

      try {
        resolveOnce(JSON.parse(output) as XvfbProbeResult);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        rejectOnce(
          createXvfbProbeError(
            `Xvfb pool probe returned invalid JSON: ${message}` +
              formatOutputTail(stdout, stderr),
            false
          )
        );
      }
    });
  });

const runXvfbProbe = async (xvfb: PooledXvfb): Promise<XvfbProbeResult> => {
  const startedAt = Date.now();
  let lastError: unknown;

  while (Date.now() - startedAt < xvfbPoolProbeTimeoutMs) {
    const remainingTimeoutMs = Math.max(
      1,
      xvfbPoolProbeTimeoutMs - (Date.now() - startedAt)
    );
    try {
      return await runXvfbProbeOnce(xvfb, remainingTimeoutMs);
    } catch (error) {
      lastError = error;
      if (!isRetryableXvfbProbeError(error)) {
        throw error;
      }
    }

    const remainingDelayMs = xvfbPoolProbeTimeoutMs - (Date.now() - startedAt);
    if (remainingDelayMs <= 0) {
      break;
    }
    await delay(Math.min(xvfbPoolProbeRetryIntervalMs, remainingDelayMs));
  }

  if (lastError instanceof Error) {
    throw lastError;
  }
  throw createGtkOperationFailedError('Timed out probing Xvfb pool.');
};

const cleanCheckXvfb = async (
  xvfb: PooledXvfb,
  allowedMappedWindowCount: number
): Promise<boolean> => {
  try {
    const probe = await runXvfbProbe(xvfb);
    return probe.mappedWindowCount <= allowedMappedWindowCount;
  } catch {
    return false;
  }
};

const returnXvfbToPool = async (
  xvfb: PooledXvfb,
  limits: XvfbPoolLimits
): Promise<void> => {
  const clean = await cleanCheckXvfb(xvfb, 0);
  if (!clean) {
    await terminateXvfb(xvfb);
    return;
  }

  await retainIdleXvfb(xvfb, limits);
};

const allPoolKey = (xvfb: XvfbSessionOptions): string =>
  `${xvfb.screen}\n${xvfb.trayHost ? 'tray' : 'no-tray'}`;

const spawnDriverProcess = (
  driverPath: string,
  socketPath: string,
  effective: EffectiveDisplay,
  xvfb: PooledXvfb | undefined,
  systemOutputSink: SystemOutputSink | undefined
): DriverProcess => {
  const driverArgs = [
    '--socket',
    socketPath,
    ...(effective.kind === 'xvfb' && effective.xvfb?.trayHost === true
      ? ['--with-tray-host']
      : []),
  ];
  const env = createDriverEnvironment(effective, xvfb);
  const stdout: string[] = [];
  const stderr: string[] = [];

  const command =
    effective.kind === 'xvfb' && xvfb === undefined
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
      : effective.kind === 'xvfb'
        ? {
            args: ['--', process.execPath, driverPath, ...driverArgs],
            bin: 'dbus-run-session',
          }
        : {
            args: [driverPath, ...driverArgs],
            bin: process.execPath,
          };

  const child = spawn(command.bin, command.args, {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const processState: DriverProcess = {
    child,
    commandLine: [command.bin, ...command.args].join(' '),
    stderr,
    stdout,
    systemOutputSink,
  };

  child.stdout.on('data', (chunk: Buffer) => {
    appendOutput(stdout, chunk);
    appendSystemOutput(
      processState.systemOutputSink,
      'launcher-driver',
      'stdout',
      chunk
    );
  });
  child.stderr.on('data', (chunk: Buffer) => {
    appendOutput(stderr, chunk);
    appendSystemOutput(
      processState.systemOutputSink,
      'launcher-driver',
      'stderr',
      chunk
    );
  });
  child.stdout.once('end', () => {
    flushSystemOutput(
      processState.systemOutputSink,
      'launcher-driver',
      'stdout'
    );
  });
  child.stderr.once('end', () => {
    flushSystemOutput(
      processState.systemOutputSink,
      'launcher-driver',
      'stderr'
    );
  });

  return processState;
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
          appendPrerequisiteInstallHint(
            `Launcher driver failed to start: ${error.message}` +
              formatOutputTail(processState.stdout, processState.stderr)
          )
        )
      );
    };

    const rejectFromExit = (
      code: number | null,
      signal: NodeJS.Signals | null
    ): void => {
      rejectOnce(
        createGtkOperationFailedError(
          appendPrerequisiteInstallHint(
            `Launcher driver exited before ready: code=${String(
              code
            )}, signal=${String(signal)}` +
              formatOutputTail(processState.stdout, processState.stderr)
          )
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
          const message = JSON.parse(line) as
            | DriverMessage
            | DriverReadyMessage;
          if (isDriverEventMessage(message as DriverMessage)) {
            const event = message as DriverEventMessage;
            if (event.channel === 'system.output') {
              routeWireSystemOutput(processState.systemOutputSink, event.value);
            }
          } else if (
            isRecord(message) &&
            message.type === 'ready' &&
            parseReadyMessage(line) !== undefined
          ) {
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
  const deadlineMs = currentWaitDeadlineMs();
  const request: DriverRequest =
    deadlineMs === undefined
      ? { command, id, payload }
      : { command, deadlineMs, id, payload };
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
  tempDirectory: string,
  poolOptions: DriverSessionPoolOptions
): DriverSession => {
  const eventHandlers = new Map<string, Set<(value: unknown) => void>>();
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

  const handleEvent = (event: DriverEventMessage): void => {
    if (event.channel === 'system.output') {
      routeWireSystemOutput(processState.systemOutputSink, event.value);
      return;
    }

    const handlers = eventHandlers.get(
      createDriverEventKey(event.channel, event.scopeId)
    );
    if (handlers === undefined) {
      return;
    }

    for (const handler of handlers) {
      try {
        handler(event.value);
      } catch (error) {
        queueMicrotask(() => {
          throw error;
        });
      }
    }
  };

  const handleResponse = (line: string): void => {
    const message = JSON.parse(line) as DriverMessage;
    if (isDriverEventMessage(message)) {
      handleEvent(message);
      return;
    }

    const response = message as DriverResponse;
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

  const subscribe = (
    channel: DriverEventChannel,
    scopeId: string,
    handler: (value: unknown) => void
  ): DriverEventSubscription => {
    const key = createDriverEventKey(channel, scopeId);
    const handlers = eventHandlers.get(key) ?? new Set();
    handlers.add(handler);
    eventHandlers.set(key, handlers);

    let disposed = false;
    return {
      dispose: (): void => {
        if (disposed) {
          return;
        }
        disposed = true;
        handlers.delete(handler);
        if (handlers.size === 0) {
          eventHandlers.delete(key);
        }
      },
    };
  };

  const setSystemOutputSink = (sink: SystemOutputSink | undefined): void => {
    processState.systemOutputSink = sink;
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

  const closeDriver = async (): Promise<void> => {
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

  const terminate = async (): Promise<void> => {
    try {
      await closeDriver();
    } finally {
      if (poolOptions.xvfb !== undefined) {
        await terminateXvfb(poolOptions.xvfb);
      }
    }
  };

  let session: DriverSession;

  const release = async (): Promise<void> => {
    if (poolOptions.mode === 'none') {
      await closeDriver();
      return;
    }

    if (poolOptions.mode === 'xvfb') {
      try {
        await closeDriver();
      } catch (error) {
        if (poolOptions.xvfb !== undefined) {
          await terminateXvfb(poolOptions.xvfb);
        }
        throw error;
      }
      if (poolOptions.xvfb !== undefined) {
        await returnXvfbToPool(poolOptions.xvfb, poolOptions.limits);
      }
      return;
    }

    if (poolOptions.xvfb === undefined || poolOptions.allKey === undefined) {
      await terminate();
      return;
    }

    let resetResult: DriverResetResult;
    try {
      resetResult = await request<DriverResetResult>('launcher.reset', null);
    } catch (error) {
      await terminate().catch(() => undefined);
      throw error;
    }

    const tablesAreEmpty =
      resetResult.appCount === 0 &&
      resetResult.elementCount === 0 &&
      resetResult.imageInfoCount === 0 &&
      resetResult.trayItemCount === 0;
    const clean =
      tablesAreEmpty &&
      (await cleanCheckXvfb(
        poolOptions.xvfb,
        poolOptions.allowedMappedWindowCount
      ));
    if (!clean) {
      await terminate();
      return;
    }

    await retainIdleAllSession(
      {
        key: poolOptions.allKey,
        lastUsedAt: Date.now(),
        session,
        xvfb: poolOptions.xvfb,
      },
      poolOptions.limits
    );
  };

  session = { release, request, setSystemOutputSink, subscribe, terminate };
  return session;
};

const startFreshDriverSession = async (
  effective: EffectiveDisplay,
  xvfb: PooledXvfb | undefined,
  poolOptions: DriverSessionPoolOptions,
  systemOutputSink: SystemOutputSink | undefined
): Promise<DriverSession> => {
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

    processState = spawnDriverProcess(
      driverPath,
      socketPath,
      effective,
      xvfb,
      systemOutputSink
    );
    const connection = await waitForDriverReady(server, processState);
    server.close();
    const resolvedPoolOptions =
      poolOptions.mode === 'all' && xvfb !== undefined
        ? {
            ...poolOptions,
            allowedMappedWindowCount: (await runXvfbProbe(xvfb))
              .mappedWindowCount,
          }
        : poolOptions;
    return createDriverSession(
      connection.socket,
      connection.bufferedInput,
      processState,
      tempDirectory,
      resolvedPoolOptions
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
    if (xvfb !== undefined) {
      await terminateXvfb(xvfb);
    }
    rmSync(tempDirectory, { force: true, recursive: true });
    throw error;
  }
};

const startDriverSession = async (
  options: GtkAppLauncherOptions,
  systemOutputSink: SystemOutputSink | undefined
): Promise<DriverSession> => {
  const display = resolveDisplay(options.display);
  const xvfbOptions = resolveXvfbOptions(options);
  const effective = resolveEffectiveDisplay(display, xvfbOptions);

  if (effective.kind !== 'xvfb' || effective.xvfb === undefined) {
    return startFreshDriverSession(
      effective,
      undefined,
      emptyDriverSessionPoolOptions(),
      systemOutputSink
    );
  }

  const pool = effective.xvfb.pool;
  if (pool === undefined) {
    return startFreshDriverSession(
      effective,
      undefined,
      emptyDriverSessionPoolOptions(),
      systemOutputSink
    );
  }

  if (pool.type === 'xvfb') {
    const xvfb = await leaseXvfb(effective.xvfb.screen, systemOutputSink);
    return startFreshDriverSession(
      effective,
      xvfb,
      {
        allKey: undefined,
        allowedMappedWindowCount: 0,
        limits: poolLimits(pool),
        mode: 'xvfb',
        xvfb,
      },
      systemOutputSink
    );
  }

  const key = allPoolKey(effective.xvfb);
  for (;;) {
    const idle = popArrayEntry(idleAllByKey, key);
    if (idle === undefined) {
      break;
    }
    if (
      idle.xvfb.child.exitCode === null &&
      idle.xvfb.child.signalCode === null
    ) {
      idle.lastUsedAt = Date.now();
      idle.xvfb.lastUsedAt = idle.lastUsedAt;
      idle.xvfb.systemOutputSink = systemOutputSink;
      idle.session.setSystemOutputSink(systemOutputSink);
      return idle.session;
    }
    await idle.session.terminate().catch(() => undefined);
  }

  const xvfb = await leaseXvfb(effective.xvfb.screen, systemOutputSink);
  return startFreshDriverSession(
    effective,
    xvfb,
    {
      allKey: key,
      allowedMappedWindowCount: 0,
      limits: poolLimits(pool),
      mode: 'all',
      xvfb,
    },
    systemOutputSink
  );
};

const createLaunchPayload = (
  options: GtkAppLauncherOptions,
  args: readonly string[],
  launchOptions: GtkAppLauncherLaunchOptions | undefined,
  outputScopeId: string | null
): DriverLaunchPayload => {
  const display = resolveDisplay(options.display);
  const xvfb = resolveXvfbOptions(options);
  const effective = resolveEffectiveDisplay(display, xvfb);

  return {
    appPath: options.appPath,
    args: [...(options.args ?? []), ...args],
    env: resolveLauncherEnvironment(options, effective),
    outputBufferBytes: resolveOutputBufferBytes(
      options.outputBufferBytes,
      launchOptions?.outputBufferBytes
    ),
    outputScopeId,
    timeoutMs: options.timeoutMs ?? null,
  };
};

const createEnvironmentPayload = (
  options: GtkAppLauncherOptions
): DriverEnvironmentPayload => {
  const display = resolveDisplay(options.display);
  const xvfb = resolveXvfbOptions(options);
  const effective = resolveEffectiveDisplay(display, xvfb);

  return {
    env: resolveLauncherEnvironment(options, effective),
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
  ref: DriverAppRef,
  outputSubscription: DriverEventSubscription | undefined
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
    outputSubscription?.dispose();
    await session.request<null>('app.release', { appId: ref.appId });
  };

  const app: GtkApp = {
    capture: async (): Promise<GtkCapture> =>
      decodeCapture(await appRequest<WireCapture>('app.capture')),
    environment: async (): Promise<GtkAppEnvironment> =>
      wireEnvironmentToGtkAppEnvironment(
        await appRequest<WireGtkAppEnvironment>('app.environment')
      ),
    output: (): Promise<WireGtkAppOutput> =>
      appRequest<WireGtkAppOutput>('app.output'),
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
      target.bounds = (): Promise<GtkCaptureBounds> =>
        session.request<GtkCaptureBounds>('element.bounds', { elementId });
      target.moveTo = (x: number, y: number): Promise<GtkCaptureBounds> =>
        session.request<GtkCaptureBounds>('window.moveTo', {
          elementId,
          x,
          y,
        });
      target.resizeHints = (): Promise<GtkWindowResizeHints> =>
        session.request<GtkWindowResizeHints>('window.resizeHints', {
          elementId,
        });
      target.resizeTo = (
        width: number,
        height: number
      ): Promise<GtkCaptureBounds> =>
        session.request<GtkCaptureBounds>('window.resizeTo', {
          elementId,
          height,
          width,
        });
      target.setBounds = (
        bounds: GtkCaptureBounds
      ): Promise<GtkCaptureBounds> =>
        session.request<GtkCaptureBounds>('window.setBounds', {
          bounds,
          elementId,
        });
      target.x11Info = (): Promise<GtkX11WindowInfo> =>
        session.request<GtkX11WindowInfo>('window.x11Info', { elementId });
      addChildContainerProxyOperations(session, elementId, target);
      break;
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
  const outputSubscriptions = new Set<DriverEventSubscription>();
  let systemOutputRecorder = createGtkSystemOutputRecorder(
    normalizeOutputBufferBytes(
      options.systemOutputBufferBytes,
      'systemOutputBufferBytes'
    )
  );
  let sessionPromise: Promise<DriverSession> | undefined;

  const ensureSession = (): Promise<DriverSession> => {
    if (sessionPromise === undefined) {
      systemOutputRecorder = createGtkSystemOutputRecorder(
        normalizeOutputBufferBytes(
          options.systemOutputBufferBytes,
          'systemOutputBufferBytes'
        )
      );
      sessionPromise = startDriverSession(
        options,
        createSystemOutputSink(systemOutputRecorder, options.onSystemOutput)
      );
    }
    return sessionPromise;
  };

  const trackOutputSubscription = (
    subscription: DriverEventSubscription
  ): DriverEventSubscription => {
    let tracked: DriverEventSubscription;
    tracked = {
      dispose: (): void => {
        if (!outputSubscriptions.delete(tracked)) {
          return;
        }
        subscription.dispose();
      },
    };
    outputSubscriptions.add(tracked);
    return tracked;
  };

  const disposeOutputSubscriptions = (): void => {
    for (const subscription of [...outputSubscriptions]) {
      subscription.dispose();
    }
  };

  const launch = async (
    args?: readonly string[],
    launchOptions?: GtkAppLauncherLaunchOptions
  ): Promise<GtkApp> => {
    const session = await ensureSession();
    const onOutput = launchOptions?.onOutput;
    const outputScopeId = onOutput === undefined ? null : createOutputScopeId();
    const outputSubscription =
      outputScopeId === null
        ? undefined
        : trackOutputSubscription(
            session.subscribe('app.output', outputScopeId, (value) => {
              onOutput?.(value as GtkAppOutputEvent);
            })
          );
    const payload = createLaunchPayload(
      options,
      args ?? [],
      launchOptions,
      outputScopeId
    );
    try {
      const appRef = await session.request<DriverAppRef>(
        'launcher.launch',
        payload
      );
      return createProxyGtkApp(session, appRef, outputSubscription);
    } catch (error) {
      outputSubscription?.dispose();
      throw error;
    }
  };

  const environment = async (): Promise<GtkAppEnvironment> => {
    const payload = createEnvironmentPayload(options);
    const session = await ensureSession();
    return wireEnvironmentToGtkAppEnvironment(
      await session.request<WireGtkAppEnvironment>(
        'launcher.environment',
        payload
      )
    );
  };

  const systemOutput = (): Promise<GtkSystemOutput> =>
    Promise.resolve(systemOutputRecorder.snapshot());

  const release = async (): Promise<void> => {
    const releasingSession = sessionPromise;
    sessionPromise = undefined;
    if (releasingSession === undefined) {
      return;
    }
    const session = await releasingSession;
    try {
      await session.release();
    } finally {
      disposeOutputSubscriptions();
    }
  };

  return {
    environment,
    launch,
    release,
    systemOutput,
    [Symbol.asyncDispose]: release,
  };
};
