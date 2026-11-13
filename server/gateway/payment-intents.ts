/**
 * PaymentIntent: one attempt to collect one amount from one customer.
 *
 *                    create
 *                      │
 *                      ▼
 *          ┌── requires_payment_method ◄──────────────┐ (declined / OTP failed:
 *          │           │ confirm (card)               │  customer can try another card)
 *          │           ├──────────► requires_action ──┤
 *          │           │              │ verify OTP    │
 *          │           ▼              ▼               │
 *          │    capture_method = automatic? ──yes──► succeeded ──► refunds
 *          │           │ no                           ▲
 *          │           ▼                              │ capture
 *          │     requires_capture ────────────────────┘
 *          ▼           │
 *       canceled ◄─────┘
 *
 * Every state change runs in a transaction with SELECT … FOR UPDATE, so two
 * simultaneous requests (e.g. a double-clicked Pay button) can't both succeed.
 */
import type { Db } from '../db/index.ts';
import type { Config } from '../config.ts';
import type { Merchant } from './merchants.ts';
import { ApiError, badRequest, notFound } from '../lib/errors.ts';
import { hmac, newId, newOtp, randomToken, safeEqual } from '../lib/crypto.ts';
import { recordEvent, type EventType } from './events.ts';
import { assertSessionOpen, completeSessionFor } from './checkout.ts';
import { authorize, DECLINE_MESSAGES, type DeclineCode } from './bank.ts';
import { detectNetwork } from '../../src/core/networks.ts';
import { onlyDigits } from '../../src/core/format.ts';
import { validateCardNumber, validateCvv, validateExpiry } from '../../src/core/validation.ts';

export type Status =
  | 'requires_payment_method'
  | 'requires_action'
  | 'requires_capture'
  | 'succeeded'
  | 'canceled';

export interface PaymentIntentRow {
  id: string;
  merchant_id: string;
  amount: string | number; // BIGINT comes back as a string from pg
  currency: string;
  description: string | null;
  status: Status;
  capture_method: 'automatic' | 'manual';
  client_secret: string;
  card_id: string | null;
  pending_card_id: string | null;
  amount_capturable: string | number;
  amount_received: string | number;
  amount_refunded: string | number;
  last_error_code: string | null;
  last_error_message: string | null;
  otp_hash: string | null;
  otp_expires_at: Date | string | null;
  otp_attempts: number;
  otp_sends: number;
  created_at: Date | string;
}

interface CardRow {
  id: string;
  brand: string;
  last4: string;
  exp_month: number;
  exp_year: number;
  cardholder: string;
}

export const SUPPORTED_CURRENCIES = ['inr'];
export const MAX_AMOUNT = 10_00_000_00; // ₹10,00,000 in paise
const OTP_TTL_MS = 5 * 60_000;
const MAX_OTP_ATTEMPTS = 3;
const MAX_OTP_SENDS = 3;

/** Result of a service call: the API response plus events to deliver after commit. */
export interface Outcome<T> {
  body: T;
  status?: number;
  events: string[];
}

export class PaymentIntents {
  private db: Db;
  private cfg: Config;

  constructor(db: Db, cfg: Config) {
    this.db = db;
    this.cfg = cfg;
  }

  // ───────────────────────── create ─────────────────────────

  async create(merchant: Merchant, input: Record<string, unknown>): Promise<Outcome<unknown>> {
    return this.db.transaction(async (tx) => {
      const { body, eventId } = await this.createWithin(tx, merchant, input);
      return { body, status: 200, events: [eventId] };
    });
  }

  /** Validate and insert inside an existing transaction (used by checkout sessions too). */
  async createWithin(tx: Db, merchant: Merchant, input: Record<string, unknown>) {
    const amount = input.amount;
    if (typeof amount !== 'number' || !Number.isInteger(amount) || amount < 100) {
      throw badRequest('amount_invalid', 'amount must be an integer in paise, at least 100 (₹1)', 'amount');
    }
    if (amount > MAX_AMOUNT) throw badRequest('amount_too_large', 'amount must be at most ₹10,00,000', 'amount');
    const currency = String(input.currency ?? '').toLowerCase();
    if (!SUPPORTED_CURRENCIES.includes(currency)) {
      throw badRequest('currency_not_supported', `currency must be one of: ${SUPPORTED_CURRENCIES.join(', ')}`, 'currency');
    }
    const captureMethod = input.capture_method ?? 'automatic';
    if (captureMethod !== 'automatic' && captureMethod !== 'manual') {
      throw badRequest('capture_method_invalid', 'capture_method must be "automatic" or "manual"', 'capture_method');
    }
    const description = input.description == null ? null : String(input.description).slice(0, 500);

    const id = newId('pi');
    const [row] = await tx.query<PaymentIntentRow>(
      `INSERT INTO payment_intents (id, merchant_id, amount, currency, description, status, capture_method, client_secret)
       VALUES ($1, $2, $3, $4, $5, 'requires_payment_method', $6, $7) RETURNING *`,
      [id, merchant.id, amount, currency, description, captureMethod, `${id}_secret_${randomToken(18)}`],
    );
    const body = await this.serialize(tx, row, { includeSecret: true });
    const eventId = await recordEvent(tx, merchant.id, 'payment_intent.created', await this.serialize(tx, row));
    return { body, row, eventId };
  }

