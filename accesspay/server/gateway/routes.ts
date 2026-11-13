import { Router, type Request, type Response } from 'express';
import type { Db } from '../db/index.ts';
import { authOf, requireKey } from './auth.ts';
import { idempotency } from './idempotency.ts';
import type { PaymentIntents, Outcome } from './payment-intents.ts';
import type { WebhookDispatcher } from './webhooks.ts';
import type { Checkout } from './checkout.ts';

/**
 * Public REST API, versioned under /v1.
 *
 *   POST /v1/payment_intents                     sk  create
 *   GET  /v1/payment_intents                     sk  list (cursor pagination)
 *   GET  /v1/payment_intents/:id                 sk  retrieve  (pk + ?client_secret= also allowed)
 *   POST /v1/payment_intents/:id/confirm         pk  submit card details from the browser
 *   POST /v1/payment_intents/:id/verify_otp      pk  submit the OTP
 *   POST /v1/payment_intents/:id/resend_otp      pk  request a new OTP
 *   POST /v1/payment_intents/:id/capture         sk  take an authorised payment
 *   POST /v1/payment_intents/:id/cancel          sk
 *   POST /v1/refunds                             sk  full or partial refund
 *   POST /v1/checkout/sessions                   sk  hosted checkout: returns a URL to send the customer to
 *   GET  /v1/checkout/sessions/:id               sk
 *   POST /v1/payment_links                       sk  no-code link for a fixed product + price
 *   GET  /v1/payment_links                       sk
 */
export function gatewayRouter(db: Db, intents: PaymentIntents, checkout: Checkout, webhooks: WebhookDispatcher): Router {
  const r = Router();
  const secret = requireKey(db, ['secret']);
  const publishable = requireKey(db, ['publishable']);
  const either = requireKey(db, ['secret', 'publishable']);
  const idem = idempotency(db);

  // Send the response, then deliver any webhook events the change produced.
  const respond = (res: Response, outcome: Outcome<unknown>) => {
    res.status(outcome.status ?? 200).json(outcome.body);
    webhooks.dispatch(outcome.events);
  };
  const body = (req: Request) => (req.body && typeof req.body === 'object' ? req.body : {}) as Record<string, unknown>;
  const id = (req: Request) => String(req.params.id);

  r.post('/payment_intents', secret, idem, async (req, res) => {
    respond(res, await intents.create(authOf(res).merchant, body(req)));
  });

  r.get('/payment_intents', secret, async (req, res) => {
    res.json(
      await intents.list(authOf(res).merchant, {
        limit: req.query.limit ? Number(req.query.limit) : undefined,
        startingAfter: req.query.starting_after ? String(req.query.starting_after) : undefined,
        status: req.query.status ? String(req.query.status) : undefined,
      }),
    );
  });

  r.get('/payment_intents/:id', either, async (req, res) => {
    const { merchant, keyKind } = authOf(res);
    // With a publishable key you must prove you own this payment with its client_secret.
    const cs = keyKind === 'publishable' ? String(req.query.client_secret ?? '') : undefined;
    res.json(await intents.retrieve(merchant, id(req), cs));
  });

  r.post('/payment_intents/:id/confirm', publishable, async (req, res) => {
    respond(res, await intents.confirm(authOf(res).merchant, id(req), body(req)));
  });

  r.post('/payment_intents/:id/verify_otp', publishable, async (req, res) => {
    respond(res, await intents.verifyOtp(authOf(res).merchant, id(req), body(req)));
  });

  r.post('/payment_intents/:id/resend_otp', publishable, async (req, res) => {
    respond(res, await intents.resendOtp(authOf(res).merchant, id(req), body(req)));
  });

  r.post('/payment_intents/:id/capture', secret, idem, async (req, res) => {
    respond(res, await intents.capture(authOf(res).merchant, id(req), body(req)));
  });

  r.post('/payment_intents/:id/cancel', secret, idem, async (req, res) => {
    respond(res, await intents.cancel(authOf(res).merchant, id(req)));
  });

  r.post('/refunds', secret, idem, async (req, res) => {
    respond(res, await intents.refund(authOf(res).merchant, body(req)));
  });

  r.post('/checkout/sessions', secret, idem, async (req, res) => {
    respond(res, await checkout.createSession(authOf(res).merchant, body(req)));
  });

  r.get('/checkout/sessions/:id', secret, async (req, res) => {
    res.json(await checkout.retrieveSession(authOf(res).merchant, id(req)));
  });

  r.post('/payment_links', secret, idem, async (req, res) => {
    res.json(await checkout.createLink(authOf(res).merchant, body(req)));
  });

  r.get('/payment_links', secret, async (_req, res) => {
    res.json(await checkout.listLinks(authOf(res).merchant));
  });

  return r;
}
