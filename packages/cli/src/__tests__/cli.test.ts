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

      const session = await runDev({
        cwd: tempDir,
        engineOnly: true,
        useFakeRunner: true,
        port: 0,
      });

      expect(session.engine).toBeDefined();
      expect(session.engine.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
      expect(session.engine.token).toHaveLength(48);

      const healthRes = await fetch(`${session.engine.url}/health`);
      expect(healthRes.status).toBe(200);

      await session.stop();
    });
  });
});
