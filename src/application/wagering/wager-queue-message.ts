import { z } from 'zod';

const common = z.strictObject({
  walletId: z.uuid(),
  providerId: z.string().min(1).max(128),
  externalTransactionId: z.string().min(1).max(128),
  currency: z.string().regex(/^[A-Z]{3}$/),
  amount: z.string().regex(/^(0|[1-9]\d{0,15})\.\d{2}$/),
});

const reversal = common.extend({
  referenceExternalTransactionId: z.string().min(1).max(128),
});

export const wagerQueueMessageSchema = z.strictObject({
  schemaVersion: z.literal(1),
  kind: z.literal('WAGER_TRANSACTION'),
  messageId: z.uuid(),
  payload: z.discriminatedUnion('type', [
    common.extend({ type: z.literal('BET') }),
    common.extend({ type: z.literal('WIN') }),
    common.extend({ type: z.literal('LOSS') }),
    reversal.extend({ type: z.literal('REFUND') }),
    reversal.extend({ type: z.literal('ROLLBACK') }),
  ]),
});

export type WagerQueueMessage = z.infer<typeof wagerQueueMessageSchema>;

export function parseWagerQueueMessage(body: string): WagerQueueMessage {
  const parsed: unknown = JSON.parse(body);

  return wagerQueueMessageSchema.parse(parsed);
}
