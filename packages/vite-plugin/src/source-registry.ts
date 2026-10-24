import { createHash } from 'node:crypto';
import type { VerifiedSourceMapping } from './types.js';

/**
 * Server-side registry maintaining verified element-to-source mappings.
 * Strictly in-memory during dev server lifetime.
 */
export class SourceRegistry {
  private mappings = new Map<string, VerifiedSourceMapping>();
  private fileRevisions = new Map<string, string>();

  /**
   * Generates a deterministic, opaque source ID and stores the verified mapping.
   */
  public register(
    filePath: string,
    line: number,
    column: number,
    elementTag?: string,
    fileContent?: string,
    absolutePath?: string
  ): string {
    // Generate file revision if content is supplied
    let revision = this.fileRevisions.get(filePath);
    if (fileContent && !revision) {
      revision = createHash('sha256').update(fileContent).digest('hex').slice(0, 12);
      this.fileRevisions.set(filePath, revision);
    }

    // Deterministic opaque sourceId
    const fileHash = createHash('sha256').update(filePath).digest('hex').slice(0, 8);
    const sourceId = `src_${fileHash}_${line}_${column}`;

    const mapping: VerifiedSourceMapping = {
      sourceId,
      file: filePath,
      line,
      column,
      revision,
      elementTag,
      absolutePath,
    };

    this.mappings.set(sourceId, mapping);
    return sourceId;
  }

  /**
   * Resolves an opaque source ID to its verified source mapping.
   */
  public resolve(sourceId: string): VerifiedSourceMapping | undefined {
    return this.mappings.get(sourceId);
  }

  /**
   * Invalidates mappings for a file when modified during HMR.
   */
  public invalidateFile(filePath: string): void {
    this.fileRevisions.delete(filePath);
    for (const [key, mapping] of this.mappings.entries()) {
      if (
        mapping.file === filePath ||
        mapping.absolutePath === filePath ||
        (mapping.absolutePath && mapping.absolutePath.endsWith(filePath)) ||
        (filePath && filePath.endsWith(mapping.file))
      ) {
        this.mappings.delete(key);
      }
    }
  }

  /**
   * Clears the entire registry.
   */
  public clear(): void {
    this.mappings.clear();
    this.fileRevisions.clear();
  }

  public get size(): number {
    return this.mappings.size;
  }
}
