#!/usr/bin/env node
// gestament - TypeScript based test driver for GTK.
// Copyright (c) Kouji Matsui. (@kekyo@mi.kekyo.net)
// Under MIT.
// https://github.com/kekyo/gestament

import { spawn, type ChildProcess } from 'node:child_process';
import { realpathSync, writeSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

/////////////////////////////////////////////////////////////////////////////////////////

interface HostArguments {
  readonly withTrayHost: boolean;
}

const readyPrefix = 'gestament-display-session-ready:';
const trayHostReadyLine = 'gestament-tray-host-ready';
const trayHostReadyTimeoutMs = 30_000;

const parseArguments = (args: readonly string[]): HostArguments => {
  let withTrayHost = false;
  let index = 0;

  while (index < args.length) {
    const argument = args[index];

    if (argument === '--with-tray-host') {
      withTrayHost = true;
      index += 1;
      continue;
    }

    throw new Error(`Unknown gestament display session option: ${argument}`);
  }

  return { withTrayHost };
};

const waitForTrayHostReady = (host: ChildProcess): Promise<void> =>
  new Promise<void>((resolve, reject) => {
    if (host.stdout === null) {
      reject(new Error('gestament tray host did not expose stdout.'));
      return;
    }

    let output = '';
    let settled = false;

    const timeout = setTimeout(() => {
      if (!settled) {
        settled = true;
        reject(new Error('Timed out waiting for gestament tray host.'));
      }
    }, trayHostReadyTimeoutMs);

    host.stdout.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8');
      output += text;
      if (!settled && output.includes(trayHostReadyLine)) {
        settled = true;
        clearTimeout(timeout);
        resolve();
        return;
      }
      if (settled) {
        process.stdout.write(text);
      }
    });

    host.on('exit', (code, signal) => {
      if (!settled) {
        settled = true;
        clearTimeout(timeout);
        reject(
          new Error(
            `gestament tray host exited before ready: code=${String(
              code
            )}, signal=${String(signal)}`
          )
        );
      }
    });

    host.on('error', (error) => {
      if (!settled) {
        settled = true;
        clearTimeout(timeout);
        reject(error);
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

const writeReady = (): void => {
  writeSync(
    3,
    `${readyPrefix}${JSON.stringify({
      dbusSessionBusAddress: process.env.DBUS_SESSION_BUS_ADDRESS ?? null,
      display: process.env.DISPLAY ?? null,
      xauthority: process.env.XAUTHORITY ?? null,
    })}\n`
  );
};

const run = async (): Promise<void> => {
  const parsed = parseArguments(process.argv.slice(2));
  const trayHost = parsed.withTrayHost ? await startTrayHost() : undefined;

  const shutdown = (): void => {
    if (
      trayHost !== undefined &&
      trayHost.exitCode === null &&
      trayHost.signalCode === null
    ) {
      trayHost.kill('SIGTERM');
    }
    process.exit(0);
  };

  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);

  writeReady();

  setInterval(() => {
    // Keep dbus-run-session and xvfb-run alive until the parent terminates us.
  }, 2_147_483_647);
};

/////////////////////////////////////////////////////////////////////////////////////////

run().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`gestament display session host: ${message}\n`);
  process.exitCode = 2;
});
