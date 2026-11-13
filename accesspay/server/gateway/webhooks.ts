import type { Db } from '../db/index.ts';
import { hmac, newId, safeEqual } from '../lib/crypto.ts';
import { resolvesToPrivateAddress } from '../lib/urls.ts';

/**
 * Webhook delivery.
 *
 * Each request is signed so the merchant can check it really came from us:
 *   AccessPay-Signature: t=<unix seconds>,v1=<HMAC-SHA256(webhook_secret, "<t>.<raw body>")>
 * Including the timestamp stops attackers from replaying an old webhook.
 *
 * Failed deliveries are retried with exponential backoff. Every attempt is
 * logged in webhook_deliveries (visible in the dashboard).
 *
 * Limitation: retries are scheduled in memory, so they're lost if the server
 * restarts. A production system would run a worker that polls the events table.
 */
export const SIGNATURE_HEADER = 'AccessPay-Signature';
const RETRY_DELAYS_MS = [0, 2_000, 10_000, 60_000];
const TIMEOUT_MS = 5_000;

export function signPayload(secret: string, body: string, timestamp = Math.floor(Date.now() / 1000)): string {
  return `t=${timestamp},v1=${hmac(secret, `${timestamp}.${body}`)}`;
}

/** What a merchant runs on their side to verify a webhook. */
export function verifySignature(secret: string, body: string, header: string | undefined, toleranceSec = 300): boolean {
  if (!header) return false;
  const parts = Object.fromEntries(header.split(',').map((p) => p.split('=') as [string, string]));
  const t = Number(parts.t);
  if (!t || !parts.v1) return false;
  if (Math.abs(Date.now() / 1000 - t) > toleranceSec) return false; // too old: possible replay
  return safeEqual(hmac(secret, `${t}.${body}`), parts.v1);
}

export class WebhookDispatcher {
  private db: Db;
  private inFlight = new Set<Promise<void>>();
  private retryDelays: number[];
  private blockPrivate: boolean;

  constructor(db: Db, opts: { retryDelaysMs?: number[]; blockPrivateAddresses?: boolean } = {}) {
    this.db = db;
    this.retryDelays = opts.retryDelaysMs ?? RETRY_DELAYS_MS;
    this.blockPrivate = opts.blockPrivateAddresses ?? false;
  }

  /** Queue delivery of events (call after the transaction that created them has committed). */
  dispatch(eventIds: string[]): void {
    for (const id of eventIds) this.track(this.deliver(id, 1));
  }

  /** Resolves when no deliveries are running (used by tests). */
  async idle(): Promise<void> {
    while (this.inFlight.size) await Promise.allSettled([...this.inFlight]);
  }

  private track(p: Promise<void>) {
    this.inFlight.add(p);
    p.finally(() => this.inFlight.delete(p));
  }

  private async deliver(eventId: string, attempt: number): Promise<void> {
    const delay = this.retryDelays[attempt - 1] ?? 0;
    if (delay) await new Promise((r) => setTimeout(r, delay));

    const [row] = await this.db.query<{
      id: string; type: string; data: unknown; created_at: Date; merchant_id: string;
      webhook_url: string | null; webhook_secret: string;
    }>(
      `SELECT e.id, e.type, e.data, e.created_at, e.merchant_id, m.webhook_url, m.webhook_secret
       FROM events e JOIN merchants m ON m.id = e.merchant_id WHERE e.id = $1`,
      [eventId],
    );
    if (!row?.webhook_url) return;

    const body = JSON.stringify({
      id: row.id,
      object: 'event',
      type: row.type,
      created: Math.floor(new Date(row.created_at).getTime() / 1000),
      data: { object: row.data },
    });

    let statusCode: number | null = null;
    let error: string | null = null;
    try {
      if (this.blockPrivate && (await resolvesToPrivateAddress(row.webhook_url))) {
        throw new Error('Blocked: webhook URL points to a private network address');
      }
      const res = await fetch(row.webhook_url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', [SIGNATURE_HEADER]: signPayload(row.webhook_secret, body) },
        body,
        signal: AbortSignal.timeout(TIMEOUT_MS),
        redirect: 'manual', // don't follow redirects to somewhere we didn't check
      });
      statusCode = res.status;
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
    const success = statusCode !== null && statusCode >= 200 && statusCode < 300;

    await this.db.query(
      `INSERT INTO webhook_deliveries (id, event_id, merchant_id, attempt, url, status_code, success, error)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [newId('whd'), row.id, row.merchant_id, attempt, row.webhook_url, statusCode, success, error],
    );

    if (!success && attempt < this.retryDelays.length) this.track(this.deliver(eventId, attempt + 1));
  }
}