  // ───────────────────────── read ─────────────────────────

  async retrieve(merchant: Merchant, id: string, clientSecret?: string): Promise<unknown> {
    const row = await this.get(this.db, merchant, id);
    if (clientSecret !== undefined) this.checkClientSecret(row, clientSecret);
    return this.serialize(this.db, row, { includeSecret: clientSecret !== undefined });
  }

  async list(merchant: Merchant, opts: { limit?: number; startingAfter?: string; status?: string }) {
    const limit = Math.min(Math.max(opts.limit ?? 20, 1), 100);
    const params: unknown[] = [merchant.id, limit + 1];
    let where = 'merchant_id = $1';
    if (opts.status) {
      params.push(opts.status);
      where += ` AND status = $${params.length}`;
    }
    if (opts.startingAfter) {
      // Cursor pagination: stable even while new payments arrive (unlike OFFSET).
      params.push(opts.startingAfter);
      where += ` AND (created_at, id) < (SELECT created_at, id FROM payment_intents WHERE id = $${params.length})`;
    }
    const rows = await this.db.query<PaymentIntentRow>(
      `SELECT * FROM payment_intents WHERE ${where} ORDER BY created_at DESC, id DESC LIMIT $2`,
      params,
    );
    const page = rows.slice(0, limit);
    return {
      object: 'list',
      has_more: rows.length > limit,
      data: await Promise.all(page.map((r) => this.serialize(this.db, r))),
    };
  }

  // ───────────────────────── confirm (browser, publishable key) ─────────────────────────

  async confirm(merchant: Merchant, id: string, input: Record<string, unknown>): Promise<Outcome<unknown>> {
    const card = parseCard(input.card);

    return this.db.transaction(async (tx) => {
      const pi = await this.lock(tx, merchant, id);
      this.checkClientSecret(pi, String(input.client_secret ?? ''));
      // requires_action too: the customer closed the OTP step and is trying again.
      this.expectStatus(pi, ['requires_payment_method', 'requires_action'], 'confirm');
      await assertSessionOpen(tx, pi.id);

      const cardId = await this.tokenize(tx, merchant, card);
      const decision = authorize(card.number);

      if (decision.result === 'declined') {
        return this.fail(tx, pi, 'card_declined', decision.declineCode);
      }
      if (decision.result === 'otp_required') {
        const otp = newOtp();
        const [row] = await tx.query<PaymentIntentRow>(
          `UPDATE payment_intents SET status = 'requires_action', pending_card_id = $2, otp_hash = $3,
             otp_expires_at = $4, otp_attempts = 0, otp_sends = 1,
             last_error_code = NULL, last_error_message = NULL, updated_at = now()
           WHERE id = $1 RETURNING *`,
          [pi.id, cardId, this.otpHash(pi.id, otp), new Date(Date.now() + OTP_TTL_MS)],
        );
        const body = await this.serialize(tx, row, { includeSecret: true, testOtp: otp });
        const evt = await recordEvent(tx, merchant.id, 'payment_intent.requires_action', await this.serialize(tx, row));
        return { body, events: [evt] };
      }
      return this.authorizeAndMaybeCapture(tx, pi, cardId);
    });
  }

