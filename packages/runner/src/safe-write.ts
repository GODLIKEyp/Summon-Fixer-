/**
 * Node's pathname-based fs.rename cannot condition replacement on an expected
 * inode/content hash, and Node exposes no portable directory-handle-relative
 * rename. Advisory locks do not exclude arbitrary editors or hostile writers.
 *
 * Do not reintroduce check-then-rename here. A future writer must establish BOTH
 * directory identity confinement AND exclusive/transactional content ownership.
 * Until then, fail before opening any target or staging file for writing. This
 * also preserves modes and leaves no staging artifacts to clean up.
 */
export class SafeWriteUnavailableError extends Error {
  readonly code = 'SAFE_WRITE_UNAVAILABLE';
  readonly statusCode = 503;
  constructor() {
    super('Automatic application is disabled: this runtime cannot guarantee an identity-bound, concurrent-writer-safe replacement. No files were modified. Review the proposal and apply it using your editor.');
    this.name = 'SafeWriteUnavailableError';
  }
}

export function replaceFileSafely(_path: string, _content: string): void {
  throw new SafeWriteUnavailableError();
}
