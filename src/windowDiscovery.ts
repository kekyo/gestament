// gestament - TypeScript based test driver for GTK.
// Copyright (c) Kouji Matsui. (@kekyo@mi.kekyo.net)
// Under MIT.
// https://github.com/kekyo/gestament

import { normalizeNativeError } from './errors';
import {
  nativeBounds,
  nativeElementInfo,
  nativeWindowAt,
  nativeWindowCount,
  nativeX11Info,
  nativeX11WindowSnapshots,
  type NativeCaptureBounds,
  type NativeElementHandle,
  type NativeX11WindowSnapshot,
} from './native';
import type {
  GtkAutomationError,
  GtkCaptureBounds,
  GtkWindowBackend,
  GtkWindowBackendStatus,
  GtkWindowDiscoveryAtspiSnapshot,
  GtkWindowDiscoveryDiagnostics,
  GtkWindowDiscoveryMergeCandidate,
  GtkWindowDiscoveryX11Snapshot,
  GtkWindowDebugDiagnostics,
} from './types';

/////////////////////////////////////////////////////////////////////////////////////////

export interface AtspiWindowSnapshot {
  readonly source: 'at-spi';
  readonly handle: NativeElementHandle;
  readonly index: number;
  readonly processId: number;
  readonly roleName: string;
  readonly name: string;
  readonly accessibleId: string;
  readonly bounds: GtkCaptureBounds | null;
  readonly x11WindowId: string | null;
}

export interface X11WindowSnapshot {
  readonly source: 'x11';
  readonly windowId: string;
  readonly title: string;
  readonly className: string;
  readonly instanceName: string;
  readonly transientFor: string | null;
  readonly processId: number | null;
  readonly bounds: GtkCaptureBounds;
  readonly normalHints: NativeX11WindowSnapshot['normalHints'];
  readonly hasNormalHints: boolean;
  readonly stackingOrder: number;
  readonly active: boolean;
}

export interface UnifiedNativeWindow {
  readonly atspi: AtspiWindowSnapshot | null;
  readonly x11: X11WindowSnapshot | null;
  readonly title: string;
  readonly name: string;
  readonly roleName: string;
  readonly processId: number | null;
  readonly bounds: GtkCaptureBounds | null;
  readonly sortIndex: number;
  readonly debugDiagnostics: GtkWindowDebugDiagnostics;
}

export interface NativeWindowDiscoveryResult {
  readonly windows: readonly UnifiedNativeWindow[];
  readonly backendStatus: readonly GtkWindowBackendStatus[];
}

export interface WindowBackendCollection<Snapshot> {
  readonly snapshots: readonly Snapshot[];
  readonly status: GtkWindowBackendStatus;
}

interface WindowMergeMatch {
  readonly index: number;
  readonly confidence: number;
  readonly matchedBy: string;
}

interface WindowMergeDecision {
  readonly confidence: number | null;
  readonly matchedBy: string | null;
  readonly rejectionReason: string | null;
}

interface AcceptedWindowMerge {
  readonly atspiIndex: number;
  readonly x11Index: number;
}

const knownBackends: readonly GtkWindowBackend[] = ['at-spi', 'x11'];
const atspiOnlyConfidence = 0.6;
const x11OnlyConfidence = 0.6;
const minimumMergeConfidence = 0.7;
const maximumCenterDistance = 48;
const minimumOverlapRatio = 0.5;
const sameConfidenceEpsilon = 0.000_001;

const normalizeRoleName = (value: string): string =>
  value.trim().toLowerCase().replace(/[_-]+/g, ' ').replace(/\s+/g, ' ');

const nativeErrorMessage = (error: unknown): string => {
  const normalized = normalizeNativeError(error) as GtkAutomationError;
  return `${normalized.code}: ${normalized.message}`;
};

const backendStatus = (
  backend: GtkWindowBackend,
  available: boolean,
  windowCount: number | null,
  message: string | null
): GtkWindowBackendStatus => ({
  backend,
  available,
  windowCount,
  message,
});

const boundsArea = (bounds: GtkCaptureBounds): number =>
  bounds.width * bounds.height;

const intersectionArea = (
  first: GtkCaptureBounds,
  second: GtkCaptureBounds
): number => {
  const left = Math.max(first.x, second.x);
  const top = Math.max(first.y, second.y);
  const right = Math.min(first.x + first.width, second.x + second.width);
  const bottom = Math.min(first.y + first.height, second.y + second.height);
  return Math.max(0, right - left) * Math.max(0, bottom - top);
};

