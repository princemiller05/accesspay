/**
 * Hosted checkout: the "plug-in" way to use AccessPay.
 *
 * A merchant doesn't build a card form. Instead:
 *   - Checkout Session (some server code): their server calls
 *       POST /v1/checkout/sessions { amount, name, success_url, cancel_url }
 *     and redirects the customer to the returned `url` on OUR site.
 *   - Payment Link (no code): they create a link in the dashboard, e.g.
 *       https://accesspay…/l/plink_123   -> "Masala chai, ₹449"
 *     and put it behind any "Pay" button. Each visit creates a fresh session.
 *
 * The customer pays on our accessible checkout page, then is sent back to the
 * merchant's success_url (only ever on the merchant's own website).
 *
 * Why the amount can't come from the merchant's web page: anyone can edit a
 * page in their browser's dev tools and change ₹449 to ₹1. Amounts must come
 * from the merchant's server (sessions) or from our database (payment links).
 */
import type { Db } from '../db/index.ts';
import type { Config } from '../config.ts';
import type { Merchant } from './merchants.ts';
import type { PaymentIntents, PaymentIntentRow } from './payment-intents.ts';
import { recordEvent } from './events.ts';
import { ApiError, badRequest, notFound } from '../lib/errors.ts';
import { newId } from '../lib/crypto.ts';
import { assertSameSite } from '../lib/urls.ts';

export const SESSION_TTL_MS = 30 * 60_000;

interface SessionRow {
  id: string;
  merchant_id: string;
  payment_intent_id: string;
  payment_link_id: string | null;
  name: string;
  success_url: string | null;
  cancel_url: string | null;
  expires_at: Date | string;
  completed_at: Date | string | null;
  created_at: Date | string;
}

interface LinkRow {
  id: string;
  merchant_id: string;
  name: string;
  description: string | null;
  amount: string | number;
  currency: string;
  success_url: string | null;
  active: boolean;
  created_at: Date | string;
}

const unix = (d: Date | string) => Math.floor(new Date(d).getTime() / 1000);

function sessionStatus(s: SessionRow): 'open' | 'complete' | 'expired' {
  if (s.completed_at) return 'complete';
  return new Date(s.expires_at).getTime() < Date.now() ? 'expired' : 'open';
}

/** success_url with ?session_id=cs_… added, so the merchant knows which payment came back. */
function withSessionId(url: string | null, id: string): string | null {
  if (!url) return null;
  const u = new URL(url);
  u.searchParams.set('session_id', id);
  return u.toString();
}

function serializeSession(s: SessionRow, pi: { amount: number | string; currency: string; status: string }, cfg: Config) {
  const paid = pi.status === 'succeeded' ? 'paid' : pi.status === 'requires_capture' ? 'authorized' : 'unpaid';
  return {
    id: s.id,
    object: 'checkout.session',
    url: `${cfg.publicUrl}/pay/?s=${s.id}`,
    status: sessionStatus(s),
    payment_status: paid,
    name: s.name,
    amount: Number(pi.amount),
    currency: pi.currency,
    payment_intent: s.payment_intent_id,
    payment_link: s.payment_link_id,
    success_url: s.success_url,
    cancel_url: s.cancel_url,
    expires_at: unix(s.expires_at),
    created: unix(s.created_at),
  };
}

function serializeLink(l: LinkRow, cfg: Config) {
  return {
    id: l.id,
    object: 'payment_link',
    url: `${cfg.publicUrl}/l/${l.id}`,
    name: l.name,
    description: l.description,
    amount: Number(l.amount),
    currency: l.currency,
    success_url: l.success_url,
    active: l.active,
    created: unix(l.created_at),
  };
}

// ───────── hooks used by payment-intents.ts ─────────

/** Payments that belong to an expired checkout can't be confirmed. */
export async function assertSessionOpen(tx: Db, paymentIntentId: string): Promise<void> {
  const [s] = await tx.query<SessionRow>('SELECT * FROM checkout_sessions WHERE payment_intent_id = $1', [paymentIntentId]);
  if (s && sessionStatus(s) === 'expired') {
    throw badRequest('checkout_session_expired', 'This checkout has expired. Go back to the shop and start again.');
  }
}

/** Called in the same transaction as a successful authorisation. Returns an event id if a session completed. */
export async function completeSessionFor(tx: Db, pi: PaymentIntentRow, cfg: Config): Promise<string | null> {
  const [s] = await tx.query<SessionRow>(
    'UPDATE checkout_sessions SET completed_at = now() WHERE payment_intent_id = $1 AND completed_at IS NULL RETURNING *',
    [pi.id],
  );
  if (!s) return null;
  return recordEvent(tx, s.merchant_id, 'checkout.session.completed', serializeSession(s, pi, cfg));
}

// ───────── service ─────────

export class Checkout {
  private db: Db;
  private cfg: Config;
  private intents: PaymentIntents;

  constructor(db: Db, cfg: Config, intents: PaymentIntents) {
    this.db = db;
    this.cfg = cfg;
    this.intents = intents;
  }

  private get allowLocalHttp() {
    return !this.cfg.production;
  }

