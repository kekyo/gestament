// gestament - TypeScript based test driver for GTK.
// Copyright (c) Kouji Matsui. (@kekyo@mi.kekyo.net)
// Under MIT.
// https://github.com/kekyo/gestament

/////////////////////////////////////////////////////////////////////////////////////////

/** Error code values reported by the GTK automation library. */
export type GtkAutomationErrorCode =
  | 'APP_EXITED'
  | 'ELEMENT_NOT_FOUND'
  | 'INVALID_ARGUMENT'
  | 'NATIVE_LOAD_FAILED'
  | 'OPERATION_FAILED'
  | 'STALE_ELEMENT'
  | 'TIMEOUT'
  | 'UNSUPPORTED_INTERFACE';

/** Base error for GTK automation failures. */
export interface GtkAutomationError extends Error {
  /** Stable machine-readable error code. */
  readonly code: GtkAutomationErrorCode;
}

/////////////////////////////////////////////////////////////////////////////////////////

/**
 * Screen-relative rectangular bounds in physical pixels.
 */
export interface GtkCaptureBounds {
  /**
   * Left coordinate relative to the root screen.
   */
  readonly x: number;

  /**
   * Top coordinate relative to the root screen.
   */
  readonly y: number;

  /**
   * Rectangle width in pixels.
   */
  readonly width: number;

  /**
   * Rectangle height in pixels.
   */
  readonly height: number;
}

/**
 * Real screen capture for a GTK accessible element.
 */
export interface GtkCapture {
  /**
   * PNG image buffer captured from the real root screen.
   */
  readonly image: Buffer;

  /**
   * Screen bounds reported by AT-SPI for the accessible element.
   */
  readonly bounds: GtkCaptureBounds;

  /**
   * Captured portion after clipping bounds to the root screen.
   */
  readonly visibleBounds: GtkCaptureBounds;

  /**
   * Whether the accessible bounds were clipped to the root screen.
   */
  readonly clipped: boolean;
}

/**
 * X11 normal-size hints exposed for a GTK top-level window.
 */
export interface GtkWindowResizeHints {
  /**
   * Base window width in pixels.
   */
  readonly baseWidth: number;

  /**
   * Base window height in pixels.
   */
  readonly baseHeight: number;

  /**
   * Minimum window width in pixels.
   */
  readonly minWidth: number;

  /**
   * Minimum window height in pixels.
   */
  readonly minHeight: number;

  /**
   * Width step used when the window manager resizes the window.
   */
  readonly widthIncrement: number;

  /**
   * Height step used when the window manager resizes the window.
   */
  readonly heightIncrement: number;
}

/**
 * X11-specific metadata for a GTK top-level window.
 */
export interface GtkX11WindowInfo {
  /**
   * X11 window id formatted as a hexadecimal string.
   */
  readonly windowId: string;

  /**
   * Window title read from _NET_WM_NAME or WM_NAME.
   */
  readonly title: string;

  /**
   * WM_CLASS class name.
   */
  readonly className: string;

  /**
   * WM_CLASS instance name.
   */
  readonly instanceName: string;

  /**
   * Normal-size hints exposed through WM_NORMAL_HINTS.
   */
  readonly normalHints: GtkWindowResizeHints;
}

/////////////////////////////////////////////////////////////////////////////////////////

/**
 * Normalized accessible widget category used for test-side branching.
 *
 * This value is derived from AT-SPI role/capability information. It is not a
 * GTK GObject class name such as GtkButton or GtkLabel.
 */
export type GtkWidgetKind =
  | 'window'
  | 'button'
  | 'container'
  | 'label'
  | 'entry'
  | 'text'
  | 'checkbox'
  | 'switch'
  | 'radio'
  | 'toggleButton'
  | 'slider'
  | 'spinButton'
  | 'progressBar'
  | 'comboBox'
  | 'list'
  | 'listItem'
  | 'table'
  | 'tableCell'
  | 'image'
  | 'menu'
  | 'menuItem'
  | 'unknown';

/** Metadata exposed by AT-SPI for a GTK accessible element. */
export interface GtkElementInfo {
  /**
   * Normalized widget category derived from the AT-SPI role.
   */
  readonly kind: GtkWidgetKind;

  /**
   * Stable AT-SPI role name reported for the accessible.
   *
   * The exact spelling is provided by the platform AT-SPI implementation.
   */
  readonly roleName: string;

  /**
   * Localized AT-SPI role name reported for the accessible.
   */
  readonly localizedRoleName: string;

  /**
   * Accessible id assigned to the element, when one is exposed.
   */
  readonly accessibleId: string;

  /**
   * Accessible name reported by the application.
   */
  readonly name: string;

  /**
   * Accessible description reported by the application.
   */
  readonly description: string;

  /**
   * AT-SPI interfaces currently exposed by the accessible.
   */
  readonly interfaces: readonly string[];

  /**
   * AT-SPI states currently exposed by the accessible.
   */
  readonly states: readonly string[];
}

/**
 * Shared operation for objects that can capture their current screen area.
 */
export interface GtkCapturable {
  /**
   * Captures pixels from the real screen area represented by this object.
   *
   * This does not render widgets off-screen. If another window covers the
   * target area, the returned image contains the covering window pixels.
   *
   * @returns A promise that resolves to the captured PNG image and screen bounds.
   */
  readonly capture: () => Promise<GtkCapture>;
}

/**
 * Keyboard modifier keys that can be held or released independently.
 */
export type GtkKeyboardModifier = 'shift' | 'control' | 'alt' | 'super';

