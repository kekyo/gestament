// gestament - TypeScript based test driver for GTK.
// Copyright (c) Kouji Matsui. (@kekyo@mi.kekyo.net)
// Under MIT.
// https://github.com/kekyo/gestament

import { defineConfig } from 'vite';
import dts from 'vite-plugin-dts';
import prettierMax from 'prettier-max';
import screwUp from 'screw-up';

export default defineConfig({
  plugins: [
    prettierMax({
      typescript: 'tsconfig.test.json',
    }),
    screwUp({
      outputMetadataFile: true,
    }),
    dts({
      insertTypesEntry: true,
    }),
  ],
  build: {
    lib: {
      entry: {
        index: 'src/index.ts',
        'gestament-config': 'src/gestament-config.ts',
        'gestament-display-session-host':
          'src/gestament-display-session-host.ts',
        testing: 'src/testing.ts',
        'gestament-tray-host': 'src/gestament-tray-host.ts',
        'gestament-xvfb': 'src/gestament-xvfb.ts',
        'gestament-xvfb-worker': 'src/gestament-xvfb-worker.ts',
      },
      fileName: (format, entryName) =>
        `${entryName}.${format === 'es' ? 'mjs' : 'cjs'}`,
      formats: ['es', 'cjs'],
    },
    rollupOptions: {
      external: [
        'assert',
        '@tesseract.js-data/eng',
        'node-gyp-build',
        'node:assert',
        'node:child_process',
        'node:crypto',
        'node:fs',
        'node:fs/promises',
        'node:module',
        'node:path',
        'node:url',
        'node:zlib',
        'pngjs',
        'ssim.js',
        'stream',
        'tesseract.js',
        'util',
        'zlib',
      ],
    },
    target: 'node20',
    sourcemap: true,
    minify: false,
  },
});
