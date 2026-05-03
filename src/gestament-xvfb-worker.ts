#!/usr/bin/env node
// gestament - TypeScript based test driver for GTK.
// Copyright (c) Kouji Matsui. (@kekyo@mi.kekyo.net)
// Under MIT.
// https://github.com/kekyo/gestament

import { spawn, type ChildProcess } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

/////////////////////////////////////////////////////////////////////////////////////////

interface WorkerArguments {
  readonly command: readonly string[];
  readonly withTrayHost: boolean;
}

const trayHostReadyLine = 'gestament-tray-host-ready';
const trayHostReadyTimeoutMs = 30_000;

const parseArguments = (args: readonly string[]): WorkerArguments => {
  let withTrayHost = false;
  let index = 0;

  while (index < args.length) {
    const argument = args[index];
    if (argument === '--') {
      return {
        command: args.slice(index + 1),
        withTrayHost,
      };
    }

    if (argument === '--with-tray-host') {
      withTrayHost = true;
      index += 1;
      continue;
    }

    throw new Error(`Unknown gestament-xvfb worker option: ${argument}`);
  }

  throw new Error('Missing command separator: --');
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

const runCommand = (
  command: readonly string[]
): Promise<{
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
}> =>
  new Promise((resolve, reject) => {
    if (command.length === 0) {
      reject(new Error('Missing command to run under Xvfb.'));
      return;
    }

    const child = spawn(command[0] as string, command.slice(1), {
      env: process.env,
      stdio: 'inherit',
    });

    child.on('error', reject);
    child.on('exit', (code, signal) => {
      resolve({ code, signal });
    });
  });

const run = async (): Promise<void> => {
  const parsed = parseArguments(process.argv.slice(2));
  const trayHost = parsed.withTrayHost ? await startTrayHost() : undefined;

  try {
    const result = await runCommand(parsed.command);
    if (result.code !== null) {
      process.exitCode = result.code;
      return;
    }

    process.stderr.write(
      `gestament-xvfb command exited by signal: ${result.signal}\n`
    );
    process.exitCode = 1;
  } finally {
    if (trayHost !== undefined && trayHost.exitCode === null) {
      trayHost.kill('SIGTERM');
    }
  }
};

/////////////////////////////////////////////////////////////////////////////////////////

run().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`gestament-xvfb worker: ${message}\n`);
  process.exitCode = 2;
});