/**
 * Keyboard key identifier used by low-level input synthesis.
 *
 * @remarks
 * String values are interpreted as X11 keysym names. Number values are
 * interpreted as numeric X11 keysym values.
 */
export type GtkKeyInput = string | number;

/**
 * Mouse buttons that can be held or released independently.
 */
export type GtkMouseButton = 'left' | 'middle' | 'right' | 'back' | 'forward';

/**
 * Low-level input controller for the display session used by a launched app.
 */
export interface GtkInputController {
  /**
   * Presses or releases one keyboard modifier.
   *
   * @param modifier - Modifier key to change.
   * @param pressed - true to hold the modifier, false to release it.
   * @returns A promise that resolves when the modifier state was synthesized.
   */
  readonly setModifier: (
    modifier: GtkKeyboardModifier,
    pressed: boolean
  ) => Promise<void>;

  /**
   * Sends one press-and-release key input.
   *
   * @param key - X11 keysym name or numeric keysym value.
   * @returns A promise that resolves when the key press was synthesized.
   * @remarks
   * Modifier keys are intentionally rejected here. Use `setModifier()` to
   * control Shift, Control, Alt, or Super state explicitly.
   */
  readonly pressKey: (key: GtkKeyInput) => Promise<void>;

  /**
   * Moves the mouse pointer to screen-relative coordinates.
   *
   * @param x - Horizontal coordinate relative to the root screen.
   * @param y - Vertical coordinate relative to the root screen.
   * @returns A promise that resolves when pointer motion was synthesized.
   */
  readonly moveMouseTo: (x: number, y: number) => Promise<void>;

  /**
   * Presses or releases one mouse button.
   *
   * @param button - Mouse button to change.
   * @param pressed - true to hold the button, false to release it.
   * @returns A promise that resolves when the button state was synthesized.
   */
  readonly setMouseButton: (
    button: GtkMouseButton,
    pressed: boolean
  ) => Promise<void>;

  /**
   * Sends mouse wheel steps.
   *
   * @param xSteps - Horizontal wheel steps. Positive values scroll right.
   * @param ySteps - Vertical wheel steps. Positive values scroll down.
   * @returns A promise that resolves when all wheel steps were synthesized.
   */
  readonly scrollWheel: (xSteps: number, ySteps: number) => Promise<void>;
}

/**
 * A GTK accessible element resolved within a launched application process.
 *
 * If the host widget or window disappears after this element is obtained,
 * operations reject with STALE_ELEMENT.
 */
export interface GtkElement extends GtkCapturable {
  /**
   * Normalized widget category captured when this element was resolved.
   */
  readonly kind: GtkWidgetKind;

  /**
   * Reads current AT-SPI metadata for this element.
   *
   * @returns A promise that resolves to the current element metadata.
   */
  readonly info: () => Promise<GtkElementInfo>;
}

/**
 * Shared operations for widgets that expose typed direct children.
 *
 * @typeParam Child - Element type returned for child elements.
 */
export interface GtkChildContainer<Child extends GtkWidgetElement> {
  /**
   * Resolves a direct child by AT-SPI child order.
   *
   * @param index - Zero-based AT-SPI child index.
   * @returns A promise that resolves to the child element, or undefined when no child exists at the index.
   */
  readonly childAt: (index: number) => Promise<Child | undefined>;

  /**
   * Counts direct children currently exposed by this element.
   *
   * @returns A promise that resolves to the current direct child count.
   */
  readonly getChildCount: () => Promise<number>;
}

/**
 * Shared operations for widgets that expose selectable direct children.
 *
 * @typeParam Child - Element type returned for child elements.
 */
export interface GtkSelectableChildContainer<
  Child extends GtkWidgetElement,
> extends GtkChildContainer<Child> {
  /**
   * Counts currently selected children.
   *
   * @returns A promise that resolves to the current selected child count.
   */
  readonly getSelectedChildCount: () => Promise<number>;

  /**
   * Resolves a selected child by selected-child order.
   *
   * @param selectedIndex - Zero-based selected child index.
   * @returns A promise that resolves to the selected child element, or undefined when no selected child exists at the index.
   */
  readonly selectedChildAt: (
    selectedIndex: number
  ) => Promise<Child | undefined>;

  /**
   * Reads whether a direct child is selected.
   *
   * @param index - Zero-based direct child index.
   * @returns A promise that resolves to true when the child is selected.
   */
  readonly isChildSelected: (index: number) => Promise<boolean>;

  /**
   * Selects a direct child.
   *
   * @param index - Zero-based direct child index.
   * @returns A promise that resolves when the child has been selected.
   */
  readonly selectChildAt: (index: number) => Promise<void>;

  /**
   * Deselects a direct child.
   *
   * @param index - Zero-based direct child index.
   * @returns A promise that resolves when the child has been deselected.
   */
  readonly deselectChildAt: (index: number) => Promise<void>;

  /**
   * Selects all direct children when the widget supports multi-selection.
   *
   * @returns A promise that resolves when all selectable children have been selected.
   */
  readonly selectAllChildren: () => Promise<void>;

  /**
   * Clears the current child selection.
   *
   * @returns A promise that resolves when selection has been cleared.
   */
  readonly clearSelection: () => Promise<void>;
}

/**
 * A GTK top-level window element.
 */
