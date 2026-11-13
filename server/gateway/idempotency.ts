import type { RequestHandler } from 'express';
import type { Db } from '../db/index.ts';
import { ApiError } from '../lib/errors.ts';
import { sha256 } from '../lib/crypto.ts';
import { authOf } from './auth.ts';

/**
 * Idempotency keys: makes "create payment", "capture" and "refund" safe to retry.
 *
 * Networks fail. If a merchant's request times out, they don't know whether the
 * payment was created. With an Idempotency-Key header they can simply send the
 * same request again: the first response is stored and replayed, so the
 * customer is never charged twice.
 *
 *  - same key + same request  -> the stored response is replayed
 *  - same key + different request -> 422 (probably a bug in the merchant's code)
 *  - same key while the first request is still running -> 409, try again
 *  - keys expire after 24 hours
 */
const KEY_TTL_HOURS = 24;

export function idempotency(db: Db): RequestHandler {
  return async (req, res, next) => {
    const key = req.header('idempotency-key');
    if (!key) return next();
    try {
      if (key.length > 255) throw new ApiError(400, 'invalid_request_error', 'idempotency_key_too_long', 'Idempotency-Key must be at most 255 characters');
      const { merchant } = authOf(res);
      const requestHash = sha256(`${req.method} ${req.originalUrl} ${JSON.stringify(req.body ?? {})}`);

      await db.query(
        `DELETE FROM idempotency_keys WHERE merchant_id = $1 AND key = $2
           AND created_at < now() - make_interval(hours => $3)`,
        [merchant.id, key, KEY_TTL_HOURS],
      );
      // Atomic "claim": only one request can insert the row.
      const claimed = await db.query(
        `INSERT INTO idempotency_keys (merchant_id, key, request_hash) VALUES ($1, $2, $3)
         ON CONFLICT DO NOTHING RETURNING key`,
        [merchant.id, key, requestHash],
      );

      if (claimed.length === 0) {
        const [row] = await db.query<{ request_hash: string; response_status: number | null; response_body: unknown }>(
          'SELECT request_hash, response_status, response_body FROM idempotency_keys WHERE merchant_id = $1 AND key = $2',
          [merchant.id, key],
        );
        if (row.request_hash !== requestHash) {
          throw new ApiError(422, 'idempotency_error', 'idempotency_key_reused',
            'This Idempotency-Key was already used with different request parameters');
        }
        if (row.response_status === null) {
          throw new ApiError(409, 'idempotency_error', 'request_in_progress',
            'A request with this Idempotency-Key is still being processed. Retry shortly.');
        }
        res.setHeader('Idempotent-Replayed', 'true');
        res.status(row.response_status).json(row.response_body);
        return;
      }

      // First time: let the request run, then save whatever it responds with.
      const originalJson = res.json.bind(res);
      res.json = (body: unknown) => {
        const status = res.statusCode;
        const save =
          status >= 500
            ? // Server errors aren't saved, so the merchant can retry after we fix things.
              db.query('DELETE FROM idempotency_keys WHERE merchant_id = $1 AND key = $2', [merchant.id, key])
            : db.query(
                'UPDATE idempotency_keys SET response_status = $3, response_body = $4 WHERE merchant_id = $1 AND key = $2',
                [merchant.id, key, status, JSON.stringify(body)],
              );
        // Send only after saving, so an immediate retry always finds the stored response.
        save
          .catch((e) => console.error('failed to save idempotent response', e))
          .finally(() => originalJson(body));
        return res;
      };
      next();
    } catch (err) {
      next(err);
    }
  };
}
