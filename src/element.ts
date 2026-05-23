// gestament - TypeScript based test driver for GTK.
// Copyright (c) Kouji Matsui. (@kekyo@mi.kekyo.net)
// Under MIT.
// https://github.com/kekyo/gestament

import {
  nativeBounds,
  nativeCapture,
  nativeCaptureBounds,
  nativeChildAt,
  nativeChildCount,
  nativeClick,
  nativeClearSelection,
  nativeDeselectChildAt,
  nativeIsChildSelected,
  nativeElementInfo,
  nativeImageInfo,
  nativeMoveWindow,
  nativeResizeWindow,
  nativeSelectAllChildren,
  nativeSelectChildAt,
  nativeSelectedChildAt,
  nativeSelectedChildCount,
  nativeSetWindowBounds,
  nativeSetText,
  nativeSetValue,
  nativeResizeHints,
  nativeActivateWindow,
  nativeTableCellAt,
  nativeTableColumnCount,
  nativeTableDeselectColumn,
  nativeTableDeselectRow,
  nativeTableIsCellSelected,
  nativeTableIsColumnSelected,
  nativeTableIsRowSelected,
  nativeTableRowCount,
  nativeTableSelectColumn,
  nativeTableSelectRow,
  nativeTableSelectedColumns,
  nativeTableSelectedRows,
  nativeText,
  nativeValueInfo,
  nativeX11Info,
  type NativeElementInfo,
  type NativeElementHandle,
  type NativeImageInfo,
} from './native';
import {
  createGtkInvalidArgumentError,
  createGtkOperationFailedError,
  createGtkUnsupportedInterfaceError,
} from './errors';
import type {
  GtkCapture,
  GtkCaptureBounds,
  GtkComboBoxItemElement,
  GtkElement,
  GtkElementInfo,
  GtkImageInfo,
  GtkListItemElement,
  GtkMenuItemElement,
  GtkTableCellElement,
  GtkValueInfo,
  GtkWidgetElement,
  GtkWidgetKind,
  GtkWindowResizeHints,
  GtkX11WindowInfo,
} from './types';

/////////////////////////////////////////////////////////////////////////////////////////

const assertNonNegativeIndex = (name: string, index: number): void => {
  if (!Number.isInteger(index) || index < 0) {
    throw createGtkInvalidArgumentError(
      `${name} must be a non-negative integer.`
    );
  }
};

const assertFiniteNumber = (name: string, value: number): void => {
  if (!Number.isFinite(value)) {
    throw createGtkInvalidArgumentError(`${name} must be a finite number.`);
  }
};

const int32Min = -2147483648;
const int32Max = 2147483647;

const assertInt32 = (name: string, value: number): void => {
  if (!Number.isInteger(value) || value < int32Min || value > int32Max) {
    throw createGtkInvalidArgumentError(`${name} must be a 32-bit integer.`);
  }
};

const assertPositiveInt32 = (name: string, value: number): void => {
  assertInt32(name, value);
  if (value <= 0) {
    throw createGtkInvalidArgumentError(`${name} must be greater than zero.`);
  }
};

const normalizeRoleName = (roleName: string): string =>
  roleName.trim().toLowerCase().replace(/[_-]+/g, ' ').replace(/\s+/g, ' ');

const hasInterface = (info: NativeElementInfo, name: string): boolean =>
  info.interfaces.some(
    (interfaceName) => interfaceName.toLowerCase() === name.toLowerCase()
  );

const hasState = (info: NativeElementInfo, name: string): boolean =>
  info.states.some((state) => state.toLowerCase() === name.toLowerCase());

const elementInfoOverrides = new WeakMap<
  NativeElementHandle,
  Partial<GtkElementInfo>
>();

const overrideElementInfo = (
  handle: NativeElementHandle,
  override: Partial<GtkElementInfo>
): NativeElementHandle => {
  elementInfoOverrides.set(handle, override);
  return handle;
};

const nativeInfoKind = (handle: NativeElementHandle): GtkWidgetKind =>
  elementInfoOverrides.get(handle)?.kind ??
  widgetKindFromInfo(nativeElementInfo(handle));

