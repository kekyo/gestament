#!/usr/bin/env node
// gestament - TypeScript based test driver for GTK.
// Copyright (c) Kouji Matsui. (@kekyo@mi.kekyo.net)
// Under MIT.
// https://github.com/kekyo/gestament

import { nativeCaptureScreen, nativeMappedX11WindowCount } from './native';

/////////////////////////////////////////////////////////////////////////////////////////

const run = (): void => {
  const capture = nativeCaptureScreen();
  const mappedWindowCount = nativeMappedX11WindowCount();
  process.stdout.write(
    `${JSON.stringify({
      bounds: capture.bounds,
      mappedWindowCount,
    })}\n`
  );
};

try {
  run();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  const code = (error as { code?: unknown }).code;
  process.stderr.write(
    `gestament-xvfb-pool-probe: ${JSON.stringify({
      code: typeof code === 'string' ? code : undefined,
      message,
    })}\n`
  );
  process.exitCode = 1;
}