  async verifyOtp(merchant: Merchant, id: string, input: Record<string, unknown>): Promise<Outcome<unknown>> {
    const otp = String(input.otp ?? '').trim();
    if (!/^\d{6}$/.test(otp)) throw badRequest('otp_invalid', 'Enter the 6-digit code', 'otp');

    return this.db.transaction(async (tx) => {
      const pi = await this.lock(tx, merchant, id);
      this.checkClientSecret(pi, String(input.client_secret ?? ''));
      this.expectStatus(pi, ['requires_action'], 'verify an OTP for');

      if (!pi.otp_expires_at || new Date(pi.otp_expires_at).getTime() < Date.now()) {
        throw badRequest('otp_expired', 'This code has expired. Request a new code.', 'otp');
      }
      if (!safeEqual(this.otpHash(pi.id, otp), pi.otp_hash ?? '')) {
        const attempts = pi.otp_attempts + 1;
        if (attempts >= MAX_OTP_ATTEMPTS) {
          return this.fail(tx, pi, 'authentication_failed');
        }
        await tx.query('UPDATE payment_intents SET otp_attempts = $2, updated_at = now() WHERE id = $1', [pi.id, attempts]);
        const left = MAX_OTP_ATTEMPTS - attempts;
        return {
          status: 400,
          events: [],
          body: {
            error: {
              type: 'card_error',
              code: 'incorrect_otp',
              message: `That code is incorrect. You have ${left} ${left === 1 ? 'attempt' : 'attempts'} left.`,
              attempts_remaining: left,
              param: 'otp',
            },
          },
        };
      }
      return this.authorizeAndMaybeCapture(tx, pi, pi.pending_card_id!);
    });
  }

  async resendOtp(merchant: Merchant, id: string, input: Record<string, unknown>): Promise<Outcome<unknown>> {
    return this.db.transaction(async (tx) => {
      const pi = await this.lock(tx, merchant, id);
      this.checkClientSecret(pi, String(input.client_secret ?? ''));
      this.expectStatus(pi, ['requires_action'], 'resend an OTP for');
      if (pi.otp_sends >= MAX_OTP_SENDS) {
        throw new ApiError(429, 'rate_limit_error', 'otp_send_limit', 'Too many codes requested. Start the payment again.');
      }
      const otp = newOtp();
      const [row] = await tx.query<PaymentIntentRow>(
        `UPDATE payment_intents SET otp_hash = $2, otp_expires_at = $3, otp_attempts = 0,
           otp_sends = otp_sends + 1, updated_at = now() WHERE id = $1 RETURNING *`,
        [pi.id, this.otpHash(pi.id, otp), new Date(Date.now() + OTP_TTL_MS)],
      );
      return { body: await this.serialize(tx, row, { includeSecret: true, testOtp: otp }), events: [] };
    });
  }

  // ───────────────────────── merchant actions (secret key) ─────────────────────────

  async capture(merchant: Merchant, id: string, input: Record<string, unknown> = {}): Promise<Outcome<unknown>> {
    return this.db.transaction(async (tx) => {
      const pi = await this.lock(tx, merchant, id);
      this.expectStatus(pi, ['requires_capture'], 'capture');
      const capturable = Number(pi.amount_capturable);
      const amount = input.amount_to_capture === undefined ? capturable : input.amount_to_capture;
      if (typeof amount !== 'number' || !Number.isInteger(amount) || amount < 1 || amount > capturable) {
        throw badRequest('amount_to_capture_invalid', `amount_to_capture must be between 1 and ${capturable}`, 'amount_to_capture');
      }
      const [row] = await tx.query<PaymentIntentRow>(
        `UPDATE payment_intents SET status = 'succeeded', amount_received = $2, amount_capturable = 0, updated_at = now()
         WHERE id = $1 RETURNING *`,
        [pi.id, amount],
      );
      const body = await this.serialize(tx, row);
      return { body, events: [await recordEvent(tx, merchant.id, 'payment_intent.succeeded', body)] };
    });
  }

  async cancel(merchant: Merchant, id: string): Promise<Outcome<unknown>> {
    return this.db.transaction(async (tx) => {
      const pi = await this.lock(tx, merchant, id);
      this.expectStatus(pi, ['requires_payment_method', 'requires_action', 'requires_capture'], 'cancel');
      const [row] = await tx.query<PaymentIntentRow>(
        `UPDATE payment_intents SET status = 'canceled', amount_capturable = 0, otp_hash = NULL, updated_at = now()
         WHERE id = $1 RETURNING *`,
        [pi.id],
      );
      const body = await this.serialize(tx, row);
      return { body, events: [await recordEvent(tx, merchant.id, 'payment_intent.canceled', body)] };
    });
  }

