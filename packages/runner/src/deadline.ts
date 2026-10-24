export const DEFAULT_PROPOSAL_TIMEOUT_MS = 60_000;
export const MAX_PROPOSAL_TIMEOUT_MS = 600_000;

export function validateTimeoutMs(value: number, maximum = MAX_PROPOSAL_TIMEOUT_MS): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new RangeError(`Timeout must be an integer between 1 and ${maximum} milliseconds`);
  }
  return value;
}
