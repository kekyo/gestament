#!/usr/bin/env node
// gestament - TypeScript based test driver for GTK.
// Copyright (c) Kouji Matsui. (@kekyo@mi.kekyo.net)
// Under MIT.
// https://github.com/kekyo/gestament

import { realpathSync } from 'node:fs';
import { mkdir, stat, writeFile } from 'node:fs/promises';
import { basename, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { version as packageVersion } from './generated/packageMetadata';

/////////////////////////////////////////////////////////////////////////////////////////

/** Result returned by the gestament CLI runner. */
export interface GestamentCliOutput {
  /** Process exit code. */
  readonly exitCode: 0 | 2;

  /** Text to write to stderr. */
  readonly stderr: string;

  /** Text to write to stdout. */
  readonly stdout: string;
}

interface InitOptions {
  readonly directory: string | undefined;
  readonly force: boolean;
  readonly name: string | undefined;
}

interface ScaffoldFile {
  readonly content: string;
  readonly path: string;
}

const fallbackPackageName = 'gestament-tests';
const packageNamePattern =
  /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/u;

const usageText = [
  'Usage: gestament init [directory] [--name <package-name>] [--force]',
  '       gestament init --help',
  '       gestament --help',
  '',
  'Creates a minimal Vitest project for gestament GTK tests.',
  '',
].join('\n');

const gitIgnoreExampleText = [
  'node_modules/',
  'test-results/',
  'coverage/',
  '*.log',
  '',
].join('\n');

const tsconfigText = `${JSON.stringify(
  {
    compilerOptions: {
      target: 'ES2020',
      module: 'ESNext',
      lib: ['ES2020'],
      moduleResolution: 'Bundler',
      strict: true,
      skipLibCheck: true,
      noEmit: true,
    },
    include: ['tests', 'vitest.config.ts'],
  },
  undefined,
  2
)}\n`;

const vitestConfigText = [
  "import { defineConfig } from 'vitest/config';",
  '',
  'export default defineConfig({',
  '  test: {',
  '    globals: true,',
  "    environment: 'node',",
  "    include: ['tests/**/*.test.ts'],",
  '    coverage: {',
  '      enabled: false,',
  '    },',
  '  },',
  '});',
  '',
].join('\n');

const isNotFoundError = (error: unknown): boolean =>
  typeof error === 'object' &&
  error !== null &&
  'code' in error &&
  (error as { readonly code?: string }).code === 'ENOENT';

const statIfExists = async (
  path: string
): Promise<
  | {
      readonly isDirectory: () => boolean;
    }
  | undefined
> => {
  try {
    return await stat(path);
  } catch (error) {
    if (isNotFoundError(error)) {
      return undefined;
    }
    throw error;
  }
};

const normalizePackageName = (value: string): string => {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/gu, '-')
    .replace(/^[._-]+|[._-]+$/gu, '');
  return normalized.length === 0 ? fallbackPackageName : normalized;
};

const isValidPackageName = (value: string): boolean =>
  value.length <= 214 &&
  !value.startsWith('.') &&
  !value.startsWith('_') &&
  packageNamePattern.test(value);

const createPackageJsonText = (name: string): string =>
  `${JSON.stringify(
    {
      name,
      version: '0.0.1',
      private: true,
      scripts: {
        test: 'vitest run',
      },
      devDependencies: {
        '@types/node': '>=20.0.0',
        gestament: `^${packageVersion}`,
        typescript: '>=5.7.0',
        vitest: '>=3.2.0',
      },
    },
    undefined,
    2
  )}\n`;

const createScaffoldFiles = (name: string): readonly ScaffoldFile[] => [
  {
    content: createPackageJsonText(name),
    path: 'package.json',
  },
  {
    content: tsconfigText,
    path: 'tsconfig.json',
  },
  {
    content: vitestConfigText,
    path: 'vitest.config.ts',
  },
  {
    content: gitIgnoreExampleText,
    path: '.gitignore.gestament-example',
  },
];

const createHelpOutput = (): GestamentCliOutput => ({
  exitCode: 0,
  stderr: '',
  stdout: usageText,
});

const createUsageError = (message: string): GestamentCliOutput => ({
  exitCode: 2,
  stderr: `${message}\nRun "gestament --help" for usage.\n`,
  stdout: '',
});

