#!/usr/bin/env node
// gestament - TypeScript based test driver for GTK.
// Copyright (c) Kouji Matsui. (@kekyo@mi.kekyo.net)
// Under MIT.
// https://github.com/kekyo/gestament

import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

/////////////////////////////////////////////////////////////////////////////////////////

const fail = (message, exitCode = 1) => {
  console.error(message);
  process.exit(exitCode);
};

const requireEnv = (name) => {
  const value = process.env[name];
  if (value === undefined || value.length === 0) {
    fail(`Missing required environment variable: ${name}`, 2);
  }
  return value;
};

const optionalPositiveIntegerEnv = (name, defaultValue) => {
  const value = process.env[name];
  if (value === undefined || value.length === 0) {
    return defaultValue;
  }
  if (!/^[1-9][0-9]*$/.test(value)) {
    fail(`${name} must be a positive integer: ${value}`, 2);
  }
  return Number(value);
};

const assertCondition = (condition, message) => {
  if (!condition) {
    fail(message);
  }
};

const delay = (timeoutMs) =>
  new Promise((resolveDelay) => {
    setTimeout(resolveDelay, timeoutMs);
  });

const prebuildDirectoryForArch = (arch) => {
  switch (arch) {
    case 'amd64':
      return 'linux-x64';
    case 'i686':
      return 'linux-ia32';
    case 'arm64':
      return 'linux-arm64';
    case 'armv7l':
      return 'linux-arm';
    case 'riscv64':
      return 'linux-riscv64';
    default:
      fail(`Unsupported GESTAMENT_ARCH: ${arch}`, 2);
  }
};

const prebuildFileForArch = (arch) => {
  switch (arch) {
    case 'armv7l':
      return 'node.napi.armv7.glibc.node';
    case 'amd64':
    case 'i686':
    case 'arm64':
    case 'riscv64':
      return 'node.napi.glibc.node';
    default:
      fail(`Unsupported GESTAMENT_ARCH: ${arch}`, 2);
  }
};

const fixturePathForBackend = (packageRoot, backend) => {
  switch (backend) {
    case 'gtk3':
      return resolve(packageRoot, '.build/gtk3-test-app/gtk3-test-app');
    case 'gtk4':
      return resolve(packageRoot, '.build/gtk4-test-app/gtk4-test-app');
    default:
      fail(`Unsupported GESTAMENT_GTK_BACKEND: ${backend}`, 2);
  }
};

const assertNativeInfo = (nativeInfo, expected) => {
  assertCondition(
    nativeInfo.version === expected.version,
    `Native version mismatch: native=${nativeInfo.version}, expected=${expected.version}.`
  );
  assertCondition(
    nativeInfo.arch === expected.arch,
    `Native arch mismatch: native=${nativeInfo.arch}, expected=${expected.arch}.`
  );
  assertCondition(
    nativeInfo.gtkBackend === expected.backend,
    `Native GTK backend mismatch: native=${nativeInfo.gtkBackend}, expected=${expected.backend}.`
  );
};

const assertCapture = (capture, label) => {
  assertCondition(
    Buffer.isBuffer(capture.image) && capture.image.length > 0,
    `${label} capture did not return PNG bytes.`
  );
  assertCondition(
    capture.bounds.width > 0 && capture.bounds.height > 0,
    `${label} capture bounds were empty.`
  );
  assertCondition(
    capture.visibleBounds.width > 0 && capture.visibleBounds.height > 0,
    `${label} visible capture bounds were empty.`
  );
};

const waitForText = async (element, expectedText) => {
  const startedAt = Date.now();
  let lastText = '';
  while (Date.now() - startedAt <= 10_000) {
    lastText = await element.text();
    if (lastText === expectedText) {
      return;
    }
    await delay(50);
  }
  fail(`Expected text "${expectedText}", got "${lastText}".`);
};

const isRetryableSmokeError = (error) =>
  error !== null &&
  typeof error === 'object' &&
  'code' in error &&
  error.code === 'ELEMENT_NOT_FOUND';

const runAppSmoke = async (gestament, appPath, timeoutMs) => {
  const launcher = gestament.createGtkAppLauncher({
    appPath,
    timeoutMs,
  });

  try {
    const app = await launcher.launch();
    const entry = await app.getById('name_entry');
    assertCondition(
      entry.kind === 'entry',
      `name_entry kind was ${entry.kind}.`
    );
    await entry.setText('container-smoke');

    const button = await app.getById('submit_button');
    assertCondition(
      button.kind === 'button',
      `submit_button kind was ${button.kind}.`
    );
    await button.click();

    const label = await app.getById('result_label');
    assertCondition(
      label.kind === 'label',
      `result_label kind was ${label.kind}.`
    );
    await waitForText(label, 'container-smoke');

    assertCapture(await button.capture(), 'button');
    assertCapture(await app.capture(), 'screen');
  } finally {
    await launcher.release();
  }
};

const main = async () => {
  const packageRoot = process.cwd();
  const arch = requireEnv('GESTAMENT_ARCH');
  const backend = requireEnv('GESTAMENT_GTK_BACKEND');
  const packageVersion = requireEnv('GESTAMENT_PACKAGE_VERSION');
  const timeoutMs = optionalPositiveIntegerEnv(
    'GESTAMENT_PLATFORM_SMOKE_TIMEOUT_MS',
    60_000
  );
  const packageJsonPath = resolve(packageRoot, 'package.json');

  const prebuildPath = resolve(
    packageRoot,
    'prebuilds',
    prebuildDirectoryForArch(arch),
    backend,
    prebuildFileForArch(arch)
  );
  assertCondition(
    existsSync(prebuildPath),
    `Missing native prebuild: ${prebuildPath}`
  );

  const requireFromPackage = createRequire(packageJsonPath);
  const addon = requireFromPackage(prebuildPath);
  assertNativeInfo(addon.nativeInfo(), {
    arch,
    backend,
    version: packageVersion,
  });

  const entryPoint = resolve(packageRoot, 'dist/index.mjs');
  assertCondition(
    existsSync(entryPoint),
    `Missing JavaScript build: ${entryPoint}`
  );
  const gestament = await import(pathToFileURL(entryPoint).href);
  assertCondition(
    typeof gestament.createGtkAppLauncher === 'function',
    'dist/index.mjs does not export createGtkAppLauncher.'
  );
  assertCondition(
    typeof gestament.launchGtkApp === 'function',
    'dist/index.mjs does not export launchGtkApp.'
  );

  const appPath = fixturePathForBackend(packageRoot, backend);
  assertCondition(existsSync(appPath), `Missing GTK fixture: ${appPath}`);

  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      await runAppSmoke(gestament, appPath, timeoutMs);
      console.log(`gestament platform smoke passed: ${arch}/${backend}`);
      return;
    } catch (error) {
      if (attempt >= 2 || !isRetryableSmokeError(error)) {
        throw error;
      }
      console.error(
        `Retrying platform smoke after accessible lookup failure: ${arch}/${backend}`
      );
      await delay(1_000);
    }
  }
};

await main();
