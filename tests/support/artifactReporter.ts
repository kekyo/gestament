// gestament - TypeScript based test driver for GTK.
// Copyright (c) Kouji Matsui. (@kekyo@mi.kekyo.net)
// Under MIT.
// https://github.com/kekyo/gestament

import { appendFile, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { Reporter, TestCase } from 'vitest/node';

import {
  ensureTestArtifactDirectory,
  getTestArtifactConfig,
} from './testArtifacts';

/////////////////////////////////////////////////////////////////////////////////////////

interface ConsoleLogLike {
  readonly content: string;
  readonly taskId?: string;
  readonly time: number;
  readonly type: 'stderr' | 'stdout';
}

interface RegisteredTestArtifact {
  readonly directory: string;
  readonly name: string;
}

interface ErrorLike {
  readonly message?: string;
  readonly name?: string;
  readonly stack?: string;
}

const registeredTests = new Map<string, RegisteredTestArtifact>();

const formatIsoTime = (time: number): string => new Date(time).toISOString();

const appendLog = async (directory: string, content: string): Promise<void> => {
  await mkdir(directory, { recursive: true });
  await appendFile(join(directory, 'result.log'), content);
};

const appendRunLog = async (content: string): Promise<void> => {
  const directory = getTestArtifactConfig().runRoot;
  await mkdir(directory, { recursive: true });
  await appendFile(join(directory, 'run.log'), content);
};

const registerTest = async (
  testCase: TestCase
): Promise<RegisteredTestArtifact> => {
  const existing = registeredTests.get(testCase.id);
  if (existing !== undefined) {
    return existing;
  }

  const directory = await ensureTestArtifactDirectory(
    testCase.fullName,
    testCase.id
  );
  const artifact = {
    directory,
    name: testCase.fullName,
  };
  registeredTests.set(testCase.id, artifact);
  return artifact;
};

const serializeErrors = (
  errors: ReadonlyArray<ErrorLike> | undefined
): readonly {
  readonly message: string;
  readonly name: string;
  readonly stack?: string;
}[] => {
  if (errors === undefined) {
    return [];
  }

  return errors.map((error) => {
    const serialized: {
      message: string;
      name: string;
      stack?: string;
    } = {
      message: error.message ?? '',
      name: error.name ?? 'Error',
    };
    if (error.stack !== undefined) {
      serialized.stack = error.stack;
    }
    return serialized;
  });
};

/**
 * Creates a Vitest reporter that stores per-test execution logs.
 * @returns Vitest reporter.
 */
export const createTestArtifactsReporter = (): Reporter => ({
  onTestCaseReady: async (testCase) => {
    const artifact = await registerTest(testCase);
    await appendLog(
      artifact.directory,
      `[${new Date().toISOString()}] start ${artifact.name}\n`
    );
  },

  onTestCaseResult: async (testCase) => {
    const artifact = await registerTest(testCase);
    const result = testCase.result();
    const diagnostic = testCase.diagnostic();
    const errors = serializeErrors(result.errors);

    await appendLog(
      artifact.directory,
      `[${new Date().toISOString()}] ${result.state}${
        diagnostic === undefined ? '' : ` ${diagnostic.duration}ms`
      }\n`
    );
    await writeFile(
      join(artifact.directory, 'result.json'),
      `${JSON.stringify(
        {
          arch: getTestArtifactConfig().arch,
          diagnostic,
          errors,
          moduleId: testCase.module.moduleId,
          state: result.state,
          testId: testCase.id,
          testName: artifact.name,
          timestamp: getTestArtifactConfig().timestamp,
        },
        undefined,
        2
      )}\n`
    );
  },

  onUserConsoleLog: async (log: ConsoleLogLike) => {
    if (log.taskId === undefined) {
      await appendRunLog(
        `[${formatIsoTime(log.time)}] ${log.type}: ${log.content}`
      );
      return;
    }

    const artifact = registeredTests.get(log.taskId);
    if (artifact === undefined) {
      await appendRunLog(
        `[${formatIsoTime(log.time)}] ${log.type} ${log.taskId}: ${log.content}`
      );
      return;
    }

    await appendLog(
      artifact.directory,
      `[${formatIsoTime(log.time)}] ${log.type}: ${log.content}`
    );
  },
});