const boundsOverlapRatio = (
  first: GtkCaptureBounds,
  second: GtkCaptureBounds
): number => {
  const smallerArea = Math.min(boundsArea(first), boundsArea(second));
  return smallerArea <= 0 ? 0 : intersectionArea(first, second) / smallerArea;
};

const centerDistance = (
  first: GtkCaptureBounds,
  second: GtkCaptureBounds
): number => {
  const firstX = first.x + first.width / 2;
  const firstY = first.y + first.height / 2;
  const secondX = second.x + second.width / 2;
  const secondY = second.y + second.height / 2;
  return Math.hypot(firstX - secondX, firstY - secondY);
};

const titlesMatch = (
  atspi: AtspiWindowSnapshot,
  x11: X11WindowSnapshot
): boolean => atspi.name.length > 0 && atspi.name === x11.title;

const processIdsMatch = (
  atspi: AtspiWindowSnapshot,
  x11: X11WindowSnapshot
): boolean => x11.processId !== null && atspi.processId === x11.processId;

const processIdsCompatible = (
  atspi: AtspiWindowSnapshot,
  x11: X11WindowSnapshot
): boolean => x11.processId === null || atspi.processId === x11.processId;

const boundsOverlapEnough = (
  atspi: AtspiWindowSnapshot,
  x11: X11WindowSnapshot
): boolean =>
  atspi.bounds !== null &&
  boundsOverlapRatio(atspi.bounds, x11.bounds) >= minimumOverlapRatio;

const roleCanRepresentWindow = (roleName: string): boolean => {
  const normalized = normalizeRoleName(roleName);
  return (
    normalized === 'frame' ||
    normalized === 'window' ||
    normalized === 'dialog' ||
    normalized === 'alert dialog'
  );
};

const matchAtspiToX11 = (
  atspi: AtspiWindowSnapshot,
  x11: X11WindowSnapshot
): Omit<WindowMergeMatch, 'index'> | undefined => {
  if (
    atspi.x11WindowId !== null &&
    atspi.x11WindowId === x11.windowId &&
    processIdsCompatible(atspi, x11) &&
    boundsOverlapEnough(atspi, x11)
  ) {
    return {
      confidence: 0.98,
      matchedBy: 'resolved-x11-window',
    };
  }

  if (
    processIdsMatch(atspi, x11) &&
    titlesMatch(atspi, x11) &&
    boundsOverlapEnough(atspi, x11)
  ) {
    return {
      confidence: 0.92,
      matchedBy: 'pid-title-bounds-overlap',
    };
  }

  if (
    processIdsMatch(atspi, x11) &&
    (titlesMatch(atspi, x11) || roleCanRepresentWindow(atspi.roleName)) &&
    atspi.bounds !== null &&
    centerDistance(atspi.bounds, x11.bounds) <= maximumCenterDistance
  ) {
    return {
      confidence: 0.82,
      matchedBy: 'pid-role-title-center-proximity',
    };
  }

  if (titlesMatch(atspi, x11) && x11.transientFor !== null) {
    return {
      confidence: 0.72,
      matchedBy: 'title-transient-relation',
    };
  }

  return undefined;
};

const explainRejectedAtspiToX11 = (
  atspi: AtspiWindowSnapshot,
  x11: X11WindowSnapshot
): string => {
  if (!processIdsCompatible(atspi, x11)) {
    return 'process-id-mismatch';
  }
  if (atspi.bounds === null) {
    return 'missing-atspi-bounds';
  }
  if (
    atspi.x11WindowId !== null &&
    atspi.x11WindowId !== x11.windowId &&
    processIdsMatch(atspi, x11)
  ) {
    return 'resolved-x11-window-mismatch';
  }
  if (!boundsOverlapEnough(atspi, x11)) {
    return 'bounds-overlap-too-small';
  }
  if (!titlesMatch(atspi, x11) && !roleCanRepresentWindow(atspi.roleName)) {
    return 'title-and-role-mismatch';
  }
  if (centerDistance(atspi.bounds, x11.bounds) > maximumCenterDistance) {
    return 'center-distance-too-large';
  }
  return 'below-merge-threshold';
};

