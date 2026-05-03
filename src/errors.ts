// gestament - TypeScript based test driver for GTK.
// Copyright (c) Kouji Matsui. (@kekyo@mi.kekyo.net)
// Under MIT.
// https://github.com/kekyo/gestament

import type { GtkAutomationError, GtkAutomationErrorCode } from './types';

/////////////////////////////////////////////////////////////////////////////////////////

const createGtkAutomationError = (
  code: GtkAutomationErrorCode,
  message: string
): GtkAutomationError => {
  const error = new Error(message) as GtkAutomationError;
  Object.defineProperty(error, 'code', {
    enumerable: true,
    value: code,
  });
  error.name = 'GtkAutomationError';
  return error;
};

/** Creates an error for a GTK application that exited before an operation completed. */
export const createGtkAppExitedError = (message: string): GtkAutomationError =>
  createGtkAutomationError('APP_EXITED', message);

/** Creates an error for an invalid public API argument. */
export const createGtkInvalidArgumentError = (
  message: string
): GtkAutomationError => createGtkAutomationError('INVALID_ARGUMENT', message);

/** Creates an error for an accessible element that was not found. */
export const createGtkElementNotFoundError = (
  message: string
): GtkAutomationError => createGtkAutomationError('ELEMENT_NOT_FOUND', message);

/** Creates an error for an element whose host object no longer exists. */
export const createGtkStaleElementError = (
  message: string
): GtkAutomationError => createGtkAutomationError('STALE_ELEMENT', message);

/** Creates an error for an operation that exceeded its timeout. */
export const createGtkOperationTimeoutError = (
  message: string
): GtkAutomationError => createGtkAutomationError('TIMEOUT', message);

/** Creates an error for an operation that failed. */
export const createGtkOperationFailedError = (
  message: string
): GtkAutomationError => createGtkAutomationError('OPERATION_FAILED', message);

/** Creates an error for an operation that is not supported by the element. */
export const createGtkUnsupportedInterfaceError = (
  message: string
): GtkAutomationError =>
  createGtkAutomationError('UNSUPPORTED_INTERFACE', message);

/** Converts native addon errors into the public error shape. */
export const normalizeNativeError = (error: unknown): GtkAutomationError => {
  if (error instanceof Error) {
    const maybeCode = (error as { code?: unknown }).code;
    if (
      maybeCode === 'ELEMENT_NOT_FOUND' ||
      maybeCode === 'INVALID_ARGUMENT' ||
      maybeCode === 'NATIVE_LOAD_FAILED' ||
      maybeCode === 'OPERATION_FAILED' ||
      maybeCode === 'STALE_ELEMENT' ||
      maybeCode === 'UNSUPPORTED_INTERFACE'
    ) {
      return createGtkAutomationError(maybeCode, error.message);
    }

    return createGtkAutomationError('OPERATION_FAILED', error.message);
  }

  return createGtkAutomationError('OPERATION_FAILED', String(error));
};