const widgetKindFromInfo = (info: NativeElementInfo): GtkWidgetKind => {
  const roleName = normalizeRoleName(info.roleName);
  if (hasInterface(info, 'TableCell')) {
    return 'tableCell';
  }
  switch (roleName) {
    case 'frame':
    case 'dialog':
    case 'window':
      return 'window';
    case 'filler':
    case 'panel':
    case 'scroll pane':
    case 'layered pane':
    case 'split pane':
    case 'viewport':
      return 'container';
    case 'button':
    case 'push button':
    case 'push button menu':
      return 'button';
    case 'label':
    case 'static':
      return 'label';
    case 'entry':
    case 'password text':
    case 'search box':
      return 'entry';
    case 'text':
      return hasInterface(info, 'EditableText') ||
        hasState(info, 'editable') ||
        hasState(info, 'singleLine')
        ? 'entry'
        : 'text';
    case 'paragraph':
      return 'text';
    case 'check box':
      return 'checkbox';
    case 'switch':
      return 'switch';
    case 'radio button':
      return 'radio';
    case 'toggle button':
      return hasInterface(info, 'Image') || info.name.length > 0
        ? 'toggleButton'
        : 'switch';
    case 'slider':
      return 'slider';
    case 'spin button':
      return 'spinButton';
    case 'progress bar':
    case 'level bar':
      return 'progressBar';
    case 'combo box':
      return 'comboBox';
    case 'list':
    case 'list box':
      return 'list';
    case 'tree':
      return hasInterface(info, 'Table') ? 'table' : 'list';
    case 'list item':
    case 'tree item':
      return 'listItem';
    case 'table':
    case 'tree table':
      return 'table';
    case 'table cell':
      return 'tableCell';
    case 'image':
    case 'icon':
      return 'image';
    case 'menu':
    case 'menu bar':
    case 'popup menu':
      return 'menu';
    case 'menu item':
    case 'check menu item':
    case 'radio menu item':
    case 'tearoff menu item':
      return 'menuItem';
    default:
      return 'unknown';
  }
};

const toGtkElementInfo = (info: NativeElementInfo): GtkElementInfo => ({
  ...info,
  kind: widgetKindFromInfo(info),
});

const toGtkElementInfoForHandle = (
  handle: NativeElementHandle
): GtkElementInfo => {
  const info = toGtkElementInfo(nativeElementInfo(handle));
  const override = elementInfoOverrides.get(handle);
  return override === undefined ? info : { ...info, ...override };
};

type GtkElementCommon = Omit<GtkElement, 'kind'>;

const createCommonElement = (
  handle: NativeElementHandle
): GtkElementCommon => ({
  info: async (): Promise<GtkElementInfo> => toGtkElementInfoForHandle(handle),
  capture: async (): Promise<GtkCapture> => nativeCapture(handle),
});

const expectedKindLabel = (expectedKinds: readonly GtkWidgetKind[]): string =>
  expectedKinds.join(', ');

const assertExpectedKind = <Child extends GtkWidgetElement>(
  element: GtkWidgetElement,
  expectedKinds: readonly GtkWidgetKind[],
  operation: string
): Child => {
  if (!expectedKinds.includes(element.kind)) {
    throw createGtkUnsupportedInterfaceError(
      `${operation} returned ${element.kind}, expected ${expectedKindLabel(
        expectedKinds
      )}.`
    );
  }
  return element as Child;
};

const createGetChildCountOperation =
  (handle: NativeElementHandle): (() => Promise<number>) =>
  async (): Promise<number> =>
    nativeChildCount(handle);

const createChildAtOperation =
  <Child extends GtkWidgetElement>(
    handle: NativeElementHandle,
    expectedKinds: readonly GtkWidgetKind[] | undefined
  ): ((index: number) => Promise<Child | undefined>) =>
  async (index: number): Promise<Child | undefined> => {
    assertNonNegativeIndex('index', index);
    const childHandle = nativeChildAt(handle, index);
    if (childHandle === undefined) {
      return undefined;
    }

    const child = createGtkElement(childHandle);
    return expectedKinds === undefined
      ? (child as Child)
      : assertExpectedKind<Child>(child, expectedKinds, 'childAt()');
  };

const createChildContainerOperations = <Child extends GtkWidgetElement>(
  handle: NativeElementHandle,
  expectedKinds: readonly GtkWidgetKind[] | undefined
): {
  readonly childAt: (index: number) => Promise<Child | undefined>;
  readonly getChildCount: () => Promise<number>;
} => ({
  childAt: createChildAtOperation<Child>(handle, expectedKinds),
  getChildCount: createGetChildCountOperation(handle),
});

const createSelectableChildContainerOperations = <
  Child extends GtkWidgetElement,
