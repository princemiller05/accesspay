import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startServer, card, PK, SK, type TestServer } from './helpers.ts';
import { signPayload, verifySignature } from '../../server/gateway/webhooks.ts';

let s: TestServer;
beforeAll(async () => {
  s = await startServer();
});
afterAll(async () => {
  await s.close();
});

async function createPI(body: Record<string, unknown> = {}) {
  const r = await s.api('POST', '/v1/payment_intents', { key: SK, body: { amount: 249900, currency: 'inr', ...body } });
  expect(r.status).toBe(200);
  return r.body as { id: string; client_secret: string; status: string };
}
const confirm = (pi: { id: string; client_secret: string }, c: unknown) =>
  s.api('POST', `/v1/payment_intents/${pi.id}/confirm`, { key: PK, body: { client_secret: pi.client_secret, card: c } });
const verifyOtp = (pi: { id: string; client_secret: string }, otp: string) =>
  s.api('POST', `/v1/payment_intents/${pi.id}/verify_otp`, { key: PK, body: { client_secret: pi.client_secret, otp } });

describe('API keys', () => {
  it('rejects requests without a key', async () => {
    const r = await s.api('POST', '/v1/payment_intents', { body: { amount: 1000, currency: 'inr' } });
    expect(r.status).toBe(401);
    expect(r.body.error.code).toBe('missing_api_key');
  });

  it('rejects unknown keys', async () => {
    const r = await s.api('GET', '/v1/payment_intents', { key: 'sk_test_wrong' });
    expect(r.status).toBe(401);
  });

  it('does not let a publishable key create payments or refunds', async () => {
    expect((await s.api('POST', '/v1/payment_intents', { key: PK, body: { amount: 1000, currency: 'inr' } })).status).toBe(403);
    expect((await s.api('POST', '/v1/refunds', { key: PK, body: {} })).status).toBe(403);
  });

  it('does not let a secret key be used for browser-side confirm', async () => {
    const pi = await createPI();
    const r = await s.api('POST', `/v1/payment_intents/${pi.id}/confirm`, { key: SK, body: { client_secret: pi.client_secret, card: card('4242424242424242') } });
    expect(r.status).toBe(403);
  });
});

describe('creating payments', () => {
  it.each([
    [{ amount: 2499.5 }, 'amount_invalid'],
    [{ amount: 50 }, 'amount_invalid'],
    [{ amount: '249900' }, 'amount_invalid'],
    [{ amount: 1e12 }, 'amount_too_large'],
    [{ currency: 'usd' }, 'currency_not_supported'],
    [{ capture_method: 'later' }, 'capture_method_invalid'],
  ])('rejects %o', async (override, code) => {
    const r = await s.api('POST', '/v1/payment_intents', { key: SK, body: { amount: 249900, currency: 'inr', ...override } });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe(code);
  });

  it('returns a client_secret only on create', async () => {
    const pi = await createPI();
    expect(pi.client_secret).toMatch(new RegExp(`^${pi.id}_secret_`));
    const r = await s.api('GET', `/v1/payment_intents/${pi.id}`, { key: SK });
    expect(r.body.client_secret).toBeUndefined();
  });

  it('paginates with a cursor', async () => {
    for (let i = 0; i < 3; i++) await createPI();
    const first = await s.api('GET', '/v1/payment_intents?limit=2', { key: SK });
    expect(first.body.data).toHaveLength(2);
    expect(first.body.has_more).toBe(true);
    const next = await s.api('GET', `/v1/payment_intents?limit=2&starting_after=${first.body.data[1].id}`, { key: SK });
    const ids = new Set([...first.body.data, ...next.body.data].map((p: { id: string }) => p.id));
    expect(ids.size).toBe(first.body.data.length + next.body.data.length); // no duplicates across pages
  });
});

