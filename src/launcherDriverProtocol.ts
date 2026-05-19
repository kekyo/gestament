// gestament - TypeScript based test driver for GTK.
// Copyright (c) Kouji Matsui. (@kekyo@mi.kekyo.net)
// Under MIT.
// https://github.com/kekyo/gestament

import type {
  GtkAutomationErrorCode,
  GtkCaptureBounds,
  GtkImagePoint,
  GtkImageSize,
  GtkTrayItemSelector,
  GtkWidgetKind,
} from './types';

/////////////////////////////////////////////////////////////////////////////////////////

export type DriverCommand =
  | 'launcher.launch'
  | 'launcher.release'
  | 'launcher.reset'
  | 'app.release'
  | 'app.capture'
  | 'app.findById'
  | 'app.getById'
  | 'app.findByPath'
  | 'app.getByPath'
  | 'app.windowAt'
  | 'app.getWindowCount'
  | 'app.findTrayItem'
  | 'app.getTrayItem'
  | 'app.trayItemAt'
  | 'app.getTrayItemCount'
  | 'element.info'
  | 'element.capture'
  | 'element.childAt'
  | 'element.getChildCount'
  | 'element.click'
  | 'element.text'
  | 'element.setText'
  | 'element.isChecked'
  | 'element.toggle'
  | 'element.value'
  | 'element.valueInfo'
  | 'element.setValue'
  | 'element.increment'
  | 'element.decrement'
  | 'element.getSelectedChildCount'
  | 'element.selectedChildAt'
  | 'element.isChildSelected'
  | 'element.selectChildAt'
  | 'element.deselectChildAt'
  | 'element.selectAllChildren'
  | 'element.clearSelection'
  | 'element.getRowCount'
  | 'element.getColumnCount'
  | 'element.cellAt'
  | 'element.selectedRows'
  | 'element.selectedColumns'
  | 'element.isRowSelected'
  | 'element.isColumnSelected'
  | 'element.isCellSelected'
  | 'element.selectRow'
  | 'element.deselectRow'
  | 'element.selectColumn'
  | 'element.deselectColumn'
  | 'element.imageInfo'
  | 'imageInfo.capture'
  | 'tray.metadata'
  | 'tray.element'
  | 'tray.capture'
  | 'tray.click'
  | 'tray.openMenu';

export type WireGtkAppEnvironment = Readonly<Record<string, string | null>>;

export interface DriverLaunchPayload {
  readonly appPath: string;
  readonly args: readonly string[];
  readonly env: WireGtkAppEnvironment;
  readonly timeoutMs: number | null;
}

export interface DriverAppPayload {
  readonly appId: string;
}

export interface DriverElementPayload {
  readonly elementId: string;
}

export interface DriverTrayPayload {
  readonly trayItemId: string;
}

export interface DriverImageInfoPayload {
  readonly imageInfoId: string;
}

export interface DriverIndexPayload {
  readonly index: number;
}

export interface DriverSelectedIndexPayload {
  readonly selectedIndex: number;
}

export interface DriverTableCellPayload {
  readonly row: number;
  readonly column: number;
}

export interface DriverTextPayload {
  readonly text: string;
}

export interface DriverValuePayload {
  readonly value: number;
}

export interface DriverIdPayload {
  readonly id: string;
}

export interface DriverPathPayload {
  readonly path: string;
}

export interface DriverTraySelectorPayload {
  readonly selector: GtkTrayItemSelector;
}

export interface DriverReadyMessage {
  readonly type: 'ready';
}

export interface DriverRequest {
  readonly id: number;
  readonly command: DriverCommand;
  readonly payload: unknown;
}

export interface DriverSuccessResponse {
  readonly id: number;
  readonly ok: true;
  readonly value: unknown;
}

export interface DriverErrorResponse {
  readonly id: number;
  readonly ok: false;
  readonly error: SerializedDriverError;
}

export type DriverResponse = DriverSuccessResponse | DriverErrorResponse;

export interface SerializedDriverError {
  readonly code?: GtkAutomationErrorCode | string;
  readonly message: string;
  readonly name: string;
  readonly stack?: string;
}

export interface DriverElementRef {
  readonly elementId: string;
  readonly kind: GtkWidgetKind;
}

export interface DriverTrayItemRef {
  readonly trayItemId: string;
}

export interface DriverAppRef {
  readonly appId: string;
}

export interface WireCapture {
  readonly bounds: GtkCaptureBounds;
  readonly clipped: boolean;
  readonly imageBase64: string;
  readonly visibleBounds: GtkCaptureBounds;
}

export interface WireImageInfo {
  readonly bounds: GtkCaptureBounds;
  readonly description: string;
  readonly imageInfoId: string;
  readonly locale: string;
  readonly position: GtkImagePoint;
  readonly size: GtkImageSize;
}
