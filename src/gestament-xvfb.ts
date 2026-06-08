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
import { existsSync, realpathSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { Readable } from 'node:stream';
import { delay } from 'async-primitives';

import { appendPrerequisiteInstallHint } from './prerequisites';
import { resolveRuntimeTimeouts } from './runtimeTimeouts';
import {
  cleanupStaleX11DisplayArtifacts,
  connectUnixSocket,
  createXvfbDisplayArtifactPaths,
  isRetryableXvfbProbeExit,
  isXvfbDisplayNumberAvailable,
  releaseXvfbDisplayLock,
  tryAcquireXvfbDisplayLock,
  type XvfbDisplayLock,
} from './xvfbSession';

/////////////////////////////////////////////////////////////////////////////////////////

interface ParsedArguments {
  readonly screen: string;
  readonly command: readonly string[];
  readonly withTrayHost: boolean;
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

const formatProbeOutputTail = (
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

interface XvfbProbeError extends Error {
  readonly retryable: boolean;
}

interface FatalXvfbStartupError extends Error {
  readonly fatalXvfbStartup: true;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const createXvfbProbeError = (
  message: string,
  retryable: boolean
): XvfbProbeError => {
  const error = new Error(message) as Error & {
    retryable?: boolean;
  };
  Object.defineProperty(error, 'retryable', {
    value: retryable,
  });
  return error as XvfbProbeError;
};

const isRetryableXvfbProbeError = (error: unknown): error is XvfbProbeError =>
  isRecord(error) && typeof error.retryable === 'boolean' && error.retryable;

const createFatalXvfbStartupError = (error: unknown): FatalXvfbStartupError => {
  const message = error instanceof Error ? error.message : String(error);
  const fatal = new Error(
    `Xvfb readiness probe failed: ${message}`
  ) as FatalXvfbStartupError;
  Object.defineProperty(fatal, 'fatalXvfbStartup', {
    value: true,
  });
  return fatal;
};

const isFatalXvfbStartupError = (
  error: unknown
): error is FatalXvfbStartupError =>
  isRecord(error) && error.fatalXvfbStartup === true;

const resolveXvfbPoolProbePath = (): string => {
  const executablePath = process.argv[1];
  if (executablePath === undefined) {
    throw new Error('Missing executable path.');
  }

  const probePath = resolve(
    dirname(realpathSync(executablePath)),
    'gestament-xvfb-pool-probe.cjs'
  );
  if (!existsSync(probePath)) {
    throw new Error(`Internal Xvfb probe was not found: ${probePath}`);
  }
  return probePath;
};

const runXvfbProbeOnce = (xvfb: XvfbLease, timeoutMs: number): Promise<void> =>
  new Promise<void>((resolveProbe, rejectProbe) => {
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

    const resolveOnce = (): void => {
      if (settled) {
        return;
      }
      settled = true;
      if (timeout !== undefined) {
        clearTimeout(timeout);
      }
      resolveProbe();
    };

    timeout = setTimeout(() => {
      child.kill('SIGKILL');
      rejectOnce(createXvfbProbeError('Timed out probing Xvfb.', false));
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
    child.once('close', (code, signal) => {
      if (code === 0) {
        resolveOnce();
        return;
      }

      const stderrText = stderr.join('');
      rejectOnce(
        createXvfbProbeError(
          `Xvfb probe failed: code=${String(code)}, signal=${String(signal)}` +
            formatProbeOutputTail(stdout, stderr),
          isRetryableXvfbProbeExit(stderrText)
        )
      );
    });
  });

const waitForXvfbProcessExit = async (
  xvfb: XvfbLease,
  timeoutMs: number
): Promise<void> => {
  const startedAt = Date.now();
  while (xvfb.child.exitCode === null && xvfb.child.signalCode === null) {
    if (Date.now() - startedAt > timeoutMs) {
      return;
    }
    await delay(25);
  }
};

const waitForXvfbReady = async (xvfb: XvfbLease): Promise<void> => {
  const startedAt = Date.now();
  const paths = createXvfbDisplayArtifactPaths(xvfb.displayNumber);
  const timeouts = resolveRuntimeTimeouts();
  let lastError: unknown;

  while (Date.now() - startedAt <= timeouts.xvfbStartupTimeoutMs) {
    if (existsSync(paths.socketPath)) {
      try {
        await connectUnixSocket(
          paths.socketPath,
          timeouts.xvfbSocketConnectTimeoutMs
        );
        const remainingTimeoutMs = Math.max(
          1,
          timeouts.xvfbStartupTimeoutMs - (Date.now() - startedAt)
        );
        try {
          await runXvfbProbeOnce(xvfb, remainingTimeoutMs);
          return;
        } catch (error) {
          lastError = error;
          if (!isRetryableXvfbProbeError(error)) {
            throw createFatalXvfbStartupError(error);
          }
        }
      } catch (error) {
        if (isFatalXvfbStartupError(error)) {
          throw error;
        }
        lastError = error;
      }
    }
    await delay(25);
  }

  const suffix =
    lastError instanceof Error ? ` Last error: ${lastError.message}` : '';
  throw new Error(
    `Timed out waiting for Xvfb display ${xvfb.display}.${suffix}`
  );
};

const killXvfbNow = (xvfb: XvfbLease): void => {
  if (xvfb.child.exitCode === null && xvfb.child.signalCode === null) {
    xvfb.child.kill('SIGTERM');
  }
  releaseXvfbDisplayLock(xvfb.displayLock);
};

const spawnDirectXvfb = async (screen: string): Promise<XvfbLease> => {
  const timeouts = resolveRuntimeTimeouts();
  for (
    let displayNumber = firstDisplayNumber;
    displayNumber <= lastDisplayNumber;
    displayNumber += 1
  ) {
    const paths = createXvfbDisplayArtifactPaths(displayNumber);
    const displayLock = tryAcquireXvfbDisplayLock(
      displayNumber,
      paths,
      undefined
    );
    if (displayLock === undefined) {
      continue;
    }

    if (
      !(await isXvfbDisplayNumberAvailable(
        paths,
        timeouts.xvfbSocketConnectTimeoutMs
      ))
    ) {
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
        waitForXvfbReady(xvfb),
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
      await cleanupStaleX11DisplayArtifacts(
        paths,
        timeouts.xvfbSocketConnectTimeoutMs
      ).catch(() => undefined);
      if (isFatalXvfbStartupError(error)) {
        throw error;
      }
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
  const timeouts = resolveRuntimeTimeouts();
  if (xvfb.child.exitCode === null && xvfb.child.signalCode === null) {
    xvfb.child.kill('SIGTERM');
    await waitForXvfbProcessExit(xvfb, timeouts.displaySessionReleaseTimeoutMs);
    if (xvfb.child.exitCode === null && xvfb.child.signalCode === null) {
      xvfb.child.kill('SIGKILL');
      await waitForXvfbProcessExit(
        xvfb,
        timeouts.displaySessionReleaseTimeoutMs
      );
    }
  }
  await cleanupStaleX11DisplayArtifacts(
    createXvfbDisplayArtifactPaths(xvfb.displayNumber),
    timeouts.xvfbSocketConnectTimeoutMs
  ).catch(() => undefined);
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
