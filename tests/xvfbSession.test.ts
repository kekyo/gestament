// gestament - TypeScript based test driver for GTK.
// Copyright (c) Kouji Matsui. (@kekyo@mi.kekyo.net)
// Under MIT.
// https://github.com/kekyo/gestament

import { spawn } from 'node:child_process';
import { createServer, type Server } from 'node:net';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';

import {
  cleanupStaleX11DisplayArtifacts,
  removeStaleXvfbDisplayLock,
  type XvfbDisplayArtifactPaths,
} from '../src/xvfbSession';

/////////////////////////////////////////////////////////////////////////////////////////

const deadPid = 999_999_999;
const socketTimeoutMs = 100;

const createPaths = (
  directory: string,
  name: string
): XvfbDisplayArtifactPaths => ({
  gestamentLockPath: join(directory, `${name}.gestament.lock`),
  serverLockPath: join(directory, `${name}.x.lock`),
  socketPath: join(directory, `${name}.sock`),
});

const writePid = (path: string, pid: string | number): void => {
  writeFileSync(path, `${pid}\n`);
};

const listenUnixSocket = (path: string): Promise<Server> =>
  new Promise<Server>((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(path, () => {
      server.removeListener('error', reject);
      resolve(server);
    });
  });

const closeServer = (server: Server): Promise<void> =>
  new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error !== undefined) {
        reject(error);
        return;
      }
      resolve();
    });
  });

const createAbandonedUnixSocket = (path: string): Promise<void> =>
  new Promise<void>((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        '-e',
        [
          "const { createServer } = require('node:net');",
          'const server = createServer();',
          'server.listen(process.argv[1], () => {',
          "  process.stdout.write('ready\\n');",
          '});',
          'setInterval(() => undefined, 1000);',
        ].join('\n'),
        path,
      ],
      {
        stdio: ['ignore', 'pipe', 'pipe'],
      }
    );
    let stdout = '';
    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('Timed out creating an abandoned Unix socket.'));
    }, 5_000);

    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
      if (!stdout.includes('ready')) {
        return;
      }
      clearTimeout(timeout);
      child.kill('SIGKILL');
    });
    child.once('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once('close', () => {
      clearTimeout(timeout);
      resolve();
    });
  });

describe.concurrent('Xvfb session artifacts', () => {
  it('removes stale gestament display locks and keeps live locks', () => {
    const directory = mkdtempSync(join(tmpdir(), 'gestament-xvfb-session-'));
    try {
      const invalidLockPath = join(directory, 'invalid.lock');
      writePid(invalidLockPath, 'not-a-pid');

      expect(removeStaleXvfbDisplayLock(invalidLockPath)).toBe(true);
      expect(existsSync(invalidLockPath)).toBe(false);

      const deadLockPath = join(directory, 'dead.lock');
      writePid(deadLockPath, deadPid);

      expect(removeStaleXvfbDisplayLock(deadLockPath)).toBe(true);
      expect(existsSync(deadLockPath)).toBe(false);

      const liveLockPath = join(directory, 'live.lock');
      writePid(liveLockPath, process.pid);

      expect(removeStaleXvfbDisplayLock(liveLockPath)).toBe(false);
      expect(existsSync(liveLockPath)).toBe(true);
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  });

  it('keeps X11 artifacts when the lock pid is live or the socket accepts connections', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'gestament-xvfb-session-'));
    try {
      const liveLockPaths = createPaths(directory, 'live-lock');
      writePid(liveLockPaths.serverLockPath, process.pid);

      expect(
        await cleanupStaleX11DisplayArtifacts(liveLockPaths, socketTimeoutMs)
      ).toBe(false);
      expect(existsSync(liveLockPaths.serverLockPath)).toBe(true);

      const socketPaths = createPaths(directory, 'live-socket');
      const server = await listenUnixSocket(socketPaths.socketPath);
      try {
        expect(
          await cleanupStaleX11DisplayArtifacts(socketPaths, socketTimeoutMs)
        ).toBe(false);
        expect(existsSync(socketPaths.socketPath)).toBe(true);
      } finally {
        await closeServer(server);
      }
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  });

  it('removes dead X11 locks with non-connectable sockets', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'gestament-xvfb-session-'));
    try {
      const paths = createPaths(directory, 'stale-x11');
      writePid(paths.serverLockPath, deadPid);
      await createAbandonedUnixSocket(paths.socketPath);
      expect(lstatSync(paths.socketPath).isSocket()).toBe(true);

      expect(
        await cleanupStaleX11DisplayArtifacts(paths, socketTimeoutMs)
      ).toBe(true);
      expect(existsSync(paths.serverLockPath)).toBe(false);
      expect(existsSync(paths.socketPath)).toBe(false);
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  });

  it('keeps symlinks, unexpected artifact types, and unlink failures blocked', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'gestament-xvfb-session-'));
    try {
      const symlinkPaths = createPaths(directory, 'symlink-lock');
      const targetPath = join(directory, 'target');
      writeFileSync(targetPath, 'target');
      symlinkSync(targetPath, symlinkPaths.serverLockPath);

      expect(
        await cleanupStaleX11DisplayArtifacts(symlinkPaths, socketTimeoutMs)
      ).toBe(false);
      expect(lstatSync(symlinkPaths.serverLockPath).isSymbolicLink()).toBe(
        true
      );

      const directoryPaths = createPaths(directory, 'directory-socket');
      writePid(directoryPaths.serverLockPath, deadPid);
      rmSync(directoryPaths.socketPath, { force: true, recursive: true });
      writeFileSync(directoryPaths.socketPath, 'not-a-socket');

      expect(
        await cleanupStaleX11DisplayArtifacts(directoryPaths, socketTimeoutMs)
      ).toBe(false);
      expect(existsSync(directoryPaths.serverLockPath)).toBe(true);

      if (typeof process.getuid !== 'function' || process.getuid() !== 0) {
        const protectedPaths = createPaths(directory, 'permission');
        writePid(protectedPaths.serverLockPath, deadPid);
        chmodSync(directory, 0o500);
        try {
          expect(
            await cleanupStaleX11DisplayArtifacts(
              protectedPaths,
              socketTimeoutMs
            )
          ).toBe(false);
          expect(existsSync(protectedPaths.serverLockPath)).toBe(true);
        } finally {
          chmodSync(directory, 0o700);
        }
      }
    } finally {
      chmodSync(directory, 0o700);
      rmSync(directory, { force: true, recursive: true });
    }
  });
});
