/**
 * "Chai & Co.": a pretend online shop that USES the gateway, the way a real
 * merchant would. It lives in this repo for the demo, but it only talks to the
 * gateway over HTTP with its secret key, exactly like an outside company.
 *
 * The important part: card details never pass through the shop. The shop
 * creates a payment, hands the browser a client_secret, and the browser sends
 * the card straight to the gateway. That keeps the shop out of PCI DSS scope.
 */
import express, { Router } from 'express';
import { randomUUID } from 'node:crypto';
import type { Config } from '../config.ts';
import { SIGNATURE_HEADER, verifySignature } from '../gateway/webhooks.ts';

interface Order {
  id: string;
  amount: number;
  status: 'awaiting_payment' | 'authorized' | 'paid' | 'payment_failed' | 'canceled' | 'refunded' | 'partially_refunded';
  paymentIntentId: string;
  refunded: number;
  history: Array<{ at: string; event: string }>;
}

const CART = [
  { name: 'Masala chai, 250 g', amount: 449_00 },
  { name: 'Hand-painted kulhad set (×4)', amount: 1650_00 },
  { name: 'Delivery', amount: 400_00 },
];

export function demoMerchantRouter(cfg: Config, gatewayUrl: () => string): Router {
  const r = Router();
  // The shop keeps its own records. In memory here; a real shop would use its own database.
  const orders = new Map<string, Order>();

  r.post('/api/orders', express.json(), async (_req, res, next) => {
    try {
      const orderId = `order_${randomUUID().slice(0, 8)}`;
      const amount = CART.reduce((sum, item) => sum + item.amount, 0);

      // Server-to-server call with the SECRET key. The Idempotency-Key means a
      // retried request can't create a second payment for the same order.
      const gw = await fetch(`${gatewayUrl()}/v1/payment_intents`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${cfg.demoSecretKey}`,
          'Content-Type': 'application/json',
          'Idempotency-Key': `create-${orderId}`,
        },
        body: JSON.stringify({
          amount,
          currency: 'inr',
          capture_method: 'manual', // authorise now, charge when the order ships
          description: `Chai & Co. ${orderId}`,
        }),
      });
      const pi = (await gw.json()) as { id: string; client_secret: string; error?: unknown };
      if (!gw.ok) {
        res.status(502).json({ error: 'Could not start payment', detail: pi.error });
        return;
      }
      orders.set(orderId, {
        id: orderId,
        amount,
        status: 'awaiting_payment',
        paymentIntentId: pi.id,
        refunded: 0,
        history: [{ at: new Date().toISOString(), event: 'order.created' }],
      });
      // Only the client_secret and PUBLISHABLE key go to the browser.
      res.json({
        order_id: orderId,
        amount,
        currency: 'inr',
        payment_intent: pi.id,
        client_secret: pi.client_secret,
        publishable_key: cfg.demoPublishableKey,
      });
    } catch (err) {
      next(err);
    }
  });

  r.get('/api/orders/:id', (req, res) => {
    const order = orders.get(req.params.id);
    if (!order) {
      res.status(404).json({ error: 'Order not found' });
      return;
    }
    res.json(order);
  });

  // Webhook receiver. Needs the RAW body: the signature is over the exact bytes sent.
  r.post('/webhooks', express.raw({ type: 'application/json', limit: '100kb' }), (req, res) => {
    const raw = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : '';
    if (!verifySignature(cfg.demoWebhookSecret, raw, req.header(SIGNATURE_HEADER))) {
      res.status(400).json({ error: 'Invalid signature' });
      return;
    }
    const event = JSON.parse(raw) as {
      type: string;
      data: { object: { id: string; payment_intent?: string; amount?: number; amount_received?: number; amount_refunded?: number } };
    };
    const piId = event.data.object.payment_intent ?? event.data.object.id;
    const order = [...orders.values()].find((o) => o.paymentIntentId === piId);
    if (order) {
      const next: Partial<Record<string, Order['status']>> = {
        'payment_intent.amount_capturable_updated': 'authorized',
        'payment_intent.succeeded': 'paid',
        'payment_intent.payment_failed': 'payment_failed',
        'payment_intent.canceled': 'canceled',
      };
      if (event.type === 'refund.created') {
        order.refunded += event.data.object.amount ?? 0;
        order.status = order.refunded >= order.amount ? 'refunded' : 'partially_refunded';
      } else if (next[event.type]) {
        order.status = next[event.type]!;
      }
      order.history.push({ at: new Date().toISOString(), event: event.type });
    }
    // Always answer 2xx quickly; otherwise the gateway retries.
    res.json({ received: true });
  });

  return r;
}