const evaluateAtspiToX11 = (
  atspi: AtspiWindowSnapshot,
  x11: X11WindowSnapshot
): WindowMergeDecision => {
  const match = matchAtspiToX11(atspi, x11);
  if (match === undefined) {
    return {
      confidence: null,
      matchedBy: null,
      rejectionReason: explainRejectedAtspiToX11(atspi, x11),
    };
  }
  if (match.confidence < minimumMergeConfidence) {
    return {
      confidence: match.confidence,
      matchedBy: match.matchedBy,
      rejectionReason: 'below-merge-threshold',
    };
  }
  return {
    confidence: match.confidence,
    matchedBy: match.matchedBy,
    rejectionReason: null,
  };
};

const findBestX11Match = (
  atspi: AtspiWindowSnapshot,
  x11Snapshots: readonly X11WindowSnapshot[],
  usedX11Indexes: ReadonlySet<number>
): WindowMergeMatch | undefined => {
  let best: WindowMergeMatch | undefined;
  let ambiguous = false;
  for (let index = 0; index < x11Snapshots.length; index += 1) {
    if (usedX11Indexes.has(index)) {
      continue;
    }

    const x11 = x11Snapshots[index];
    if (x11 === undefined) {
      continue;
    }

    const match = matchAtspiToX11(atspi, x11);
    if (match === undefined || match.confidence < minimumMergeConfidence) {
      continue;
    }

    if (best === undefined || match.confidence > best.confidence) {
      best = {
        index,
        confidence: match.confidence,
        matchedBy: match.matchedBy,
      };
      ambiguous = false;
      continue;
    }

    if (Math.abs(match.confidence - best.confidence) <= sameConfidenceEpsilon) {
      ambiguous = true;
    }
  }
  return ambiguous ? undefined : best;
};

const mergedTitle = (
  atspi: AtspiWindowSnapshot | null,
  x11: X11WindowSnapshot | null
): string => x11?.title ?? atspi?.name ?? '';

const mergedName = (
  atspi: AtspiWindowSnapshot | null,
  x11: X11WindowSnapshot | null
): string => atspi?.name ?? x11?.title ?? '';

const mergedRoleName = (atspi: AtspiWindowSnapshot | null): string =>
  atspi?.roleName ?? 'window';

const mergedProcessId = (
  atspi: AtspiWindowSnapshot | null,
  x11: X11WindowSnapshot | null
): number | null => atspi?.processId ?? x11?.processId ?? null;

const mergedBounds = (
  atspi: AtspiWindowSnapshot | null,
  x11: X11WindowSnapshot | null
): GtkCaptureBounds | null => x11?.bounds ?? atspi?.bounds ?? null;

const unifiedSortIndex = (
  atspi: AtspiWindowSnapshot | null,
  x11: X11WindowSnapshot | null
): number => atspi?.index ?? 100_000 + (x11?.stackingOrder ?? 0);

const sourceList = (
  atspi: AtspiWindowSnapshot | null,
  x11: X11WindowSnapshot | null
): readonly GtkWindowBackend[] => [
  ...(atspi === null ? [] : (['at-spi'] as const)),
  ...(x11 === null ? [] : (['x11'] as const)),
];

const createDebugDiagnostics = (
  atspi: AtspiWindowSnapshot | null,
  x11: X11WindowSnapshot | null,
  statuses: readonly GtkWindowBackendStatus[],
  mergeConfidence: number,
  matchedBy: string,
  discovery: GtkWindowDiscoveryDiagnostics
): GtkWindowDebugDiagnostics => {
  const seenBy = sourceList(atspi, x11);
  const missingFrom = knownBackends.filter(
    (backend) =>
      !seenBy.includes(backend) &&
      statuses.some((status) => status.backend === backend && status.available)
  );

  return {
    seenBy,
    missingFrom,
    mergeConfidence,
    matchedBy,
    backendStatus: statuses,
    rawIds: {
      atspi:
        atspi?.accessibleId.length === 0 ? null : (atspi?.accessibleId ?? null),
      x11: x11?.windowId ?? null,
    },
    discovery,
  };
};

