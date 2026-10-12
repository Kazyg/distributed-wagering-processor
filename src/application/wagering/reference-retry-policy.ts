export const MAX_REFERENCE_ATTEMPTS = 5;

export function referenceRetryDelayMs(attempt: number): number {
  if (!Number.isInteger(attempt) || attempt < 1) {
    throw new Error('Invalid retry attempt');
  }

  return Math.min(1_000 * 2 ** (attempt - 1), 30_000);
}
