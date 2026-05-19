// gestament - TypeScript based test driver for GTK.
// Copyright (c) Kouji Matsui. (@kekyo@mi.kekyo.net)
// Under MIT.
// https://github.com/kekyo/gestament

import { describe, expect, it } from 'vitest';

import {
  appendPrerequisiteInstallHint,
  prerequisiteInstallHint,
} from '../src/prerequisites';

/////////////////////////////////////////////////////////////////////////////////////////

describe('prerequisite installation hint', () => {
  it('shows a fixed Debian and Ubuntu apt-get example', () => {
    expect(prerequisiteInstallHint).toContain('Debian/Ubuntu');
    expect(prerequisiteInstallHint).toContain('sudo apt-get update');
    expect(prerequisiteInstallHint).toContain('sudo apt-get install -y');
    expect(prerequisiteInstallHint).toContain('at-spi2-core dbus dbus-x11');
    expect(prerequisiteInstallHint).toContain('libx11-6 libxtst6');
    expect(prerequisiteInstallHint).toContain('xauth xvfb');
    expect(prerequisiteInstallHint).toContain('libgtk-3-0');
    expect(prerequisiteInstallHint).toContain('libgtk-4-1');
    expect(prerequisiteInstallHint).toContain(
      'Package names vary by distribution.'
    );
  });

  it('appends the hint without duplicating it', () => {
    const message = 'Native load failed.';
    const hinted = appendPrerequisiteInstallHint(message);

    expect(hinted).toContain(message);
    expect(hinted).toContain(prerequisiteInstallHint);
    expect(appendPrerequisiteInstallHint(hinted)).toBe(hinted);
  });
});
