import { describe, expect, test } from 'bun:test';

import { withVisibilityHeartbeat } from '../../../src/infrastructure/messaging/sqs-visibility-heartbeat';

describe('SQS visibility heartbeat', () => {
  test('should renew while processing is running', async () => {
    let renewals = 0;

    const result = await withVisibilityHeartbeat(
      async () => {
        await Bun.sleep(100);
        return 'PROCESSED';
      },

      async () => {
        renewals += 1;
      },

      { intervalMs: 10 },
    );

    expect(result).toBe('PROCESSED');
    expect(renewals).toBeGreaterThan(0);
  });

  test('should stop after successful processing', async () => {
    let renewals = 0;

    await withVisibilityHeartbeat(
      async () => 'PROCESSED',

      async () => {
        renewals += 1;
      },

      { intervalMs: 10 },
    );

    await Bun.sleep(30);

    expect(renewals).toBe(0);
  });

  test('should propagate processing failures', async () => {
    await expect(
      withVisibilityHeartbeat(
        async () => {
          throw new Error('Database unavailable');
        },

        async () => {},

        { intervalMs: 10 },
      ),
    ).rejects.toThrow('Database unavailable');
  });

  test('should report heartbeat failures without losing the result', async () => {
    let failures = 0;

    const result = await withVisibilityHeartbeat(
      async () => {
        await Bun.sleep(70);
        return 'PROCESSED';
      },

      async () => {
        throw new Error('SQS temporarily unavailable');
      },

      {
        intervalMs: 10,
        onError: () => {
          failures += 1;
        },
      },
    );

    expect(result).toBe('PROCESSED');
    expect(failures).toBeGreaterThan(0);
  });
});
