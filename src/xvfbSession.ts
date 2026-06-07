// gestament - TypeScript based test driver for GTK.
// Copyright (c) Kouji Matsui. (@kekyo@mi.kekyo.net)
// Under MIT.
// https://github.com/kekyo/gestament

import {
  closeSync,
  lstatSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeSync,
  type Stats,
} from 'node:fs';
import { createConnection } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/////////////////////////////////////////////////////////////////////////////////////////

/** Standard native error message returned when XOpenDisplay cannot open DISPLAY. */
export const x11DisplayOpenFailureMessage =
  'Failed to open the X11 display. Ensure DISPLAY points to an X11 display.';

/** Prefix used by the Xvfb probe helper when serializing native errors. */
export const xvfbPoolProbePrefix = 'gestament-xvfb-pool-probe: ';

/** Filesystem paths used to coordinate one X11 display number. */
export interface XvfbDisplayArtifactPaths {
  /** gestament-owned lock path used before starting Xvfb. */
  readonly gestamentLockPath: string;

  /** X server lock path, usually /tmp/.X<N>-lock. */
  readonly serverLockPath: string;

  /** X11 Unix socket path, usually /tmp/.X11-unix/X<N>. */
  readonly socketPath: string;
}

/** gestament-owned display-number lock. */
export interface XvfbDisplayLock {
  /** Display number protected by this lock. */
  readonly displayNumber: number;

  /** Open file descriptor for the lock file. */
  readonly fd: number;

  /** Lock file path. */
  readonly path: string;

  /** True after the lock has been released. */
  released: boolean;
}

interface XvfbProbeErrorPayload {
  readonly code: string | undefined;
  readonly message: string | undefined;
}

const errorCode = (error: unknown): string | undefined =>
  typeof error === 'object' &&
  error !== null &&
  'code' in error &&
  typeof (error as { readonly code?: unknown }).code === 'string'
    ? (error as { readonly code: string }).code
    : undefined;

const safeLstat = (path: string): Stats | undefined => {
  try {
    return lstatSync(path);
  } catch (error) {
    if (errorCode(error) === 'ENOENT') {
      return undefined;
    }
    throw error;
  }
};

const readPidFile = (path: string): number | undefined => {
  try {
    const pid = Number.parseInt(readFileSync(path, 'utf8').trim(), 10);
    return Number.isInteger(pid) && pid > 0 ? pid : undefined;
  } catch {
    return undefined;
  }
};

const processExists = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return errorCode(error) === 'EPERM';
  }
};

const openXvfbDisplayLock = (
  displayNumber: number,
  path: string
): XvfbDisplayLock | undefined => {
  try {
    const fd = openSync(path, 'wx');
    writeSync(fd, `${process.pid}\n`);
    return { displayNumber, fd, path, released: false };
  } catch (error) {
    if (errorCode(error) === 'EEXIST') {
      return undefined;
    }
    throw error;
  }
};

const removeRegularFile = (path: string): boolean => {
  const stats = safeLstat(path);
  if (stats === undefined) {
    return true;
  }
  if (!stats.isFile()) {
    return false;
  }

  try {
    unlinkSync(path);
    return true;
  } catch (error) {
    return errorCode(error) === 'ENOENT';
  }
};

const removeUnixSocket = (path: string): boolean => {
  const stats = safeLstat(path);
  if (stats === undefined) {
    return true;
  }
  if (!stats.isSocket()) {
    return false;
  }

  try {
    unlinkSync(path);
    return true;
  } catch (error) {
    return errorCode(error) === 'ENOENT';
  }
};

const hasX11Artifacts = (paths: XvfbDisplayArtifactPaths): boolean =>
  safeLstat(paths.serverLockPath) !== undefined ||
  safeLstat(paths.socketPath) !== undefined;

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
      if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        return undefined;
      }
      const record = value as Record<string, unknown>;
      return {
        code: typeof record.code === 'string' ? record.code : undefined,
        message:
          typeof record.message === 'string' ? record.message : undefined,
      };
    } catch {
      return undefined;
    }
  }
  return undefined;
};