export interface GtkWindowElement
  extends GtkElement, GtkChildContainer<GtkWidgetElement> {
  /**
   * Discriminator for window elements.
   */
  readonly kind: 'window';

  /**
   * Reads current screen-relative bounds without capturing image pixels.
   *
   * @returns A promise that resolves to the current window bounds.
   */
  readonly bounds: () => Promise<GtkCaptureBounds>;

  /**
   * Moves this window to screen-relative coordinates.
   *
   * @param x - Left coordinate relative to the root screen.
   * @param y - Top coordinate relative to the root screen.
   * @returns A promise that resolves to the actual bounds observed after the move.
   */
  readonly moveTo: (x: number, y: number) => Promise<GtkCaptureBounds>;

  /**
   * Resizes this window.
   *
   * @param width - Requested window width in physical pixels.
   * @param height - Requested window height in physical pixels.
   * @returns A promise that resolves to the actual bounds observed after the resize.
   */
  readonly resizeTo: (
    width: number,
    height: number
  ) => Promise<GtkCaptureBounds>;

  /**
   * Moves and resizes this window.
   *
   * @param bounds - Requested screen-relative bounds in physical pixels.
   * @returns A promise that resolves to the actual bounds observed after the change.
   */
  readonly setBounds: (bounds: GtkCaptureBounds) => Promise<GtkCaptureBounds>;

  /**
   * Activates this window as if the window manager focused it.
   *
   * @returns A promise that resolves when the activation request has been sent
   * and focus has been observed.
   * @remarks
   * This operation is currently supported for X11 windows. It rejects with
   * UNSUPPORTED_INTERFACE when the window cannot be resolved on X11.
   */
  readonly activate: () => Promise<void>;

  /**
   * Reads X11 normal-size hints for this window.
   *
   * @returns A promise that resolves to the current resize hints.
   */
  readonly resizeHints: () => Promise<GtkWindowResizeHints>;

  /**
   * Reads X11-specific window metadata for this window.
   *
   * @returns A promise that resolves to X11 window metadata.
   * @remarks
   * Rejects with UNSUPPORTED_INTERFACE when the current display is not X11 or
   * the native X11 window cannot be resolved.
   */
  readonly x11Info: () => Promise<GtkX11WindowInfo>;
}

/**
 * A generic GTK container element with typed child traversal.
 */
export interface GtkContainerElement
  extends GtkElement, GtkChildContainer<GtkWidgetElement> {
  /**
   * Discriminator for generic container elements.
   */
  readonly kind: 'container';
}

/**
 * Shared operation for widgets that expose an executable primary AT-SPI action.
 */
export interface GtkClickable {
  /**
   * Executes the element's primary AT-SPI action.
   *
   * @returns A promise that resolves when the action has been executed.
   */
  readonly click: () => Promise<void>;
}

/**
 * Shared operations for widgets with a checked, pressed, or selected state.
 */
export interface GtkCheckable {
  /**
   * Reads whether the element is currently checked or pressed.
   *
   * @returns A promise that resolves to true when the element is checked or pressed.
   */
  readonly isChecked: () => Promise<boolean>;

  /**
   * Executes the element's primary action to toggle or select it.
   *
   * @remarks
   * Radio elements usually become selected when toggled, but toggling an already
   * selected radio element is not guaranteed to clear the selection.
   *
   * @returns A promise that resolves when the toggle action has been executed.
   */
  readonly toggle: () => Promise<void>;
}

/**
 * A GTK button element with an executable primary action.
 */
export interface GtkButtonElement extends GtkElement, GtkClickable {
  /**
   * Discriminator for button elements.
   */
  readonly kind: 'button';
}

/**
 * Shared operation for widgets that expose readable text through AT-SPI.
 */
export interface GtkTextDisplay {
  /**
   * Reads the element text through the AT-SPI Text interface.
   *
   * @returns A promise that resolves to the current element text.
   */
  readonly text: () => Promise<string>;
}

/**
 * A GTK label element with readable text.
 */
export interface GtkLabelElement extends GtkElement, GtkTextDisplay {
  /**
   * Discriminator for label elements.
   */
  readonly kind: 'label';
}

/**
 * A GTK entry element with editable and readable text.
 */
export interface GtkEntryElement extends GtkElement, GtkTextDisplay {
  /**
   * Discriminator for entry elements.
   */
  readonly kind: 'entry';

  /**
   * Replaces the element text through the AT-SPI EditableText interface.
   *
   * @param text - Text contents to set on the element.
   * @returns A promise that resolves when the text has been replaced.
   */
  readonly setText: (text: string) => Promise<void>;
}

/**
 * A GTK text element with readable text.
 */
export interface GtkTextElement extends GtkElement, GtkTextDisplay {
  /**
   * Discriminator for text elements.
   */
  readonly kind: 'text';
}

/**
 * A GTK checkbox element with executable and checkable operations.
 */
export interface GtkCheckboxElement
  extends GtkElement, GtkClickable, GtkCheckable {
  /**
   * Discriminator for checkbox elements.
   */
  readonly kind: 'checkbox';
}

/**
 * A GTK switch element with executable and checkable operations.
 */
export interface GtkSwitchElement
  extends GtkElement, GtkClickable, GtkCheckable {
  /**
   * Discriminator for switch elements.
   */
  readonly kind: 'switch';
}

/**
 * A GTK radio button element with executable and checkable operations.
 */
export interface GtkRadioElement
  extends GtkElement, GtkClickable, GtkCheckable {
  /**
   * Discriminator for radio button elements.
   */
  readonly kind: 'radio';
}

/**
 * A GTK toggle button element with executable and checkable operations.
 */