describe('confirming with a card', () => {
  it('approves a frictionless card and never stores the card number or CVV', async () => {
    const pi = await createPI();
    const r = await confirm(pi, card('4242424242424242', { cvc: '987' }));
    expect(r.status).toBe(200);
    expect(r.body.status).toBe('succeeded');
    expect(r.body.payment_method).toMatchObject({ brand: 'visa', last4: '4242' });

    const dump = JSON.stringify(await s.db.query('SELECT * FROM cards')) + JSON.stringify(await s.db.query('SELECT * FROM payment_intents')) + JSON.stringify(await s.db.query('SELECT * FROM events'));
    expect(dump).not.toContain('4242424242424242');
    expect(dump).not.toContain('987');
  });

  it('rejects a wrong client_secret', async () => {
    const pi = await createPI();
    const r = await confirm({ ...pi, client_secret: `${pi.id}_secret_guess` }, card('4242424242424242'));
    expect(r.status).toBe(401);
  });

  it('re-validates the card on the server (never trust the browser)', async () => {
    const pi = await createPI();
    const r = await confirm(pi, card('4242424242424241'));
    expect(r.status).toBe(402);
    expect(r.body.error).toMatchObject({ code: 'invalid_number', param: 'card.number' });
    const amex = await confirm(pi, card('378282246310005', { cvc: '123' }));
    expect(amex.body.error.code).toBe('invalid_cvc');
  });

  it('handles a decline, then lets the customer retry with another card', async () => {
    const pi = await createPI();
    const declined = await confirm(pi, card('4000000000009995'));
    expect(declined.status).toBe(402);
    expect(declined.body.error).toMatchObject({ type: 'card_error', code: 'card_declined', decline_code: 'insufficient_funds' });
    const after = await s.api('GET', `/v1/payment_intents/${pi.id}`, { key: SK });
    expect(after.body.status).toBe('requires_payment_method');

    const retry = await confirm(pi, card('4242424242424242'));
    expect(retry.body.status).toBe('succeeded');
  });

  it('hides "lost card" from the customer', async () => {
    const pi = await createPI();
    const r = await confirm(pi, card('4000000000009987'));
    expect(r.body.error.message).not.toMatch(/lost/i);
  });

  it('lets only one of two simultaneous confirms through (no double charge)', async () => {
    const pi = await createPI();
    const results = await Promise.all([confirm(pi, card('4242424242424242')), confirm(pi, card('4242424242424242'))]);
    const statuses = results.map((r) => r.status).sort();
    expect(statuses).toEqual([200, 400]);
    expect(results.find((r) => r.status === 400)!.body.error.code).toBe('payment_intent_unexpected_state');
  });
});

describe('OTP step', () => {
  it('requires OTP for 4111…, then succeeds with the right code', async () => {
    const pi = await createPI();
    const r = await confirm(pi, card('4111111111111111'));
    expect(r.body.status).toBe('requires_action');
    expect(r.body.next_action.type).toBe('otp');
    const code = r.body.next_action.otp.test_code;
    expect(code).toMatch(/^\d{6}$/);

    const ok = await verifyOtp(pi, code);
    expect(ok.body.status).toBe('succeeded');
  });

  it('counts down attempts and fails the payment after 3 wrong codes', async () => {
    const pi = await createPI();
    const { body } = await confirm(pi, card('4111111111111111'));
    const wrong = body.next_action.otp.test_code === '000000' ? '111111' : '000000';

    const a1 = await verifyOtp(pi, wrong);
    expect(a1.status).toBe(400);
    expect(a1.body.error.attempts_remaining).toBe(2);
    await verifyOtp(pi, wrong);
    const a3 = await verifyOtp(pi, wrong);
    expect(a3.status).toBe(402);
    expect(a3.body.error.code).toBe('authentication_failed');
    // the right code no longer works
    const late = await verifyOtp(pi, body.next_action.otp.test_code);
    expect(late.body.error.code).toBe('payment_intent_unexpected_state');
  });

  it('rejects an expired code', async () => {
    const pi = await createPI();
    const { body } = await confirm(pi, card('4111111111111111'));
    await s.db.query("UPDATE payment_intents SET otp_expires_at = now() - interval '1 second' WHERE id = $1", [pi.id]);
    const r = await verifyOtp(pi, body.next_action.otp.test_code);
    expect(r.body.error.code).toBe('otp_expired');
  });

  it('issues a new code on resend (old one stops working) and limits resends', async () => {
    const pi = await createPI();
    const { body } = await confirm(pi, card('4111111111111111'));
    const resend = () => s.api('POST', `/v1/payment_intents/${pi.id}/resend_otp`, { key: PK, body: { client_secret: pi.client_secret } });
    const r1 = await resend();
    const newCode = r1.body.next_action.otp.test_code;
    if (newCode !== body.next_action.otp.test_code) {
      expect((await verifyOtp(pi, body.next_action.otp.test_code)).body.error.code).toBe('incorrect_otp');
    }
    await resend();
    const r3 = await resend();
    expect(r3.status).toBe(429);
  });
});