>(
  handle: NativeElementHandle,
  expectedKinds: readonly GtkWidgetKind[]
): {
  readonly childAt: (index: number) => Promise<Child | undefined>;
  readonly getChildCount: () => Promise<number>;
  readonly getSelectedChildCount: () => Promise<number>;
  readonly selectedChildAt: (
    selectedIndex: number
  ) => Promise<Child | undefined>;
  readonly isChildSelected: (index: number) => Promise<boolean>;
  readonly selectChildAt: (index: number) => Promise<void>;
  readonly deselectChildAt: (index: number) => Promise<void>;
  readonly selectAllChildren: () => Promise<void>;
  readonly clearSelection: () => Promise<void>;
} => ({
  ...createChildContainerOperations<Child>(handle, expectedKinds),
  getSelectedChildCount: async (): Promise<number> =>
    nativeSelectedChildCount(handle),
  selectedChildAt: async (
    selectedIndex: number
  ): Promise<Child | undefined> => {
    assertNonNegativeIndex('selectedIndex', selectedIndex);
    const childHandle = nativeSelectedChildAt(handle, selectedIndex);
    if (childHandle === undefined) {
      return undefined;
    }

    const child = createGtkElement(childHandle);
    return assertExpectedKind<Child>(child, expectedKinds, 'selectedChildAt()');
  },
  isChildSelected: async (index: number): Promise<boolean> => {
    assertNonNegativeIndex('index', index);
    return nativeIsChildSelected(handle, index);
  },
  selectChildAt: async (index: number): Promise<void> => {
    assertNonNegativeIndex('index', index);
    nativeSelectChildAt(handle, index);
  },
  deselectChildAt: async (index: number): Promise<void> => {
    assertNonNegativeIndex('index', index);
    nativeDeselectChildAt(handle, index);
  },
  selectAllChildren: async (): Promise<void> => {
    nativeSelectAllChildren(handle);
  },
  clearSelection: async (): Promise<void> => {
    nativeClearSelection(handle);
  },
});

const createOperationFailedForOutOfRangeIndex = (index: number): Error =>
  createGtkOperationFailedError(`Child index is out of range: ${index}`);

const isUnsupportedInterfaceError = (error: unknown): boolean =>
  (error as { code?: unknown }).code === 'UNSUPPORTED_INTERFACE';

const visitNativeDescendants = (
  handle: NativeElementHandle,
  visitor: (descendantHandle: NativeElementHandle) => boolean,
  maxNodes: number
): void => {
  const queue: NativeElementHandle[] = [];
  const childCount = nativeChildCount(handle);
  for (let index = 0; index < childCount; index += 1) {
    const childHandle = nativeChildAt(handle, index);
    if (childHandle !== undefined) {
      queue.push(childHandle);
    }
  }

  let visitedNodes = 0;
  while (queue.length > 0 && visitedNodes < maxNodes) {
    const currentHandle = queue.shift()!;
    visitedNodes += 1;
    if (visitor(currentHandle)) {
      return;
    }

    const currentChildCount = nativeChildCount(currentHandle);
    for (let index = 0; index < currentChildCount; index += 1) {
      const childHandle = nativeChildAt(currentHandle, index);
      if (childHandle !== undefined) {
        queue.push(childHandle);
      }
    }
  }
};

const findFirstDescendantName = (
  handle: NativeElementHandle
): string | undefined => {
  let foundName: string | undefined;
  visitNativeDescendants(
    handle,
    (descendantHandle) => {
      const name = nativeElementInfo(descendantHandle).name;
      if (name.length === 0) {
        return false;
      }

      foundName = name;
      return true;
    },
    64
  );
  return foundName;
};

const directChildKindAt = (
  handle: NativeElementHandle,
  index: number
): GtkWidgetKind | undefined => {
  const childHandle = nativeChildAt(handle, index);
  return childHandle === undefined ? undefined : nativeInfoKind(childHandle);
};

const handleContainsComboItems = (handle: NativeElementHandle): boolean => {
  const childCount = nativeChildCount(handle);
  if (childCount === 0) {
    return false;
  }

  const firstChildKind = directChildKindAt(handle, 0);
  return firstChildKind === 'listItem' || firstChildKind === 'menuItem';
};

const findComboBoxItemContainerHandle = (
  handle: NativeElementHandle
): NativeElementHandle | undefined => {
  if (handleContainsComboItems(handle)) {
    return handle;
  }

  // GTK4 GtkDropDown exposes the expanded popup list as a nested descendant.
  let foundHandle: NativeElementHandle | undefined;
  visitNativeDescendants(
    handle,
    (descendantHandle) => {
      const kind = nativeInfoKind(descendantHandle);
      if (
        (kind === 'list' || kind === 'menu') &&
        handleContainsComboItems(descendantHandle)
      ) {
        foundHandle = descendantHandle;
        return true;
      }

      return false;
    },
    128
  );
  return foundHandle;
};

