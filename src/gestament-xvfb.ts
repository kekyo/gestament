#!/usr/bin/env node
// gestament - TypeScript based test driver for GTK.
// Copyright (c) Kouji Matsui. (@kekyo@mi.kekyo.net)
// Under MIT.
// https://github.com/kekyo/gestament

import {
  spawn,
  type ChildProcess,
  type ChildProcessByStdio,
} from 'node:child_process';
import {
  closeSync,
  existsSync,
  openSync,
  readFileSync,
  realpathSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { createConnection } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import type { Readable } from 'node:stream';
import { delay } from 'async-primitives';

import { appendPrerequisiteInstallHint } from './prerequisites';
import { resolveRuntimeTimeouts } from './runtimeTimeouts';

/////////////////////////////////////////////////////////////////////////////////////////

interface ParsedArguments {
  readonly screen: string;
  readonly command: readonly string[];
  readonly withTrayHost: boolean;
}

interface XvfbDisplayLock {
  readonly displayNumber: number;
  readonly fd: number;
  readonly path: string;
  released: boolean;
}

interface XvfbLease {
  readonly child: ChildProcessByStdio<null, null, Readable>;
  readonly display: string;
  readonly displayLock: XvfbDisplayLock;
  readonly displayNumber: number;
  readonly stderr: string[];
}

const defaultScreen = '1280x720x24';
const firstDisplayNumber = 90;
const lastDisplayNumber = 590;
const startupErrorPrefix = 'gestament-xvfb failed to start: ';
const screenPattern = /^[1-9][0-9]*x[1-9][0-9]*x[1-9][0-9]*$/;

const printUsage = (): void => {
  process.stdout.write(
    [
      'Usage: gestament-xvfb [--screen=WIDTHxHEIGHTxDEPTH] -- <command> [args...]',
      '       gestament-xvfb [--with-tray-host] [--screen=WIDTHxHEIGHTxDEPTH] -- <command> [args...]',
      '',
      'Runs a command under Xvfb and dbus-run-session for GTK visual tests.',
      '',
    ].join('\n')
  );
};

const errorCode = (error: unknown): string | undefined =>
  typeof error === 'object' &&
  error !== null &&
  'code' in error &&
  typeof (error as { readonly code?: unknown }).code === 'string'
    ? (error as { readonly code: string }).code
    : undefined;

const appendOutput = (lines: string[], chunk: Buffer): void => {
  lines.push(chunk.toString('utf8'));
  if (lines.length > 40) {
    lines.splice(0, lines.length - 40);
  }
};

const formatOutputTail = (stderr: readonly string[]): string => {
  const stderrText = stderr.join('').trim();
  return stderrText.length === 0 ? '' : `\nstderr:\n${stderrText}`;
};

const xvfbDisplayLockPath = (displayNumber: number): string =>
  resolve(tmpdir(), `gestament-xvfb-display-${displayNumber}.lock`);

const readXvfbDisplayLockPid = (path: string): number | undefined => {
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

const removeStaleXvfbDisplayLock = (path: string): void => {
  const pid = readXvfbDisplayLockPid(path);
  if (pid === undefined || processExists(pid)) {
    return;
  }

  try {
    unlinkSync(path);
  } catch (error) {
    if (errorCode(error) !== 'ENOENT') {
      throw error;
    }
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

const tryAcquireXvfbDisplayLock = (
  displayNumber: number
): XvfbDisplayLock | undefined => {
  const path = xvfbDisplayLockPath(displayNumber);
  const lock = openXvfbDisplayLock(displayNumber, path);
  if (lock !== undefined) {
    return lock;
  }

  removeStaleXvfbDisplayLock(path);
  return openXvfbDisplayLock(displayNumber, path);
};

const releaseXvfbDisplayLock = (lock: XvfbDisplayLock): void => {
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

const xvfbSocketPath = (displayNumber: number): string =>
  `/tmp/.X11-unix/X${displayNumber}`;

const xvfbServerLockPath = (displayNumber: number): string =>
  `/tmp/.X${displayNumber}-lock`;

const isDisplayNumberAvailable = (displayNumber: number): boolean =>
  !existsSync(xvfbServerLockPath(displayNumber)) &&
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

const waitForXvfbReady = async (displayNumber: number): Promise<void> => {
  const startedAt = Date.now();
  const path = xvfbSocketPath(displayNumber);
  const timeouts = resolveRuntimeTimeouts();
  while (Date.now() - startedAt <= timeouts.xvfbStartupTimeoutMs) {
    if (existsSync(path)) {
      try {
        await connectUnixSocket(path, timeouts.xvfbSocketConnectTimeoutMs);
        return;
      } catch {
        // Keep polling until the X server accepts local connections.
      }
    }
    await delay(25);
  }

  throw new Error(`Timed out waiting for Xvfb display :${displayNumber}.`);
};

const killXvfbNow = (xvfb: XvfbLease): void => {
  if (xvfb.child.exitCode === null && xvfb.child.signalCode === null) {
    xvfb.child.kill('SIGTERM');
  }
  releaseXvfbDisplayLock(xvfb.displayLock);
};

const spawnDirectXvfb = async (screen: string): Promise<XvfbLease> => {
  for (
    let displayNumber = firstDisplayNumber;
    displayNumber <= lastDisplayNumber;
    displayNumber += 1
  ) {
    const displayLock = tryAcquireXvfbDisplayLock(displayNumber);
    if (displayLock === undefined) {
      continue;
    }

    if (!isDisplayNumberAvailable(displayNumber)) {
      releaseXvfbDisplayLock(displayLock);
      continue;
    }

    const stderr: string[] = [];
    const child = spawn(
      'Xvfb',
      [`:${displayNumber}`, '-screen', '0', screen, '-nolisten', 'tcp'],
      {
        env: process.env,
        stdio: ['ignore', 'ignore', 'pipe'],
      }
    );
    const xvfb: XvfbLease = {
      child,
      display: `:${displayNumber}`,
      displayLock,
      displayNumber,
      stderr,
    };
    child.stderr.on('data', (chunk: Buffer) => {
      appendOutput(stderr, chunk);
    });

    try {
      await Promise.race([
        waitForXvfbReady(displayNumber),
        new Promise<never>((_resolve, reject) => {
          child.once('error', reject);
        }),
        new Promise<never>((_resolve, reject) => {
          child.once('exit', (code, signal) => {
            reject(
              new Error(
                `Xvfb exited before ready: code=${String(
                  code
                )}, signal=${String(signal)}` + formatOutputTail(stderr)
              )
            );
          });
        }),
      ]);
      return xvfb;
    } catch (error) {
      killXvfbNow(xvfb);
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes('ENOENT')) {
        throw new Error(
          appendPrerequisiteInstallHint(
            `${startupErrorPrefix}Failed to start Xvfb: ${message}`
          )
        );
      }
    }
  }

  throw new Error(
    `${startupErrorPrefix}Failed to allocate an Xvfb display for screen ${screen}.`
  );
};

const terminateXvfb = async (xvfb: XvfbLease): Promise<void> => {
  if (xvfb.child.exitCode === null && xvfb.child.signalCode === null) {
    xvfb.child.kill('SIGTERM');
    const startedAt = Date.now();
    const releaseTimeoutMs =
      resolveRuntimeTimeouts().displaySessionReleaseTimeoutMs;
    while (xvfb.child.exitCode === null && xvfb.child.signalCode === null) {
      if (Date.now() - startedAt > releaseTimeoutMs) {
        xvfb.child.kill('SIGKILL');
        break;
      }
      await delay(25);
    }
  }
  releaseXvfbDisplayLock(xvfb.displayLock);
};

const waitForChildExit = (
  child: ChildProcess
): Promise<{
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
}> =>
  new Promise((resolveChild, rejectChild) => {
    child.once('error', rejectChild);
    child.once('exit', (code, signal) => {
      resolveChild({ code, signal });
    });
  });

const parseArguments = (args: readonly string[]): ParsedArguments => {
  let screen = defaultScreen;
  let withTrayHost = false;
  let index = 0;

  while (index < args.length) {
    const argument = args[index];
    if (!argument || argument === '--help' || argument === '-h') {
      printUsage();
      process.exit(0);
    }

    if (argument === '--') {
      return {
        command: args.slice(index + 1),
        screen,
        withTrayHost,
      };
    }

    if (argument.startsWith('--screen=')) {
      screen = argument.slice('--screen='.length);
      index += 1;
      continue;
    }

    if (argument === '--screen') {
      const value = args[index + 1];
      if (value === undefined) {
        throw new Error('--screen requires WIDTHxHEIGHTxDEPTH.');
      }
      screen = value;
      index += 2;
      continue;
    }

    if (argument === '--with-tray-host') {
      withTrayHost = true;
      index += 1;
      continue;
    }

    throw new Error(`Unknown gestament-xvfb option: ${argument}`);
  }

  throw new Error('Missing command separator: --');
};

const run = async (): Promise<void> => {
  const parsed = parseArguments(process.argv.slice(2));
  if (!screenPattern.test(parsed.screen)) {
    throw new Error(
      `Invalid Xvfb screen value: ${parsed.screen}. Expected WIDTHxHEIGHTxDEPTH.`
    );
  }
  if (parsed.command.length === 0) {
    throw new Error('Missing command to run under Xvfb.');
  }

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    GDK_BACKEND: 'x11',
    GESTAMENT_XVFB_ACTIVE: '1',
    GSETTINGS_BACKEND: 'memory',
    GTK_THEME: process.env.GTK_THEME ?? 'Adwaita',
    XDG_SESSION_TYPE: 'x11',
  };
  delete env.AT_SPI_BUS_ADDRESS;
  delete env.DBUS_SESSION_BUS_ADDRESS;
  delete env.DISPLAY;
  delete env.NO_AT_BRIDGE;
  delete env.WAYLAND_DISPLAY;
  delete env.XAUTHORITY;

  const executablePath = process.argv[1];
  if (executablePath === undefined) {
    throw new Error('Missing executable path.');
  }

  const workerPath = resolve(
    dirname(realpathSync(executablePath)),
    'gestament-xvfb-worker.cjs'
  );
  const workerArgs = parsed.withTrayHost ? ['--with-tray-host'] : [];

  const xvfb = await spawnDirectXvfb(parsed.screen);
  env.DISPLAY = xvfb.display;

  const killXvfbOnProcessExit = (): void => {
    killXvfbNow(xvfb);
  };
  process.once('exit', killXvfbOnProcessExit);
  process.once('SIGINT', () => {
    killXvfbNow(xvfb);
    process.exit(130);
  });
  process.once('SIGTERM', () => {
    killXvfbNow(xvfb);
    process.exit(143);
  });

  try {
    const child = spawn(
      'dbus-run-session',
      [
        '--',
        process.execPath,
        workerPath,
        ...workerArgs,
        '--',
        ...parsed.command,
      ],
      {
        env,
        stdio: 'inherit',
      }
    );
    const { code, signal } = await waitForChildExit(child).catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(
        appendPrerequisiteInstallHint(`${startupErrorPrefix}${message}`)
      );
    });

    if (code !== null) {
      process.exitCode = code;
      return;
    }

    process.stderr.write(
      `gestament-xvfb command exited by signal: ${signal}\n`
    );
    process.exitCode = 1;
  } finally {
    process.removeListener('exit', killXvfbOnProcessExit);
    await terminateXvfb(xvfb);
  }
};

/////////////////////////////////////////////////////////////////////////////////////////

run().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  if (message.startsWith(startupErrorPrefix)) {
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
    return;
  }

  process.stderr.write(`gestament-xvfb: ${message}\n`);
  process.stderr.write('Run "gestament-xvfb --help" for usage.\n');
  process.exitCode = 2;
});