describe('capture and refunds', () => {
  async function authorized() {
    const pi = await createPI({ capture_method: 'manual' });
    const r = await confirm(pi, card('4242424242424242'));
    expect(r.body.status).toBe('requires_capture');
    expect(r.body.amount_capturable).toBe(249900);
    return pi;
  }

  it('captures part of an authorised amount', async () => {
    const pi = await authorized();
    const r = await s.api('POST', `/v1/payment_intents/${pi.id}/capture`, { key: SK, body: { amount_to_capture: 200000 } });
    expect(r.body).toMatchObject({ status: 'succeeded', amount_received: 200000, amount_capturable: 0 });
    const again = await s.api('POST', `/v1/payment_intents/${pi.id}/capture`, { key: SK, body: {} });
    expect(again.body.error.code).toBe('payment_intent_unexpected_state');
  });

  it('cannot capture more than authorised', async () => {
    const pi = await authorized();
    const r = await s.api('POST', `/v1/payment_intents/${pi.id}/capture`, { key: SK, body: { amount_to_capture: 300000 } });
    expect(r.status).toBe(400);
  });

  it('cancels an authorisation', async () => {
    const pi = await authorized();
    const r = await s.api('POST', `/v1/payment_intents/${pi.id}/cancel`, { key: SK, body: {} });
    expect(r.body).toMatchObject({ status: 'canceled', amount_capturable: 0 });
  });

  it('refunds partially, then the rest, and never more than was paid', async () => {
    const pi = await createPI();
    await confirm(pi, card('4242424242424242'));
    const refund = (amount?: number) => s.api('POST', '/v1/refunds', { key: SK, body: { payment_intent: pi.id, amount } });

    expect((await refund(50000)).body).toMatchObject({ object: 'refund', amount: 50000, status: 'succeeded' });
    expect((await refund(300000)).status).toBe(400); // more than remaining
    expect((await refund()).body.amount).toBe(199900); // default = the rest
    expect((await refund(1)).body.error.code).toBe('charge_already_refunded');

    const after = await s.api('GET', `/v1/payment_intents/${pi.id}`, { key: SK });
    expect(after.body.amount_refunded).toBe(249900);
  });

  it('cannot refund an unpaid payment', async () => {
    const pi = await createPI();
    const r = await s.api('POST', '/v1/refunds', { key: SK, body: { payment_intent: pi.id } });
    expect(r.body.error.code).toBe('payment_intent_unexpected_state');
  });
});

describe('idempotency keys', () => {
  it('replays the same response for a retried request', async () => {
    const opts = { key: SK, body: { amount: 100000, currency: 'inr' }, headers: { 'Idempotency-Key': 'order-42' } };
    const a = await s.api('POST', '/v1/payment_intents', opts);
    const b = await s.api('POST', '/v1/payment_intents', opts);
    expect(b.body.id).toBe(a.body.id);
    expect(b.headers.get('idempotent-replayed')).toBe('true');
  });

  it('rejects the same key with different parameters', async () => {
    const headers = { 'Idempotency-Key': 'order-43' };
    await s.api('POST', '/v1/payment_intents', { key: SK, body: { amount: 100000, currency: 'inr' }, headers });
    const r = await s.api('POST', '/v1/payment_intents', { key: SK, body: { amount: 999900, currency: 'inr' }, headers });
    expect(r.status).toBe(422);
    expect(r.body.error.code).toBe('idempotency_key_reused');
  });

  it('makes refunds safe to retry', async () => {
    const pi = await createPI();
    await confirm(pi, card('4242424242424242'));
    const opts = { key: SK, body: { payment_intent: pi.id, amount: 1000 }, headers: { 'Idempotency-Key': `refund-${pi.id}` } };
    await s.api('POST', '/v1/refunds', opts);
    await s.api('POST', '/v1/refunds', opts);
    const after = await s.api('GET', `/v1/payment_intents/${pi.id}`, { key: SK });
    expect(after.body.amount_refunded).toBe(1000); // refunded once, not twice
  });
});

describe('webhooks', () => {
  it('signs payloads; tampered bodies and old timestamps fail verification', () => {
    const body = '{"type":"payment_intent.succeeded"}';
    const header = signPayload('whsec_x', body);
    expect(verifySignature('whsec_x', body, header)).toBe(true);
    expect(verifySignature('whsec_x', body.replace('succeeded', 'failed'), header)).toBe(false);
    expect(verifySignature('whsec_other', body, header)).toBe(false);
    const old = signPayload('whsec_x', body, Math.floor(Date.now() / 1000) - 3600);
    expect(verifySignature('whsec_x', body, old)).toBe(false);
  });

  it('the demo shop learns about the payment via a signed webhook', async () => {
    const order = await s.api('POST', '/shop/api/orders', { body: {} });
    const pi = { id: order.body.payment_intent, client_secret: order.body.client_secret };
    await confirm(pi, card('4242424242424242'));
    await s.webhooks.idle();
    const o = await s.api('GET', `/shop/api/orders/${order.body.order_id}`);
    expect(o.body.status).toBe('authorized');
  });

  it('the shop rejects webhooks with a bad signature', async () => {
    const r = await fetch(`${s.url}/shop/webhooks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'AccessPay-Signature': 't=1,v1=abc' },
      body: '{}',
    });
    expect(r.status).toBe(400);
  });

  it('retries failed deliveries and logs every attempt', async () => {
    await s.db.query("UPDATE merchants SET webhook_url = $1", [`${s.url}/does-not-exist`]);
    const pi = await createPI();
    await s.webhooks.idle();
    const rows = await s.db.query<{ attempt: number; success: boolean; status_code: number }>(
      `SELECT d.attempt, d.success, d.status_code FROM webhook_deliveries d JOIN events e ON e.id = d.event_id
       WHERE e.data->>'id' = $1 ORDER BY d.attempt`,
      [pi.id],
    );
    expect(rows.map((r) => r.attempt)).toEqual([1, 2, 3]);
    expect(rows.every((r) => !r.success && r.status_code === 404)).toBe(true);
    await s.db.query("UPDATE merchants SET webhook_url = $1", [`${s.url}/shop/webhooks`]);
  });
});