const resolveComboBoxItemContainerHandle = (
  handle: NativeElementHandle
): NativeElementHandle => {
  const descendantItemContainer = findComboBoxItemContainerHandle(handle);
  if (descendantItemContainer !== undefined) {
    return descendantItemContainer;
  }

  const childCount = nativeChildCount(handle);
  if (childCount !== 1) {
    return handle;
  }

  const childHandle = nativeChildAt(handle, 0);
  if (childHandle === undefined) {
    return handle;
  }

  const childKind = nativeInfoKind(childHandle);
  return childKind === 'menu' || childKind === 'list' ? childHandle : handle;
};

const comboBoxClickTargetHandle = (
  handle: NativeElementHandle
): NativeElementHandle => {
  const childHandle = nativeChildAt(handle, 0);
  if (childHandle === undefined) {
    return handle;
  }

  const childKind = nativeInfoKind(childHandle);
  return childKind === 'button' || childKind === 'toggleButton'
    ? childHandle
    : handle;
};

const overrideComboBoxItemInfo = (
  handle: NativeElementHandle
): NativeElementHandle => {
  const info = nativeElementInfo(handle);
  if (info.name.length > 0) {
    return handle;
  }

  const descendantName = findFirstDescendantName(handle);
  return descendantName === undefined
    ? handle
    : overrideElementInfo(handle, { name: descendantName });
};

const itemIdentityMatches = (
  candidate: GtkElementInfo,
  selected: GtkElementInfo
): boolean => {
  if (candidate.accessibleId.length > 0 && selected.accessibleId.length > 0) {
    return candidate.accessibleId === selected.accessibleId;
  }

  return (
    candidate.kind === selected.kind &&
    candidate.roleName === selected.roleName &&
    candidate.name === selected.name &&
    candidate.description === selected.description
  );
};

interface ComboBoxItemLookup {
  readonly itemContainerHandle: NativeElementHandle;
  readonly itemHandle: NativeElementHandle;
}

const comboBoxItemLookupAt = (
  handle: NativeElementHandle,
  index: number
): ComboBoxItemLookup => {
  const itemContainerHandle = resolveComboBoxItemContainerHandle(handle);
  const itemHandle = nativeChildAt(itemContainerHandle, index);
  if (itemHandle === undefined) {
    throw createOperationFailedForOutOfRangeIndex(index);
  }

  const itemKind = nativeInfoKind(itemHandle);
  if (itemKind !== 'listItem' && itemKind !== 'menuItem') {
    throw createGtkUnsupportedInterfaceError(
      `ComboBox childAt() returned ${itemKind}, expected listItem, menuItem.`
    );
  }

  return {
    itemContainerHandle,
    itemHandle: overrideComboBoxItemInfo(itemHandle),
  };
};

const comboBoxItemHandleAt = (
  handle: NativeElementHandle,
  index: number
): NativeElementHandle => comboBoxItemLookupAt(handle, index).itemHandle;

