// gestament - TypeScript based test driver for GTK.
// Copyright (c) Kouji Matsui. (@kekyo@mi.kekyo.net)
// Under MIT.
// https://github.com/kekyo/gestament

import { createGtkInvalidArgumentError } from './errors';

/////////////////////////////////////////////////////////////////////////////////////////

/** Runtime timeout values used by gestament infrastructure and native operations. */
export interface RuntimeTimeouts {
  readonly appWaitTimeoutMs: number;
  readonly appReleaseTimeoutMs: number;
  readonly atspiReadinessProbeTimeoutMs: number;
  readonly atspiStateChangeTimeoutMs: number;
  readonly displaySessionReleaseTimeoutMs: number;
  readonly displaySessionStartupTimeoutMs: number;
  readonly trayHostReadyTimeoutMs: number;
  readonly windowActivationTimeoutMs: number;
  readonly windowGeometryTimeoutMs: number;
  readonly xvfbPoolProbeTimeoutMs: number;
  readonly xvfbSocketConnectTimeoutMs: number;
  readonly xvfbStartupTimeoutMs: number;
}

type MutableRuntimeTimeouts = {
  -readonly [Key in keyof RuntimeTimeouts]: RuntimeTimeouts[Key];
};

/** Environment variable names that override runtime timeout values. */
export const runtimeTimeoutEnvironmentNames = {
  appWaitTimeoutMs: 'GESTAMENT_APP_WAIT_TIMEOUT_MS',
  appReleaseTimeoutMs: 'GESTAMENT_APP_RELEASE_TIMEOUT_MS',
  atspiReadinessProbeTimeoutMs: 'GESTAMENT_ATSPI_READINESS_PROBE_TIMEOUT_MS',
  atspiStateChangeTimeoutMs: 'GESTAMENT_ATSPI_STATE_CHANGE_TIMEOUT_MS',
  displaySessionReleaseTimeoutMs:
    'GESTAMENT_DISPLAY_SESSION_RELEASE_TIMEOUT_MS',
  displaySessionStartupTimeoutMs:
    'GESTAMENT_DISPLAY_SESSION_STARTUP_TIMEOUT_MS',
  trayHostReadyTimeoutMs: 'GESTAMENT_TRAY_HOST_READY_TIMEOUT_MS',
  windowActivationTimeoutMs: 'GESTAMENT_WINDOW_ACTIVATION_TIMEOUT_MS',
  windowGeometryTimeoutMs: 'GESTAMENT_WINDOW_GEOMETRY_TIMEOUT_MS',
  xvfbPoolProbeTimeoutMs: 'GESTAMENT_XVFB_POOL_PROBE_TIMEOUT_MS',
  xvfbSocketConnectTimeoutMs: 'GESTAMENT_XVFB_SOCKET_CONNECT_TIMEOUT_MS',
  xvfbStartupTimeoutMs: 'GESTAMENT_XVFB_STARTUP_TIMEOUT_MS',
} as const satisfies Record<keyof RuntimeTimeouts, string>;

/** Default runtime timeout values, in milliseconds. */
export const defaultRuntimeTimeouts = {
  appWaitTimeoutMs: 10_000,
  appReleaseTimeoutMs: 2_000,
  atspiReadinessProbeTimeoutMs: 50,
  atspiStateChangeTimeoutMs: 5_000,
  displaySessionReleaseTimeoutMs: 5_000,
  displaySessionStartupTimeoutMs: 30_000,
  trayHostReadyTimeoutMs: 30_000,
  windowActivationTimeoutMs: 2_000,
  windowGeometryTimeoutMs: 2_000,
  xvfbPoolProbeTimeoutMs: 30_000,
  xvfbSocketConnectTimeoutMs: 250,
  xvfbStartupTimeoutMs: 10_000,
} as const satisfies RuntimeTimeouts;

const timeoutEntries = Object.entries(runtimeTimeoutEnvironmentNames) as Array<
  [keyof RuntimeTimeouts, string]
>;

const readPositiveIntegerTimeout = (
  env: NodeJS.ProcessEnv,
  name: string,
  defaultValue: number
): number => {
  const value = env[name];
  if (value === undefined || value.length === 0) {
    return defaultValue;
  }
  if (!/^[1-9][0-9]*$/u.test(value)) {
    throw createGtkInvalidArgumentError(
      `${name} must be a positive integer timeout in milliseconds: ${value}.`
    );
  }

  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw createGtkInvalidArgumentError(
      `${name} must be a safe integer timeout in milliseconds: ${value}.`
    );
  }

  return parsed;
};

/** Resolves runtime timeout values from environment variables. */
export const resolveRuntimeTimeouts = (
  env: NodeJS.ProcessEnv = process.env
): RuntimeTimeouts => {
  const resolved: MutableRuntimeTimeouts = { ...defaultRuntimeTimeouts };
  for (const [key, name] of timeoutEntries) {
    resolved[key] = readPositiveIntegerTimeout(env, name, resolved[key]);
  }
  return resolved;
};
