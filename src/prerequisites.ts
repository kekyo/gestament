// gestament - TypeScript based test driver for GTK.
// Copyright (c) Kouji Matsui. (@kekyo@mi.kekyo.net)
// Under MIT.
// https://github.com/kekyo/gestament

/////////////////////////////////////////////////////////////////////////////////////////

/**
 * Fixed Debian/Ubuntu example shown when native GTK automation prerequisites may
 * be missing.
 */
export const prerequisiteInstallHint = [
  '',
  '',
  'gestament: Native GTK automation prerequisites may be missing.',
  'For Debian/Ubuntu, install runtime prerequisites for example with:',
  '',
  '  sudo apt-get update',
  '  sudo apt-get install -y at-spi2-core dbus dbus-x11 libx11-6 libxtst6 xauth xvfb',
  '',
  '',
].join('\n');

/**
 * Appends the fixed prerequisite installation hint to an error message.
 *
 * @param message Base error message.
 * @returns Error message followed by the prerequisite installation hint.
 */
export const appendPrerequisiteInstallHint = (message: string): string =>
  message.includes(prerequisiteInstallHint)
    ? message
    : `${message}${prerequisiteInstallHint}`;