const toAtspiDiscoverySnapshot = (
  snapshot: AtspiWindowSnapshot
): GtkWindowDiscoveryAtspiSnapshot => ({
  accessibleId:
    snapshot.accessibleId.length === 0 ? null : snapshot.accessibleId,
  bounds: snapshot.bounds,
  index: snapshot.index,
  name: snapshot.name,
  processId: snapshot.processId,
  roleName: snapshot.roleName,
  x11WindowId: snapshot.x11WindowId,
});

const toX11DiscoverySnapshot = (
  snapshot: X11WindowSnapshot
): GtkWindowDiscoveryX11Snapshot => ({
  active: snapshot.active,
  bounds: snapshot.bounds,
  className: snapshot.className,
  instanceName: snapshot.instanceName,
  processId: snapshot.processId,
  stackingOrder: snapshot.stackingOrder,
  title: snapshot.title,
  transientFor: snapshot.transientFor,
  windowId: snapshot.windowId,
});

const createDiscoveryDiagnostics = (
  atspiSnapshots: readonly AtspiWindowSnapshot[],
  x11Snapshots: readonly X11WindowSnapshot[],
  acceptedMerges: readonly AcceptedWindowMerge[]
): GtkWindowDiscoveryDiagnostics => {
  const acceptedKeys = new Set(
    acceptedMerges.map((merge) => `${merge.atspiIndex}:${merge.x11Index}`)
  );
  const mergeCandidates: GtkWindowDiscoveryMergeCandidate[] = [];
  for (
    let atspiIndex = 0;
    atspiIndex < atspiSnapshots.length;
    atspiIndex += 1
  ) {
    const atspi = atspiSnapshots[atspiIndex];
    if (atspi === undefined) {
      continue;
    }
    for (let x11Index = 0; x11Index < x11Snapshots.length; x11Index += 1) {
      const x11 = x11Snapshots[x11Index];
      if (x11 === undefined) {
        continue;
      }

      const decision = evaluateAtspiToX11(atspi, x11);
      const accepted = acceptedKeys.has(`${atspi.index}:${x11Index}`);
      mergeCandidates.push({
        accepted,
        atspiAccessibleId:
          atspi.accessibleId.length === 0 ? null : atspi.accessibleId,
        atspiIndex: atspi.index,
        confidence: decision.confidence,
        matchedBy: decision.matchedBy,
        rejectionReason: accepted
          ? null
          : (decision.rejectionReason ?? 'not-selected'),
        x11WindowId: x11.windowId,
      });
    }
  }

  return {
    atspiSnapshots: atspiSnapshots.map(toAtspiDiscoverySnapshot),
    mergeCandidates,
    x11Snapshots: x11Snapshots.map(toX11DiscoverySnapshot),
  };
};

const emptyDiscoveryDiagnostics = (): GtkWindowDiscoveryDiagnostics => ({
  atspiSnapshots: [],
  mergeCandidates: [],
  x11Snapshots: [],
});

const createUnifiedWindow = (
  atspi: AtspiWindowSnapshot | null,
  x11: X11WindowSnapshot | null,
  statuses: readonly GtkWindowBackendStatus[],
  mergeConfidence: number,
  matchedBy: string,
  discovery: GtkWindowDiscoveryDiagnostics
): UnifiedNativeWindow => ({
  atspi,
  x11,
  title: mergedTitle(atspi, x11),
  name: mergedName(atspi, x11),
  roleName: mergedRoleName(atspi),
  processId: mergedProcessId(atspi, x11),
  bounds: mergedBounds(atspi, x11),
  sortIndex: unifiedSortIndex(atspi, x11),
  debugDiagnostics: createDebugDiagnostics(
    atspi,
    x11,
    statuses,
    mergeConfidence,
    matchedBy,
    discovery
  ),
});

export const toX11WindowSnapshot = (
  snapshot: NativeX11WindowSnapshot
): X11WindowSnapshot => ({
  source: 'x11',
  windowId: snapshot.windowId,
  title: snapshot.title,
  className: snapshot.className,
  instanceName: snapshot.instanceName,
  transientFor: snapshot.transientFor,
  processId: snapshot.processId,
  bounds: snapshot.bounds,
  normalHints: snapshot.normalHints,
  hasNormalHints: snapshot.hasNormalHints,
  stackingOrder: snapshot.stackingOrder,
  active: snapshot.active,
});

