import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import { build } from 'vite';
import { sha256 } from '../sha256.js';
import { computeProposalDigest, TaskStateSchema } from '../index.js';

describe('Browser-compatible synchronous SHA-256', () => {
  it.each(['', 'abc', 'a'.repeat(55), 'a'.repeat(56), 'a'.repeat(64), 'a'.repeat(1000000),
    'नमस्ते 😀 café', '\ud800', 'x\u0000y'])('matches Node SHA-256 for vector %#', (value) => {
    expect(sha256(value)).toBe(createHash('sha256').update(value).digest('hex'));
  });

  it('preserves canonical proposal digest bytes and the synchronous API', () => {
    const edits = [{ path: './src/b.ts', changeType: 'update' as const, oldContent: '😀', newContent: 'नमस्ते' },
      { path: 'src/a.ts', changeType: 'update' as const, oldContent: 'old', newContent: 'new' }];
    const baseline = { version: 4, edits: [edits[1], edits[0]].map((edit) => ({
      path: edit.path.replace(/^\.\//, ''), changeType: edit.changeType,
      oldContent: edit.oldContent, newContent: edit.newContent, patch: null,
    })) };
    const digest = computeProposalDigest(edits, 4);
    expect(typeof digest).toBe('string');
    expect(digest).toBe(createHash('sha256').update(JSON.stringify(baseline)).digest('hex'));
  });

  it('bundles runtime contracts for a browser without Node shims', async () => {
    const result = await build({ configFile: false, logLevel: 'silent',
      build: { write: false, minify: false, lib: { entry: resolve('src/index.ts'), formats: ['iife'], name: 'SummonContracts', fileName: 'contracts' } } });
    const outputs = Array.isArray(result) ? result : [result];
    const code = outputs.flatMap((output) => 'output' in output ? output.output : [])
      .filter((chunk) => chunk.type === 'chunk').map((chunk) => chunk.code).join('\n');
    expect(code).toContain('computeProposalDigest');
    expect(code).not.toMatch(/node:crypto|__vite-browser-external|require\(/);
    const sandbox: Record<string, unknown> = { TextEncoder };
    runInNewContext(code, sandbox);
    const api = sandbox.SummonContracts as typeof import('../index.js');
    expect(api.computeProposalDigest([], 1)).toBe(computeProposalDigest([], 1));
    expect(api.TaskRequestSchema.safeParse({ requestId: 'browser', prompt: 'test', createdAt: new Date().toISOString() }).success).toBe(true);
  });

  it('accepts additive application state without making it required for old payloads', () => {
    const schema = TaskStateSchema.shape.application;
    expect(schema.safeParse(undefined).success).toBe(true);
    expect(schema.parse({ status: 'applied', appliedEditsCount: 1 })).toEqual({ status: 'applied', appliedEditsCount: 1 });
  });
});
