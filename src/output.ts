// gestament - TypeScript based test driver for GTK.
// Copyright (c) Kouji Matsui. (@kekyo@mi.kekyo.net)
// Under MIT.
// https://github.com/kekyo/gestament

import { createGtkInvalidArgumentError } from './errors';
import type {
  GtkAppOutput,
  GtkAppOutputEvent,
  GtkAppOutputStream,
  GtkSystemOutput,
  GtkSystemOutputEvent,
  GtkSystemOutputSource,
  GtkSystemOutputSourceSnapshot,
} from './types';

/////////////////////////////////////////////////////////////////////////////////////////

interface OutputStreamState {
  readonly chunks: Buffer[];
  readonly decoder: TextDecoder;
  byteLength: number;
  flushed: boolean;
  truncated: boolean;
}

export interface GtkAppOutputRecorder {
  readonly append: (
    stream: GtkAppOutputStream,
    chunk: Buffer
  ) => GtkAppOutputEvent | undefined;
  readonly flush: (stream: GtkAppOutputStream) => GtkAppOutputEvent | undefined;
  readonly snapshot: (
    exitCode: number | null,
    exitSignal: string | null
  ) => GtkAppOutput;
}

export interface GtkSystemOutputRecorder {
  readonly append: (
    source: GtkSystemOutputSource,
    stream: GtkAppOutputStream,
    chunk: Buffer
  ) => GtkSystemOutputEvent | undefined;
  readonly flush: (
    source: GtkSystemOutputSource,
    stream: GtkAppOutputStream
  ) => GtkSystemOutputEvent | undefined;
  readonly snapshot: () => GtkSystemOutput;
}

export const normalizeOutputBufferBytes = (
  value: number | undefined,
  optionName = 'outputBufferBytes'
): number | undefined => {
  if (value === undefined) {
    return undefined;
  }
  if (!Number.isSafeInteger(value) || value < 0) {
    throw createGtkInvalidArgumentError(
      `${optionName} must be a non-negative safe integer.`
    );
  }
  return value;
};

const createStreamState = (): OutputStreamState => ({
  byteLength: 0,
  chunks: [],
  decoder: new TextDecoder(),
  flushed: false,
  truncated: false,
});

const appendBoundedChunk = (
  state: OutputStreamState,
  chunk: Buffer,
  maxBytes: number | undefined
): void => {
  if (chunk.length === 0) {
    return;
  }

  if (maxBytes === undefined) {
    state.chunks.push(Buffer.from(chunk));
    state.byteLength += chunk.length;
    return;
  }

  if (maxBytes === 0) {
    state.truncated = true;
    return;
  }

  if (chunk.length >= maxBytes) {
    state.chunks.splice(
      0,
      state.chunks.length,
      Buffer.from(chunk.subarray(chunk.length - maxBytes))
    );
    state.byteLength = maxBytes;
    state.truncated = true;
    return;
  }

  state.chunks.push(Buffer.from(chunk));
  state.byteLength += chunk.length;

  while (state.byteLength > maxBytes) {
    const first = state.chunks[0];
    if (first === undefined) {
      state.byteLength = 0;
      return;
    }

    const excess = state.byteLength - maxBytes;
    if (first.length <= excess) {
      state.chunks.shift();
      state.byteLength -= first.length;
      state.truncated = true;
      continue;
    }

    state.chunks[0] = Buffer.from(first.subarray(excess));
    state.byteLength -= excess;
    state.truncated = true;
  }
};

const streamText = (state: OutputStreamState): string =>
  Buffer.concat(state.chunks, state.byteLength).toString('utf8');

const createOutputEvent = <Event>(
  nextSequence: () => number,
  create: (sequence: number) => Event,
  text: string
): Event | undefined => {
  if (text.length === 0) {
    return undefined;
  }
  return create(nextSequence());
};

export const createGtkAppOutputRecorder = (
  outputBufferBytes: number | undefined
): GtkAppOutputRecorder => {
  const maxBytes = normalizeOutputBufferBytes(outputBufferBytes);
  const stdout = createStreamState();
  const stderr = createStreamState();
  let nextSequence = 0;

  const streamState = (stream: GtkAppOutputStream): OutputStreamState =>
    stream === 'stdout' ? stdout : stderr;

  const takeSequence = (): number => {
    const sequence = nextSequence;
    nextSequence += 1;
    return sequence;
  };

  const createEvent = (
    stream: GtkAppOutputStream,
    text: string
  ): GtkAppOutputEvent | undefined =>
    createOutputEvent(
      takeSequence,
      (sequence) => ({
        sequence,
        stream,
        text,
        timestampMs: Date.now(),
      }),
      text
    );

  return {
    append: (
      stream: GtkAppOutputStream,
      chunk: Buffer
    ): GtkAppOutputEvent | undefined => {
      const state = streamState(stream);
      appendBoundedChunk(state, chunk, maxBytes);
      return createEvent(stream, state.decoder.decode(chunk, { stream: true }));
    },
    flush: (stream: GtkAppOutputStream): GtkAppOutputEvent | undefined => {
      const state = streamState(stream);
      if (state.flushed) {
        return undefined;
      }
      state.flushed = true;
      return createEvent(stream, state.decoder.decode());
    },
    snapshot: (
      exitCode: number | null,
      exitSignal: string | null
    ): GtkAppOutput => ({
      exitCode,
      exitSignal,
      stderr: streamText(stderr),
      stderrTruncated: stderr.truncated,
      stdout: streamText(stdout),
      stdoutTruncated: stdout.truncated,
    }),
  };
};

