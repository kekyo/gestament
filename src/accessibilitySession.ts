// gestament - TypeScript based test driver for GTK.
// Copyright (c) Kouji Matsui. (@kekyo@mi.kekyo.net)
// Under MIT.
// https://github.com/kekyo/gestament

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createGtkInvalidArgumentError } from './errors';
import type { GtkAccessibilitySessionMode } from './types';

/////////////////////////////////////////////////////////////////////////////////////////

export type ResolvedAccessibilitySessionMode =
  | 'inherit'
  | 'isolated'
  | 'minimal';

export interface AccessibilitySessionCommand {
  readonly args: readonly string[];
  readonly bin: string;
  readonly cleanup: () => void;
}

const a11yBusServicePath = '/usr/share/dbus-1/services/org.a11y.Bus.service';

const accessibilitySessionModes = [
  'auto',
  'inherit',
  'isolated',
  'minimal',
] as const;

const isAccessibilitySessionMode = (
  value: string
): value is GtkAccessibilitySessionMode =>
  accessibilitySessionModes.includes(value as GtkAccessibilitySessionMode);

const escapeXmlText = (value: string): string =>
  value
    .replace(/&/gu, '&amp;')
    .replace(/</gu, '&lt;')
    .replace(/>/gu, '&gt;')
    .replace(/"/gu, '&quot;')
    .replace(/'/gu, '&apos;');

const createMinimalDbusConfig = (rootDirectory: string): string => {
  if (!existsSync(a11yBusServicePath)) {
    throw createGtkInvalidArgumentError(
      `AT-SPI D-Bus service file was not found: ${a11yBusServicePath}`
    );
  }

  const sessionDirectory = join(rootDirectory, 'minimal-a11y-session');
  const serviceDirectory = join(sessionDirectory, 'services');
  mkdirSync(serviceDirectory, { recursive: true });
  copyFileSync(
    a11yBusServicePath,
    join(serviceDirectory, 'org.a11y.Bus.service')
  );

  const configPath = join(sessionDirectory, 'session.conf');
  writeFileSync(
    configPath,
    [
      '<!DOCTYPE busconfig PUBLIC "-//freedesktop//DTD D-Bus Bus Configuration 1.0//EN"',
      ' "http://www.freedesktop.org/standards/dbus/1.0/busconfig.dtd">',
      '<busconfig>',
      '  <type>session</type>',
      '  <keep_umask/>',
      '  <listen>unix:tmpdir=/tmp</listen>',
      '  <auth>EXTERNAL</auth>',
      `  <servicedir>${escapeXmlText(serviceDirectory)}</servicedir>`,
      '  <policy context="default">',
      '    <allow send_destination="*" eavesdrop="true"/>',
      '    <allow eavesdrop="true"/>',
      '    <allow own="*"/>',
      '  </policy>',
      '  <limit name="max_incoming_bytes">1000000000</limit>',
      '  <limit name="max_outgoing_bytes">1000000000</limit>',
      '  <limit name="max_message_size">1000000000</limit>',
      '</busconfig>',
      '',
    ].join('\n')
  );
  return configPath;
};

export const validateAccessibilitySessionMode = (
  value: string
): GtkAccessibilitySessionMode => {
  if (isAccessibilitySessionMode(value)) {
    return value;
  }
  throw createGtkInvalidArgumentError(
    `accessibilitySession must be "auto", "inherit", "isolated", or "minimal": ${value}`
  );
};

export const resolveAccessibilitySessionMode = (
  mode: GtkAccessibilitySessionMode | undefined,
  autoMode: ResolvedAccessibilitySessionMode
): ResolvedAccessibilitySessionMode => {
  if (mode === undefined || mode === 'auto') {
    return autoMode;
  }
  const validated = validateAccessibilitySessionMode(mode);
  return validated === 'auto' ? autoMode : validated;
};

export const applyAccessibilitySessionEnvironment = (
  env: NodeJS.ProcessEnv,
  mode: ResolvedAccessibilitySessionMode
): void => {
  delete env.AT_SPI_BUS_ADDRESS;
  delete env.NO_AT_BRIDGE;
  if (mode !== 'inherit') {
    delete env.DBUS_SESSION_BUS_ADDRESS;
  }
  if (mode === 'minimal') {
    delete env.GNOME_KEYRING_CONTROL;
    delete env.SSH_AUTH_SOCK;
    env.GIO_USE_VFS = 'local';
    env.GTK_USE_PORTAL = '0';
    env.GNOME_ACCESSIBILITY = '1';
  }
};

export const createAccessibilitySessionCommand = (
  bin: string,
  args: readonly string[],
  mode: ResolvedAccessibilitySessionMode,
  rootDirectory?: string
): AccessibilitySessionCommand => {
  if (mode === 'inherit') {
    return {
      args,
      bin,
      cleanup: (): void => undefined,
    };
  }

  if (mode === 'isolated') {
    return {
      args: ['--', bin, ...args],
      bin: 'dbus-run-session',
      cleanup: (): void => undefined,
    };
  }

  const ownedRootDirectory =
    rootDirectory ?? mkdtempSync(join(tmpdir(), 'gestament-a11y-session-'));
  const configPath = createMinimalDbusConfig(ownedRootDirectory);
  return {
    args: [`--config-file=${configPath}`, '--', bin, ...args],
    bin: 'dbus-run-session',
    cleanup:
      rootDirectory === undefined
        ? (): void => {
            rmSync(ownedRootDirectory, { force: true, recursive: true });
          }
        : (): void => undefined,
  };
};
