// gestament - TypeScript based test driver for GTK.
// Copyright (c) Kouji Matsui. (@kekyo@mi.kekyo.net)
// Under MIT.
// https://github.com/kekyo/gestament

import { describe, expect, it } from 'vitest';

import { createGtkSystemOutputRecorder } from '../src/output';
import type { GtkSystemOutput } from '../src/types';

/////////////////////////////////////////////////////////////////////////////////////////

const sourceSnapshot = (
  output: GtkSystemOutput,
  source: 'xvfb' | 'launcher-driver' | 'tray-host'
) => output.sources.find((entry) => entry.source === source);

describe('system output recorder', () => {
  it('retains source-separated output with cross-source sequences', () => {
    const recorder = createGtkSystemOutputRecorder(undefined);
    const events = [
      recorder.append('launcher-driver', 'stdout', Buffer.from('driver-out')),
      recorder.append('xvfb', 'stderr', Buffer.from('xvfb-err')),
      recorder.append('tray-host', 'stdout', Buffer.from('tray-out')),
    ];

    expect(events.map((event) => event?.sequence)).toEqual([0, 1, 2]);

    const output = recorder.snapshot();
    expect(sourceSnapshot(output, 'launcher-driver')).toMatchObject({
      stderr: '',
      stderrTruncated: false,
      stdout: 'driver-out',
      stdoutTruncated: false,
    });
    expect(sourceSnapshot(output, 'xvfb')).toMatchObject({
      stderr: 'xvfb-err',
      stderrTruncated: false,
      stdout: '',
      stdoutTruncated: false,
    });
    expect(sourceSnapshot(output, 'tray-host')).toMatchObject({
      stderr: '',
      stderrTruncated: false,
      stdout: 'tray-out',
      stdoutTruncated: false,
    });
  });

  it('retains bounded source stream tails', () => {
    const recorder = createGtkSystemOutputRecorder(4);
    recorder.append('launcher-driver', 'stdout', Buffer.from('abcdef'));
    recorder.append('launcher-driver', 'stderr', Buffer.from('uvwxyz'));

    const output = recorder.snapshot();

    expect(sourceSnapshot(output, 'launcher-driver')).toMatchObject({
      stderr: 'wxyz',
      stderrTruncated: true,
      stdout: 'cdef',
      stdoutTruncated: true,
    });
  });

  it('can disable retained source stream text', () => {
    const recorder = createGtkSystemOutputRecorder(0);
    recorder.append('tray-host', 'stdout', Buffer.from('stdout'));
    recorder.append('tray-host', 'stderr', Buffer.from('stderr'));

    const output = recorder.snapshot();

    expect(sourceSnapshot(output, 'tray-host')).toMatchObject({
      stderr: '',
      stderrTruncated: true,
      stdout: '',
      stdoutTruncated: true,
    });
  });
});
