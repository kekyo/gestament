// gestament - TypeScript based test driver for GTK.
// Copyright (c) Kouji Matsui. (@kekyo@mi.kekyo.net)
// Under MIT.
// https://github.com/kekyo/gestament

import type {
  GtkAutomationErrorCode,
  GtkAppOutput,
  GtkAppOutputEvent,
  GtkCaptureBounds,
  GtkImagePoint,
  GtkImageSize,
  GtkKeyboardModifier,
  GtkMouseButton,
  GtkSystemOutputSource,
  GtkTrayItemSelector,
  GtkWidgetKind,
} from './types';

/////////////////////////////////////////////////////////////////////////////////////////

export type DriverCommand =
  | 'launcher.environment'
  | 'launcher.launch'
  | 'launcher.release'
  | 'launcher.reset'
  | 'app.environment'
  | 'app.output'
  | 'app.release'
  | 'app.capture'
  | 'app.findById'
  | 'app.getById'
  | 'app.findByPath'
  | 'app.getByPath'
  | 'app.windowAt'
  | 'app.getWindowCount'
  | 'app.inputSetModifier'
  | 'app.inputPressKeyName'
  | 'app.inputPressKeySym'
  | 'app.inputMoveMouse'
  | 'app.inputSetMouseButton'
  | 'app.inputScrollWheel'
  | 'app.findTrayItem'
  | 'app.getTrayItem'
  | 'app.trayItemAt'
  | 'app.getTrayItemCount'
  | 'element.info'
  | 'element.capture'
  | 'element.bounds'
  | 'element.childAt'
  | 'element.getChildCount'
  | 'element.click'
  | 'element.text'
  | 'element.setText'
  | 'element.isChecked'
  | 'element.toggle'
  | 'element.isSelected'
  | 'element.select'
  | 'element.isExpanded'
  | 'element.expand'
  | 'element.collapse'
  | 'element.isVisited'
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
  | 'window.moveTo'
  | 'window.resizeHints'
  | 'window.resizeTo'
  | 'window.setBounds'
  | 'window.activate'
  | 'window.x11Info'
  | 'imageInfo.capture'
  | 'tray.metadata'
  | 'tray.element'
  | 'tray.capture'
  | 'tray.click'
  | 'tray.openMenu';

export type WireGtkAppEnvironment = Readonly<Record<string, string | null>>;

export type DriverEventChannel = 'app.output' | 'system.output';

export interface DriverLaunchPayload {
  readonly appPath: string;
  readonly args: readonly string[];
  readonly env: WireGtkAppEnvironment;
  readonly outputBufferBytes: number | null;
  readonly outputScopeId: string | null;
  readonly timeoutMs: number | null;
}

export interface DriverEnvironmentPayload {
  readonly env: WireGtkAppEnvironment;
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

export interface DriverKeyboardModifierPayload {
  readonly modifier: GtkKeyboardModifier;
  readonly pressed: boolean;
}

export interface DriverKeyNamePayload {
  readonly key: string;
}

export interface DriverKeySymPayload {
  readonly keysym: number;
}

export interface DriverMouseMovePayload {
  readonly x: number;
  readonly y: number;
}

export interface DriverMouseButtonPayload {
  readonly button: GtkMouseButton;
  readonly pressed: boolean;
}

export interface DriverMouseWheelPayload {
  readonly xSteps: number;
  readonly ySteps: number;
}

export interface DriverWindowMovePayload {
  readonly x: number;
  readonly y: number;
}

export interface DriverWindowResizePayload {
  readonly height: number;
  readonly width: number;
}

export interface DriverWindowBoundsPayload {
  readonly bounds: GtkCaptureBounds;
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
  readonly deadlineMs?: number | null | undefined;
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

export interface DriverEventMessage {
  readonly channel: DriverEventChannel;
  readonly scopeId: string;
  readonly type: 'event';
  readonly value: unknown;
}

export type DriverMessage = DriverEventMessage | DriverResponse;

export interface SerializedDriverError {
  readonly code?: GtkAutomationErrorCode | string;
  readonly message: string;
  readonly name: string;
  readonly stack?: string;
}

export interface DriverElementRef {
  readonly elementId: string;
  readonly hasTableNavigation: boolean;
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

export type WireGtkAppOutputEvent = GtkAppOutputEvent;

export type WireGtkAppOutput = GtkAppOutput;

export type WireGtkSystemOutput =
  | {
      readonly chunkBase64: string;
      readonly source: GtkSystemOutputSource;
      readonly stream: 'stdout' | 'stderr';
      readonly type: 'chunk';
    }
  | {
      readonly source: GtkSystemOutputSource;
      readonly stream: 'stdout' | 'stderr';
      readonly type: 'flush';
    };

export interface WireImageInfo {
  readonly bounds: GtkCaptureBounds;
  readonly description: string;
  readonly imageInfoId: string;
  readonly locale: string;
  readonly position: GtkImagePoint;
  readonly size: GtkImageSize;
}
