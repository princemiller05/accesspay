import type { Db } from '../db/index.ts';
import { newId } from '../lib/crypto.ts';

export type EventType =
  | 'payment_intent.created'
  | 'payment_intent.requires_action'
  | 'payment_intent.amount_capturable_updated' // authorised, waiting for capture
  | 'payment_intent.succeeded'
  | 'payment_intent.payment_failed'
  | 'payment_intent.canceled'
  | 'refund.created'
  | 'checkout.session.completed';

/**
 * Records an event in the SAME transaction as the state change that caused it
 * (the "transactional outbox" pattern). Either both are saved or neither is,
 * so a merchant can never miss a webhook for a payment that succeeded.
 * Delivery happens after the transaction commits (see webhooks.ts).
 */
export async function recordEvent(tx: Db, merchantId: string, type: EventType, data: unknown): Promise<string> {
  const id = newId('evt');
  await tx.query('INSERT INTO events (id, merchant_id, type, data) VALUES ($1, $2, $3, $4)', [
    id,
    merchantId,
    type,
    JSON.stringify(data),
  ]);
  return id;
}
