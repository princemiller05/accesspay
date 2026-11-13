/**
 * Merchant dashboard API. Merchants log in with email + password; the
 * dashboard then uses a session cookie (never an API key in the browser).
 *
 * Session cookie: "<merchantId>.<expiresAt>.<HMAC>", HttpOnly (JavaScript
 * can't read it, which limits XSS damage), SameSite=Lax and Secure in production.
 *
 * CSRF protection: SameSite=Lax stops other sites sending the cookie on POSTs,
 * and we additionally require a JSON body and a same-origin Origin header.
 */
import express, { Router, type RequestHandler, type Response } from 'express';
import type { Db } from '../db/index.ts';
import type { Config } from '../config.ts';
import { ApiError } from '../lib/errors.ts';
import { hmac, safeEqual, verifyPassword } from '../lib/crypto.ts';
import { createMerchant, findByEmail, findById, rollSecretKey, updateSettings, type Merchant } from '../gateway/merchants.ts';
import type { PaymentIntents } from '../gateway/payment-intents.ts';
import type { WebhookDispatcher } from '../gateway/webhooks.ts';
import type { Checkout } from '../gateway/checkout.ts';
import { badRequest } from '../lib/errors.ts';
import { parseHttpUrl, resolvesToPrivateAddress } from '../lib/urls.ts';
import { rateLimit } from '../gateway/public-checkout.ts';

const COOKIE = 'ap_session';
const SESSION_MS = 8 * 60 * 60_000;
const LOGIN_WINDOW_MS = 15 * 60_000;
const MAX_LOGIN_ATTEMPTS = 5;