export const mergeNativeWindowSnapshots = (
  atspiSnapshots: readonly AtspiWindowSnapshot[],
  x11Snapshots: readonly X11WindowSnapshot[],
  statuses: readonly GtkWindowBackendStatus[]
): readonly UnifiedNativeWindow[] => {
  const usedX11Indexes = new Set<number>();
  const acceptedMerges: AcceptedWindowMerge[] = [];
  const unifiedWindows: UnifiedNativeWindow[] = [];

  for (const atspi of atspiSnapshots) {
    const match = findBestX11Match(atspi, x11Snapshots, usedX11Indexes);
    if (match !== undefined) {
      usedX11Indexes.add(match.index);
      acceptedMerges.push({
        atspiIndex: atspi.index,
        x11Index: match.index,
      });
      unifiedWindows.push(
        createUnifiedWindow(
          atspi,
          x11Snapshots[match.index] ?? null,
          statuses,
          match.confidence,
          match.matchedBy,
          emptyDiscoveryDiagnostics()
        )
      );
      continue;
    }

    unifiedWindows.push(
      createUnifiedWindow(
        atspi,
        null,
        statuses,
        atspiOnlyConfidence,
        'at-spi-only',
        emptyDiscoveryDiagnostics()
      )
    );
  }

  for (let index = 0; index < x11Snapshots.length; index += 1) {
    if (usedX11Indexes.has(index)) {
      continue;
    }

    unifiedWindows.push(
      createUnifiedWindow(
        null,
        x11Snapshots[index] ?? null,
        statuses,
        x11OnlyConfidence,
        'x11-only',
        emptyDiscoveryDiagnostics()
      )
    );
  }

  const discovery = createDiscoveryDiagnostics(
    atspiSnapshots,
    x11Snapshots,
    acceptedMerges
  );
  const discoveredWindows = unifiedWindows.map((window) => ({
    ...window,
    debugDiagnostics: {
      ...window.debugDiagnostics,
      discovery,
    },
  }));

  return discoveredWindows.sort(
    (first, second) => first.sortIndex - second.sortIndex
  );
};

export const collectAtspiWindowSnapshots = (
  processId: number
): WindowBackendCollection<AtspiWindowSnapshot> => {
  try {
    const count = nativeWindowCount(processId);
    const snapshots: AtspiWindowSnapshot[] = [];
    for (let index = 0; index < count; index += 1) {
      const handle = nativeWindowAt(processId, index);
      if (handle === undefined) {
        continue;
      }

      const info = nativeElementInfo(handle);
      let bounds: NativeCaptureBounds | null = null;
      let x11WindowId: string | null = null;
      try {
        bounds = nativeBounds(handle);
      } catch {
        bounds = null;
      }
      try {
        x11WindowId = nativeX11Info(handle).windowId;
      } catch {
        x11WindowId = null;
      }

      snapshots.push({
        source: 'at-spi',
        handle,
        index,
        processId: info.processId,
        roleName: info.roleName,
        name: info.name,
        accessibleId: info.accessibleId,
        bounds,
        x11WindowId,
      });
    }

    return {
      snapshots,
      status: backendStatus('at-spi', true, snapshots.length, null),
    };
  } catch (error) {
    return {
      snapshots: [],
      status: backendStatus('at-spi', false, null, nativeErrorMessage(error)),
    };
  }
};

export const collectX11WindowSnapshots = (
  processId: number
): WindowBackendCollection<X11WindowSnapshot> => {
  try {
    const snapshots = nativeX11WindowSnapshots(processId, true).map(
      toX11WindowSnapshot
    );
    return {
      snapshots,
      status: backendStatus('x11', true, snapshots.length, null),
    };
  } catch (error) {
    return {
      snapshots: [],
      status: backendStatus('x11', false, null, nativeErrorMessage(error)),
    };
  }
};

export const collectUnifiedNativeWindows = (
  processId: number
): readonly UnifiedNativeWindow[] =>
  collectNativeWindowDiscovery(processId).windows;

export const collectNativeWindowDiscovery = (
  processId: number
): NativeWindowDiscoveryResult => {
  const atspi = collectAtspiWindowSnapshots(processId);
  const x11 = collectX11WindowSnapshots(processId);
  const statuses = [atspi.status, x11.status];
  return {
    windows: mergeNativeWindowSnapshots(
      atspi.snapshots,
      x11.snapshots,
      statuses
    ),
    backendStatus: statuses,
  };
};