const createComboBoxOperations = (
  handle: NativeElementHandle
): {
  readonly childAt: (
    index: number
  ) => Promise<GtkComboBoxItemElement | undefined>;
  readonly getChildCount: () => Promise<number>;
  readonly getSelectedChildCount: () => Promise<number>;
  readonly selectedChildAt: (
    selectedIndex: number
  ) => Promise<GtkComboBoxItemElement | undefined>;
  readonly isChildSelected: (index: number) => Promise<boolean>;
  readonly selectChildAt: (index: number) => Promise<void>;
  readonly deselectChildAt: (index: number) => Promise<void>;
  readonly selectAllChildren: () => Promise<void>;
  readonly clearSelection: () => Promise<void>;
} => ({
  childAt: async (
    index: number
  ): Promise<GtkComboBoxItemElement | undefined> => {
    assertNonNegativeIndex('index', index);
    const itemContainerHandle = resolveComboBoxItemContainerHandle(handle);
    const itemHandle = nativeChildAt(itemContainerHandle, index);
    if (itemHandle === undefined) {
      return undefined;
    }

    overrideComboBoxItemInfo(itemHandle);
    return assertExpectedKind<GtkComboBoxItemElement>(
      createGtkElement(itemHandle),
      ['listItem', 'menuItem'],
      'childAt()'
    );
  },
  getChildCount: async (): Promise<number> =>
    nativeChildCount(resolveComboBoxItemContainerHandle(handle)),
  getSelectedChildCount: async (): Promise<number> =>
    nativeSelectedChildCount(handle),
  selectedChildAt: async (
    selectedIndex: number
  ): Promise<GtkComboBoxItemElement | undefined> => {
    assertNonNegativeIndex('selectedIndex', selectedIndex);
    const childHandle = nativeSelectedChildAt(handle, selectedIndex);
    if (childHandle === undefined) {
      return undefined;
    }

    return assertExpectedKind<GtkComboBoxItemElement>(
      createGtkElement(childHandle),
      ['listItem', 'menuItem'],
      'selectedChildAt()'
    );
  },
  isChildSelected: async (index: number): Promise<boolean> => {
    assertNonNegativeIndex('index', index);
    const itemHandle = comboBoxItemHandleAt(handle, index);
    const itemInfo = toGtkElementInfoForHandle(itemHandle);
    const selectedCount = nativeSelectedChildCount(handle);
    for (
      let selectedIndex = 0;
      selectedIndex < selectedCount;
      selectedIndex += 1
    ) {
      const selectedHandle = nativeSelectedChildAt(handle, selectedIndex);
      if (selectedHandle === undefined) {
        continue;
      }

      const selectedInfo = toGtkElementInfo(nativeElementInfo(selectedHandle));
      if (itemIdentityMatches(itemInfo, selectedInfo)) {
        return true;
      }
    }

    return false;
  },
  selectChildAt: async (index: number): Promise<void> => {
    assertNonNegativeIndex('index', index);
    const { itemContainerHandle, itemHandle } = comboBoxItemLookupAt(
      handle,
      index
    );
    const expectedName = toGtkElementInfoForHandle(itemHandle).name;
    nativeClick(itemHandle);
    if (
      itemContainerHandle !== handle &&
      expectedName.length > 0 &&
      nativeElementInfo(handle).name !== expectedName
    ) {
      throw createGtkOperationFailedError(
        'ComboBox child selection did not change the selected item.'
      );
    }
  },
  deselectChildAt: async (index: number): Promise<void> => {
    assertNonNegativeIndex('index', index);
    comboBoxItemHandleAt(handle, index);
    nativeDeselectChildAt(handle, 0);
  },
  selectAllChildren: async (): Promise<void> => {
    nativeSelectAllChildren(handle);
  },
  clearSelection: async (): Promise<void> => {
    const selectedBefore = nativeSelectedChildCount(handle);
    nativeClearSelection(handle);
    if (selectedBefore > 0 && nativeSelectedChildCount(handle) > 0) {
      throw createGtkOperationFailedError(
        'ComboBox selection could not be cleared.'
      );
    }
  },
});

const createSetTextOperation =
  (handle: NativeElementHandle): ((text: string) => Promise<void>) =>
  async (text: string): Promise<void> => {
    nativeSetText(handle, text);
  };

const createClickOperation =
  (handle: NativeElementHandle): (() => Promise<void>) =>
  async (): Promise<void> => {
    nativeClick(handle);
  };

const createComboBoxClickOperation =
  (handle: NativeElementHandle): (() => Promise<void>) =>
  async (): Promise<void> => {
    nativeClick(comboBoxClickTargetHandle(handle));
  };

const createTextOperation =
  (handle: NativeElementHandle): (() => Promise<string>) =>
  async (): Promise<string> =>
    nativeText(handle);

const createIsCheckedOperation =
  (handle: NativeElementHandle): (() => Promise<boolean>) =>
  async (): Promise<boolean> => {
    const info = nativeElementInfo(handle);
    return hasState(info, 'checked') || hasState(info, 'pressed');
  };

const createToggleOperation =
  (handle: NativeElementHandle): (() => Promise<void>) =>
  async (): Promise<void> => {
    nativeClick(handle);
  };

const createValueInfoOperation =
  (handle: NativeElementHandle): (() => Promise<GtkValueInfo>) =>
  async (): Promise<GtkValueInfo> =>
    nativeValueInfo(handle);

const createImageInfoOperation =
  (handle: NativeElementHandle): (() => Promise<GtkImageInfo>) =>
  async (): Promise<GtkImageInfo> => {
    const info: NativeImageInfo = nativeImageInfo(handle);
    return {
      ...info,
      capture: async (): Promise<GtkCapture> =>
        nativeCaptureBounds(info.bounds),
    };
  };

const createBoundsOperation =
  (handle: NativeElementHandle): (() => Promise<GtkCaptureBounds>) =>
  async (): Promise<GtkCaptureBounds> =>
    nativeBounds(handle);

