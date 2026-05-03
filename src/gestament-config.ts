#!/usr/bin/env node
// gestament - TypeScript based test driver for GTK.
// Copyright (c) Kouji Matsui. (@kekyo@mi.kekyo.net)
// Under MIT.
// https://github.com/kekyo/gestament

import { realpathSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/////////////////////////////////////////////////////////////////////////////////////////

export interface GestamentConfigOutput {
  readonly exitCode: 0 | 2;
  readonly stderr: string;
  readonly stdout: string;
}

const usageText = [
  'Usage: gestament-config --includedir',
  '       gestament-config --cflags',
  '       gestament-config --help',
  '',
  'Prints build flags for the gestament GTK helper header.',
  '',
].join('\n');

export const createGestamentConfigOutput = (
  args: readonly string[],
  includeDir: string
): GestamentConfigOutput => {
  if (args.length !== 1) {
    return {
      exitCode: 2,
      stderr:
        'gestament-config: expected exactly one option.\n' +
        'Run "gestament-config --help" for usage.\n',
      stdout: '',
    };
  }

  const option = args[0];
  if (option === '--help' || option === '-h') {
    return {
      exitCode: 0,
      stderr: '',
      stdout: usageText,
    };
  }

  if (option === '--includedir') {
    return {
      exitCode: 0,
      stderr: '',
      stdout: `${includeDir}\n`,
    };
  }

  if (option === '--cflags') {
    return {
      exitCode: 0,
      stderr: '',
      stdout: `-I${includeDir}\n`,
    };
  }

  return {
    exitCode: 2,
    stderr:
      `gestament-config: unknown option: ${option}\n` +
      'Run "gestament-config --help" for usage.\n',
    stdout: '',
  };
};

const includeDirFromExecutable = (executablePath: string): string => {
  const executableRealPath = realpathSync(executablePath);
  const packageRoot = dirname(dirname(executableRealPath));
  return resolve(packageRoot, 'include');
};

const isMainModule = (): boolean => {
  const executablePath = process.argv[1];
  if (executablePath === undefined) {
    return false;
  }

  return (
    realpathSync(executablePath) ===
    realpathSync(fileURLToPath(import.meta.url))
  );
};

const run = (): void => {
  const executablePath = process.argv[1];
  if (executablePath === undefined) {
    process.stderr.write('gestament-config: missing executable path.\n');
    process.exitCode = 2;
    return;
  }

  const output = createGestamentConfigOutput(
    process.argv.slice(2),
    includeDirFromExecutable(executablePath)
  );
  process.stdout.write(output.stdout);
  process.stderr.write(output.stderr);
  process.exitCode = output.exitCode;
};

/////////////////////////////////////////////////////////////////////////////////////////

if (isMainModule()) {
  run();
}