export interface GtkToggleButtonElement
  extends GtkElement, GtkClickable, GtkCheckable {
  /**
   * Discriminator for toggle button elements.
   */
  readonly kind: 'toggleButton';
}

/**
 * Numeric value metadata exposed through the AT-SPI Value interface.
 */
export interface GtkValueInfo {
  /**
   * Current numeric value.
   */
  readonly value: number;

  /**
   * Minimum numeric value.
   */
  readonly minimum: number;

  /**
   * Maximum numeric value.
   */
  readonly maximum: number;

  /**
   * Minimum increment used by step-based controls.
   */
  readonly minimumIncrement: number;

  /**
   * Text representation reported by AT-SPI, when available.
   */
  readonly text: string;
}

/**
 * Point reported by the AT-SPI Image interface.
 */
export interface GtkImagePoint {
  /**
   * Horizontal pixel coordinate.
   */
  readonly x: number;

  /**
   * Vertical pixel coordinate.
   */
  readonly y: number;
}

/**
 * Image size reported by the AT-SPI Image interface.
 */
export interface GtkImageSize {
  /**
   * Image width in physical pixels.
   */
  readonly width: number;

  /**
   * Image height in physical pixels.
   */
  readonly height: number;
}

/**
 * Metadata exposed through the AT-SPI Image interface.
 */
export interface GtkImageInfo {
  /**
   * Text description of the displayed image.
   */
  readonly description: string;

  /**
   * Locale associated with the displayed image.
   */
  readonly locale: string;

  /**
   * Image position reported by AT-SPI.
   *
   * @remarks Some backends report this relative to the image widget rather than
   * the root screen. Use `bounds` when screen-relative coordinates are required.
   */
  readonly position: GtkImagePoint;

  /**
   * Displayed image size.
   */
  readonly size: GtkImageSize;

  /**
   * Screen-relative image bounding box.
   */
  readonly bounds: GtkCaptureBounds;

  /**
   * Captures pixels for the current image area.
   *
   * @remarks The capture uses `bounds`, which is read from AT-SPI Image extents
   * with screen coordinates. It does not use `position` because backends may
   * report image position relative to the widget.
   *
   * @returns A promise that resolves to the captured PNG image and screen bounds.
   */
  readonly capture: () => Promise<GtkCapture>;
}

/**
 * Shared read-only operations for widgets that expose AT-SPI Value.
 */
export interface GtkValueDisplay {
  /**
   * Reads the current numeric value through the AT-SPI Value interface.
   *
   * @returns A promise that resolves to the current numeric value.
   */
  readonly value: () => Promise<number>;

  /**
   * Reads numeric value metadata through the AT-SPI Value interface.
   *
   * @returns A promise that resolves to the current value metadata.
   */
  readonly valueInfo: () => Promise<GtkValueInfo>;
}

/**
 * Shared read-write operations for widgets that expose AT-SPI Value.
 */
export interface GtkValueControl extends GtkValueDisplay {
  /**
   * Sets the current numeric value through the AT-SPI Value interface.
   *
   * @param value - Numeric value to set.
   * @returns A promise that resolves when the value has been set.
   */
  readonly setValue: (value: number) => Promise<void>;
}

/**
 * Step-based operations for spin button value controls.
 */
export interface GtkSpinButtonControl {
  /**
   * Increments the spin button by one AT-SPI Value minimum increment.
   *
   * @remarks When a backend reports a zero minimum increment, gestament uses a
   * fallback step so the operation can still move the value.
   *
   * @returns A promise that resolves when the value has been incremented.
   */
  readonly increment: () => Promise<void>;

  /**
   * Decrements the spin button by one AT-SPI Value minimum increment.
   *
   * @remarks When a backend reports a zero minimum increment, gestament uses a
   * fallback step so the operation can still move the value.
   *
   * @returns A promise that resolves when the value has been decremented.
   */
  readonly decrement: () => Promise<void>;
}

/**
 * A GTK slider element with read-write value operations.
 */
export interface GtkSliderElement extends GtkElement, GtkValueControl {
  /**
   * Discriminator for slider elements.
   */
  readonly kind: 'slider';
}

/**
 * A GTK spin button element with read-write and step value operations.
 */
export interface GtkSpinButtonElement
  extends GtkElement, GtkValueControl, GtkSpinButtonControl {
  /**
   * Discriminator for spin button elements.
   */
  readonly kind: 'spinButton';
}

/**
 * A GTK progress bar element with read-only value operations.
 */
export interface GtkProgressBarElement extends GtkElement, GtkValueDisplay {
  /**
   * Discriminator for progress bar elements.
   */
  readonly kind: 'progressBar';
}

/**
 * A GTK list item element with an executable primary action.
 */
export interface GtkListItemElement extends GtkElement, GtkClickable {
  /**
   * Discriminator for list item elements.
   */
  readonly kind: 'listItem';
}

/**
 * A GTK menu item element with an executable primary action.
 */
export interface GtkMenuItemElement extends GtkElement, GtkClickable {
  /**
   * Discriminator for menu item elements.
   */
  readonly kind: 'menuItem';
}

/**
 * Item element returned by combo box child traversal.
 */
export type GtkComboBoxItemElement = GtkListItemElement | GtkMenuItemElement;

/**
 * A GTK combo box element with executable and selectable child operations.
 */
export interface GtkComboBoxElement
  extends
    GtkElement,
    GtkClickable,
    GtkSelectableChildContainer<GtkComboBoxItemElement> {
  /**
   * Discriminator for combo box elements.
   */
  readonly kind: 'comboBox';
}

