// gestament - TypeScript based test driver for GTK.
// Copyright (c) Kouji Matsui. (@kekyo@mi.kekyo.net)
// Under MIT.
// https://github.com/kekyo/gestament

import { AsyncLocalStorage } from 'node:async_hooks';
import { delay } from 'async-primitives';

import {
  createGtkInvalidArgumentError,
  createGtkOperationTimeoutError,
} from './errors';

/////////////////////////////////////////////////////////////////////////////////////////

/** Options shared by GTK wait helpers. */
export interface GtkWaitOptions {
  /**
   * Maximum time to retry in milliseconds.
   *
   * @remarks Default is 10000.
   */
  readonly timeoutMs?: number | undefined;

  /**
   * Delay between retry attempts in milliseconds.
   *
   * @remarks Default is 50.
   */
  readonly intervalMs?: number | undefined;

  /**
   * Message included in the timeout error.
   */
  readonly message?: string | undefined;
}

interface GtkWaitContext {
  readonly deadlineMs: number;
}

const defaultTimeoutMs = 10_000;
const defaultIntervalMs = 50;

const waitContext = new AsyncLocalStorage<GtkWaitContext>();

const immediateFailureCodes = new Set([
  'APP_EXITED',
  'INVALID_ARGUMENT',
  'NATIVE_LOAD_FAILED',
  'UNSUPPORTED_INTERFACE',
]);

const validateNonNegativeFiniteNumber = (name: string, value: number): void => {
  if (!Number.isFinite(value) || value < 0) {
    throw createGtkInvalidArgumentError(
      `${name} must be a non-negative finite number.`
    );
  }
};

const validatePositiveFiniteNumber = (name: string, value: number): void => {
  if (!Number.isFinite(value) || value <= 0) {
    throw createGtkInvalidArgumentError(
      `${name} must be a positive finite number.`
    );
  }
};

const errorCode = (error: unknown): string | undefined => {
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
};

const errorLabel = (error: unknown): string => {
  if (error instanceof Error) {
    const code = errorCode(error);
    return code === undefined
      ? `${error.name}: ${error.message}`
      : `${error.name} [${code}]: ${error.message}`;
  }
  return String(error);
};

const waitTimeoutMessage = (
  timeoutMs: number,
  message: string | undefined,
  lastError: unknown
): string => {
  const base = message ?? 'Timed out waiting for GTK condition.';
  const last =
    lastError === undefined ? '' : ` Last error: ${errorLabel(lastError)}`;
  return `${base} Timeout: ${timeoutMs}ms.${last}`;
};

const retryableError = (error: unknown): boolean =>
  !immediateFailureCodes.has(errorCode(error) ?? '');

const resolveWaitDeadlineMs = (
  startedAtMs: number,
  timeoutMs: number
): number => {
  const requestedDeadlineMs = startedAtMs + timeoutMs;
  const parentDeadlineMs = waitContext.getStore()?.deadlineMs;
  return parentDeadlineMs === undefined
    ? requestedDeadlineMs
    : Math.min(requestedDeadlineMs, parentDeadlineMs);
};

/**
 * Returns the current absolute wait deadline.
 *
 * @returns The current deadline in Date.now() milliseconds, or undefined outside wait helpers.
 */
export const currentWaitDeadlineMs = (): number | undefined =>
  waitContext.getStore()?.deadlineMs;

/**
 * Limits a wait timeout to the current shared wait deadline.
 *
 * @param fallbackTimeoutMs Timeout to use outside a shared wait context.
 * @returns Effective timeout in milliseconds.
 */
export const effectiveWaitTimeoutMs = (fallbackTimeoutMs: number): number => {
  const deadlineMs = currentWaitDeadlineMs();
  if (deadlineMs === undefined) {
    return fallbackTimeoutMs;
  }
  return Math.min(fallbackTimeoutMs, Math.max(0, deadlineMs - Date.now()));
};

/**
 * Runs a callback inside an existing absolute GTK wait deadline.
 *
 * @param deadlineMs Absolute deadline in Date.now() milliseconds.
 * @param operation Operation to execute.
 * @returns The operation result.
 */
export const runWithWaitDeadline = async <Result>(
  deadlineMs: number,
  operation: () => Result | Promise<Result>
): Promise<Result> => waitContext.run({ deadlineMs }, async () => operation());

/**
 * Repeats a probe until it returns a result or the timeout expires.
 *
 * @param probe Operation to retry.
 * @param options Wait options.
 * @returns The first successful probe result.
 */
export const waitForResult = async <Result>(
  probe: () => Result | Promise<Result>,
  options?: GtkWaitOptions
): Promise<Result> => {
  const timeoutMs = options?.timeoutMs ?? defaultTimeoutMs;
  const intervalMs = options?.intervalMs ?? defaultIntervalMs;
  validateNonNegativeFiniteNumber('timeoutMs', timeoutMs);
  validatePositiveFiniteNumber('intervalMs', intervalMs);

  const startedAtMs = Date.now();
  const deadlineMs = resolveWaitDeadlineMs(startedAtMs, timeoutMs);
  const effectiveTimeoutMs = Math.max(0, deadlineMs - startedAtMs);
  return waitContext.run({ deadlineMs }, async (): Promise<Result> => {
    let lastError: unknown;

    while (true) {
      try {
        return await probe();
      } catch (error) {
        if (!retryableError(error)) {
          throw error;
        }

        lastError = error;
      }

      const remainingMs = deadlineMs - Date.now();
      if (remainingMs <= 0) {
        throw createGtkOperationTimeoutError(
          waitTimeoutMessage(effectiveTimeoutMs, options?.message, lastError)
        );
      }

      await delay(Math.min(intervalMs, remainingMs));
    }
  });
};

/**
 * Repeats an assertion block until it succeeds or the timeout expires.
 *
 * @param probe Assertion block to retry.
 * @param options Wait options.
 * @returns Promise resolved when the assertion block passes.
 */
export const toPass = async (
  probe: () => void | Promise<void>,
  options?: GtkWaitOptions
): Promise<void> => {
  await waitForResult(async () => {
    await probe();
  }, options);
};
