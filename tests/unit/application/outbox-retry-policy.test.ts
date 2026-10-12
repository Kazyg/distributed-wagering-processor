import { describe, expect, test } from 'bun:test';

import { outboxRetryDelayMs } from '../../../src/application/wagering/outbox-retry-policy';

describe('Outbox retry policy', () => {
  test('should use exponential backoff', () => {
    expect(outboxRetryDelayMs(1)).toBe(1_000);
    expect(outboxRetryDelayMs(2)).toBe(2_000);
    expect(outboxRetryDelayMs(3)).toBe(4_000);
    expect(outboxRetryDelayMs(4)).toBe(8_000);
  });

  test('should cap the delay at five minutes', () => {
    expect(outboxRetryDelayMs(10)).toBe(300_000);
    expect(outboxRetryDelayMs(20)).toBe(300_000);
  });

  test('should reject invalid attempts', () => {
    expect(() => outboxRetryDelayMs(0)).toThrow();
    expect(() => outboxRetryDelayMs(-1)).toThrow();
    expect(() => outboxRetryDelayMs(1.5)).toThrow();
  });
});