/**
 * A GTK list element with selectable list item operations.
 */
export interface GtkListElement
  extends GtkElement, GtkSelectableChildContainer<GtkListItemElement> {
  /**
   * Discriminator for list elements.
   */
  readonly kind: 'list';
}

/**
 * GTK table selection operations.
 *
 * @remarks
 * These operations require AT-SPI Table selection support. GTK4 widgets such as
 * GtkColumnView can expose visible table rows and cells without exposing this
 * interface in current GTK4 versions.
 */
export interface GtkTableSelection {
  /**
   * Reads selected row indexes.
   *
   * @returns A promise that resolves to selected row indexes.
   */
  readonly selectedRows: () => Promise<readonly number[]>;

  /**
   * Reads selected column indexes.
   *
   * @returns A promise that resolves to selected column indexes.
   */
  readonly selectedColumns: () => Promise<readonly number[]>;

  /**
   * Reads whether a row is selected.
   *
   * @param row - Zero-based table row index.
   * @returns A promise that resolves to true when the row is selected.
   */
  readonly isRowSelected: (row: number) => Promise<boolean>;

  /**
   * Reads whether a column is selected.
   *
   * @param column - Zero-based table column index.
   * @returns A promise that resolves to true when the column is selected.
   */
  readonly isColumnSelected: (column: number) => Promise<boolean>;

  /**
   * Reads whether a cell is selected.
   *
   * @param row - Zero-based table row index.
   * @param column - Zero-based table column index.
   * @returns A promise that resolves to true when the cell is selected.
   */
  readonly isCellSelected: (row: number, column: number) => Promise<boolean>;

  /**
   * Selects a row.
   *
   * @param row - Zero-based table row index.
   * @returns A promise that resolves when the row has been selected.
   */
  readonly selectRow: (row: number) => Promise<void>;

  /**
   * Deselects a row.
   *
   * @param row - Zero-based table row index.
   * @returns A promise that resolves when the row has been deselected.
   */
  readonly deselectRow: (row: number) => Promise<void>;

  /**
   * Selects a column.
   *
   * @param column - Zero-based table column index.
   * @returns A promise that resolves when the column has been selected.
   */
  readonly selectColumn: (column: number) => Promise<void>;

  /**
   * Deselects a column.
   *
   * @param column - Zero-based table column index.
   * @returns A promise that resolves when the column has been deselected.
   */
  readonly deselectColumn: (column: number) => Promise<void>;
}

/**
 * A GTK table element.
 */
export interface GtkTableElement extends GtkElement, GtkTableSelection {
  /**
   * Discriminator for table elements.
   */
  readonly kind: 'table';

  /**
   * Counts logical table rows.
   *
   * @returns A promise that resolves to the current row count.
   */
  readonly getRowCount: () => Promise<number>;

  /**
   * Counts logical table columns.
   *
   * @returns A promise that resolves to the current column count.
   */
  readonly getColumnCount: () => Promise<number>;

  /**
   * Resolves a logical table cell by row and column.
   *
   * @param row - Zero-based table row index.
   * @param column - Zero-based table column index.
   * @returns A promise that resolves to the table cell element, or undefined when no cell exists at the position.
   */
  readonly cellAt: (
    row: number,
    column: number
  ) => Promise<GtkTableCellElement | undefined>;
}

/**
 * A GTK table cell element.
 */
export interface GtkTableCellElement extends GtkElement {
  /**
   * Discriminator for table cell elements.
   */
  readonly kind: 'tableCell';
}

/**
 * A GTK image element.
 */
export interface GtkImageElement extends GtkElement {
  /**
   * Discriminator for image elements.
   */
  readonly kind: 'image';

  /**
   * Reads image metadata through the AT-SPI Image interface.
   *
   * @returns A promise that resolves to the current image metadata.
   */
  readonly imageInfo: () => Promise<GtkImageInfo>;
}

/**
 * A GTK menu element with typed menu item traversal.
 */
export interface GtkMenuElement
  extends GtkElement, GtkChildContainer<GtkMenuItemElement> {
  /**
   * Discriminator for menu elements.
   */
  readonly kind: 'menu';
}

/**
 * A GTK element whose widget category is not recognized.
 */
export interface GtkUnknownElement extends GtkElement {
  /**
   * Discriminator for elements whose widget category is not recognized.
   */
  readonly kind: 'unknown';
}

/**
 * Any specialized GTK element discriminated by its normalized widget kind.
 */
export type GtkWidgetElement =
  | GtkWindowElement
  | GtkButtonElement
  | GtkContainerElement
  | GtkLabelElement
  | GtkEntryElement
  | GtkTextElement
  | GtkCheckboxElement
  | GtkSwitchElement
  | GtkRadioElement
  | GtkToggleButtonElement
  | GtkSliderElement
  | GtkSpinButtonElement
  | GtkProgressBarElement
  | GtkComboBoxElement
  | GtkListElement
  | GtkListItemElement
  | GtkTableElement
  | GtkTableCellElement
  | GtkImageElement
  | GtkMenuElement
  | GtkMenuItemElement
  | GtkUnknownElement;

/**
 * Specialized GTK element type for a normalized widget kind.
 *
 * @typeParam Kind - Normalized widget kind to extract from GtkWidgetElement.
 *
 * @remarks
 * Returns never when the kind is not present in GtkWidgetElement.
 */
export type GtkElementOfKind<Kind extends GtkWidgetKind> = Extract<
  GtkWidgetElement,
  { readonly kind: Kind }
