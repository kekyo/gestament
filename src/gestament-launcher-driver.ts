#!/usr/bin/env node
// gestament - TypeScript based test driver for GTK.
// Copyright (c) Kouji Matsui. (@kekyo@mi.kekyo.net)
// Under MIT.
// https://github.com/kekyo/gestament

import { spawn, type ChildProcess } from 'node:child_process';
import { createConnection, type Socket } from 'node:net';
import { realpathSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import {
  createGtkAppExitedError,
  createGtkOperationFailedError,
  createGtkStaleElementError,
  createGtkUnsupportedInterfaceError,
} from './errors';
import { createGtkAppEnvironment, launchGtkApp } from './launchGtkApp';
import { runWithWaitDeadline } from './wait';
import type {
  DriverEnvironmentPayload,
  DriverAppPayload,
  DriverAppRef,
  DriverCommand,
  DriverElementPayload,
  DriverElementRef,
  DriverIdPayload,
  DriverImageInfoPayload,
  DriverIndexPayload,
  DriverLaunchPayload,
  DriverPathPayload,
  DriverReadyMessage,
  DriverRequest,
  DriverSelectedIndexPayload,
  DriverTableCellPayload,
  DriverTextPayload,
  DriverTrayItemRef,
  DriverTrayPayload,
  DriverTraySelectorPayload,
  DriverValuePayload,
  SerializedDriverError,
  WireCapture,
  WireGtkAppEnvironment,
  WireImageInfo,
} from './launcherDriverProtocol';
import type {
  GtkApp,
  GtkAppEnvironment,
  GtkCapture,
  GtkImageInfo,
  GtkTrayItem,
  GtkWidgetElement,
} from './types';

/////////////////////////////////////////////////////////////////////////////////////////

interface DriverArguments {
  readonly socketPath: string;
  readonly withTrayHost: boolean;
}

interface ElementEntry {
  readonly appId: string;
  readonly element: GtkWidgetElement;
}

interface TrayItemEntry {
  readonly appId: string;
  readonly trayItem: GtkTrayItem;
}

interface ImageInfoEntry {
  readonly appId: string;
  readonly capture: () => Promise<GtkCapture>;
}

type AsyncMethod = (...args: unknown[]) => Promise<unknown>;

const trayHostReadyLine = 'gestament-tray-host-ready';
const trayHostReadyTimeoutMs = 30_000;

const apps = new Map<string, GtkApp>();
const elements = new Map<string, ElementEntry>();
const trayItems = new Map<string, TrayItemEntry>();
const imageInfos = new Map<string, ImageInfoEntry>();
const staleElementIds = new Set<string>();
const staleTrayItemIds = new Set<string>();
const staleImageInfoIds = new Set<string>();

let nextAppId = 1;
let nextElementId = 1;
let nextTrayItemId = 1;
let nextImageInfoId = 1;
let shuttingDown = false;
let trayHostProcess: ChildProcess | undefined;

const parseArguments = (args: readonly string[]): DriverArguments => {
  let socketPath: string | undefined;
  let withTrayHost = false;
  let index = 0;

  while (index < args.length) {
    const argument = args[index];

    if (argument === '--socket') {
      const value = args[index + 1];
      if (value === undefined || value.length === 0) {
        throw new Error('--socket requires a Unix socket path.');
      }
      socketPath = value;
      index += 2;
      continue;
    }

    if (argument === '--with-tray-host') {
      withTrayHost = true;
      index += 1;
      continue;
    }

    throw new Error(`Unknown gestament launcher driver option: ${argument}`);
  }

  if (socketPath === undefined) {
    throw new Error('Missing --socket option.');
  }

  return { socketPath, withTrayHost };
};

const waitForTrayHostReady = (host: ChildProcess): Promise<void> =>
  new Promise<void>((resolveReady, rejectReady) => {
    if (host.stdout === null) {
      rejectReady(new Error('gestament tray host did not expose stdout.'));
      return;
    }

    let output = '';
    let settled = false;

    const timeout = setTimeout(() => {
      if (!settled) {
        settled = true;
        rejectReady(new Error('Timed out waiting for gestament tray host.'));
      }
    }, trayHostReadyTimeoutMs);

    host.stdout.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8');
      output += text;
      if (!settled && output.includes(trayHostReadyLine)) {
        settled = true;
        clearTimeout(timeout);
        resolveReady();
        return;
      }
      if (settled) {
        process.stdout.write(text);
      }
    });

    host.once('exit', (code, signal) => {
      if (!settled) {
        settled = true;
        clearTimeout(timeout);
        rejectReady(
          new Error(
            `gestament tray host exited before ready: code=${String(
              code
            )}, signal=${String(signal)}`
          )
        );
      }
    });

    host.once('error', (error) => {
      if (!settled) {
        settled = true;
        clearTimeout(timeout);
        rejectReady(error);
      }
    });
  });

