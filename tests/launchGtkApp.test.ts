// gestament - TypeScript based test driver for GTK.
// Copyright (c) Kouji Matsui. (@kekyo@mi.kekyo.net)
// Under MIT.
// https://github.com/kekyo/gestament

import { describe, expect, it } from 'vitest';

import { createGtkAppEnvironment } from '../src/launchGtkApp';

/////////////////////////////////////////////////////////////////////////////////////////

describe('GTK application launch environment', () => {
  it('adds the gestament default GTK test environment', () => {
    expect(createGtkAppEnvironment({}, undefined)).toEqual({
      GDK_BACKEND: 'x11',
      GSETTINGS_BACKEND: 'memory',
      GTK_THEME: 'Adwaita',
    });
  });

  it('allows explicit overrides except NO_AT_BRIDGE', () => {
    expect(
      createGtkAppEnvironment(
        {
          GDK_BACKEND: 'wayland',
          GSETTINGS_BACKEND: 'dconf',
          GTK_THEME: 'HighContrast',
          NO_AT_BRIDGE: '1',
          PATH: '/usr/bin',
        },
        {
          CUSTOM_VALUE: 'custom',
          GDK_BACKEND: 'wayland',
          GSETTINGS_BACKEND: 'dconf',
          GTK_THEME: 'Yaru',
          NO_AT_BRIDGE: '1',
        }
      )
    ).toEqual({
      CUSTOM_VALUE: 'custom',
      GDK_BACKEND: 'wayland',
      GSETTINGS_BACKEND: 'dconf',
      GTK_THEME: 'Yaru',
      PATH: '/usr/bin',
    });
  });
});