/** Creates the filesystem artifact paths for a display number. */
export const createXvfbDisplayArtifactPaths = (
  displayNumber: number
): XvfbDisplayArtifactPaths => ({
  gestamentLockPath: join(
    tmpdir(),
    `gestament-xvfb-display-${displayNumber}.lock`
  ),
  serverLockPath: `/tmp/.X${displayNumber}-lock`,
  socketPath: `/tmp/.X11-unix/X${displayNumber}`,
});

/** Attempts to connect to a Unix domain socket within a timeout. */
export const connectUnixSocket = (
  path: string,
  timeoutMs: number
): Promise<void> =>
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
        rejectConnect(new Error(`Timed out connecting to ${path}.`));
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

/** Removes a stale gestament-owned display lock when the owning pid is gone or invalid. */
export const removeStaleXvfbDisplayLock = (path: string): boolean => {
  const stats = safeLstat(path);
  if (stats === undefined) {
    return true;
  }
  if (!stats.isFile()) {
    return false;
  }

  const pid = readPidFile(path);
  if (pid !== undefined && processExists(pid)) {
    return false;
  }
  return removeRegularFile(path);
};

/** Tries to acquire gestament's display-number lock. */
export const tryAcquireXvfbDisplayLock = (
  displayNumber: number,
  paths: XvfbDisplayArtifactPaths,
  leasedDisplayNumbers: ReadonlySet<number> | undefined
): XvfbDisplayLock | undefined => {
  if (leasedDisplayNumbers?.has(displayNumber)) {
    return undefined;
  }

  const lock = openXvfbDisplayLock(displayNumber, paths.gestamentLockPath);
  if (lock !== undefined) {
    return lock;
  }

  if (!removeStaleXvfbDisplayLock(paths.gestamentLockPath)) {
    return undefined;
  }
  return openXvfbDisplayLock(displayNumber, paths.gestamentLockPath);
};

/** Releases a gestament-owned display-number lock. */
export const releaseXvfbDisplayLock = (lock: XvfbDisplayLock): void => {
  if (lock.released) {
    return;
  }

  lock.released = true;
  closeSync(lock.fd);
  try {
    unlinkSync(lock.path);
  } catch (error) {
    if (errorCode(error) !== 'ENOENT') {
      throw error;
    }
  }
};

/** Conservatively removes stale X11 server lock/socket artifacts for one display. */
export const cleanupStaleX11DisplayArtifacts = async (
  paths: XvfbDisplayArtifactPaths,
  socketConnectTimeoutMs: number
): Promise<boolean> => {
  const serverLockStats = safeLstat(paths.serverLockPath);
  const socketStats = safeLstat(paths.socketPath);

  if (serverLockStats === undefined && socketStats === undefined) {
    return true;
  }
  if (
    (serverLockStats !== undefined && !serverLockStats.isFile()) ||
    (socketStats !== undefined && !socketStats.isSocket())
  ) {
    return false;
  }

  if (socketStats !== undefined) {
    try {
      await connectUnixSocket(paths.socketPath, socketConnectTimeoutMs);
      return false;
    } catch {
      // A non-connectable socket is only removed when the X11 lock is stale too.
    }
  }

  if (serverLockStats === undefined) {
    return false;
  }

  const pid = readPidFile(paths.serverLockPath);
  if (pid !== undefined && processExists(pid)) {
    return false;
  }

  if (!removeRegularFile(paths.serverLockPath)) {
    return false;
  }
  if (socketStats !== undefined && !removeUnixSocket(paths.socketPath)) {
    return false;
  }
  return !hasX11Artifacts(paths);
};

/** Returns true when the X11 display artifacts are absent or conservatively cleaned. */
export const isXvfbDisplayNumberAvailable = async (
  paths: XvfbDisplayArtifactPaths,
  socketConnectTimeoutMs: number
): Promise<boolean> =>
  cleanupStaleX11DisplayArtifacts(paths, socketConnectTimeoutMs);

/** Returns true when a serialized Xvfb probe error is an early XOpenDisplay failure. */
export const isRetryableXvfbProbeExit = (stderrText: string): boolean => {
  const payload = parseXvfbProbeErrorPayload(stderrText);
  return (
    payload?.code === 'OPERATION_FAILED' &&
    payload.message === x11DisplayOpenFailureMessage
  );
};
