import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveWorkspaceRoot } from '../workspace.js';
import { runDev } from '../dev.js';

describe('Summon CLI Foundation', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'summon-cli-test-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  describe('resolveWorkspaceRoot', () => {
    it('resolves project root when package.json is present', () => {
      writeFileSync(join(tempDir, 'package.json'), '{}');
      const root = resolveWorkspaceRoot(tempDir);
      expect(root).toBeDefined();
    });

    it('rejects directories without package.json to prevent arbitrary traversal', () => {
      expect(() => {
        resolveWorkspaceRoot(tempDir);
      }).toThrowError(/Cannot resolve project workspace/);
    });
  });

  describe('runDev', () => {
    it('starts engine and returns valid session in engine-only mode', async () => {
      writeFileSync(join(tempDir, 'package.json'), JSON.stringify({ name: 'test' }));
      const signalsBefore = { int: process.listenerCount('SIGINT'), term: process.listenerCount('SIGTERM') };

      const session = await runDev({
        cwd: tempDir,
        engineOnly: true,
        useFakeRunner: true,
        port: 0,
        proposalTimeoutMs: 1234,
      });

      expect(session.engine).toBeDefined();
      expect(session.engine.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
      expect(session.engine.token).toHaveLength(48);

      const healthRes = await fetch(`${session.engine.url}/health`);
      expect(healthRes.status).toBe(200);

      await session.stop();
      await session.stop();
      expect(process.listenerCount('SIGINT')).toBe(signalsBefore.int);
      expect(process.listenerCount('SIGTERM')).toBe(signalsBefore.term);
    });

    it('rejects an occupied port without installing signal handlers', async () => {
      writeFileSync(join(tempDir, 'package.json'), '{}');
      const first = await runDev({ cwd: tempDir, engineOnly: true, useFakeRunner: true, port: 0 });
      const count = process.listenerCount('SIGTERM');
      try {
        await expect(runDev({ cwd: tempDir, engineOnly: true, useFakeRunner: true, port: first.engine.port }))
          .rejects.toMatchObject({ code: 'EADDRINUSE' });
        expect(process.listenerCount('SIGTERM')).toBe(count);
      } finally { await first.stop(); }
    });

    it('rejects unbounded proposal deadlines before opening a server', async () => {
      writeFileSync(join(tempDir, 'package.json'), '{}');
      await expect(runDev({ cwd: tempDir, engineOnly: true, useFakeRunner: true, port: 0,
        proposalTimeoutMs: Infinity })).rejects.toThrow('Timeout must be an integer');
    });
  });
});