const startTrayHost = async (): Promise<ChildProcess> => {
  const executablePath = process.argv[1];
  if (executablePath === undefined) {
    throw new Error('Missing executable path.');
  }

  const hostPath = resolve(
    dirname(realpathSync(executablePath)),
    'gestament-tray-host.cjs'
  );
  const host = spawn(process.execPath, [hostPath], {
    env: process.env,
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  try {
    await waitForTrayHostReady(host);
    return host;
  } catch (error) {
    if (host.exitCode === null && host.signalCode === null) {
      host.kill('SIGTERM');
    }
    throw error;
  }
};

const connectToParent = (socketPath: string): Promise<Socket> =>
  new Promise<Socket>((resolveConnect, rejectConnect) => {
    const socket = createConnection(socketPath);

    const rejectFromError = (error: Error): void => {
      socket.removeListener('connect', resolveFromConnect);
      rejectConnect(error);
    };
    const resolveFromConnect = (): void => {
      socket.removeListener('error', rejectFromError);
      resolveConnect(socket);
    };

    socket.once('error', rejectFromError);
    socket.once('connect', resolveFromConnect);
  });

const writeReady = (socket: Socket): void => {
  const ready: DriverReadyMessage = { type: 'ready' };
  socket.write(`${JSON.stringify(ready)}\n`);
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

const gtkAppEnvironmentToWireEnvironment = (
  env: GtkAppEnvironment
): WireGtkAppEnvironment => {
  const wireEnv: Record<string, string | null> = {};
  for (const [key, value] of Object.entries(env)) {
    wireEnv[key] = value ?? null;
  }
  return wireEnv;
};

const toWireCapture = (capture: GtkCapture): WireCapture => ({
  bounds: capture.bounds,
  clipped: capture.clipped,
  imageBase64: capture.image.toString('base64'),
  visibleBounds: capture.visibleBounds,
});

const registerApp = (app: GtkApp): DriverAppRef => {
  const appId = `app-${nextAppId}`;
  nextAppId += 1;
  apps.set(appId, app);
  return { appId };
};

const registerElement = (
  appId: string,
  element: GtkWidgetElement
): DriverElementRef => {
  const elementId = `element-${nextElementId}`;
  nextElementId += 1;
  elements.set(elementId, { appId, element });
  return { elementId, kind: element.kind };
};

const registerTrayItem = (
  appId: string,
  trayItem: GtkTrayItem
): DriverTrayItemRef => {
  const trayItemId = `tray-${nextTrayItemId}`;
  nextTrayItemId += 1;
  trayItems.set(trayItemId, { appId, trayItem });
  return { trayItemId };
};

const registerImageInfo = (
  appId: string,
  info: GtkImageInfo
): WireImageInfo => {
  const imageInfoId = `image-info-${nextImageInfoId}`;
  nextImageInfoId += 1;
  imageInfos.set(imageInfoId, { appId, capture: info.capture });
  return {
    bounds: info.bounds,
    description: info.description,
    imageInfoId,
    locale: info.locale,
    position: info.position,
    size: info.size,
  };
};

const resolveApp = (appId: string): GtkApp => {
  const app = apps.get(appId);
  if (app === undefined) {
    throw createGtkAppExitedError(
      'GTK application has exited or was released.'
    );
  }
  return app;
};

const resolveElementEntry = (elementId: string): ElementEntry => {
  const entry = elements.get(elementId);
  if (entry === undefined) {
    if (staleElementIds.has(elementId)) {
      throw createGtkStaleElementError('GTK element is no longer available.');
    }
    throw createGtkAppExitedError('GTK element is not registered.');
  }
  if (!apps.has(entry.appId)) {
    throw createGtkStaleElementError('GTK element is no longer available.');
  }
  return entry;
};

const resolveTrayItemEntry = (trayItemId: string): TrayItemEntry => {
  const entry = trayItems.get(trayItemId);
  if (entry === undefined) {
    if (staleTrayItemIds.has(trayItemId)) {
      throw createGtkStaleElementError('Tray item is no longer registered.');
    }
    throw createGtkAppExitedError('GTK tray item is not registered.');
  }
  if (!apps.has(entry.appId)) {
    throw createGtkStaleElementError('Tray item is no longer registered.');
  }
  return entry;
};

const resolveImageInfoEntry = (imageInfoId: string): ImageInfoEntry => {
  const entry = imageInfos.get(imageInfoId);
  if (entry === undefined) {
    if (staleImageInfoIds.has(imageInfoId)) {
      throw createGtkStaleElementError(
        'GTK image info is no longer available.'
      );
    }
    throw createGtkAppExitedError('GTK image info is not registered.');
  }
  if (!apps.has(entry.appId)) {
    throw createGtkStaleElementError('GTK image info is no longer available.');
  }
  return entry;
};

const removeAppRefs = (appId: string): void => {
  for (const [elementId, entry] of elements) {
    if (entry.appId === appId) {
      staleElementIds.add(elementId);
      elements.delete(elementId);
    }
  }
  for (const [trayItemId, entry] of trayItems) {
    if (entry.appId === appId) {
      staleTrayItemIds.add(trayItemId);
      trayItems.delete(trayItemId);
    }
  }
  for (const [imageInfoId, entry] of imageInfos) {
    if (entry.appId === appId) {
      staleImageInfoIds.add(imageInfoId);
      imageInfos.delete(imageInfoId);
    }
  }
};

const releaseApp = async (appId: string): Promise<void> => {
  const app = apps.get(appId);
  if (app === undefined) {
    return;
  }

  apps.delete(appId);
  removeAppRefs(appId);
  await app.release();
};

const releaseApps = async (): Promise<void> => {
  const appIds = [...apps.keys()];
  await Promise.all(appIds.map((appId) => releaseApp(appId)));
};

const stopTrayHost = (): void => {
  if (
    trayHostProcess !== undefined &&
    trayHostProcess.exitCode === null &&
    trayHostProcess.signalCode === null
  ) {
    trayHostProcess.kill('SIGTERM');
  }
};

const releaseAll = async (): Promise<void> => {
  await releaseApps();
  stopTrayHost();
};

const asMethod = (
  target: unknown,
  methodName: string,
  kindLabel: string
): AsyncMethod => {
  const value = (target as Record<string, unknown>)[methodName];
  if (typeof value !== 'function') {
    throw createGtkUnsupportedInterfaceError(
      `${kindLabel} does not support ${methodName}().`
    );
  }
  return value as AsyncMethod;
};

const callElementMethod = (
  entry: ElementEntry,
  methodName: string,
  args: unknown[] = []
): Promise<unknown> =>
  asMethod(
    entry.element,
    methodName,
    `GTK ${entry.element.kind} element`
  )(...args);

const callTrayItemMethod = (
  entry: TrayItemEntry,
  methodName: string,
  args: unknown[] = []
): Promise<unknown> =>
  asMethod(entry.trayItem, methodName, 'GTK tray item')(...args);

const serializeError = (error: unknown): SerializedDriverError => {
  if (error instanceof Error) {
    const maybeCode = (error as { code?: unknown }).code;
    const base = {
      message: error.message,
      name: error.name,
    };
    const withStack =
      error.stack === undefined ? base : { ...base, stack: error.stack };
    return typeof maybeCode === 'string'
      ? { ...withStack, code: maybeCode }
      : withStack;
  }

  return {
    message: String(error),
    name: 'Error',
  };
};

const appPayload = (payload: unknown): DriverAppPayload =>
  payload as DriverAppPayload;

const elementPayload = (payload: unknown): DriverElementPayload =>
  payload as DriverElementPayload;

const trayPayload = (payload: unknown): DriverTrayPayload =>
  payload as DriverTrayPayload;

const optionalElementRef = (
  appId: string,
  element: GtkWidgetElement | undefined
): DriverElementRef | null =>
  element === undefined ? null : registerElement(appId, element);

const optionalTrayItemRef = (
  appId: string,
  trayItem: GtkTrayItem | undefined
): DriverTrayItemRef | null =>
  trayItem === undefined ? null : registerTrayItem(appId, trayItem);

const handleLauncherCommand = async (
  command: DriverCommand,
  payload: unknown
): Promise<unknown> => {
  switch (command) {
    case 'launcher.environment': {
      const environmentPayload = payload as DriverEnvironmentPayload;
      return gtkAppEnvironmentToWireEnvironment(
        createGtkAppEnvironment(
          process.env,
          wireEnvironmentToGtkAppEnvironment(environmentPayload.env)
        )
      );
    }
    case 'launcher.launch': {
      const launchPayload = payload as DriverLaunchPayload;
      const launchOptions = {
        env: wireEnvironmentToGtkAppEnvironment(launchPayload.env),
        ...(launchPayload.timeoutMs === null
          ? {}
          : { timeoutMs: launchPayload.timeoutMs }),
      };
      const app = await launchGtkApp(
        launchPayload.appPath,
        launchPayload.args,
        launchOptions
      );
      return registerApp(app);
    }
    case 'launcher.release':
      await releaseAll();
      return null;
    case 'launcher.reset':
      await releaseApps();
      return {
        appCount: apps.size,
        elementCount: elements.size,
        imageInfoCount: imageInfos.size,
        trayItemCount: trayItems.size,
      };
    default:
      throw createGtkOperationFailedError(`Unsupported command: ${command}`);
  }
};

const handleAppCommand = async (
  command: DriverCommand,
  payload: unknown
): Promise<unknown> => {
  const { appId } = appPayload(payload);
  const app = resolveApp(appId);

  switch (command) {
    case 'app.environment':
      return gtkAppEnvironmentToWireEnvironment(await app.environment());
    case 'app.release':
      await releaseApp(appId);
      return null;
    case 'app.capture':
      return toWireCapture(await app.capture());
    case 'app.findById': {
      const { id } = payload as DriverAppPayload & DriverIdPayload;
      return optionalElementRef(appId, await app.findById(id));
    }
    case 'app.getById': {
      const { id } = payload as DriverAppPayload & DriverIdPayload;
      return registerElement(appId, await app.getById(id));
    }
    case 'app.findByPath': {
      const { path } = payload as DriverAppPayload & DriverPathPayload;
      return optionalElementRef(appId, await app.findByPath(path));
    }
    case 'app.getByPath': {
      const { path } = payload as DriverAppPayload & DriverPathPayload;
      return registerElement(appId, await app.getByPath(path));
    }
    case 'app.windowAt': {
      const { index } = payload as DriverAppPayload & DriverIndexPayload;
      return optionalElementRef(appId, await app.windowAt(index));
    }
    case 'app.getWindowCount':
      return app.getWindowCount();
    case 'app.findTrayItem': {
      const { selector } = payload as DriverAppPayload &
        DriverTraySelectorPayload;
      return optionalTrayItemRef(appId, await app.findTrayItem(selector));
    }
    case 'app.getTrayItem': {
      const { selector } = payload as DriverAppPayload &
        DriverTraySelectorPayload;
      return registerTrayItem(appId, await app.getTrayItem(selector));
    }
    case 'app.trayItemAt': {
      const { index } = payload as DriverAppPayload & DriverIndexPayload;
      return optionalTrayItemRef(appId, await app.trayItemAt(index));
    }
    case 'app.getTrayItemCount':
      return app.getTrayItemCount();
    default:
      throw createGtkOperationFailedError(
        `Unsupported app command: ${command}`
      );
  }
};

const handleElementCommand = async (
  command: DriverCommand,
  payload: unknown
): Promise<unknown> => {
  const { elementId } = elementPayload(payload);
  const entry = resolveElementEntry(elementId);

  switch (command) {
    case 'element.info':
      return entry.element.info();
    case 'element.capture':
      return toWireCapture(await entry.element.capture());
    case 'element.bounds':
      return callElementMethod(entry, 'bounds');
    case 'window.resizeHints':
      return callElementMethod(entry, 'resizeHints');
    case 'window.x11Info':
      return callElementMethod(entry, 'x11Info');
    case 'element.childAt': {
      const { index } = payload as DriverElementPayload & DriverIndexPayload;
      return optionalElementRef(
        entry.appId,
        (await callElementMethod(entry, 'childAt', [index])) as
          | GtkWidgetElement
          | undefined
      );
    }
    case 'element.getChildCount':
      return callElementMethod(entry, 'getChildCount');
    case 'element.click':
      await callElementMethod(entry, 'click');
      return null;
    case 'element.text':
      return callElementMethod(entry, 'text');
    case 'element.setText': {
      const { text } = payload as DriverElementPayload & DriverTextPayload;
      await callElementMethod(entry, 'setText', [text]);
      return null;
    }
    case 'element.isChecked':
      return callElementMethod(entry, 'isChecked');
    case 'element.toggle':
      await callElementMethod(entry, 'toggle');
      return null;
    case 'element.value':
      return callElementMethod(entry, 'value');
    case 'element.valueInfo':
      return callElementMethod(entry, 'valueInfo');
    case 'element.setValue': {
      const { value } = payload as DriverElementPayload & DriverValuePayload;
      await callElementMethod(entry, 'setValue', [value]);
      return null;
    }
    case 'element.increment':
      await callElementMethod(entry, 'increment');
      return null;
    case 'element.decrement':
      await callElementMethod(entry, 'decrement');
      return null;
    case 'element.getSelectedChildCount':
      return callElementMethod(entry, 'getSelectedChildCount');
    case 'element.selectedChildAt': {
      const { selectedIndex } = payload as DriverElementPayload &
        DriverSelectedIndexPayload;
      return optionalElementRef(
        entry.appId,
        (await callElementMethod(entry, 'selectedChildAt', [selectedIndex])) as
          | GtkWidgetElement
          | undefined
      );
    }
    case 'element.isChildSelected': {
      const { index } = payload as DriverElementPayload & DriverIndexPayload;
      return callElementMethod(entry, 'isChildSelected', [index]);
    }
    case 'element.selectChildAt': {
      const { index } = payload as DriverElementPayload & DriverIndexPayload;
      await callElementMethod(entry, 'selectChildAt', [index]);
      return null;
    }
    case 'element.deselectChildAt': {
      const { index } = payload as DriverElementPayload & DriverIndexPayload;
      await callElementMethod(entry, 'deselectChildAt', [index]);
      return null;
    }
    case 'element.selectAllChildren':
      await callElementMethod(entry, 'selectAllChildren');
      return null;
    case 'element.clearSelection':
      await callElementMethod(entry, 'clearSelection');
      return null;
    case 'element.getRowCount':
      return callElementMethod(entry, 'getRowCount');
    case 'element.getColumnCount':
      return callElementMethod(entry, 'getColumnCount');
    case 'element.cellAt': {
      const { column, row } = payload as DriverElementPayload &
        DriverTableCellPayload;
      return optionalElementRef(
        entry.appId,
        (await callElementMethod(entry, 'cellAt', [row, column])) as
          | GtkWidgetElement
          | undefined
      );
    }
    case 'element.selectedRows':
      return callElementMethod(entry, 'selectedRows');
    case 'element.selectedColumns':
      return callElementMethod(entry, 'selectedColumns');
    case 'element.isRowSelected': {
      const { row } = payload as DriverElementPayload & DriverTableCellPayload;
      return callElementMethod(entry, 'isRowSelected', [row]);
    }
    case 'element.isColumnSelected': {
      const { column } = payload as DriverElementPayload &
        DriverTableCellPayload;
      return callElementMethod(entry, 'isColumnSelected', [column]);
    }
    case 'element.isCellSelected': {
      const { column, row } = payload as DriverElementPayload &
        DriverTableCellPayload;
      return callElementMethod(entry, 'isCellSelected', [row, column]);
    }
    case 'element.selectRow': {
      const { row } = payload as DriverElementPayload & DriverTableCellPayload;
      await callElementMethod(entry, 'selectRow', [row]);
      return null;
    }
    case 'element.deselectRow': {
      const { row } = payload as DriverElementPayload & DriverTableCellPayload;
      await callElementMethod(entry, 'deselectRow', [row]);
      return null;
    }
    case 'element.selectColumn': {
      const { column } = payload as DriverElementPayload &
        DriverTableCellPayload;
      await callElementMethod(entry, 'selectColumn', [column]);
      return null;
    }
    case 'element.deselectColumn': {
      const { column } = payload as DriverElementPayload &
        DriverTableCellPayload;
      await callElementMethod(entry, 'deselectColumn', [column]);
      return null;
    }
    case 'element.imageInfo': {
      const info = (await callElementMethod(
        entry,
        'imageInfo'
      )) as GtkImageInfo;
      return registerImageInfo(entry.appId, info);
    }
    default:
      throw createGtkOperationFailedError(
        `Unsupported element command: ${command}`
      );
  }
};

const handleImageInfoCommand = async (
  command: DriverCommand,
  payload: unknown
): Promise<unknown> => {
  if (command !== 'imageInfo.capture') {
    throw createGtkOperationFailedError(
      `Unsupported image info command: ${command}`
    );
  }
  const { imageInfoId } = payload as DriverImageInfoPayload;
  const entry = resolveImageInfoEntry(imageInfoId);
  return toWireCapture(await entry.capture());
};

const handleTrayCommand = async (
  command: DriverCommand,
  payload: unknown
): Promise<unknown> => {
  const { trayItemId } = trayPayload(payload);
  const entry = resolveTrayItemEntry(trayItemId);

  switch (command) {
    case 'tray.metadata':
      return entry.trayItem.metadata();
    case 'tray.element':
      return optionalElementRef(
        entry.appId,
        (await callTrayItemMethod(entry, 'element')) as
          | GtkWidgetElement
          | undefined
      );
    case 'tray.capture':
      return toWireCapture(await entry.trayItem.capture());
    case 'tray.click':
      await entry.trayItem.click();
      return null;
    case 'tray.openMenu':
      return optionalElementRef(
        entry.appId,
        (await callTrayItemMethod(entry, 'openMenu')) as
          | GtkWidgetElement
          | undefined
      );
    default:
      throw createGtkOperationFailedError(
        `Unsupported tray command: ${command}`
      );
  }
};

const handleRequest = async (request: DriverRequest): Promise<unknown> => {
  if (request.command.startsWith('launcher.')) {
    return handleLauncherCommand(request.command, request.payload);
  }
  if (request.command.startsWith('app.')) {
    return handleAppCommand(request.command, request.payload);
  }
  if (request.command.startsWith('element.')) {
    return handleElementCommand(request.command, request.payload);
  }
  if (request.command.startsWith('window.')) {
    return handleElementCommand(request.command, request.payload);
  }
  if (request.command.startsWith('imageInfo.')) {
    return handleImageInfoCommand(request.command, request.payload);
  }
  if (request.command.startsWith('tray.')) {
    return handleTrayCommand(request.command, request.payload);
  }
  throw createGtkOperationFailedError(
    `Unsupported launcher driver command: ${request.command}`
  );
};

const writeResponse = (
  socket: Socket,
  id: number,
  response:
    | {
        readonly ok: true;
        readonly value: unknown;
      }
    | {
        readonly error: SerializedDriverError;
        readonly ok: false;
      }
): void => {
  socket.write(`${JSON.stringify({ id, ...response })}\n`);
};

const handleRequestLine = async (
  socket: Socket,
  line: string
): Promise<void> => {
  const request = JSON.parse(line) as DriverRequest;
  try {
    const value =
      request.deadlineMs === undefined || request.deadlineMs === null
        ? await handleRequest(request)
        : await runWithWaitDeadline(request.deadlineMs, () =>
            handleRequest(request)
          );
    writeResponse(socket, request.id, { ok: true, value });
    if (request.command === 'launcher.release') {
      socket.end();
    }
  } catch (error) {
    writeResponse(socket, request.id, {
      error: serializeError(error),
      ok: false,
    });
  }
};

const installSocketProtocol = (socket: Socket): void => {
  let input = '';

  socket.on('data', (chunk: Buffer) => {
    input += chunk.toString('utf8');
    let newlineIndex = input.indexOf('\n');
    while (newlineIndex >= 0) {
      const line = input.slice(0, newlineIndex);
      input = input.slice(newlineIndex + 1);
      void handleRequestLine(socket, line);
      newlineIndex = input.indexOf('\n');
    }
  });

  socket.once('close', () => {
    void shutdown(0);
  });
  socket.once('error', () => {
    void shutdown(1);
  });
};

const shutdown = async (exitCode: number): Promise<void> => {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  await releaseAll();
  process.exitCode = exitCode;
  setImmediate(() => {
    process.exit(exitCode);
  });
};

const run = async (): Promise<void> => {
  const parsed = parseArguments(process.argv.slice(2));
  trayHostProcess = parsed.withTrayHost ? await startTrayHost() : undefined;

  const socket = await connectToParent(parsed.socketPath);
  installSocketProtocol(socket);
  writeReady(socket);

  process.once('SIGINT', () => {
    void shutdown(130);
  });
  process.once('SIGTERM', () => {
    void shutdown(143);
  });
};

/////////////////////////////////////////////////////////////////////////////////////////

run().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`gestament launcher driver: ${message}\n`);
  process.exitCode = 2;
});