const createMoveToOperation =
  (
    handle: NativeElementHandle
  ): ((x: number, y: number) => Promise<GtkCaptureBounds>) =>
  async (x: number, y: number): Promise<GtkCaptureBounds> => {
    assertInt32('x', x);
    assertInt32('y', y);
    return nativeMoveWindow(handle, x, y);
  };

const createResizeToOperation =
  (
    handle: NativeElementHandle
  ): ((width: number, height: number) => Promise<GtkCaptureBounds>) =>
  async (width: number, height: number): Promise<GtkCaptureBounds> => {
    assertPositiveInt32('width', width);
    assertPositiveInt32('height', height);
    return nativeResizeWindow(handle, width, height);
  };

const createSetBoundsOperation =
  (
    handle: NativeElementHandle
  ): ((bounds: GtkCaptureBounds) => Promise<GtkCaptureBounds>) =>
  async (bounds: GtkCaptureBounds): Promise<GtkCaptureBounds> => {
    if (typeof bounds !== 'object' || bounds === null) {
      throw createGtkInvalidArgumentError('bounds must be an object.');
    }
    assertInt32('bounds.x', bounds.x);
    assertInt32('bounds.y', bounds.y);
    assertPositiveInt32('bounds.width', bounds.width);
    assertPositiveInt32('bounds.height', bounds.height);
    return nativeSetWindowBounds(handle, bounds);
  };

const createActivateWindowOperation =
  (handle: NativeElementHandle): (() => Promise<void>) =>
  async (): Promise<void> => {
    nativeActivateWindow(handle);
  };

const createResizeHintsOperation =
  (handle: NativeElementHandle): (() => Promise<GtkWindowResizeHints>) =>
  async (): Promise<GtkWindowResizeHints> =>
    nativeResizeHints(handle);

const createX11InfoOperation =
  (handle: NativeElementHandle): (() => Promise<GtkX11WindowInfo>) =>
  async (): Promise<GtkX11WindowInfo> =>
    nativeX11Info(handle);

const createValueOperation =
  (handle: NativeElementHandle): (() => Promise<number>) =>
  async (): Promise<number> =>
    nativeValueInfo(handle).value;

const createSetValueOperation =
  (handle: NativeElementHandle): ((value: number) => Promise<void>) =>
  async (value: number): Promise<void> => {
    assertFiniteNumber('value', value);
    nativeSetValue(handle, value);
  };

const assertUsableValueMetadata = (info: GtkValueInfo): void => {
  if (
    !Number.isFinite(info.value) ||
    !Number.isFinite(info.minimum) ||
    !Number.isFinite(info.maximum) ||
    !Number.isFinite(info.minimumIncrement)
  ) {
    throw createGtkOperationFailedError(
      'Accessible value metadata does not contain usable numeric values.'
    );
  }
};

const valueStep = (info: GtkValueInfo): number => {
  assertUsableValueMetadata(info);
  if (info.minimumIncrement > 0) {
    return info.minimumIncrement;
  }

  const range = info.maximum - info.minimum;
  if (!Number.isFinite(range) || range <= 0) {
    throw createGtkOperationFailedError(
      'Accessible value metadata does not contain a usable increment.'
    );
  }
  return Math.min(1, range);
};

const clampedValue = (
  value: number,
  minimum: number,
  maximum: number
): number => Math.min(Math.max(value, minimum), maximum);

const createIncrementOperation =
  (handle: NativeElementHandle): (() => Promise<void>) =>
  async (): Promise<void> => {
    const info = nativeValueInfo(handle);
    const step = valueStep(info);
    nativeSetValue(
      handle,
      clampedValue(info.value + step, info.minimum, info.maximum)
    );
  };

const createDecrementOperation =
  (handle: NativeElementHandle): (() => Promise<void>) =>
  async (): Promise<void> => {
    const info = nativeValueInfo(handle);
    const step = valueStep(info);
    nativeSetValue(
      handle,
      clampedValue(info.value - step, info.minimum, info.maximum)
    );
  };

const collectDirectTableCellChildren = (
  rowHandle: NativeElementHandle
): NativeElementHandle[] => {
  const cells: NativeElementHandle[] = [];
  const childCount = nativeChildCount(rowHandle);
  for (let index = 0; index < childCount; index += 1) {
    const childHandle = nativeChildAt(rowHandle, index);
    if (
      childHandle !== undefined &&
      nativeInfoKind(childHandle) === 'tableCell'
    ) {
      cells.push(childHandle);
    }
  }
  return cells;
};

