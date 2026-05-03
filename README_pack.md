# gestament

TypeScript based test driver for GTK

![gestament](./images/gestament-120.png)

[![Project Status: WIP – Initial development is in progress, but there has not yet been a stable, usable release suitable for the public.](https://www.repostatus.org/badges/latest/wip.svg)](https://www.repostatus.org/#wip)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

---

## What is this?

Have you ever wanted to write tests for GTK 3 and 4 applications more easily?
For browser-based applications, there are various methods for UI/UX testing, but when it comes to GTK, things aren’t quite so straightforward.

While there are test drivers available for Python, I’m used to TypeScript, so I’d prefer to write in TypeScript.
Furthermore, even in TypeScript, there are various test drivers for browser-based applications, and we can expect synergistic benefits by repurposing this testing infrastructure.

In other words, suppose we have the following GTK3 code:

```cpp
#include <gestament/gtk.h>

GtkWidget *window = gtk_window_new(GTK_WINDOW_TOPLEVEL);

// Create GtkLabel
GtkWidget *label = gtk_label_new("Hello, gestament");
gestament_gtk_assign_accessible_id(label, "greeting_label");

gtk_container_add(GTK_CONTAINER(window), label);
```

This means you can write this UI test in TypeScript as follows:

```typescript
import { describe, expect, it } from 'vitest';
import { launchGtkApp } from 'gestament';

// Vitest test code
describe('sample GTK app', () => {
  it('shows greeting text', async () => {
    // Run a GTK app
    const app = await launchGtkApp('./sample-app', []);

    try {
      // Get GtkLabel
      const label = await app.getById('greeting_label');
      if (label.kind !== 'label') {
        throw new Error(`Unexpected widget kind: ${label.kind}`);
      }

      // Validate label text string
      expect(await label.text()).toBe('Hello, gestament');
    } finally {
      await app.release();
    }
  });
});
```

### Features

- Launches GTK applications as child processes, allowing them to be controlled from within tests.
- Provides APIs for identifying GTK application windows and widgets within those windows.
- These APIs can be used to check and manipulate widget states.
- Captures the rendering output of GTK applications to verify the display area and clip state.
- Detects StatusNotifierItem-based tray icons and allows you to click them, retrieve metadata, and capture screenshots.
- Runs GTK applications on `xvfb` to enable stable testing in headless environments.

### Environment

- Node.js version 20 or higher
- GTK3 or GTK4 (Note: GTK4 requires version 4.22 or later)
- Linux glibc i686,amd64,arm64,armv7l,riscv64

---

This section shows an example of building a test project from scratch.

First, install the native packages other than GTK before installing the NPM package.
This assumes that the GTK application development environment already has GTK itself, GLib, GDK Pixbuf, and related GTK libraries installed.

The following example is for Debian/Ubuntu:

```bash
sudo apt-get update
sudo apt-get install -y \
  at-spi2-core dbus dbus-x11 \
  libx11-6 libxtst6 \
  xauth xvfb
```

- `at-spi2-core` is the AT-SPI runtime environment that gestament uses to identify and operate widgets.
- `libx11-6` and `libxtst6` are used for X11 screen capture and input operations.
- `dbus` / `dbus-x11` and `xvfb` / `xauth` are used when running tests headlessly with `gestament-xvfb`.

This completes the native environment setup.

NPM projects can choose from many test frameworks.
gestament does not depend on a specific test framework, but the following example uses Vite and Vitest:

```bash
# Generate a Vite project with the scaffolder.
npm create vite@latest gestament-tests -- --template vanilla-ts

cd gestament-tests

# Install the Vitest test driver and gestament.
npm install
npm install -D vitest @types/node gestament
```

---

## Documentation

See [the repository documentation](https://github.com/kekyo/gestament/).

## License

Under MIT.