>;

/////////////////////////////////////////////////////////////////////////////////////////

/**
 * Selector used to resolve a StatusNotifier tray item.
 */
export type GtkTrayItemSelector =
  | {
      /**
       * StatusNotifierItem Id property.
       */
      readonly id: string;
    }
  | {
      /**
       * StatusNotifierItem Title property.
       */
      readonly title: string;
    }
  | {
      /**
       * DBus bus name that owns the StatusNotifierItem.
       */
      readonly busName: string;

      /**
       * Optional DBus object path for the StatusNotifierItem.
       */
      readonly objectPath?: string;
    };

/**
 * Metadata for a StatusNotifier tray item.
 */
export interface GtkTrayItemMetadata {
  /**
   * StatusNotifierItem Id property when provided.
   */
  readonly id?: string;

  /**
   * StatusNotifierItem Title property when provided.
   */
  readonly title?: string;

  /**
   * StatusNotifierItem Status property when provided.
   */
  readonly status?: string;

  /**
   * StatusNotifierItem IconName property when provided.
   */
  readonly iconName?: string;

  /**
   * Backend used to discover this tray item.
   */
  readonly backend: 'status-notifier';
}

/**
 * A logical StatusNotifier tray item owned by the launched application.
 */
export interface GtkTrayItem extends GtkCapturable, GtkClickable {
  /**
   * Reads current tray item metadata and fails if the DBus item is stale.
   *
   * @returns A promise that resolves to the current tray item metadata.
   */
  readonly metadata: () => Promise<GtkTrayItemMetadata>;

  /**
   * Resolves the currently rendered tray item accessible when it is visible.
   *
   * @returns A promise that resolves to the tray item element, or undefined when it is not visible.
   */
  readonly element: () => Promise<GtkWidgetElement | undefined>;

  /**
   * Opens the tray menu when one is exposed by the tray item.
   *
   * @returns A promise that resolves to the menu element, or undefined when no menu is exposed.
   */
  readonly openMenu: () => Promise<GtkWidgetElement | undefined>;
}

/////////////////////////////////////////////////////////////////////////////////////////

/**
 * Common interface for objects that own resources requiring explicit release.
 */
export interface Releasable extends AsyncDisposable {
  /**
   * Releases resources owned by this object.
   *
   * @returns A promise-like value that resolves when release has completed.
   */
  readonly release: () => PromiseLike<void>;
}

/////////////////////////////////////////////////////////////////////////////////////////

/**
 * Environment values passed to a launched GTK application.
 *
 * Undefined values remove or override inherited environment values according to
 * Node.js child_process environment handling.
 */
export type GtkAppEnvironment = Readonly<Record<string, string | undefined>>;

/**
 * Display environment used by a reusable GTK application launcher.
 */
export type GtkAppDisplay = 'xvfb' | 'host';

/** Standard output stream captured from a launched GTK application. */
export type GtkAppOutputStream = 'stdout' | 'stderr';

/** Infrastructure process that produced system output for a GTK launcher. */
export type GtkSystemOutputSource = 'xvfb' | 'launcher-driver' | 'tray-host';

/**
 * Output chunk emitted by a launched GTK application.
 */
export interface GtkAppOutputEvent {
  /**
   * Output stream that produced this chunk.
   */
  readonly stream: GtkAppOutputStream;

  /**
   * UTF-8 decoded output text for this chunk.
   */
  readonly text: string;

  /**
   * Monotonic sequence number across stdout and stderr for this application.
   */
  readonly sequence: number;

  /**
   * Time when gestament received this chunk.
   */
  readonly timestampMs: number;
}

/**
 * Output snapshot captured from a launched GTK application.
 */
export interface GtkAppOutput {
  /**
   * Captured stdout text.
   */
  readonly stdout: string;

  /**
   * Captured stderr text.
   */
  readonly stderr: string;

  /**
   * Process exit code, or null while the process is running or exited by signal.
   */
  readonly exitCode: number | null;

  /**
   * Process exit signal, or null while the process is running or exited by code.
   */
  readonly exitSignal: string | null;

  /**
   * Whether stdout was truncated by outputBufferBytes.
   */
  readonly stdoutTruncated: boolean;

  /**
   * Whether stderr was truncated by outputBufferBytes.
   */
  readonly stderrTruncated: boolean;
}

/**
 * Output chunk emitted by infrastructure processes used by a GTK launcher.
 */
export interface GtkSystemOutputEvent {
  /**
   * Infrastructure process category that produced this chunk.
   */
  readonly source: GtkSystemOutputSource;

  /**
   * Output stream that produced this chunk.
   */
  readonly stream: GtkAppOutputStream;

  /**
   * UTF-8 decoded output text for this chunk.
   */
  readonly text: string;

  /**
   * Monotonic sequence number across sources and streams for this launcher lease.
   */
  readonly sequence: number;

  /**
   * Time when gestament received this chunk.
   */
  readonly timestampMs: number;
}

/**
 * Output snapshot for one infrastructure process category.
 */
export interface GtkSystemOutputSourceSnapshot {
  /**
   * Infrastructure process category for this snapshot.
   */
  readonly source: GtkSystemOutputSource;

  /**
   * Captured stdout text.
   */
  readonly stdout: string;

  /**
   * Captured stderr text.
   */
  readonly stderr: string;

  /**
   * Whether stdout was truncated by systemOutputBufferBytes.
   */
  readonly stdoutTruncated: boolean;