const collectFallbackTableRows = (
  handle: NativeElementHandle
): NativeElementHandle[][] => {
  const rows: NativeElementHandle[][] = [];
  // GTK4 GtkColumnView exposes table rows and cells without the AT-SPI Table
  // interface, so table operations reconstruct the logical grid from children.
  visitNativeDescendants(
    handle,
    (descendantHandle) => {
      const roleName = normalizeRoleName(
        nativeElementInfo(descendantHandle).roleName
      );
      if (roleName !== 'table row') {
        return false;
      }

      const cells = collectDirectTableCellChildren(descendantHandle);
      if (cells.length > 0) {
        rows.push(
          cells.map((cellHandle) =>
            overrideElementInfo(cellHandle, { kind: 'tableCell' })
          )
        );
      }
      return false;
    },
    512
  );
  return rows;
};

const fallbackTableRowCount = (handle: NativeElementHandle): number =>
  collectFallbackTableRows(handle).length;

const fallbackTableColumnCount = (handle: NativeElementHandle): number => {
  const rows = collectFallbackTableRows(handle);
  return rows.reduce((max, row) => Math.max(max, row.length), 0);
};

const fallbackTableCellAt = (
  handle: NativeElementHandle,
  row: number,
  column: number
): NativeElementHandle | undefined => {
  const rows = collectFallbackTableRows(handle);
  return rows[row]?.[column];
};

const createTableCellAtOperation =
  (
    handle: NativeElementHandle
  ): ((
    row: number,
    column: number
  ) => Promise<GtkTableCellElement | undefined>) =>
  async (
    row: number,
    column: number
  ): Promise<GtkTableCellElement | undefined> => {
    assertNonNegativeIndex('row', row);
    assertNonNegativeIndex('column', column);
    let cellHandle: NativeElementHandle | undefined;
    try {
      cellHandle = nativeTableCellAt(handle, row, column);
    } catch (error) {
      if (!isUnsupportedInterfaceError(error)) {
        throw error;
      }

      cellHandle = fallbackTableCellAt(handle, row, column);
    }

    if (cellHandle === undefined) {
      return undefined;
    }

    overrideElementInfo(cellHandle, { kind: 'tableCell' });
    return assertExpectedKind<GtkTableCellElement>(
      createGtkElement(cellHandle),
      ['tableCell'],
      'cellAt()'
    );
  };

const createTableOperations = (
  handle: NativeElementHandle
): {
  readonly getRowCount: () => Promise<number>;
  readonly getColumnCount: () => Promise<number>;
  readonly cellAt: (
    row: number,
    column: number
  ) => Promise<GtkTableCellElement | undefined>;
  readonly selectedRows: () => Promise<readonly number[]>;
  readonly selectedColumns: () => Promise<readonly number[]>;
  readonly isRowSelected: (row: number) => Promise<boolean>;
  readonly isColumnSelected: (column: number) => Promise<boolean>;
  readonly isCellSelected: (row: number, column: number) => Promise<boolean>;
  readonly selectRow: (row: number) => Promise<void>;
  readonly deselectRow: (row: number) => Promise<void>;
  readonly selectColumn: (column: number) => Promise<void>;
  readonly deselectColumn: (column: number) => Promise<void>;
} => ({
  getRowCount: async (): Promise<number> => {
    try {
      return nativeTableRowCount(handle);
    } catch (error) {
      if (!isUnsupportedInterfaceError(error)) {
        throw error;
      }
      return fallbackTableRowCount(handle);
    }
  },
  getColumnCount: async (): Promise<number> => {
    try {
      return nativeTableColumnCount(handle);
    } catch (error) {
      if (!isUnsupportedInterfaceError(error)) {
        throw error;
      }
      return fallbackTableColumnCount(handle);
    }
  },
  cellAt: createTableCellAtOperation(handle),
  selectedRows: async (): Promise<readonly number[]> =>
    nativeTableSelectedRows(handle),
  selectedColumns: async (): Promise<readonly number[]> =>
    nativeTableSelectedColumns(handle),
  isRowSelected: async (row: number): Promise<boolean> => {
    assertNonNegativeIndex('row', row);
    return nativeTableIsRowSelected(handle, row);
  },
  isColumnSelected: async (column: number): Promise<boolean> => {
    assertNonNegativeIndex('column', column);
    return nativeTableIsColumnSelected(handle, column);
  },
  isCellSelected: async (row: number, column: number): Promise<boolean> => {
    assertNonNegativeIndex('row', row);
    assertNonNegativeIndex('column', column);
    return nativeTableIsCellSelected(handle, row, column);
  },
  selectRow: async (row: number): Promise<void> => {
    assertNonNegativeIndex('row', row);
    nativeTableSelectRow(handle, row);
  },
  deselectRow: async (row: number): Promise<void> => {
    assertNonNegativeIndex('row', row);
    nativeTableDeselectRow(handle, row);
  },
  selectColumn: async (column: number): Promise<void> => {
    assertNonNegativeIndex('column', column);
    nativeTableSelectColumn(handle, column);
  },
  deselectColumn: async (column: number): Promise<void> => {
    assertNonNegativeIndex('column', column);
    nativeTableDeselectColumn(handle, column);
  },
});