  async createSession(merchant: Merchant, input: Record<string, unknown>, paymentLinkId: string | null = null) {
    const name = String(input.name ?? '').trim().slice(0, 120);
    if (!name) throw badRequest('parameter_missing', 'name is required: what the customer is paying for, e.g. "Order #1042"', 'name');
    const successUrl = input.success_url == null ? null : assertSameSite(input.success_url, merchant.website_url, 'success_url', this.allowLocalHttp);
    const cancelUrl = input.cancel_url == null ? null : assertSameSite(input.cancel_url, merchant.website_url, 'cancel_url', this.allowLocalHttp);

    return this.db.transaction(async (tx) => {
      const { row: pi, eventId } = await this.intents.createWithin(tx, merchant, {
        amount: input.amount,
        currency: input.currency ?? 'inr',
        capture_method: input.capture_method,
        description: name,
      });
      const [s] = await tx.query<SessionRow>(
        `INSERT INTO checkout_sessions (id, merchant_id, payment_intent_id, payment_link_id, name, success_url, cancel_url, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
        [newId('cs'), merchant.id, pi.id, paymentLinkId, name, successUrl, cancelUrl, new Date(Date.now() + SESSION_TTL_MS)],
      );
      return { body: serializeSession(s, pi, this.cfg), events: [eventId] };
    });
  }

  async retrieveSession(merchant: Merchant, id: string) {
    const [s] = await this.db.query<SessionRow>('SELECT * FROM checkout_sessions WHERE id = $1 AND merchant_id = $2', [id, merchant.id]);
    if (!s) throw notFound(`checkout session: ${id}`);
    const [pi] = await this.db.query<PaymentIntentRow>('SELECT * FROM payment_intents WHERE id = $1', [s.payment_intent_id]);
    return serializeSession(s, pi, this.cfg);
  }

  /**
   * What the hosted checkout page needs. Public (no API key): the session id
   * is unguessable (96 random bits), the same model as Stripe Checkout URLs.
   */
  async publicSession(id: string) {
    const [s] = await this.db.query<SessionRow & { merchant_name: string; publishable_key: string }>(
      `SELECT cs.*, m.name AS merchant_name, m.publishable_key
       FROM checkout_sessions cs JOIN merchants m ON m.id = cs.merchant_id WHERE cs.id = $1`,
      [id],
    );
    if (!s) throw notFound('checkout session');
    const [pi] = await this.db.query<PaymentIntentRow>('SELECT * FROM payment_intents WHERE id = $1', [s.payment_intent_id]);
    const status = sessionStatus(s);
    return {
      id: s.id,
      status,
      merchant_name: s.merchant_name,
      name: s.name,
      amount: Number(pi.amount),
      currency: pi.currency,
      publishable_key: s.publishable_key,
      payment_intent: pi.id,
      // Only while the customer can still pay.
      client_secret: status === 'open' ? pi.client_secret : null,
      success_url: withSessionId(s.success_url, s.id),
      cancel_url: s.cancel_url,
      expires_at: unix(s.expires_at),
    };
  }

  // ───── payment links ─────

  async createLink(merchant: Merchant, input: Record<string, unknown>) {
    const name = String(input.name ?? '').trim().slice(0, 120);
    if (!name) throw badRequest('parameter_missing', 'Enter a product name', 'name');
    const amount = input.amount;
    if (typeof amount !== 'number' || !Number.isInteger(amount) || amount < 100 || amount > 10_00_000_00) {
      throw badRequest('amount_invalid', 'Price must be between ₹1 and ₹10,00,000', 'amount');
    }
    const description = input.description ? String(input.description).slice(0, 500) : null;
    const successUrl = input.success_url ? assertSameSite(input.success_url, merchant.website_url, 'success_url', this.allowLocalHttp) : null;
    const [l] = await this.db.query<LinkRow>(
      `INSERT INTO payment_links (id, merchant_id, name, description, amount, currency, success_url)
       VALUES ($1, $2, $3, $4, $5, 'inr', $6) RETURNING *`,
      [newId('plink'), merchant.id, name, description, amount, successUrl],
    );
    return serializeLink(l, this.cfg);
  }

  async listLinks(merchant: Merchant) {
    const rows = await this.db.query<LinkRow>('SELECT * FROM payment_links WHERE merchant_id = $1 ORDER BY created_at DESC LIMIT 100', [merchant.id]);
    return { object: 'list', data: rows.map((l) => serializeLink(l, this.cfg)) };
  }

  async setLinkActive(merchant: Merchant, id: string, active: boolean) {
    const [l] = await this.db.query<LinkRow>('UPDATE payment_links SET active = $3 WHERE id = $1 AND merchant_id = $2 RETURNING *', [id, merchant.id, active]);
    if (!l) throw notFound(`payment link: ${id}`);
    return serializeLink(l, this.cfg);
  }

  /** A customer opened a payment link: start a fresh checkout session for it. */
  async sessionFromLink(linkId: string) {
    const [l] = await this.db.query<LinkRow>('SELECT * FROM payment_links WHERE id = $1', [linkId]);
    if (!l) throw notFound('payment link');
    if (!l.active) throw new ApiError(410, 'invalid_request_error', 'payment_link_inactive', 'This payment link is no longer active');
    const [merchant] = await this.db.query<Merchant>('SELECT * FROM merchants WHERE id = $1', [l.merchant_id]);
    return this.createSession(merchant, { name: l.name, amount: Number(l.amount), currency: l.currency, success_url: l.success_url ?? undefined }, l.id);
  }
}
