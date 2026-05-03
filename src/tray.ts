// gestament - TypeScript based test driver for GTK.
// Copyright (c) Kouji Matsui. (@kekyo@mi.kekyo.net)
// Under MIT.
// https://github.com/kekyo/gestament

import {
  createGtkElementNotFoundError,
  createGtkStaleElementError,
  createGtkUnsupportedInterfaceError,
} from './errors';
import { createGtkElement } from './element';
import {
  nativeFindAnyById,
  nativeTrayItems,
  type NativeTrayItem,
} from './native';
import type {
  GtkCapture,
  GtkTrayItem,
  GtkTrayItemMetadata,
  GtkTrayItemSelector,
  GtkWidgetElement,
} from './types';

interface NativeTrayItemHandle {
  readonly processId: number;
  readonly busName: string;
  readonly objectPath: string;
}

const optionalString = (value: string): string | undefined =>
  value.length === 0 ? undefined : value;

const toMetadata = (item: NativeTrayItem): GtkTrayItemMetadata => {
  const iconName = optionalString(item.iconName);
  const id = optionalString(item.id);
  const status = optionalString(item.status);
  const title = optionalString(item.title);

  return {
    backend: 'status-notifier',
    ...(iconName === undefined ? {} : { iconName }),
    ...(id === undefined ? {} : { id }),
    ...(status === undefined ? {} : { status }),
    ...(title === undefined ? {} : { title }),
  };
};

const sameTrayItem = (
  first: NativeTrayItemHandle,
  second: NativeTrayItem
): boolean =>
  first.busName === second.busName && first.objectPath === second.objectPath;

const staleTrayItemError = (): Error =>
  createGtkStaleElementError('Tray item is no longer registered.');

const resolveCurrentInfo = (handle: NativeTrayItemHandle): NativeTrayItem => {
  const item = nativeTrayItems(handle.processId).find((candidate) =>
    sameTrayItem(handle, candidate)
  );
  if (item === undefined) {
    throw staleTrayItemError();
  }
  return item;
};

type GtkClickableElement = Extract<
  GtkWidgetElement,
  { readonly click: () => Promise<void> }
>;

const isClickableElement = (
  element: GtkWidgetElement
): element is GtkClickableElement => {
  switch (element.kind) {
    case 'button':
    case 'checkbox':
    case 'switch':
    case 'radio':
    case 'toggleButton':
    case 'comboBox':
    case 'listItem':
    case 'menuItem':
      return true;
    default:
      return false;
  }
};

/** Returns whether a native tray item matches a public selector. */
export const nativeTrayItemMatchesSelector = (
  item: NativeTrayItem,
  selector: GtkTrayItemSelector
): boolean => {
  if ('id' in selector) {
    return item.id === selector.id;
  }
  if ('title' in selector) {
    return item.title === selector.title;
  }
  if ('busName' in selector) {
    return (
      item.busName === selector.busName &&
      (selector.objectPath === undefined ||
        item.objectPath === selector.objectPath)
    );
  }
  return false;
};

/** Creates a stable logical tray item handle. */
export const createGtkTrayItem = (
  processId: number,
  item: NativeTrayItem
): GtkTrayItem => {
  const handle: NativeTrayItemHandle = {
    busName: item.busName,
    objectPath: item.objectPath,
    processId,
  };

  const trayItem: GtkTrayItem = {
    metadata: async (): Promise<GtkTrayItemMetadata> =>
      toMetadata(resolveCurrentInfo(handle)),
    element: async (): Promise<GtkWidgetElement | undefined> => {
      const current = resolveCurrentInfo(handle);
      const elementHandle = nativeFindAnyById(current.accessibleId);
      return elementHandle === undefined
        ? undefined
        : createGtkElement(elementHandle);
    },
    capture: async (): Promise<GtkCapture> => {
      const element = await trayItem.element();
      if (element === undefined) {
        throw createGtkElementNotFoundError(
          'Tray item is registered but not visible.'
        );
      }
      return element.capture();
    },
    click: async (): Promise<void> => {
      const element = await trayItem.element();
      if (element === undefined) {
        throw createGtkElementNotFoundError(
          'Tray item is registered but not visible.'
        );
      }
      if (!isClickableElement(element)) {
        throw createGtkUnsupportedInterfaceError(
          `Tray item element does not support click: ${element.kind}.`
        );
      }
      await element.click();
    },
    openMenu: async (): Promise<GtkWidgetElement | undefined> => {
      resolveCurrentInfo(handle);
      return undefined;
    },
  };

  return trayItem;
};
