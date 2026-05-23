// gestament - TypeScript based test driver for GTK.
// Copyright (c) Kouji Matsui. (@kekyo@mi.kekyo.net)
// Under MIT.
// https://github.com/kekyo/gestament

import { describe, expect, it } from 'vitest';

import type {
  GtkApp,
  GtkCapturable,
  GtkTableSelection,
  GtkButtonElement,
  GtkCapture,
  GtkComboBoxItemElement,
  GtkEntryElement,
  GtkLabelElement,
  GtkListItemElement,
  GtkElement,
  GtkElementInfo,
  GtkElementOfKind,
  GtkImageInfo,
  GtkMenuItemElement,
  GtkTableCellElement,
  GtkValueInfo,
  GtkWidgetElement,
} from '../src/types';

/////////////////////////////////////////////////////////////////////////////////////////

// NOTE: This code primarily verifies the validity of type definitions.
// For that reason, it might seem a little odd.

const expectType = <Expected>(_value: Expected): void => {
  // Type-only assertion helper.
};

const assertSpecializedOperations = async (
  element: GtkWidgetElement
): Promise<void> => {
  switch (element.kind) {
    case 'button':
      await element.click();
      // @ts-expect-error Button elements do not expose EditableText operations.
      await element.setText('ABC');
      break;
    case 'window':
      await element.activate();
      expectType<Promise<void>>(element.activate());
      expectType<Promise<GtkCapture>>(element.capture());
      expectType<number>((await element.bounds()).x);
      expectType<number>((await element.resizeHints()).baseWidth);
      expectType<string>((await element.x11Info()).windowId);
      await element.moveTo(0, 0);
      await element.resizeTo(100, 100);
      await element.setBounds({ height: 100, width: 100, x: 0, y: 0 });
      expectType<number>(
        (
          await element.setBounds({
            height: 100,
            width: 100,
            x: 0,
            y: 0,
          })
        ).height
      );
      // @ts-expect-error Window elements do not expose Text operations.
      await element.setText('ABC');
      break;
    case 'container':
      expectType<number>(await element.getChildCount());
      const genericChild: GtkWidgetElement | undefined =
        await element.childAt(0);
      if (genericChild !== undefined) {
        await assertSpecializedOperations(genericChild);
      }
      // @ts-expect-error Generic child containers do not expose Selection operations.
      await element.selectChildAt(0);
      break;
    case 'entry':
      await element.setText('ABC');
      expectType<string>(await element.text());
      // @ts-expect-error Entry elements do not expose Action operations.
      await element.click();
      break;
    case 'label':
      expectType<string>(await element.text());
      // @ts-expect-error Label elements do not expose EditableText operations.
      await element.setText('ABC');
      break;
    case 'checkbox':
    case 'switch':
    case 'radio':
    case 'toggleButton':
      await element.click();
      expectType<boolean>(await element.isChecked());
      await element.toggle();
      // @ts-expect-error Checkable elements do not expose Value operations.
      await element.value();
      break;
    case 'spinButton':
      expectType<number>(await element.value());
      expectType<GtkValueInfo>(await element.valueInfo());
      await element.setValue(3);
      await element.increment();
      await element.decrement();
      // @ts-expect-error Spin button elements do not expose Action operations.
      await element.click();
      break;
    case 'slider':
      expectType<number>(await element.value());
      expectType<GtkValueInfo>(await element.valueInfo());
      await element.setValue(30);
      // @ts-expect-error Slider elements do not expose spin step operations.
      await element.increment();
      break;
    case 'progressBar':
      expectType<number>(await element.value());
      expectType<GtkValueInfo>(await element.valueInfo());
      // @ts-expect-error Progress bar elements are read-only Value displays.
      await element.setValue(0.5);
      break;
    case 'comboBox':
      await element.click();
      expectType<number>(await element.getChildCount());
      expectType<number>(await element.getSelectedChildCount());
      await element.selectChildAt(1);
      const comboChild: GtkComboBoxItemElement | undefined =
        await element.childAt(0);
      if (comboChild !== undefined) {
        switch (comboChild.kind) {
          case 'listItem':
            await comboChild.click();
            break;
          case 'menuItem':
            await comboChild.click();
            break;
        }
        // @ts-expect-error Combo box items do not expose EditableText operations.
        await comboChild.setText('ABC');
      }
      const selectedComboChild: GtkComboBoxItemElement | undefined =
        await element.selectedChildAt(0);
      if (selectedComboChild !== undefined) {
        await selectedComboChild.click();
      }
      break;
    case 'list':
      expectType<number>(await element.getChildCount());
      expectType<number>(await element.getSelectedChildCount());
      await element.selectChildAt(1);
      const listItem: GtkListItemElement | undefined = await element.childAt(0);
      if (listItem !== undefined) {
        await listItem.click();
        // @ts-expect-error List items do not expose EditableText operations.
        await listItem.setText('ABC');
        // @ts-expect-error List items do not expose table cell lookup.
        await listItem.cellAt(0, 0);
      }
      break;
    case 'menu':
      expectType<number>(await element.getChildCount());
      const menuItem: GtkMenuItemElement | undefined = await element.childAt(0);
      if (menuItem !== undefined) {
        await menuItem.click();
      }
      // @ts-expect-error Menu elements do not expose Selection operations.
      await element.selectChildAt(0);
      break;
    case 'table':
      expectType<GtkTableSelection>(element);
      expectType<number>(await element.getRowCount());
      expectType<number>(await element.getColumnCount());
      expectType<readonly number[]>(await element.selectedRows());
      expectType<readonly number[]>(await element.selectedColumns());
      await element.selectRow(1);
      await element.selectColumn(1);
      const tableCell: GtkTableCellElement | undefined = await element.cellAt(
        0,
        0
      );
      if (tableCell !== undefined) {
        expectType<GtkCapture>(await tableCell.capture());
      }
      // @ts-expect-error Table elements expose cellAt instead of childAt.
      await element.childAt(0);
      break;
    case 'image':
      const imageInfo: GtkImageInfo = await element.imageInfo();
      expectType<GtkCapture>(await imageInfo.capture());
      // @ts-expect-error Image elements do not expose Value operations.
      await element.value();
      break;
    case 'listItem':
    case 'menuItem':
      await element.click();
      // @ts-expect-error Item elements do not expose Selection container operations.
      await element.selectChildAt(0);
      break;
    default:
      expectType<GtkCapture>(await element.capture());
      break;
  }
};

