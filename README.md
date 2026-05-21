# gestament

TypeScript based test driver for GTK

![gestament](./images/gestament-120.png)

[![Project Status: WIP – Initial development is in progress, but there has not yet been a stable, usable release suitable for the public.](https://www.repostatus.org/badges/latest/wip.svg)](https://www.repostatus.org/#wip)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![npm version](https://img.shields.io/npm/v/gestament.svg)](https://www.npmjs.com/package/gestament)

---

[(For Japanese language/日本語はこちら)](./README_ja.md)

> Please note that this English version of the document was machine-translated and then partially edited, so it may contain inaccuracies.
> We welcome pull requests to correct any errors in the text.

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

For example, run Vitest with `npm test`:

![Vitest](./images/vitest.png)

### Features

- Launches GTK applications as child processes, allowing them to be controlled from within tests.
- Provides APIs for identifying GTK application windows and widgets within those windows.
- These APIs can be used to check and manipulate widget states.
- Captures the rendering output of GTK applications to verify the display area and clip state.
- Exposes top-level window bounds, resize hints, and X11 metadata without requiring helper tools.
- Detects StatusNotifierItem-based tray icons and allows you to click them, retrieve metadata, and capture screenshots.
- Runs GTK applications on `xvfb` to enable stable testing in headless environments.
- Exposes the final GTK session environment so helper processes can join the same Xvfb and DBus session.

### Environment

- Node.js version 20 or higher
- GTK3 or GTK4 (Note: GTK4 requires version 4.22 or later)
- Linux glibc i686,amd64,arm64,armv7l,riscv64

---

## Installation

This section shows an example of building a test project from scratch.

First, install the native packages other than GTK before installing the NPM package.
This assumes that the GTK application development environment already has GTK itself, GLib, GDK Pixbuf, and related GTK libraries installed.

The following example is for Debian/Ubuntu:

```bash
sudo apt-get update
sudo apt-get install -y \
  at-spi2-core dbus dbus-x11 libx11-6 libxtst6 xauth xvfb
```

- `at-spi2-core` is the AT-SPI runtime environment that gestament uses to identify and operate widgets.
- `libx11-6` and `libxtst6` are used for X11 screen capture and input operations.
- `dbus` / `dbus-x11` and `xvfb` / `xauth` are used when running tests headlessly with the internal Xvfb session or `gestament-xvfb`.

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

## Configuration

GTK projects are C/C++ projects, and recent GTK projects commonly use meson for builds.
gestament, on the other hand, is an NPM project, so you need to configure the build environment so gestament can build GTK code and run tests.
The following sections show that procedure.

### Referencing the gestament header

gestament bundles a header-only helper for GTK applications as `include/gestament/gtk.h`.
This helper is optional, but if you use it, add the `include` directory inside the NPM package to your include path.

If the relative locations of the GTK project and the NPM project are fixed, you can specify the path directly in meson:

```meson
gestament_include = include_directories('../node_modules/gestament/include')

executable(
  'my-app',
  sources,
  include_directories: gestament_include,
  dependencies: gtk_dep,
)
```

If you do not want to fix that relationship in the build definition, you can get the include path with `gestament-config`:

```meson
gestament_config = find_program('npx')
gestament_include_dir = run_command(
  gestament_config,
  ['gestament-config', '--includedir'],
  check: true,
).stdout().strip()

executable(
  'my-app',
  sources,
  cpp_args: ['-I' + gestament_include_dir],
  dependencies: gtk_dep,
)
```

With a Makefile, you can use `--cflags` like this:

```make
GESTAMENT_CFLAGS := $(shell npx gestament-config --cflags)
CXXFLAGS += $(GESTAMENT_CFLAGS)
```

### Configuring GTK applications

GTK applications cannot be tested by gestament as-is.

gestament identifies and operates GTK application windows and widgets through "AT-SPI".
AT-SPI identifies these elements by "accessible ID", so windows and widgets must be assigned accessible IDs.

For example, if you want to check whether a `GtkLabel` displays `This is foobar`, you need to assign an accessible ID such as `foobar_label` to that label so the test can identify where the label is placed.

This is roughly the same as the `id` attribute in the HTML DOM, and is similar to identifying an element with `parent.getElementById()`.

When you create windows and widgets programmatically, assign an accessible ID like this:

```cpp
#include <atk/atk.h>

// Create a GtkLabel.
GtkWidget *label = gtk_label_new("Hello, gestament");

// Set the accessible ID through AT-SPI (GTK3).
AtkObject *accessible = gtk_widget_get_accessible(widget);
if (accessible != NULL) {
  atk_object_set_accessible_id(accessible, "foobar_label");
}
```

However, this code is for GTK3. GTK4 requires a different way to assign accessible IDs.
To absorb those differences, gestament provides the helper function `gestament_gtk_assign_accessible_id()`:

```cpp
#include <gestament/gtk.h>

GtkWidget *label = gtk_label_new("Hello, gestament");

// Available on both GTK3 and GTK4.
gestament_gtk_assign_accessible_id(label, "foobar_label");
```

If you use a `GtkBuilder` `.ui` file, you can use the usual `<object id="...">` values as IDs:

```xml
<interface>
  <object class="GtkWindow" id="main_window">
    <child>
      <object class="GtkLabel" id="foobar_label">
        // ...
      </object>
    </child>
  </object>
</interface>
```

However, this `id=` is a `GtkBuilder` ID, so it must be reapplied as an accessible ID.
You can apply all IDs in a `GtkBuilder` at once by using the helper function `gestament_gtk_assign_accessible_ids_from_builder()`:

```cpp
#include <gestament/gtk.h>

GtkBuilder *builder = gtk_builder_new();
gtk_builder_add_from_file(builder, "main-window.ui", nullptr);

// Apply all IDs in the specified GtkBuilder as accessible IDs.
gestament_gtk_assign_accessible_ids_from_builder(builder);
```

## Writing test code

In tests, explicitly specify the location of the GTK application.
`createGtkAppLauncher()` makes it easier to manage the GTK application that tests should launch.
For example, write setup code like this in a Vitest test:

```typescript
import { describe, expect, it, afterEach } from 'vitest';
import { fileURLToPath } from 'url';
import { createGtkAppLauncher } from 'gestament';

// Identify the path to the GTK application under test.
const appPath = fileURLToPath(
  new URL('../.build/gtk3-test-app/gtk3-test-app', import.meta.url)
);

// Launch and manage the GTK application.
const launcher = createGtkAppLauncher({ appPath });

// Terminate all launched applications after each test.
afterEach(() => launcher.release());
```

Then write tests like this:

```typescript
describe('foobar GTK3 app test', () => {
  it('sets entry text, clicks a button, and reads label text', async () => {
    // Launch the GTK application.
    const app = await launcher.launch();

    // Get the "name_entry" widget (GtkEntry).
    const entry = await app.getById('name_entry');
    if (entry.kind !== 'entry') {
      throw new Error(`Unexpected widget kind: ${entry.kind}`);
    }
    // Set "ABC".
    await entry.setText('ABC');

    // Get the "submit_button" widget (GtkButton).
    const button = await app.getById('submit_button');
    if (button.kind !== 'button') {
      throw new Error(`Unexpected widget kind: ${button.kind}`);
    }
    // Click the button.
    await button.click();

    // Get the "result_label" widget (GtkLabel).
    const label = await app.getById('result_label');
    if (label.kind !== 'label') {
      throw new Error(`Unexpected widget kind: ${label.kind}`);
    }
    // Poll until the label displays "ABC".
    await expect.poll(() => label.text()).toBe('ABC');
  });
});
```

By default, `createGtkAppLauncher()` uses an X11 virtual desktop by the Xvfb backend to
run tests in an isolated environment that is unaffected by your current desktop environment.

The Xvfb backend is automatically started when the GTK application launches and is automatically terminated when `launcher.release()` is called.
Therefore, you do not need to worry about the details when writing tests;
however, if you want to run tests using your current desktop environment,
you must specify options such as `display` (described later).

If you want to isolate the display environment for concurrent test execution - such as with `test.concurrent`, please create a launcher within each test.
If the same launcher is shared among concurrent tests, the display sessions within that launcher will also be shared,
which may cause interference on the screen.

---

## gestament test APIs

The following are the testing APIs provided by gestament.

### GTK application launch management

| API function                   | Details                                                                                                                                                                     |
| :----------------------------- | :-------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `launchGtkApp()`               | Directly launches a GTK application and returns the target `GtkApp`. You can specify launch arguments, environment variables, and wait timeout.                             |
| `createGtkAppEnvironment()`    | Generates environment variables to pass when launching a GTK application. Usually used internally by `launchGtkApp()` or `createGtkAppLauncher()`.                          |
| `createGtkAppLauncher()`       | Creates a launcher object that holds the specified application path, common arguments, display environment, environment variables, output settings, and wait timeout.       |
| `GtkAppLauncher.launch()`      | Launches the GTK application represented by the launcher object and returns a `GtkApp` representing the launched application. Per-launch output callbacks can be specified. |
| `GtkAppLauncher.environment()` | Returns the final environment that launched apps and helper processes should use for this launcher.                                                                         |
| `GtkAppLauncher.release()`     | Terminate all `GtkApp` instances launched from the launcher, and if the launcher was running Xvfb, terminate it as well.                                                    |

The following example manually manages GTK application launches without using `launchGtkApp()` directly:

```typescript
import { afterEach, expect, it } from 'vitest';
import { createGtkAppLauncher } from 'gestament';

// Create the launcher object.
const launcher = createGtkAppLauncher({
  appPath: './my-app',
  args: ['--test-mode'],
  display: 'xvfb',
  xvfbScreen: '1280x720x24',
  xvfbTrayHost: true,
  gsettings: 'memory',
  theme: 'Adwaita',
  timeoutMs: 15_000,
});

// Dispose of GTK applications after each test.
afterEach(() => launcher.release());

it('launches the app', async () => {
  // Launch the GTK application.
  const app = await launcher.launch(['--scenario=basic']);

  expect(await app.getWindowCount()).toBeGreaterThan(0);
});
```

Application stdout and stderr can be observed per launch. `outputBufferBytes` limits the retained
snapshot per stream; omit it to retain complete stdout/stderr until `release()`.

```typescript
// Collect the application's standard output and error logs
const outputEvents: string[] = [];
const app = await launcher.launch(['--scenario=basic'], {
  onOutput: (event) => {
    outputEvents.push(`[${event.stream}] ${event.text}`);
  },
});

// Collect all states of the application process
const output = await app.output();
expect(output.stderr).not.toContain('critical warning');
```

### Operating GTK applications

| API function                | Details                                                                                                                                           |
| :-------------------------- | :------------------------------------------------------------------------------------------------------------------------------------------------ |
| `GtkApp.release()`          | Terminates the running GTK application process.                                                                                                   |
| `GtkApp.capture()`          | Captures the entire X11 root window pointed to by `DISPLAY` as a PNG and returns a `GtkCapture` containing the image and display bounds.          |
| `GtkApp.environment()`      | Returns the final environment used for the launched app. Pass it to helper processes that must observe the same display and DBus session.         |
| `GtkApp.output()`           | Returns the retained stdout/stderr snapshot and current process exit status before `release()`.                                                   |
| `GtkApp.findById()`         | Waits for an element matching the accessible ID and returns a `GtkWidgetElement` if found. Returns `undefined` if not found.                      |
| `GtkApp.getById()`          | Waits for an element matching the accessible ID and returns a `GtkWidgetElement`. Throws an exception if not found.                               |
| `GtkApp.findByPath()`       | Waits for an accessible ID plus child indexes separated by `.`, `:`, `;`, or `,`. Returns `undefined` if not found.                               |
| `GtkApp.getByPath()`        | Waits for an accessible ID plus child indexes separated by `.`, `:`, `;`, or `,`. Throws an exception if not found.                               |
| `GtkApp.windowAt()`         | Gets a top-level window by AT-SPI traversal order and returns a `GtkWidgetElement` if it exists.                                                  |
| `GtkApp.getWindowCount()`   | Returns the number of top-level windows exposed by the application.                                                                               |
| `GtkApp.findTrayItem()`     | Waits for a tray item matching a StatusNotifierItem ID, title, or DBus information and returns a `GtkTrayItem` if found.                          |
| `GtkApp.getTrayItem()`      | Waits for a tray item matching a StatusNotifierItem ID, title, or DBus information and returns a `GtkTrayItem`. Throws an exception if not found. |
| `GtkApp.trayItemAt()`       | Gets a StatusNotifierItem by current registration order and returns a `GtkTrayItem` if it exists.                                                 |
| `GtkApp.getTrayItemCount()` | Returns the number of StatusNotifierItems currently owned by the application.                                                                     |

Code example:

```typescript
// Get the main window.
const mainWindow = await app.getById('main_window');
expect(mainWindow).toBeDefined();

// Get a descendant in one lookup
const resultLabel = await app.getByPath('main_window.0.2');
expect(resultLabel).toBeDefined();

// Get the window count.
const windowCount = await app.getWindowCount();
expect(windowCount).toBeGreaterThan(0);

// Capture the whole Xvfb screen.
const screenCapture = await app.capture();
expect(screenCapture.bounds).toEqual(screenCapture.visibleBounds);
expect(screenCapture.bounds.x).toBe(0);
expect(screenCapture.bounds.y).toBe(0);

// Get the second window (undefined if not found).
const secondWindow = await app.windowAt(1);
expect(secondWindow).toBeUndefined();
```

- Using `getByPath()` and `findByPath()` can reduce the tedious waiting involved in locating child elements.
  `getByPath(‘main_window.0.2’)` is roughly equivalent to `getById(‘main_window’).childAt(0).childAt(2)`, but
  when combining `getById()` and `childAt()`, you need to use `await` for each step.

### Operating GTK widgets

| API function           | Details                                                                                                                                                     |
| :--------------------- | :---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GtkElement.kind`      | Returns a normalized `GtkWidgetKind` derived from the target element's AT-SPI role/capability.                                                              |
| `GtkElement.info()`    | Gets the target element's role name, localized role name, accessible ID, name, description, interfaces, and states.                                         |
| `GtkElement.capture()` | Captures the area where the target element is actually displayed on the screen as a PNG and returns a `GtkCapture` containing the image and display bounds. |

`GtkElement` only provides common operations. Widget-specific operations are available after narrowing by the `kind` of `GtkWidgetElement`.

| Specialized type                                                                      | Operations                                                                                                                                                     |
| :------------------------------------------------------------------------------------ | :------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GtkEntryElement`                                                                     | `setText()` / `text()`                                                                                                                                         |
| `GtkLabelElement`, `GtkTextElement`                                                   | `text()`                                                                                                                                                       |
| `GtkButtonElement`, `GtkListItemElement`, `GtkMenuItemElement`                        | `click()`                                                                                                                                                      |
| `GtkCheckboxElement`, `GtkSwitchElement`, `GtkRadioElement`, `GtkToggleButtonElement` | `click()` / `isChecked()` / `toggle()`                                                                                                                         |
| `GtkSpinButtonElement`                                                                | `value()` / `valueInfo()` / `setValue()` / `increment()` / `decrement()`                                                                                       |
| `GtkSliderElement`                                                                    | `value()` / `valueInfo()` / `setValue()`                                                                                                                       |
| `GtkProgressBarElement`                                                               | `value()` / `valueInfo()`                                                                                                                                      |
| `GtkImageElement`                                                                     | `imageInfo()` / `GtkImageInfo.capture()`                                                                                                                       |
| `GtkWindowElement`                                                                    | `bounds()` / `resizeHints()` / `x11Info()` / `childAt()` / `getChildCount()`. Child elements are returned as `GtkWidgetElement`.                               |
| `GtkContainerElement`                                                                 | `childAt()` / `getChildCount()`. Child elements are returned as `GtkWidgetElement`.                                                                            |
| `GtkComboBoxElement`                                                                  | `click()` / `childAt()` / `getChildCount()` / `getSelectedChildCount()` / `selectedChildAt()` / `isChildSelected()` / `selectChildAt()` / `clearSelection()`   |
| `GtkListElement`                                                                      | `childAt()` / `getChildCount()` / `getSelectedChildCount()` / `selectedChildAt()` / `isChildSelected()` / `selectChildAt()` / `deselectChildAt()`, and others  |
| `GtkMenuElement`                                                                      | `childAt()` / `getChildCount()`. Child elements are returned as `GtkMenuItemElement`.                                                                          |
| `GtkTableElement`                                                                     | `getRowCount()` / `getColumnCount()` / `cellAt()` / `selectedRows()` / `selectedColumns()` / `selectRow()` / `selectColumn()` / `isCellSelected()`, and others |

Code example:

```typescript
// Get the widget with ID "name_entry" and set the text to "ABC".
const entry = await app.getById('name_entry');
if (entry.kind !== 'entry') {
  throw new Error(`Unexpected widget kind: ${entry.kind}`);
}
await entry.setText('ABC');

// Get the widget with ID "submit_button" and click it as a button.
const button = await app.getById('submit_button');
if (button.kind !== 'button') {
  throw new Error(`Unexpected widget kind: ${button.kind}`);
}
await button.click();

// Get the widget with ID "result_label" and wait until its text becomes "ABC".
const label = await app.getById('result_label');
if (label.kind !== 'label') {
  throw new Error(`Unexpected widget kind: ${label.kind}`);
}
await expect.poll(() => label.text()).toBe('ABC');

// Capture the rendered image of the label.
const capture = await label.capture();
expect(capture.visibleBounds.width).toBeGreaterThan(0);
```

Top-level windows expose a few additional APIs:

```typescript
// Get the top-level window
const mainWindow = await app.getById('main_window');
if (mainWindow.kind !== 'window') {
  throw new Error(`Unexpected widget kind: ${mainWindow.kind}`);
}

// Position and Size
const bounds = await mainWindow.bounds();
expect(bounds.width).toBeGreaterThan(0);

// Size constraints
const resizeHints = await mainWindow.resizeHints();
expect(resizeHints.minWidth).toBeGreaterThanOrEqual(0);

// X11-specific metadata
const x11Info = await mainWindow.x11Info();
expect(x11Info.normalHints.widthIncrement).toBeGreaterThanOrEqual(0);
```

- Taking a PNG screenshot will give you the window size, but if you only need the window geometry, use `bounds()`.
- Use `resizeHints()` for GTK/X11 size constraints such as base size, minimum size, and resize increments.
- `x11Info()` exposes X11-specific metadata and `WM_NORMAL_HINTS`; prefer the high-level APIs above unless you need an X11 escape hatch.
- On non-X11 backends or when the X11 window cannot be resolved, `x11Info()` rejects with `UNSUPPORTED_INTERFACE`.

For conditions that become true only after GTK layout, drawing, or an
application-side update settles, `gestament/testing` also provides retry
helpers.
These helper functions wait by polling until the specified handler succeeds:

```typescript
import { toPass, waitForResult } from 'gestament/testing';

// Wait until the handler completes
await toPass(async () => {
  expect(await label.text()).toBe('ABC');
});

// Wait until the handler completes, then return the result
const capture = await waitForResult(async () => {
  const nextCapture = await label.capture();
  expect(nextCapture.visibleBounds.width).toBeGreaterThan(0);
  return nextCapture;
});
```

These helpers share a timeout deadline with gestament lookups called inside
the retry block, so `getById()` and `getByPath()` do not wait longer than the
outer retry operation.

If you want to fine-tune the timeout parameters, specify them in the `GtkWaitOptions` argument.

`GtkWidgetKind` is a classification derived from AT-SPI roles and capabilities, not a GTK runtime type name.
You can use `switch` to write branches that absorb GTK3/GTK4 differences to some extent:

```typescript
const element = await app.getById('submit_button');

switch (element.kind) {
  // Button (GtkButton).
  case 'button':
    await element.click();
    break;
  // Text box (GtkEntry).
  case 'entry':
    await element.setText('ABC');
    break;
  // Check box (GtkCheckButton).
  case 'checkbox':
    if (!(await element.isChecked())) {
      await element.toggle();
    }
    break;
  // Numeric box with a spin button (GtkSpinButton).
  case 'spinButton':
    await element.setValue(3);
    break;
  default:
    throw new Error(`Unexpected widget kind: ${element.kind}`);
}
```

Enumerating and selecting child elements is also available after narrowing to the corresponding kind:

```typescript
const container = await app.getById('main_box');

// Exclude widgets that are not windows or containers.
if (container.kind !== 'window' && container.kind !== 'container') {
  throw new Error(`Unexpected widget kind: ${container.kind}`);
}

// Get the first child element.
const firstChild = await container.childAt(0);
switch (firstChild?.kind) {
  case 'entry':
    await firstChild.setText('ABC');
    break;
  case 'button':
    await firstChild.click();
    break;
  case 'label':
    expect(await firstChild.text()).toBe('Ready');
    break;
}

// List widget.
const list = await app.getById('item_list');
if (list.kind !== 'list') {
  throw new Error(`Unexpected widget kind: ${list.kind}`);
}

// Get the first child element of the list.
const item = await list.childAt(0);
if (item !== undefined) {
  await item.click();
}
// Select the second child element of the list.
await list.selectChildAt(1);

// Table widget.
const table = await app.getById('data_table');
if (table.kind !== 'table') {
  throw new Error(`Unexpected widget kind: ${table.kind}`);
}

// Get a table child element by row and column.
const cell = await table.cellAt(0, 1);
if (cell !== undefined) {
  expect((await cell.info()).name).toBe('R0C1');
}
```

### Operating GTK system trays

| API function             | Details                                                                                                                        |
| :----------------------- | :----------------------------------------------------------------------------------------------------------------------------- |
| `GtkTrayItem.metadata()` | Gets metadata such as the StatusNotifierItem ID, title, status, and icon name.                                                 |
| `GtkTrayItem.element()`  | Returns the `GtkWidgetElement` corresponding to the currently displayed tray icon. Returns `undefined` if it is not displayed. |
| `GtkTrayItem.capture()`  | Captures the currently displayed tray icon as a PNG.                                                                           |
| `GtkTrayItem.click()`    | Clicks the currently displayed tray icon.                                                                                      |
| `GtkTrayItem.openMenu()` | Returns a `GtkWidgetElement` if the tray icon menu can be retrieved. Returns `undefined` if it cannot be retrieved.            |

Code example:

```typescript
// Get the system tray item with ID "my-app".
const trayItem = await app.getTrayItem({ id: 'my-app' });

// Get system tray metadata.
const metadata = await trayItem.metadata();
expect(metadata.status).toBe('Active');

// Click the system tray.
await trayItem.click();

// Capture the rendered image of the system tray.
const capture = await trayItem.capture();
expect(capture.visibleBounds.width).toBeGreaterThan(0);
```

---

## Visual and OCR assertions

### Verifying UI correctness from images

`gestament/testing` provides helper APIs that compare `GtkCapture` values returned by `GtkElement.capture()` or `GtkTrayItem.capture()` with expected images.
Instead of requiring an exact match, you can assert using pixel-difference tolerances or structural similarity.

```typescript
import { expectCapture } from 'gestament/testing';

// Capture the label.
const label = await app.getById('result_label');
const capture = await label.capture();

// Compare with gtk3-result-label.png.
await expectCapture(capture, 'gtk3/result-label').toLookSimilar(
  'tests/images/gtk3-result-label.png'
);
```

- `toLookSimilar()` compares PNG images pixel by pixel.
- Pass the expected image as a `Buffer`, file path string, or `file:` URL in the first argument.

You can optionally specify comparison conditions:

```typescript
await expectCapture(capture, 'gtk3/result-label').toLookSimilar(
  'tests/images/gtk3-result-label.png',
  {
    // Specify comparison conditions to loosen strictness slightly.
    threshold: 0.12,
    maxDiffRatio: 0.02,
  }
);
```

- `threshold` is the allowed color difference for each pixel, and `maxDiffRatio` is the allowed difference ratio across all compared pixels.
- If `maxDiffPixels` is specified, both the difference ratio and the number of differing pixels must satisfy the conditions.

You can specify the image region to compare and avoid noise outside that region:

```typescript
await expectCapture(capture, 'gtk3/tray-item').toLookSimilar(
  new URL('./images/gtk3-tray-item.png', import.meta.url),
  {
    // Specify the image region.
    region: {
      x: 0,
      y: 0,
      width: 48,
      height: 48,
    },
    threshold: 0.15,
    maxDiffPixels: 12,
  }
);
```

### Verifying images by structural similarity

`toHaveSimilarity()` uses the MSSIM value from SSIM to assert structural similarity across the whole image or a specified region.
Use this when you want to check whether the overall shape and light/dark structure are preserved, rather than focusing on small font-rendering or antialiasing differences:

```typescript
// Compare with gtk3-main-window.png.
await expectCapture(capture, 'gtk3/main-window').toHaveSimilarity(
  'tests/images/gtk3-main-window.png',
  {
    minSimilarity: 0.985,
    // Specify excluded regions.
    masks: [
      {
        x: 0,
        y: 0,
        width: capture.visibleBounds.width,
        height: 24,
      },
    ],
  }
);
```

- `region` is the comparison target area, and `masks` are areas excluded from comparison.
  Both are specified in pixel coordinates whose origin is the top-left of the captured image.

### Saving image recognition results

`expectCapture()` and `createGtkCaptureExpect()` without arguments only perform comparisons.
If you want to inspect detailed results later, specify `outputResultPath` in `createGtkCaptureExpect()` to save `actual.png` and `metadata.json`.
You can also specify the destination through the `GESTAMENT_VISUAL_OUTPUT_RESULT_PATH` environment variable.

The destination path is `<outputResultPath>/<variant>/<comparison-name>-<counter>/`.
If a comparison fails, `expected.png` and `diff.png` are also saved for diagnostics.

```typescript
import { createGtkCaptureExpect } from 'gestament/testing';

const gtkExpect = createGtkCaptureExpect({
  outputResultPath: 'test-results',
  variant: 'gtk3',
});

// Destination: "test-results/gtk3/result-label-1/".
await gtkExpect
  .expectCapture(await label.capture(), 'result-label')
  .toLookSimilar('tests/images/gtk3-result-label.png');
```

### Verifying images with OCR

`toContainText()` OCRs a captured image with Tesseract.js and asserts that it contains text matching the specified string or regular expression.
Use this when you want to check whether expected text is actually rendered on a button or label:

```typescript
// Check whether "Submit" exists.
await expectCapture(capture, 'gtk3/submit-button').toContainText('Submit');

// Check whether it can be matched with a regular expression.
await expectCapture(capture, 'gtk3/status-label').toContainText(/ready/i);
```

You can also specify OCR segmentation modes:

```typescript
await expectCapture(capture, 'gtk3/submit-button').toContainText('Submit', {
  // Specify segmentation modes.
  pageSegmentationModes: ['singleBlock', 'singleLine', 'singleWord'],
});
```

If OCR recognition is unstable, you can restrict the image to the area where the text is rendered and specify preprocessing such as scaling, grayscale conversion, and thresholding:

```typescript
await expectCapture(capture, 'gtk3/submit-button').toContainText('Submit', {
  // Specify the image region.
  region: {
    x: 100,
    y: 0,
    width: 130,
    height: capture.visibleBounds.height,
  },
  // Apply preprocessing before comparison.
  preprocess: {
    scale: 3,
    grayscale: true,
    threshold: 190,
  },
});
```

If you perform multiple OCR assertions on the same capture, you can keep and reuse the OCR result with `readText()`:

```typescript
// Run OCR only once.
const ocrText = await expectCapture(capture, 'gtk3/dialog').readText({
  pageSegmentationModes: ['sparseText', 'singleBlock'],
});

// Assert the OCR result.
await ocrText.toContainText('Submit');
await ocrText.toContainText(/cancel/i);
```

For many OCR assertions, you can use a shared worker.
A shared worker keeps resources, so release it with `release()` after tests finish:

```typescript
import { afterAll } from 'vitest';
import { createGtkCaptureExpect } from 'gestament/testing';

const gtkExpect = createGtkCaptureExpect({
  // Specify the shared OCR worker.
  ocr: {
    workerMode: 'shared',
    languages: 'eng',
  },
});

// Release it after all tests finish.
afterAll(() => gtkExpect.release());
```

### Adding OCR languages

When you use only `eng`, gestament uses the bundled English traineddata.
For OCR in languages other than English, add language data for Tesseract.js and specify it with `ocr.languages` and `ocr.langPath` in `createGtkCaptureExpect()`.

For example, add a language data package like this to recognize Japanese:

```bash
npm install @tesseract.js-data/jpn
```

```typescript
import { createRequire } from 'node:module';
import { createGtkCaptureExpect } from 'gestament/testing';

// Refer to the Japanese language data package.
const require = createRequire(import.meta.url);
const jpnData = require('@tesseract.js-data/jpn') as {
  code: 'jpn';
  gzip: boolean;
  langPath: string;
};

const gtkExpect = createGtkCaptureExpect({
  ocr: {
    // Specify Japanese language data.
    languages: jpnData.code,
    langPath: jpnData.langPath,
    gzip: jpnData.gzip,
    cacheMethod: 'none',
  },
});

// Recognize and compare Japanese with OCR.
await gtkExpect
  .expectCapture(capture, 'gtk3/japanese-label')
  .toContainText('送信');
```

If you need to recognize multiple languages at the same time, specify an array in `languages`.
When you specify `langPath`, that directory must contain `*.traineddata.gz` files for all specified languages.
For example, first prepare language data like this:

```text
tests/tessdata/
  eng.traineddata.gz
  jpn.traineddata.gz
```

Then specify that directory path in `langPath`:

```typescript
const gtkExpect = createGtkCaptureExpect({
  ocr: {
    // Support multiple languages.
    languages: ['eng', 'jpn'],
    langPath: 'tests/tessdata',
    gzip: true,
    cacheMethod: 'none',
  },
});
```

If you switch languages, create a separate `createGtkCaptureExpect()` for each language configuration.
If you use shared workers, call `release()` on each `GtkCaptureExpect` after tests finish.

---

### Specifying test environment variables (Advanced topic)

gestament specifies common settings required for GTK tests through `createGtkAppLauncher()` options, not GTK application launch arguments.
By default, the following values are specified:

- `GDK_BACKEND=x11` fixes the GDK backend to X11 so GTK applications run on Xvfb.
- `GSETTINGS_BACKEND=memory` limits GSettings reads and writes to memory so test results are not affected by the user's environment settings.
- `GTK_THEME=Adwaita` fixes the theme to the standard GTK theme and isolates visual tests from the user's environment theme.

`createGtkAppLauncher()` starts an internal Xvfb session by default.
This session is launcher-scoped: apps launched from the same launcher share one Xvfb/DBus session, while separate launchers get separate sessions.
`xvfbScreen` defaults to `1280x720x24`, and `xvfbTrayHost` defaults to `true`.
`gsettings` and `theme` set `GSETTINGS_BACKEND` and `GTK_THEME`; use `null` to leave the corresponding environment variable unset.

When the effective display is an internal Xvfb session, gestament owns the session-critical environment variables:
It sets `DISPLAY`, `GDK_BACKEND=x11`, `DBUS_SESSION_BUS_ADDRESS`, `GESTAMENT_XVFB_ACTIVE=1`, and `XDG_SESSION_TYPE=x11`.
And, it also clears host values for `WAYLAND_DISPLAY`, `AT_SPI_BUS_ADDRESS`, and `NO_AT_BRIDGE`.
`XAUTHORITY` is cleared for the unauthenticated Xvfb server that gestament starts directly, and is retained only when it is required by an `xvfb-run`-provided server.

For that reason, `options.env` cannot override the following variables while using an internal Xvfb session:
`DISPLAY`, `WAYLAND_DISPLAY`, `GDK_BACKEND`, `DBUS_SESSION_BUS_ADDRESS`, `AT_SPI_BUS_ADDRESS`, `NO_AT_BRIDGE`, `XAUTHORITY`, `GESTAMENT_XVFB_ACTIVE`, and `XDG_SESSION_TYPE`.
Trying to override one of these values is treated as `INVALID_ARGUMENT`.

Use `GtkAppLauncher.environment()` before launching helper processes for a launcher, or `GtkApp.environment()` after launching an app.
The returned object is the final environment that should be passed to helpers that must observe the same Xvfb and DBus session as the tested app.

```typescript
import { spawnSync } from 'node:child_process';

// Reference the DISPLAY environment variable
// from the environment variables used during testing.
// This provides a starting point for manually controlling Xvfb.
const env = await app.environment();
const result = spawnSync(
  process.execPath,
  ['-e', 'console.log(process.env.DISPLAY)'],
  {
    env,
    encoding: 'utf8',
  }
);

expect(result.stdout.trim()).toBe(env.DISPLAY);
```

`GtkApp.capture()` captures the X11 root window, so `DISPLAY` must point to an X11 display.
Under the internal Xvfb session, the target is the entire Xvfb virtual screen.
The image size is determined by the current width and height of the X11 root window, and the internal Xvfb session uses the width and height values specified by `xvfbScreen`.
The default when unspecified is `1280x720x24`, so the PNG is normally `1280x720`.

Specify these launcher options when you want to launch on the host display or test GSettings persistence:

```typescript
const launcher = createGtkAppLauncher({
  appPath: './my-app',
  display: 'host',
  gsettings: 'dconf',
});
```

`display: 'host'` uses the current host display when `DISPLAY` or `WAYLAND_DISPLAY` exists, so the physical or already-running display itself is not isolated.
When no host display is available, gestament falls back to a launcher-scoped Xvfb session.

Image comparisons in `gestament/testing` also refer to the following environment variables:

- `GESTAMENT_VISUAL_OUTPUT_RESULT_PATH` specifies where diagnostic files such as actual/diff images are saved. If omitted, diagnostic files are not saved.
- `GESTAMENT_VISUAL_VARIANT` specifies the variant name used to separate diagnostic files. If omitted, `GESTAMENT_TEST_BACKEND` is used, and if that is also omitted, `default` is used.

### Speed Optimization Using Xvfb Pooling (Advanced topic)

Sometimes, test execution speed is critical.
gestament launches Xvfb internally to maintain UI session independence between tests, but restarting Xvfb and sessions takes time.
If this is a significant issue, you can use the Xvfb pooling feature.

`xvfbPool` controls whether Xvfb-related resources are pooled after `launcher.release()` and reused by subsequent launchers.
The default is: we do not reuse them in order to prioritize test reproducibility.

The following are the recommended settings when using this mode:

- Reproducibility first: omit `xvfbPool` (default)
- Trim only Xvfb startup time: `xvfbPool: { type: 'xvfb' }`
- Experiment with maximum reuse: `xvfbPool: { type: 'all' }`

| `xvfbPool.type` | Reused resources                          | Pool key                      |
| :-------------- | :---------------------------------------- | :---------------------------- |
| (omitted)       | Nothing. Xvfb/DBus/driver are recreated.  | none                          |
| `xvfb`          | Xvfb process only. DBus/driver are fresh. | `xvfbScreen`                  |
| `all`           | Xvfb, DBus session, driver, tray host.    | `xvfbScreen` + `xvfbTrayHost` |

Pools are not shared across Node.js processes or test workers; if a pool is reused, it is used by a single launcher at a time.

By default pooling, internal pools maintain a maximum of one idle session per reusable condition, up to a total of four.
Use `maxIdlePerKey` and `maxIdleTotal` to change those limits; either value can be `0` to discard sessions instead of retaining them.

If `display: ‘host’` uses an existing host display environment, `xvfbPool` has no effect. If `display: ‘host’` falls back to Xvfb, the specified pool mode is applied.
If a window is detected during the clean check for reuse, or if the X server probe fails, that session is discarded and not reused.

Possible side effects are listed below:

| Side effect                                | Mainly possible mode | Impact                                                       | Immediately affects tests |
| :----------------------------------------- | :------------------- | :----------------------------------------------------------- | :------------------------ |
| Previous window remains                    | `xvfb`, `all`        | Pollutes capture/click results                               | High                      |
| Orphan X client remains                    | `xvfb`, `all`        | May be visible even if AT-SPI does not expose it             | High                      |
| Accessible ID / window enumeration leakage | `all`                | Can make `findById`, `windowAt`, or `getWindowCount` wrong   | High                      |
| Tray item remains                          | `all`                | Can make `findTrayItem` or tray capture wrong                | High                      |
| Focus / stacking order carries over        | `xvfb`, `all`        | Can destabilize input target or capture                      | Medium to high            |
| Pointer / keyboard modifier state          | `xvfb`, `all`        | Can destabilize click/key operations                         | Medium                    |
| Root window property / background          | `xvfb`, `all`        | Can affect full-screen capture or environment checks         | Medium                    |
| Clipboard / PRIMARY selection              | `all`                | Can affect selection/clipboard tests                         | Medium                    |
| DBus service / AT-SPI cache state          | `all`                | Old services or cache entries may be observed                | Medium to high            |
| X server internal state / Atom table       | `xvfb`, `all`        | Usually not directly visible, but not a completely fresh X11 | Low to medium             |

---

## Self building (Advanced topic)

Install the required packages:

```bash
apt-get update
apt-get install -y \
  binutils build-essential ca-certificates file \
  libatspi2.0-dev libgdk-pixbuf-2.0-dev libglib2.0-dev libxtst-dev \
  libnode-dev libx11-dev at-spi2-core dbus-x11 \
  libgtk-3-dev libgtk-4-dev \
  make meson ninja-build pkg-config xauth xvfb
apt-get install -y \
  nodejs npm
```

- It may be better to install Node.js through [nvm](https://github.com/nvm-sh/nvm). Version 20 or later is required.

### Build and test

```bash
npm install
npm run build
npm run test
```

- Or use `build.sh` directly.

### Build all platform packages

```bash
# Prerequisities
sudo apt-get install -y podman
sudo podman run --rm --privileged docker.io/multiarch/qemu-user-static --reset -p yes

# Verify QEMU is working:
podman run --rm --platform linux/arm64 docker.io/library/debian:trixie-slim uname -m
# Should output: aarch64
```

```bash
# Build all packages
./build_package_all.sh
```

- Requires at least 24 core or upper CPU machines.
- This takes a VERY LONG TIME (maybe half hour or longer) because it builds and tests native code for all supported architectures.

## License

Under MIT.