  async refund(merchant: Merchant, input: Record<string, unknown>): Promise<Outcome<unknown>> {
    const piId = String(input.payment_intent ?? '');
    if (!piId) throw badRequest('parameter_missing', 'payment_intent is required', 'payment_intent');
    return this.db.transaction(async (tx) => {
      const pi = await this.lock(tx, merchant, piId);
      this.expectStatus(pi, ['succeeded'], 'refund');
      const remaining = Number(pi.amount_received) - Number(pi.amount_refunded);
      const amount = input.amount === undefined ? remaining : input.amount;
      if (remaining <= 0) throw badRequest('charge_already_refunded', 'This payment has already been fully refunded');
      if (typeof amount !== 'number' || !Number.isInteger(amount) || amount < 1 || amount > remaining) {
        throw badRequest('amount_invalid', `amount must be between 1 and ${remaining} (the amount not yet refunded)`, 'amount');
      }
      const reason = input.reason == null ? null : String(input.reason).slice(0, 200);
      const [refund] = await tx.query<{ id: string; amount: string; reason: string | null; status: string; created_at: Date }>(
        `INSERT INTO refunds (id, merchant_id, payment_intent_id, amount, reason, status)
         VALUES ($1, $2, $3, $4, $5, 'succeeded') RETURNING *`,
        [newId('re'), merchant.id, pi.id, amount, reason],
      );
      await tx.query(
        'UPDATE payment_intents SET amount_refunded = amount_refunded + $2, updated_at = now() WHERE id = $1',
        [pi.id, amount],
      );
      const body = {
        id: refund.id,
        object: 'refund',
        amount: Number(refund.amount),
        currency: pi.currency,
        payment_intent: pi.id,
        reason: refund.reason,
        status: refund.status,
        created: toUnix(refund.created_at),
      };
      return { body, events: [await recordEvent(tx, merchant.id, 'refund.created', body)] };
    });
  }

  // ───────────────────────── helpers ─────────────────────────

  private async authorizeAndMaybeCapture(tx: Db, pi: PaymentIntentRow, cardId: string): Promise<Outcome<unknown>> {
    const automatic = pi.capture_method === 'automatic';
    const [row] = await tx.query<PaymentIntentRow>(
      `UPDATE payment_intents SET status = $2, card_id = $3, pending_card_id = NULL, otp_hash = NULL,
         amount_capturable = $4, amount_received = $5,
         last_error_code = NULL, last_error_message = NULL, updated_at = now()
       WHERE id = $1 RETURNING *`,
      [pi.id, automatic ? 'succeeded' : 'requires_capture', cardId, automatic ? 0 : pi.amount, automatic ? pi.amount : 0],
    );
    const body = await this.serialize(tx, row, { includeSecret: true });
    const type: EventType = automatic ? 'payment_intent.succeeded' : 'payment_intent.amount_capturable_updated';
    const events = [await recordEvent(tx, pi.merchant_id, type, await this.serialize(tx, row))];
    const sessionEvent = await completeSessionFor(tx, row, this.cfg);
    if (sessionEvent) events.push(sessionEvent);
    return { body, events };
  }

  /** Declined or authentication failed: back to requires_payment_method so the customer can try another card. */
  private async fail(tx: Db, pi: PaymentIntentRow, code: 'card_declined' | 'authentication_failed', declineCode?: DeclineCode) {
    const message =
      code === 'authentication_failed'
        ? 'Too many incorrect codes. The payment was not taken. Try again or use a different card.'
        : DECLINE_MESSAGES[declineCode!];
    const [row] = await tx.query<PaymentIntentRow>(
      `UPDATE payment_intents SET status = 'requires_payment_method', pending_card_id = NULL, otp_hash = NULL,
         last_error_code = $2, last_error_message = $3, updated_at = now() WHERE id = $1 RETURNING *`,
      [pi.id, declineCode ?? code, message],
    );
    const evt = await recordEvent(tx, pi.merchant_id, 'payment_intent.payment_failed', await this.serialize(tx, row));
    return {
      status: 402, // "Payment Required": the request was fine, the card wasn't
      events: [evt],
      body: { error: { type: 'card_error', code, ...(declineCode && { decline_code: declineCode }), message } },
    };
  }