/** Creates an element bound to an opaque native accessible handle. */
export const createGtkElement = (
  handle: NativeElementHandle
): GtkWidgetElement => {
  const initialInfo = toGtkElementInfoForHandle(handle);
  const common = createCommonElement(handle);

  switch (initialInfo.kind) {
    case 'window':
      return {
        ...common,
        kind: 'window',
        bounds: createBoundsOperation(handle),
        moveTo: createMoveToOperation(handle),
        ...createChildContainerOperations<GtkWidgetElement>(handle, undefined),
        resizeTo: createResizeToOperation(handle),
        setBounds: createSetBoundsOperation(handle),
        activate: createActivateWindowOperation(handle),
        resizeHints: createResizeHintsOperation(handle),
        x11Info: createX11InfoOperation(handle),
      };
    case 'button':
      return { ...common, kind: 'button', click: createClickOperation(handle) };
    case 'container':
      return {
        ...common,
        kind: 'container',
        ...createChildContainerOperations<GtkWidgetElement>(handle, undefined),
      };
    case 'label':
      return { ...common, kind: 'label', text: createTextOperation(handle) };
    case 'entry':
      return {
        ...common,
        kind: 'entry',
        setText: createSetTextOperation(handle),
        text: createTextOperation(handle),
      };
    case 'text':
      return { ...common, kind: 'text', text: createTextOperation(handle) };
    case 'checkbox':
      return {
        ...common,
        kind: 'checkbox',
        click: createClickOperation(handle),
        isChecked: createIsCheckedOperation(handle),
        toggle: createToggleOperation(handle),
      };
    case 'switch':
      return {
        ...common,
        kind: 'switch',
        click: createClickOperation(handle),
        isChecked: createIsCheckedOperation(handle),
        toggle: createToggleOperation(handle),
      };
    case 'radio':
      return {
        ...common,
        kind: 'radio',
        click: createClickOperation(handle),
        isChecked: createIsCheckedOperation(handle),
        toggle: createToggleOperation(handle),
      };
    case 'toggleButton':
      return {
        ...common,
        kind: 'toggleButton',
        click: createClickOperation(handle),
        isChecked: createIsCheckedOperation(handle),
        toggle: createToggleOperation(handle),
      };
    case 'slider':
      return {
        ...common,
        kind: 'slider',
        value: createValueOperation(handle),
        valueInfo: createValueInfoOperation(handle),
        setValue: createSetValueOperation(handle),
      };
    case 'spinButton':
      return {
        ...common,
        kind: 'spinButton',
        value: createValueOperation(handle),
        valueInfo: createValueInfoOperation(handle),
        setValue: createSetValueOperation(handle),
        increment: createIncrementOperation(handle),
        decrement: createDecrementOperation(handle),
      };
    case 'progressBar':
      return {
        ...common,
        kind: 'progressBar',
        value: createValueOperation(handle),
        valueInfo: createValueInfoOperation(handle),
      };
    case 'comboBox':
      return {
        ...common,
        kind: 'comboBox',
        click: createComboBoxClickOperation(handle),
        ...createComboBoxOperations(handle),
      };
    case 'list':
      return {
        ...common,
        kind: 'list',
        ...createSelectableChildContainerOperations<GtkListItemElement>(
          handle,
          ['listItem']
        ),
      };
    case 'listItem':
      return {
        ...common,
        kind: 'listItem',
        click: createClickOperation(handle),
      };
    case 'table':
      return { ...common, kind: 'table', ...createTableOperations(handle) };
    case 'tableCell':
      return { ...common, kind: 'tableCell' };
    case 'image':
      return {
        ...common,
        kind: 'image',
        imageInfo: createImageInfoOperation(handle),
      };
    case 'menu':
      return {
        ...common,
        kind: 'menu',
        ...createChildContainerOperations<GtkMenuItemElement>(handle, [
          'menuItem',
        ]),
      };
    case 'menuItem':
      return {
        ...common,
        kind: 'menuItem',
        click: createClickOperation(handle),
      };
    case 'unknown':
      return { ...common, kind: 'unknown' };
  }
};
