export function outboxRetryDelayMs(attempt: number): number {
  if (!Number.isInteger(attempt) || attempt < 1) {
    throw new Error('Invalid outbox attempt');
  }

  return Math.min(1_000 * 2 ** Math.min(attempt - 1, 10), 300_000);
}
