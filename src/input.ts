// gestament - TypeScript based test driver for GTK.
// Copyright (c) Kouji Matsui. (@kekyo@mi.kekyo.net)
// Under MIT.
// https://github.com/kekyo/gestament

import { createGtkInvalidArgumentError } from './errors';
import type {
  GtkInputController,
  GtkKeyboardModifier,
  GtkKeyInput,
  GtkMouseButton,
} from './types';

/////////////////////////////////////////////////////////////////////////////////////////

export interface GtkInputControllerBackend {
  readonly setModifier: (
    modifier: GtkKeyboardModifier,
    pressed: boolean
  ) => Promise<void>;
  readonly pressKeyName: (key: string) => Promise<void>;
  readonly pressKeySym: (keysym: number) => Promise<void>;
  readonly moveMouseTo: (x: number, y: number) => Promise<void>;
  readonly setMouseButton: (
    button: GtkMouseButton,
    pressed: boolean
  ) => Promise<void>;
  readonly scrollWheel: (xSteps: number, ySteps: number) => Promise<void>;
}

const keyboardModifiers = ['shift', 'control', 'alt', 'super'] as const;
const mouseButtons = ['left', 'middle', 'right', 'back', 'forward'] as const;
const modifierKeyNames = new Set([
  'alt',
  'alt_l',
  'alt_r',
  'control',
  'control_l',
  'control_r',
  'ctrl',
  'ctrl_l',
  'ctrl_r',
  'hyper',
  'hyper_l',
  'hyper_r',
  'meta',
  'meta_l',
  'meta_r',
  'shift',
  'shift_l',
  'shift_r',
  'super',
  'super_l',
  'super_r',
]);

const isKeyboardModifier = (value: string): value is GtkKeyboardModifier =>
  keyboardModifiers.includes(value as GtkKeyboardModifier);

const isMouseButton = (value: string): value is GtkMouseButton =>
  mouseButtons.includes(value as GtkMouseButton);

const assertBoolean = (name: string, value: boolean): void => {
  if (typeof value !== 'boolean') {
    throw createGtkInvalidArgumentError(`${name} must be a boolean.`);
  }
};

const assertInt32 = (name: string, value: number): void => {
  if (!Number.isInteger(value) || value < -2147483648 || value > 2147483647) {
    throw createGtkInvalidArgumentError(`${name} must be a 32-bit integer.`);
  }
};

const assertFiniteInteger = (name: string, value: number): void => {
  if (!Number.isInteger(value)) {
    throw createGtkInvalidArgumentError(`${name} must be an integer.`);
  }
};

const assertKeysym = (value: number): void => {
  if (!Number.isInteger(value) || value < 0 || value > 0xffffffff) {
    throw createGtkInvalidArgumentError(
      'key numeric value must be an unsigned 32-bit integer.'
    );
  }
};

const normalizedKeyName = (key: string): string =>
  key
    .trim()
    .toLowerCase()
    .replace(/[-\s]+/gu, '_');

const assertNonModifierKeyName = (key: string): void => {
  if (key.length === 0) {
    throw createGtkInvalidArgumentError('key must not be empty.');
  }
  if (modifierKeyNames.has(normalizedKeyName(key))) {
    throw createGtkInvalidArgumentError(
      'modifier keys must be controlled with setModifier().'
    );
  }
};

export const createGtkInputController = (
  backend: GtkInputControllerBackend
): GtkInputController => ({
  setModifier: async (
    modifier: GtkKeyboardModifier,
    pressed: boolean
  ): Promise<void> => {
    if (!isKeyboardModifier(modifier)) {
      throw createGtkInvalidArgumentError(
        `modifier must be shift, control, alt, or super: ${String(modifier)}`
      );
    }
    assertBoolean('pressed', pressed);
    await backend.setModifier(modifier, pressed);
  },
  pressKey: async (key: GtkKeyInput): Promise<void> => {
    if (typeof key === 'string') {
      assertNonModifierKeyName(key);
      await backend.pressKeyName(key);
      return;
    }
    if (typeof key === 'number') {
      assertKeysym(key);
      await backend.pressKeySym(key);
      return;
    }
    throw createGtkInvalidArgumentError(
      'key must be a string keysym name or numeric keysym value.'
    );
  },
  moveMouseTo: async (x: number, y: number): Promise<void> => {
    assertInt32('x', x);
    assertInt32('y', y);
    await backend.moveMouseTo(x, y);
  },
  setMouseButton: async (
    button: GtkMouseButton,
    pressed: boolean
  ): Promise<void> => {
    if (!isMouseButton(button)) {
      throw createGtkInvalidArgumentError(
        `button must be left, middle, right, back, or forward: ${String(
          button
        )}`
      );
    }
    assertBoolean('pressed', pressed);
    await backend.setMouseButton(button, pressed);
  },
  scrollWheel: async (xSteps: number, ySteps: number): Promise<void> => {
    assertFiniteInteger('xSteps', xSteps);
    assertFiniteInteger('ySteps', ySteps);
    await backend.scrollWheel(xSteps, ySteps);
  },
});