  /**
   * Whether stderr was truncated by systemOutputBufferBytes.
   */
  readonly stderrTruncated: boolean;
}

/**
 * Output snapshot captured from infrastructure processes used by a GTK launcher.
 */
export interface GtkSystemOutput {
  /**
   * Captured output grouped by infrastructure process category.
   */
  readonly sources: readonly GtkSystemOutputSourceSnapshot[];
}

/**
 * Xvfb session pooling options used by a reusable GTK application launcher.
 */
export interface GtkXvfbPool {
  /**
   * Resource reuse mode.
   *
   * @remarks
   * 'xvfb' reuses only the Xvfb process. 'all' also reuses the DBus session,
   * launcher driver, and tray host, and can carry more state between launches.
   */
  readonly type: 'xvfb' | 'all';
  /**
   * Maximum idle sessions retained for each reusable condition.
   * Default is 1. 0 disables retaining idle sessions for the key being released.
   */
  readonly maxIdlePerKey?: number | undefined;
  /**
   * Maximum idle sessions retained across all reusable conditions.
   * Default is 4. 0 disables retaining idle sessions for the key being released.
   */
  readonly maxIdleTotal?: number | undefined;
}

/**
 * Options used when launching a GTK application.
 */
export interface LaunchGtkAppOptions {
  /**
   * Environment overrides passed to the child process.
   */
  readonly env?: GtkAppEnvironment | undefined;
  /**
   * Callback invoked for each stdout/stderr chunk produced by the application.
   */
  readonly onOutput?: ((event: GtkAppOutputEvent) => void) | undefined;
  /**
   * Maximum captured bytes retained per output stream.
   *
   * @remarks
   * Omit to retain complete stdout/stderr. 0 disables retained output text
   * while preserving truncation flags and onOutput notifications.
   */
  readonly outputBufferBytes?: number | undefined;
  /**
   * Timeout used by operations that wait for the application or elements.
   * Default is 10000msec (10sec).
   */
  readonly timeoutMs?: number | undefined;
}

/**
 * A launched GTK application controlled through AT-SPI.
 */
export interface GtkApp extends Releasable, GtkCapturable {
  /**
   * Captures the full X11 root window currently addressed by DISPLAY.
   *
   * @returns A promise that resolves to a PNG image for the full root window.
   * @remarks
   * When the app runs under gestament-xvfb, this captures the full Xvfb screen.
   * The capture bounds are the root window bounds, usually starting at 0,0.
   */
  readonly capture: () => Promise<GtkCapture>;

  /**
   * Reads the final environment used by the launched application.
   *
   * @returns A promise that resolves to a spawn-compatible environment object.
   * @remarks
   * When the app runs under gestament's internal Xvfb session, this includes
   * the actual DISPLAY and DBUS_SESSION_BUS_ADDRESS values for helper
   * processes that need to join the same session.
   */
  readonly environment: () => Promise<GtkAppEnvironment>;

  /**
   * Reads the retained stdout/stderr output for the launched application.
   *
   * @returns A promise that resolves to the current output snapshot.
   * @remarks
   * This is guaranteed only before release(). Use onOutput when output must be
   * retained after releasing the application or launcher.
   */
  readonly output: () => Promise<GtkAppOutput>;

  /**
   * Low-level keyboard and mouse input controller for this app's display session.
   *
   * @remarks
   * This controls the display session, not a specific widget. Activate or focus
   * the intended target before sending keyboard input.
   */
  readonly input: GtkInputController;

  /**
   * Waits for an accessible id and returns an element when it exists.
   *
   * @param id - Accessible id to resolve.
   * @returns A promise that resolves to the matching element, or undefined when it is not found before timeout.
   */
  readonly findById: (id: string) => Promise<GtkWidgetElement | undefined>;

  /**
   * Waits for an accessible id and rejects when it does not exist.
   *
   * @param id - Accessible id to resolve.
   * @returns A promise that resolves to the matching element.
   */
  readonly getById: (id: string) => Promise<GtkWidgetElement>;

  /**
   * Waits for an accessible path and returns an element when it exists.
   *
   * @param path - Accessible id followed by zero or more child indexes separated by `.`, `:`, `;`, or `,`.
   * @returns A promise that resolves to the matching element, or undefined when it is not found before timeout.
   * @remarks
   * For example, `main_window.0.2` resolves `getById('main_window')`,
   * then `childAt(0)`, then `childAt(2)`.
   */
  readonly findByPath: (path: string) => Promise<GtkWidgetElement | undefined>;

  /**
   * Waits for an accessible path and rejects when it does not exist.
   *
   * @param path - Accessible id followed by zero or more child indexes separated by `.`, `:`, `;`, or `,`.
   * @returns A promise that resolves to the matching element.
   * @remarks
   * For example, `main_window.0.2` resolves `getById('main_window')`,
   * then `childAt(0)`, then `childAt(2)`.
   */
  readonly getByPath: (path: string) => Promise<GtkWidgetElement>;

  /**
   * Resolves a top-level window by AT-SPI traversal order.
   *
   * @param index - Zero-based top-level window index.
   * @returns A promise that resolves to the window element, or undefined when no window exists at the index.
   */
  readonly windowAt: (index: number) => Promise<GtkWidgetElement | undefined>;

  /**
   * Counts top-level windows currently hosted by the application process.
   *
   * @returns A promise that resolves to the current top-level window count.
   */
  readonly getWindowCount: () => Promise<number>;