export function dashboardRouter(db: Db, cfg: Config, intents: PaymentIntents, checkout: Checkout, webhooks: WebhookDispatcher): Router {
  const r = Router();
  r.use(express.json({ limit: '10kb' }));

  const sign = (value: string) => `${value}.${hmac(cfg.appSecret, `session:${value}`)}`;
  const readSession = (cookieHeader: string | undefined): string | null => {
    const raw = cookieHeader?.split(/;\s*/).find((c) => c.startsWith(`${COOKIE}=`))?.slice(COOKIE.length + 1);
    if (!raw) return null;
    const [merchantId, exp, sig] = decodeURIComponent(raw).split('.');
    if (!merchantId || !exp || !sig) return null;
    if (!safeEqual(sig, hmac(cfg.appSecret, `session:${merchantId}.${exp}`))) return null;
    if (Number(exp) < Date.now()) return null;
    return merchantId;
  };
  const setCookie = (res: Response, value: string, maxAgeMs: number) => {
    res.cookie(COOKIE, value, {
      httpOnly: true,
      sameSite: 'lax',
      secure: cfg.production,
      maxAge: maxAgeMs,
      path: '/',
    });
  };

  // Very small in-memory rate limit for logins (per email + IP).
  const attempts = new Map<string, { count: number; first: number }>();

  const publicOrigin = new URL(cfg.publicUrl).origin;
  const allowedOrigins = (host: string | undefined) =>
    new Set([publicOrigin, ...(host ? [`http://${host}`, `https://${host}`] : [])]);

  const sameOrigin: RequestHandler = (req, _res, next) => {
    if (req.method === 'GET') return next();
    const origin = req.header('origin');
    // Allowed: this server's own host, or its public address (PUBLIC_URL). The second
    // matters when a proxy (Vite in development, a load balancer in production)
    // rewrites the Host header before the request reaches us.
    if (origin && !allowedOrigins(req.header('host')).has(origin)) {
      return next(new ApiError(403, 'invalid_request_error', 'bad_origin', 'Cross-site request blocked'));
    }
    if (!req.is('application/json')) {
      return next(new ApiError(415, 'invalid_request_error', 'json_required', 'Send JSON'));
    }
    next();
  };
  r.use(sameOrigin);

  const requireSession: RequestHandler = async (req, res, next) => {
    try {
      const id = readSession(req.header('cookie'));
      const merchant = id ? await findById(db, id) : undefined;
      if (!merchant) throw new ApiError(401, 'authentication_error', 'not_logged_in', 'Please log in');
      res.locals.merchant = merchant;
      next();
    } catch (e) {
      next(e);
    }
  };
  const merchantOf = (res: Response) => res.locals.merchant as Merchant;

  const startSession = (res: Response, merchantId: string) =>
    setCookie(res, sign(`${merchantId}.${Date.now() + SESSION_MS}`), SESSION_MS);

  /**
   * Sign-up: creates a merchant with fresh TEST keys. The secret key is
   * returned only in this response; afterwards we only have its hash.
   */
  r.post('/signup', rateLimit(5, 60 * 60_000), async (req, res) => {
    const name = String(req.body?.name ?? '').trim();
    const email = String(req.body?.email ?? '').trim();
    const password = String(req.body?.password ?? '');
    if (!name || name.length > 80) throw badRequest('name_invalid', 'Enter your business name (up to 80 characters)', 'name');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw badRequest('email_invalid', 'Enter an email address like name@example.com', 'email');
    if (password.length < 10) throw badRequest('password_too_short', 'Password must be at least 10 characters', 'password');
    const website = parseHttpUrl(req.body?.website_url, 'website_url', { allowLocalHttp: !cfg.production });
    if (await findByEmail(db, email)) {
      throw new ApiError(409, 'invalid_request_error', 'email_taken', 'An account with this email already exists. Log in instead.', 'email');
    }
    const { merchant, keys } = await createMerchant(db, { name, email, password, websiteUrl: website.origin });
    startSession(res, merchant.id);
    res.status(201).json({ ok: true, keys });
  });

  r.post('/login', async (req, res) => {
    const email = String(req.body?.email ?? '').trim();
    const password = String(req.body?.password ?? '');
    const key = `${email.toLowerCase()}|${req.ip}`;
    const now = Date.now();
    const a = attempts.get(key);
    if (a && now - a.first < LOGIN_WINDOW_MS && a.count >= MAX_LOGIN_ATTEMPTS) {
      throw new ApiError(429, 'rate_limit_error', 'too_many_attempts', 'Too many attempts. Wait 15 minutes and try again.');
    }
    const merchant = email ? await findByEmail(db, email) : undefined;
    const ok = merchant ? await verifyPassword(password, merchant.password_hash) : false;
    if (!merchant || !ok) {
      attempts.set(key, a && now - a.first < LOGIN_WINDOW_MS ? { ...a, count: a.count + 1 } : { count: 1, first: now });
      // Same message for "no such email" and "wrong password": don't reveal which emails exist.
      throw new ApiError(401, 'authentication_error', 'invalid_credentials', 'Email or password is incorrect');
    }
    attempts.delete(key);
    startSession(res, merchant.id);
    res.json({ ok: true });
  });

  r.post('/logout', (_req, res) => {
    setCookie(res, '', 0);
    res.json({ ok: true });
  });

  r.get('/me', requireSession, (_req, res) => {
    const m = merchantOf(res);
    res.json({
      name: m.name,
      email: m.email,
      publishable_key: m.publishable_key,
      secret_key_hint: `sk_test_…${m.secret_key_last4}`,
      webhook_url: m.webhook_url,
      webhook_secret: m.webhook_secret,
      website_url: m.website_url,
    });
  });

  r.get('/payments', requireSession, async (req, res) => {
    res.json(
      await intents.list(merchantOf(res), {
        limit: req.query.limit ? Number(req.query.limit) : 50,
        status: req.query.status ? String(req.query.status) : undefined,
      }),
    );
  });

  r.post('/payments/:id/capture', requireSession, async (req, res) => {
    const out = await intents.capture(merchantOf(res), String(req.params.id));
    res.json(out.body);
    webhooks.dispatch(out.events);
  });

  r.post('/payments/:id/cancel', requireSession, async (req, res) => {
    const out = await intents.cancel(merchantOf(res), String(req.params.id));
    res.json(out.body);
    webhooks.dispatch(out.events);
  });

  r.post('/payments/:id/refund', requireSession, async (req, res) => {
    const amount = req.body?.amount === undefined ? undefined : Number(req.body.amount);
    const out = await intents.refund(merchantOf(res), { payment_intent: String(req.params.id), amount });
    res.json(out.body);
    webhooks.dispatch(out.events);
  });

  r.post('/keys/roll', requireSession, async (_req, res) => {
    res.json({ secret_key: await rollSecretKey(db, merchantOf(res).id) });
  });

  r.post('/settings', requireSession, async (req, res) => {
    const allowLocalHttp = !cfg.production;
    const website = req.body?.website_url;
    const webhook = req.body?.webhook_url;
    const update: { websiteUrl?: string; webhookUrl?: string | null } = {};
    if (website !== undefined) update.websiteUrl = parseHttpUrl(website, 'website_url', { allowLocalHttp }).origin;
    if (webhook !== undefined) {
      if (webhook === '' || webhook === null) update.webhookUrl = null;
      else {
        const url = parseHttpUrl(webhook, 'webhook_url', { allowLocalHttp });
        if (cfg.production && (await resolvesToPrivateAddress(url.toString()))) {
          throw badRequest('url_not_allowed', 'webhook_url must be a public address', 'webhook_url');
        }
        update.webhookUrl = url.toString();
      }
    }
    await updateSettings(db, merchantOf(res).id, update);
    res.json({ ok: true });
  });

  r.get('/links', requireSession, async (_req, res) => {
    res.json(await checkout.listLinks(merchantOf(res)));
  });

  r.post('/links', requireSession, async (req, res) => {
    res.status(201).json(await checkout.createLink(merchantOf(res), req.body ?? {}));
  });

  r.post('/links/:id/active', requireSession, async (req, res) => {
    res.json(await checkout.setLinkActive(merchantOf(res), String(req.params.id), Boolean(req.body?.active)));
  });

  r.get('/webhooks', requireSession, async (_req, res) => {
    const rows = await db.query(
      `SELECT d.id, d.attempt, d.status_code, d.success, d.error, d.created_at, e.type AS event_type, e.id AS event_id
       FROM webhook_deliveries d JOIN events e ON e.id = d.event_id
       WHERE d.merchant_id = $1 ORDER BY d.created_at DESC LIMIT 30`,
      [merchantOf(res).id],
    );
    res.json({ data: rows });
  });

  return r;
}
