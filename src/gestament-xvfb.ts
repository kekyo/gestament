#!/usr/bin/env node
// gestament - TypeScript based test driver for GTK.
// Copyright (c) Kouji Matsui. (@kekyo@mi.kekyo.net)
// Under MIT.
// https://github.com/kekyo/gestament

import { spawn } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

/////////////////////////////////////////////////////////////////////////////////////////

interface ParsedArguments {
  readonly screen: string;
  readonly command: readonly string[];
  readonly withTrayHost: boolean;
}

const defaultScreen = '1280x720x24';
const screenPattern = /^[1-9][0-9]*x[1-9][0-9]*x[1-9][0-9]*$/;

const printUsage = (): void => {
  process.stdout.write(
    [
      'Usage: gestament-xvfb [--screen=WIDTHxHEIGHTxDEPTH] -- <command> [args...]',
      '       gestament-xvfb [--with-tray-host] [--screen=WIDTHxHEIGHTxDEPTH] -- <command> [args...]',
      '',
      'Runs a command under xvfb-run and dbus-run-session for GTK visual tests.',
      '',
    ].join('\n')
  );
};

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

const run = (): void => {
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
  };
  delete env.NO_AT_BRIDGE;
  delete env.AT_SPI_BUS_ADDRESS;

  const executablePath = process.argv[1];
  if (executablePath === undefined) {
    throw new Error('Missing executable path.');
  }

  const workerPath = resolve(
    dirname(realpathSync(executablePath)),
    'gestament-xvfb-worker.cjs'
  );
  const workerArgs = parsed.withTrayHost ? ['--with-tray-host'] : [];

  const child = spawn(
    'xvfb-run',
    [
      '-a',
      '-s',
      `-screen 0 ${parsed.screen}`,
      '--',
      'dbus-run-session',
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

  child.on('error', (error) => {
    process.stderr.write(`gestament-xvfb failed to start: ${error.message}\n`);
    process.exitCode = 1;
  });

  child.on('exit', (code, signal) => {
    if (code !== null) {
      process.exitCode = code;
      return;
    }

    process.stderr.write(
      `gestament-xvfb command exited by signal: ${signal}\n`
    );
    process.exitCode = 1;
  });
};

/////////////////////////////////////////////////////////////////////////////////////////

try {
  run();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`gestament-xvfb: ${message}\n`);
  process.stderr.write('Run "gestament-xvfb --help" for usage.\n');
  process.exitCode = 2;
}
