#!/usr/bin/env node
// gestament - TypeScript based test driver for GTK.
// Copyright (c) Kouji Matsui. (@kekyo@mi.kekyo.net)
// Under MIT.
// https://github.com/kekyo/gestament

import { nativeRunTrayHost } from './native';

try {
  const stdout = process.env.GESTAMENT_TEST_TRAY_HOST_SYSTEM_STDOUT;
  if (stdout !== undefined) {
    process.stdout.write(stdout);
  }
  const stderr = process.env.GESTAMENT_TEST_TRAY_HOST_SYSTEM_STDERR;
  if (stderr !== undefined) {
    process.stderr.write(stderr);
  }
  nativeRunTrayHost();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`gestament-tray-host: ${message}\n`);
  process.exitCode = 1;
}