  /**
   * Waits for a StatusNotifier tray item and returns it when it exists.
   *
   * @param selector - Tray item selector used to match a StatusNotifier item.
   * @returns A promise that resolves to the matching tray item, or undefined when it is not found before timeout.
   */
  readonly findTrayItem: (
    selector: GtkTrayItemSelector
  ) => Promise<GtkTrayItem | undefined>;

  /**
   * Waits for a StatusNotifier tray item and rejects when it does not exist.
   *
   * @param selector - Tray item selector used to match a StatusNotifier item.
   * @returns A promise that resolves to the matching tray item.
   */
  readonly getTrayItem: (selector: GtkTrayItemSelector) => Promise<GtkTrayItem>;

  /**
   * Resolves a StatusNotifier tray item by current registration order.
   *
   * @param index - Zero-based StatusNotifier tray item index.
   * @returns A promise that resolves to the tray item, or undefined when no item exists at the index.
   */
  readonly trayItemAt: (index: number) => Promise<GtkTrayItem | undefined>;

  /**
   * Counts StatusNotifier tray items currently owned by the application.
   *
   * @returns A promise that resolves to the current tray item count.
   */
  readonly getTrayItemCount: () => Promise<number>;
}

/**
 * Options used by a reusable GTK application launcher.
 */
export interface GtkAppLauncherOptions {
  /**
   * Target GTK application path.
   */
  readonly appPath: string;
  /**
   * Base arguments passed to every launched application.
   */
  readonly args?: readonly string[] | undefined;
  /**
   * Environment overrides passed to every launched application.
   */
  readonly env?: GtkAppEnvironment | undefined;
  /**
   * Default maximum captured bytes retained per output stream for launched apps.
   *
   * @remarks
   * Omit to retain complete stdout/stderr. launch() options can override this
   * value for an individual application.
   */
  readonly outputBufferBytes?: number | undefined;
  /**
   * Callback invoked for each stdout/stderr chunk produced by launcher infrastructure.
   */
  readonly onSystemOutput?: ((event: GtkSystemOutputEvent) => void) | undefined;
  /**
   * Default maximum captured bytes retained per system output source stream.
   *
   * @remarks
   * Omit to retain complete infrastructure stdout/stderr for the launcher
   * lease. 0 disables retained output text while preserving truncation flags
   * and onSystemOutput notifications.
   */
  readonly systemOutputBufferBytes?: number | undefined;
  /**
   * Display environment used for launched GTK applications.
   * Default is 'xvfb'.
   *
   * @remarks
   * host uses the current DISPLAY or WAYLAND_DISPLAY. When neither exists,
   * host falls back to 'xvfb'.
   */
  readonly display?: GtkAppDisplay | undefined;
  /**
   * Xvfb screen geometry used when the effective display is xvfb.
   * Default is '1280x720x24'.
   */
  readonly xvfbScreen?: string | undefined;
  /**
   * Whether to run gestament's StatusNotifier tray host with Xvfb.
   * Default is true.
   */
  readonly xvfbTrayHost?: boolean | undefined;
  /**
   * Xvfb process pooling options used when the effective display is xvfb.
   * Default is undefined, which disables pooling.
   */
  readonly xvfbPool?: GtkXvfbPool | undefined;
  /**
   * GSettings backend passed to every launched application.
   * Default is 'memory'. null (NOT backend name) leaves GSETTINGS_BACKEND unset.
   * GSettings backend variations are 'memory', 'dconf', 'keyfile' and etc.
   */
  readonly gsettings?: string | null | undefined;
  /**
   * GTK theme passed to every launched application.
   * Default is 'Adwaita'. null leaves GTK_THEME unset.
   */
  readonly theme?: string | null | undefined;
  /**
   * Timeout used by operations that wait for the application or elements.
   * Default is 10000msec (10sec).
   */
  readonly timeoutMs?: number | undefined;
}

/**
 * Per-launch options used by a reusable GTK application launcher.
 */
export interface GtkAppLauncherLaunchOptions {
  /**
   * Callback invoked for each stdout/stderr chunk produced by this launch.
   */
  readonly onOutput?: ((event: GtkAppOutputEvent) => void) | undefined;

  /**
   * Maximum captured bytes retained per output stream for this launch.
   *
   * @remarks
   * Omit to use GtkAppLauncherOptions.outputBufferBytes.
   */
  readonly outputBufferBytes?: number | undefined;
}

/**
 * Reusable launcher that tracks and releases launched GTK applications.
 */
export interface GtkAppLauncher extends Releasable {
  /**
   * Reads the final environment that will be used for applications launched by this launcher.
   *
   * @returns A promise that resolves to a spawn-compatible environment object.
   * @remarks
   * Calling this may start the launcher's reusable display session so the
   * returned DISPLAY and DBUS_SESSION_BUS_ADDRESS values are concrete.
   */
  readonly environment: () => Promise<GtkAppEnvironment>;

  /**
   * Reads the retained infrastructure stdout/stderr output for the current or previous launcher lease.
   *
   * @returns A promise that resolves to the current system output snapshot.
   * @remarks
   * The snapshot remains available after release() until the next launcher
   * session starts, so output produced during release() can be inspected.
   */
  readonly systemOutput: () => Promise<GtkSystemOutput>;

  /**
   * Launches the configured GTK application and tracks it for release().
   *
   * @param args - Additional arguments appended to the configured base arguments.
   * @returns A promise that resolves to the launched application controller.
   */
  readonly launch: (
    args?: readonly string[],
    options?: GtkAppLauncherLaunchOptions
  ) => Promise<GtkApp>;
}
