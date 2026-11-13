/**
 * Public endpoints used by customers (no API key):
 *   GET /checkout/api/sessions/:id   data for the hosted checkout page
 *   GET /l/:linkId                   open a payment link -> new session -> redirect to /pay/?s=…
 */
import { Router, type RequestHandler } from 'express';
import type { Checkout } from './checkout.ts';
import type { WebhookDispatcher } from './webhooks.ts';
import { ApiError } from '../lib/errors.ts';

/** Tiny fixed-window rate limiter (per IP, in memory). */
export function rateLimit(max: number, windowMs: number): RequestHandler {
  const hits = new Map<string, { count: number; start: number }>();
  return (req, _res, next) => {
    const key = req.ip ?? 'unknown';
    const now = Date.now();
    const h = hits.get(key);
    if (!h || now - h.start > windowMs) hits.set(key, { count: 1, start: now });
    else if (++h.count > max) return next(new ApiError(429, 'rate_limit_error', 'rate_limited', 'Too many requests. Try again in a minute.'));
    next();
  };
}

export function publicCheckoutRouter(checkout: Checkout, webhooks: WebhookDispatcher): Router {
  const r = Router();

  r.get('/checkout/api/sessions/:id', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store'); // contains the client_secret
    res.json(await checkout.publicSession(String(req.params.id)));
  });

  r.get('/l/:id', rateLimit(30, 60_000), async (req, res) => {
    try {
      const out = await checkout.sessionFromLink(String(req.params.id));
      webhooks.dispatch(out.events);
      // Relative redirect: stays on whatever host the customer used.
      res.redirect(303, `/pay/?s=${out.body.id}`);
    } catch (err) {
      const inactive = err instanceof ApiError && err.code === 'payment_link_inactive';
      res
        .status(inactive ? 410 : 404)
        .type('html')
        .send(
          `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
            `<title>Payment link unavailable – AccessPay</title></head><body style="font-family:system-ui,sans-serif;max-width:36rem;margin:3rem auto;padding:0 1rem;line-height:1.5">` +
            `<main><h1>${inactive ? 'This payment link is no longer active' : 'Payment link not found'}</h1>` +
            `<p>Please contact the shop that sent you this link.</p></main></body></html>`,
        );
    }
  });

  return r;
}
