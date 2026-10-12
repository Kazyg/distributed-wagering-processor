import { randomUUID } from 'node:crypto';
import { describe, expect, test } from 'bun:test';

import { parseWagerQueueMessage } from '../../../src/application/wagering/wager-queue-message';

function validMessage() {
  return {
    schemaVersion: 1,
    kind: 'WAGER_TRANSACTION',
    messageId: randomUUID(),
    payload: {
      type: 'BET',
      walletId: randomUUID(),
      providerId: 'test-provider',
      externalTransactionId: 'bet-123',
      amount: '30.00',
      currency: 'BRL',
    },
  };
}

describe('Wager queue message', () => {
  test('should parse a valid BET message', () => {
    const result = parseWagerQueueMessage(JSON.stringify(validMessage()));

    expect(result.schemaVersion).toBe(1);
    expect(result.payload.type).toBe('BET');
  });

  test('should reject malformed JSON', () => {
    expect(() => parseWagerQueueMessage('invalid-json')).toThrow();
  });

  test('should reject a REFUND without reference', () => {
    const event = validMessage();

    expect(() =>
      parseWagerQueueMessage(
        JSON.stringify({
          ...event,
          payload: {
            ...event.payload,
            type: 'REFUND',
          },
        }),
      ),
    ).toThrow();
  });
});
