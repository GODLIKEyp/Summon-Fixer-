import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import type { IncomingMessage } from 'node:http';
import {
  validateWorkspaceContainment,
  validateEditPolicy,
  validateLoopbackRequest,
  SecurityError,
} from '../security.js';
import { getDefaultPermissionPolicy } from '@summon-fixer/contracts';

describe('Runner Security Enforcement', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'summon-sec-test-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  describe('validateWorkspaceContainment', () => {
    it('allows valid relative files within the workspace root', () => {
      const filePath = resolve(tempDir, 'src/index.ts');
      writeFileSync(resolve(tempDir, 'package.json'), '{}');
      const normalized = validateWorkspaceContainment(tempDir, 'src/index.ts');
      expect(normalized).toBe('src/index.ts');
    });

    it('rejects path traversal attempts containing ..', () => {
      expect(() => {
        validateWorkspaceContainment(tempDir, '../outside.ts');
      }).toThrowError(SecurityError);
    });

    it('rejects symlink escapes resolving outside workspace root', () => {
      const outsideDir = mkdtempSync(join(tmpdir(), 'summon-outside-'));
      const outsideFile = resolve(outsideDir, 'secret.txt');
      writeFileSync(outsideFile, 'secret data');

      const symlinkPath = resolve(tempDir, 'escaped-link.txt');
      symlinkSync(outsideFile, symlinkPath);

      expect(() => {
        validateWorkspaceContainment(tempDir, 'escaped-link.txt');
      }).toThrowError(/Symlink escape detected/);

      rmSync(outsideDir, { recursive: true, force: true });
    });
  });

  describe('validateEditPolicy', () => {
    const policy = getDefaultPermissionPolicy('manual');

    it('permits standard source code files', () => {
      expect(() => validateEditPolicy('src/components/Button.tsx', policy)).not.toThrow();
    });

    it('rejects secret files (.env, .env.local)', () => {
      expect(() => validateEditPolicy('.env', policy)).toThrowError(SecurityError);
      expect(() => validateEditPolicy('.env.local', policy)).toThrowError(SecurityError);
      expect(() => validateEditPolicy('.env.production', policy)).toThrowError(SecurityError);
    });

    it('explicitly permits .env.example', () => {
      expect(() => validateEditPolicy('.env.example', policy)).not.toThrow();
    });

    it('rejects .git directory targets', () => {
      expect(() => validateEditPolicy('.git/config', policy)).toThrowError(SecurityError);
    });

    it('rejects lockfiles', () => {
      expect(() => validateEditPolicy('package-lock.json', policy)).toThrowError(SecurityError);
    });
  });

  describe('validateLoopbackRequest', () => {
    const validToken = 'test-secret-token-123';

    it('accepts loopback request with valid Bearer token', () => {
      const req = {
        headers: {
          host: '127.0.0.1:7890',
          authorization: `Bearer ${validToken}`,
        },
      } as unknown as IncomingMessage;

      const result = validateLoopbackRequest(req, validToken);
      expect(result.valid).toBe(true);
    });

    it('accepts loopback request with X-Summon-Token header', () => {
      const req = {
        headers: {
          host: 'localhost:7890',
          'x-summon-token': validToken,
        },
      } as unknown as IncomingMessage;

      const result = validateLoopbackRequest(req, validToken);
      expect(result.valid).toBe(true);
    });

    it('rejects non-loopback host headers', () => {
      const req = {
        headers: {
          host: 'evil.com:7890',
          authorization: `Bearer ${validToken}`,
        },
      } as unknown as IncomingMessage;

      const result = validateLoopbackRequest(req, validToken);
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.code).toBe('INVALID_HOST');
      }
    });

    it('rejects non-loopback origin headers', () => {
      const req = {
        headers: {
          host: '127.0.0.1:7890',
          origin: 'http://malicious-site.com',
          authorization: `Bearer ${validToken}`,
        },
      } as unknown as IncomingMessage;

      const result = validateLoopbackRequest(req, validToken);
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.code).toBe('INVALID_ORIGIN');
      }
    });

    it('rejects missing or invalid authorization tokens', () => {
      const reqNoToken = {
        headers: { host: '127.0.0.1:7890' },
      } as unknown as IncomingMessage;

      const resultNoToken = validateLoopbackRequest(reqNoToken, validToken);
      expect(resultNoToken.valid).toBe(false);

      const reqWrongToken = {
        headers: {
          host: '127.0.0.1:7890',
          authorization: 'Bearer wrong-token',
        },
      } as unknown as IncomingMessage;

      const resultWrong = validateLoopbackRequest(reqWrongToken, validToken);
      expect(resultWrong.valid).toBe(false);
    });
  });
});
