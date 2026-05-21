// gestament - TypeScript based test driver for GTK.
// Copyright (c) Kouji Matsui. (@kekyo@mi.kekyo.net)
// Under MIT.
// https://github.com/kekyo/gestament

import { createGtkInvalidArgumentError } from './errors';
import type {
  GtkAppOutput,
  GtkAppOutputEvent,
  GtkAppOutputStream,
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

export const normalizeOutputBufferBytes = (
  value: number | undefined
): number | undefined => {
  if (value === undefined) {
    return undefined;
  }
  if (!Number.isSafeInteger(value) || value < 0) {
    throw createGtkInvalidArgumentError(
      'outputBufferBytes must be a non-negative safe integer.'
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

export const createGtkAppOutputRecorder = (
  outputBufferBytes: number | undefined
): GtkAppOutputRecorder => {
  const maxBytes = normalizeOutputBufferBytes(outputBufferBytes);
  const stdout = createStreamState();
  const stderr = createStreamState();
  let nextSequence = 0;

  const streamState = (stream: GtkAppOutputStream): OutputStreamState =>
    stream === 'stdout' ? stdout : stderr;

  const createEvent = (
    stream: GtkAppOutputStream,
    text: string
  ): GtkAppOutputEvent | undefined => {
    if (text.length === 0) {
      return undefined;
    }
    const event = {
      sequence: nextSequence,
      stream,
      text,
      timestampMs: Date.now(),
    };
    nextSequence += 1;
    return event;
  };

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
