import { describe, expect, test } from 'bun:test';

import {
  MAX_REFERENCE_ATTEMPTS,
  referenceRetryDelayMs,
} from '../../../src/application/wagering/reference-retry-policy';

describe('Reference retry policy', () => {
  test('should use exponential backoff', () => {
    expect(referenceRetryDelayMs(1)).toBe(1_000);
    expect(referenceRetryDelayMs(2)).toBe(2_000);
    expect(referenceRetryDelayMs(3)).toBe(4_000);
    expect(referenceRetryDelayMs(4)).toBe(8_000);
  });

  test('should limit retry delays', () => {
    expect(referenceRetryDelayMs(10)).toBe(30_000);
  });

  test('should reject invalid attempts', () => {
    expect(() => referenceRetryDelayMs(0)).toThrow();
    expect(() => referenceRetryDelayMs(-1)).toThrow();
    expect(() => referenceRetryDelayMs(1.5)).toThrow();
  });

  test('should define a finite retry limit', () => {
    expect(MAX_REFERENCE_ATTEMPTS).toBe(5);
  });
});
