#!/usr/bin/env node
// gestament - TypeScript based test driver for GTK.
// Copyright (c) Kouji Matsui. (@kekyo@mi.kekyo.net)
// Under MIT.
// https://github.com/kekyo/gestament

import { nativeRunTrayHost } from './native';

try {
  nativeRunTrayHost();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`gestament-tray-host: ${message}\n`);
  process.exitCode = 1;
}