const systemOutputSources: readonly GtkSystemOutputSource[] = [
  'xvfb',
  'launcher-driver',
  'tray-host',
];

const createSourceState = (): {
  readonly stderr: OutputStreamState;
  readonly stdout: OutputStreamState;
} => ({
  stderr: createStreamState(),
  stdout: createStreamState(),
});

export const createGtkSystemOutputRecorder = (
  systemOutputBufferBytes: number | undefined
): GtkSystemOutputRecorder => {
  const maxBytes = normalizeOutputBufferBytes(
    systemOutputBufferBytes,
    'systemOutputBufferBytes'
  );
  const sources = new Map<
    GtkSystemOutputSource,
    ReturnType<typeof createSourceState>
  >();
  let nextSequence = 0;

  const takeSequence = (): number => {
    const sequence = nextSequence;
    nextSequence += 1;
    return sequence;
  };

  const sourceState = (
    source: GtkSystemOutputSource
  ): ReturnType<typeof createSourceState> => {
    const existing = sources.get(source);
    if (existing !== undefined) {
      return existing;
    }
    const state = createSourceState();
    sources.set(source, state);
    return state;
  };

  const streamState = (
    source: GtkSystemOutputSource,
    stream: GtkAppOutputStream
  ): OutputStreamState => {
    const state = sourceState(source);
    return stream === 'stdout' ? state.stdout : state.stderr;
  };

  const existingStreamState = (
    source: GtkSystemOutputSource,
    stream: GtkAppOutputStream
  ): OutputStreamState | undefined => {
    const state = sources.get(source);
    if (state === undefined) {
      return undefined;
    }
    return stream === 'stdout' ? state.stdout : state.stderr;
  };

  const createEvent = (
    source: GtkSystemOutputSource,
    stream: GtkAppOutputStream,
    text: string
  ): GtkSystemOutputEvent | undefined =>
    createOutputEvent(
      takeSequence,
      (sequence) => ({
        sequence,
        source,
        stream,
        text,
        timestampMs: Date.now(),
      }),
      text
    );

  const sourceSnapshot = (
    source: GtkSystemOutputSource,
    state: ReturnType<typeof createSourceState>
  ): GtkSystemOutputSourceSnapshot => ({
    source,
    stderr: streamText(state.stderr),
    stderrTruncated: state.stderr.truncated,
    stdout: streamText(state.stdout),
    stdoutTruncated: state.stdout.truncated,
  });

  return {
    append: (
      source: GtkSystemOutputSource,
      stream: GtkAppOutputStream,
      chunk: Buffer
    ): GtkSystemOutputEvent | undefined => {
      const state = streamState(source, stream);
      appendBoundedChunk(state, chunk, maxBytes);
      return createEvent(
        source,
        stream,
        state.decoder.decode(chunk, { stream: true })
      );
    },
    flush: (
      source: GtkSystemOutputSource,
      stream: GtkAppOutputStream
    ): GtkSystemOutputEvent | undefined => {
      const state = existingStreamState(source, stream);
      if (state === undefined) {
        return undefined;
      }
      if (state.flushed) {
        return undefined;
      }
      state.flushed = true;
      return createEvent(source, stream, state.decoder.decode());
    },
    snapshot: (): GtkSystemOutput => ({
      sources: systemOutputSources.flatMap((source) => {
        const state = sources.get(source);
        return state === undefined ? [] : [sourceSnapshot(source, state)];
      }),
    }),
  };
};

export const notifyGtkAppOutput = (
  callback: ((event: GtkAppOutputEvent) => void) | undefined,
  event: GtkAppOutputEvent | undefined
): void => {
  if (callback === undefined || event === undefined) {
    return;
  }

  try {
    callback(event);
  } catch (error) {
    queueMicrotask(() => {
      throw error;
    });
  }
};

export const notifyGtkSystemOutput = (
  callback: ((event: GtkSystemOutputEvent) => void) | undefined,
  event: GtkSystemOutputEvent | undefined
): void => {
  if (callback === undefined || event === undefined) {
    return;
  }

  try {
    callback(event);
  } catch (error) {
    queueMicrotask(() => {
      throw error;
    });
  }
};
