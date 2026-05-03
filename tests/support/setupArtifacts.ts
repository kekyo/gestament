// gestament - TypeScript based test driver for GTK.
// Copyright (c) Kouji Matsui. (@kekyo@mi.kekyo.net)
// Under MIT.
// https://github.com/kekyo/gestament

import { afterEach, beforeEach } from 'vitest';

import {
  clearCurrentTestArtifact,
  ensureTestArtifactDirectory,
  getTaskFullName,
  setCurrentTestArtifact,
} from './testArtifacts';

/////////////////////////////////////////////////////////////////////////////////////////

beforeEach(async (context) => {
  const testName = getTaskFullName(context.task);
  setCurrentTestArtifact(testName, context.task.id);
  await ensureTestArtifactDirectory(testName, context.task.id);
});

afterEach(() => {
  clearCurrentTestArtifact();
});