const parseInitOptions = (
  args: readonly string[]
): InitOptions | GestamentCliOutput => {
  let directory: string | undefined;
  let force = false;
  let name: string | undefined;
  let index = 0;

  while (index < args.length) {
    const argument = args[index];
    if (argument === undefined) {
      break;
    }

    if (argument === '--help' || argument === '-h') {
      return createHelpOutput();
    }

    if (argument === '--force') {
      force = true;
      index += 1;
      continue;
    }

    if (argument === '--name') {
      const value = args[index + 1];
      if (value === undefined) {
        return createUsageError('gestament init: --name requires a value.');
      }
      name = value;
      index += 2;
      continue;
    }

    if (argument.startsWith('--name=')) {
      name = argument.slice('--name='.length);
      index += 1;
      continue;
    }

    if (argument.startsWith('-')) {
      return createUsageError(`gestament init: unknown option: ${argument}`);
    }

    if (directory !== undefined) {
      return createUsageError(
        `gestament init: unexpected argument: ${argument}`
      );
    }

    directory = argument;
    index += 1;
  }

  return {
    directory,
    force,
    name,
  };
};

const createRelativePathList = (
  cwd: string,
  paths: readonly string[]
): readonly string[] =>
  paths.map((path) => {
    const relativePath = relative(cwd, path);
    return relativePath.length === 0 ? '.' : relativePath;
  });

const collectCollisions = async (
  targetDirectory: string,
  files: readonly ScaffoldFile[]
): Promise<readonly string[]> => {
  const collisions: string[] = [];

  for (const file of files) {
    const filePath = join(targetDirectory, file.path);
    if ((await statIfExists(filePath)) !== undefined) {
      collisions.push(filePath);
    }
  }

  const testsPath = join(targetDirectory, 'tests');
  const testsStat = await statIfExists(testsPath);
  if (testsStat !== undefined && !testsStat.isDirectory()) {
    collisions.push(testsPath);
  }

  return collisions;
};

const writeScaffold = async (
  targetDirectory: string,
  files: readonly ScaffoldFile[]
): Promise<void> => {
  await mkdir(targetDirectory, { recursive: true });
  await mkdir(join(targetDirectory, 'tests'), { recursive: true });

  for (const file of files) {
    await writeFile(join(targetDirectory, file.path), file.content);
  }
};

const runInitCommand = async (
  args: readonly string[],
  cwd: string
): Promise<GestamentCliOutput> => {
  const parsed = parseInitOptions(args);
  if ('exitCode' in parsed) {
    return parsed;
  }

  if (parsed.name !== undefined && !isValidPackageName(parsed.name)) {
    return createUsageError(
      `gestament init: invalid package name: ${parsed.name}`
    );
  }

  const directoryArgument = parsed.directory ?? '.';
  const targetDirectory = resolve(cwd, directoryArgument);
  const packageName =
    parsed.name ?? normalizePackageName(basename(targetDirectory));
  const files = createScaffoldFiles(packageName);

  await mkdir(targetDirectory, { recursive: true });

  if (!parsed.force) {
    const collisions = await collectCollisions(targetDirectory, files);
    if (collisions.length > 0) {
      return {
        exitCode: 2,
        stderr: [
          'gestament init: refusing to overwrite existing scaffold paths:',
          ...createRelativePathList(cwd, collisions).map((path) => `  ${path}`),
          'Run "gestament init --force" to overwrite generated files.',
          '',
        ].join('\n'),
        stdout: '',
      };
    }
  }

  await writeScaffold(targetDirectory, files);

  return {
    exitCode: 0,
    stderr: '',
    stdout: [
      `Created a gestament test project in ${directoryArgument}.`,
      '',
      'Next steps:',
      `  cd ${directoryArgument}`,
      '  npm install',
      '  npm test',
      '',
    ].join('\n'),
  };
};

/**
 * Runs the gestament command line interface.
 *
 * @param args Command line arguments after the executable name.
 * @param cwd Current working directory used to resolve generated paths.
 * @returns CLI output and exit code.
 */
export const runGestamentCli = async (
  args: readonly string[],
  cwd: string
): Promise<GestamentCliOutput> => {
  const command = args[0];
  if (command === undefined) {
    return createUsageError('gestament: missing command.');
  }

  if (command === '--help' || command === '-h') {
    return createHelpOutput();
  }

  if (command !== 'init') {
    return createUsageError(`gestament: unknown command: ${command}`);
  }

  return await runInitCommand(args.slice(1), cwd);
};

const isMainModule = (): boolean => {
  const executablePath = process.argv[1];
  if (executablePath === undefined) {
    return false;
  }

  return (
    realpathSync(executablePath) ===
    realpathSync(fileURLToPath(import.meta.url))
  );
};

const run = async (): Promise<void> => {
  const output = await runGestamentCli(process.argv.slice(2), process.cwd());
  process.stdout.write(output.stdout);
  process.stderr.write(output.stderr);
  process.exitCode = output.exitCode;
};

/////////////////////////////////////////////////////////////////////////////////////////

if (isMainModule()) {
  run().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`gestament: ${message}\n`);
    process.exitCode = 2;
  });
}