  private async tokenize(tx: Db, merchant: Merchant, card: ParsedCard): Promise<string> {
    const id = newId('card');
    await tx.query(
      `INSERT INTO cards (id, merchant_id, fingerprint, brand, last4, exp_month, exp_year, cardholder)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [id, merchant.id, hmac(this.cfg.appSecret, `card:${card.number}`), card.brand, card.number.slice(-4),
        card.expMonth, card.expYear, card.name],
    );
    return id; // the full number and CVV are now dropped and never stored
  }

  private otpHash(piId: string, otp: string) {
    return hmac(this.cfg.appSecret, `otp:${piId}:${otp}`);
  }

  private async get(db: Db, merchant: Merchant, id: string): Promise<PaymentIntentRow> {
    const [row] = await db.query<PaymentIntentRow>('SELECT * FROM payment_intents WHERE id = $1 AND merchant_id = $2', [id, merchant.id]);
    if (!row) throw notFound(`payment_intent: ${id}`);
    return row;
  }

  private async lock(tx: Db, merchant: Merchant, id: string): Promise<PaymentIntentRow> {
    const [row] = await tx.query<PaymentIntentRow>(
      'SELECT * FROM payment_intents WHERE id = $1 AND merchant_id = $2 FOR UPDATE',
      [id, merchant.id],
    );
    if (!row) throw notFound(`payment_intent: ${id}`);
    return row;
  }

  private checkClientSecret(pi: PaymentIntentRow, secret: string) {
    if (!safeEqual(pi.client_secret, secret)) {
      throw new ApiError(401, 'authentication_error', 'client_secret_invalid', 'Invalid client_secret for this payment');
    }
  }

  private expectStatus(pi: PaymentIntentRow, allowed: Status[], action: string) {
    if (!allowed.includes(pi.status)) {
      throw badRequest('payment_intent_unexpected_state', `You cannot ${action} a payment with status "${pi.status}"`);
    }
  }

  async serialize(db: Db, row: PaymentIntentRow, opts: { includeSecret?: boolean; testOtp?: string } = {}) {
    let card: CardRow | undefined;
    if (row.card_id) [card] = await db.query<CardRow>('SELECT * FROM cards WHERE id = $1', [row.card_id]);
    return {
      id: row.id,
      object: 'payment_intent',
      amount: Number(row.amount),
      currency: row.currency,
      description: row.description,
      status: row.status,
      capture_method: row.capture_method,
      amount_capturable: Number(row.amount_capturable),
      amount_received: Number(row.amount_received),
      amount_refunded: Number(row.amount_refunded),
      payment_method: card
        ? { brand: card.brand, last4: card.last4, exp_month: card.exp_month, exp_year: card.exp_year, cardholder: card.cardholder }
        : null,
      last_payment_error: row.last_error_code ? { code: row.last_error_code, message: row.last_error_message } : null,
      next_action:
        row.status === 'requires_action'
          ? {
              type: 'otp',
              otp: {
                expires_at: toUnix(row.otp_expires_at!),
                // Test mode only: a real bank sends the code by SMS.
                ...(opts.testOtp && { test_code: opts.testOtp }),
              },
            }
          : null,
      created: toUnix(row.created_at),
      ...(opts.includeSecret && { client_secret: row.client_secret }),
    };
  }
}

// ───────────────────────── card input ─────────────────────────

interface ParsedCard {
  number: string;
  expMonth: number;
  expYear: number;
  cvc: string;
  name: string;
  brand: string;
}

/** Re-validates on the server with the SAME code the browser uses: never trust the client. */
function parseCard(raw: unknown): ParsedCard {
  if (!raw || typeof raw !== 'object') throw badRequest('parameter_missing', 'card is required', 'card');
  const c = raw as Record<string, unknown>;
  const number = onlyDigits(String(c.number ?? ''));
  const cardErr = (code: string, message: string, param: string) => new ApiError(402, 'card_error', code, message, param);

  const numberError = validateCardNumber(number);
  if (numberError) throw cardErr('invalid_number', numberError, 'card.number');

  const expMonth = Number(c.exp_month);
  const expYear = Number(c.exp_year);
  const yy = String(expYear % 100).padStart(2, '0');
  const expiryError = validateExpiry(`${String(expMonth).padStart(2, '0')}/${yy}`);
  if (!Number.isInteger(expMonth) || !Number.isInteger(expYear) || expYear < 2000 || expiryError) {
    throw cardErr('invalid_expiry', expiryError ?? 'Enter a valid expiry date', 'card.exp_month');
  }

  const network = detectNetwork(number)!;
  const cvc = String(c.cvc ?? '');
  const cvcError = validateCvv(cvc, network);
  if (cvcError || !/^\d+$/.test(cvc)) throw cardErr('invalid_cvc', cvcError ?? 'Invalid security code', 'card.cvc');

  const name = String(c.name ?? '').trim();
  if (!name) throw cardErr('invalid_name', 'Enter the name on the card', 'card.name');

  return { number, expMonth, expYear, cvc, name: name.slice(0, 100), brand: network.id };
}

function toUnix(d: Date | string): number {
  return Math.floor(new Date(d).getTime() / 1000);
}
