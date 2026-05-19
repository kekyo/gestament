// gestament - TypeScript based test driver for GTK.
// Copyright (c) Kouji Matsui. (@kekyo@mi.kekyo.net)
// Under MIT.
// https://github.com/kekyo/gestament

import { spawn } from 'node:child_process';

/** Text output returned by a spawned process. */
export interface SpawnTextResult {
  /** Exit signal, or null when the process exited with a status code. */
  readonly signal: NodeJS.Signals | null;

  /** Exit status, or null when the process exited by signal. */
  readonly status: number | null;

  /** Captured stderr text. */
  readonly stderr: string;

  /** Captured stdout text. */
  readonly stdout: string;

  /** True when the helper killed the process after the timeout. */
  readonly timedOut: boolean;
}

/** Options for spawning a process and collecting text output. */
export interface SpawnTextOptions {
  /** Environment passed to child_process.spawn. */
  readonly env: NodeJS.ProcessEnv | undefined;

  /** Timeout in milliseconds before the process is killed. */
  readonly timeoutMs: number;
}

/**
 * Spawns a process and captures stdout/stderr without blocking the Vitest worker.
 *
 * @param command Process executable.
 * @param args Process arguments.
 * @param options Spawn and timeout options.
 * @returns Captured process result.
 */
export const spawnText = (
  command: string,
  args: readonly string[],
  options: SpawnTextOptions
): Promise<SpawnTextResult> =>
  new Promise<SpawnTextResult>((resolve, reject) => {
    const child = spawn(command, [...args], {
      env: options.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let timedOut = false;
    let settled = false;

    const timeout = setTimeout(() => {
      if (settled || child.exitCode !== null || child.signalCode !== null) {
        return;
      }
      timedOut = true;
      child.kill('SIGKILL');
    }, options.timeoutMs);

    const settle = (callback: () => void): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      callback();
    };

    child.stdout.on('data', (chunk: Buffer) => {
      stdout.push(chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr.push(chunk);
    });
    child.once('error', (error) => {
      settle(() => {
        reject(error);
      });
    });
    child.once('close', (status, signal) => {
      settle(() => {
        const stderrText = Buffer.concat(stderr).toString('utf8');
        resolve({
          signal,
          status,
          stderr: timedOut
            ? `${stderrText}\nTimed out after ${options.timeoutMs}ms.`
            : stderrText,
          stdout: Buffer.concat(stdout).toString('utf8'),
          timedOut,
        });
      });
    });
  });