const assertBaseElementOperations = async (
  element: GtkElement
): Promise<void> => {
  expectType<GtkElementInfo>(await element.info());
  expectType<GtkCapture>(await element.capture());

  // @ts-expect-error Base elements expose common operations only.
  await element.childAt(0);
  // @ts-expect-error Base elements expose common operations only.
  await element.getChildCount();
  // @ts-expect-error Base elements expose common operations only.
  await element.click();
  // @ts-expect-error Base elements expose common operations only.
  await element.setText('ABC');
  // @ts-expect-error Base elements expose common operations only.
  await element.text();
  // @ts-expect-error Base elements expose common operations only.
  await element.value();
  // @ts-expect-error Base elements expose common operations only.
  await element.isChecked();
  // @ts-expect-error Base elements expose common operations only.
  await element.selectChildAt(0);
  // @ts-expect-error Base elements expose common operations only.
  await element.cellAt(0, 0);
};

const assertKindExtractor = async (
  button: GtkElementOfKind<'button'>,
  entry: GtkElementOfKind<'entry'>,
  label: GtkElementOfKind<'label'>
): Promise<void> => {
  const buttonElement: GtkButtonElement = button;
  const entryElement: GtkEntryElement = entry;
  const labelElement: GtkLabelElement = label;

  await buttonElement.click();
  await entryElement.setText('ABC');
  expectType<string>(await labelElement.text());
};

const assertAppOperations = async (app: GtkApp): Promise<void> => {
  expectType<GtkCapturable>(app);
  expectType<GtkCapture>(await app.capture());
  await app.input.setModifier('shift', true);
  await app.input.setModifier('shift', false);
  await app.input.pressKey('a');
  await app.input.pressKey(0x61);
  await app.input.moveMouseTo(0, 0);
  await app.input.setMouseButton('left', true);
  await app.input.setMouseButton('left', false);
  await app.input.scrollWheel(0, 1);
  const pathElement: GtkWidgetElement = await app.getByPath('main_window.0.0');
  const optionalPathElement: GtkWidgetElement | undefined =
    await app.findByPath('main_window.0.0');
  expectType<GtkWidgetElement>(pathElement);
  expectType<GtkWidgetElement | undefined>(optionalPathElement);

  // @ts-expect-error Apps do not expose element metadata operations.
  await app.info();
  // @ts-expect-error Apps do not expose element child traversal.
  await app.childAt(0);
  // @ts-expect-error Apps do not expose executable element actions.
  await app.click();
};

/////////////////////////////////////////////////////////////////////////////////////////

describe('GTK element types', () => {
  it('narrows specialized operations by widget kind', async () => {
    if (false) {
      await assertSpecializedOperations(
        undefined as unknown as GtkWidgetElement
      );
      await assertBaseElementOperations(undefined as unknown as GtkElement);
      await assertKindExtractor(
        undefined as unknown as GtkElementOfKind<'button'>,
        undefined as unknown as GtkElementOfKind<'entry'>,
        undefined as unknown as GtkElementOfKind<'label'>
      );
      await assertAppOperations(undefined as unknown as GtkApp);
    }

    expect(true).toBe(true);
  });
});
