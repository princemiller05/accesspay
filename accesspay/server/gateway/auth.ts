import type { RequestHandler, Response } from 'express';
import type { Db } from '../db/index.ts';
import { ApiError } from '../lib/errors.ts';
import { findByPublishableKey, findBySecretKey, type Merchant } from './merchants.ts';

/**
 * Two kinds of API key, like Stripe:
 *  - secret key (sk_…): lives on the merchant's SERVER. Full access: create, capture, refund, list.
 *  - publishable key (pk_…): safe to put in the browser. Can only confirm a payment
 *    the merchant already created, and only with that payment's client_secret.
 */
export type KeyKind = 'secret' | 'publishable';

export interface AuthLocals {
  merchant: Merchant;
  keyKind: KeyKind;
}

export const authOf = (res: Response): AuthLocals => res.locals as AuthLocals;

function bearer(header: string | undefined): string | null {
  const m = /^Bearer\s+(\S+)$/i.exec(header ?? '');
  return m ? m[1] : null;
}

export function requireKey(db: Db, allowed: KeyKind[]): RequestHandler {
  return async (req, res, next) => {
    try {
      const key = bearer(req.header('authorization'));
      if (!key) {
        throw new ApiError(401, 'authentication_error', 'missing_api_key',
          'Send your API key in the Authorization header: "Bearer sk_test_…"');
      }
      let merchant: Merchant | undefined;
      let kind: KeyKind;
      if (key.startsWith('sk_')) {
        kind = 'secret';
        merchant = await findBySecretKey(db, key);
      } else if (key.startsWith('pk_')) {
        kind = 'publishable';
        merchant = await findByPublishableKey(db, key);
      } else {
        throw new ApiError(401, 'authentication_error', 'invalid_api_key', 'Invalid API key');
      }
      if (!merchant) throw new ApiError(401, 'authentication_error', 'invalid_api_key', 'Invalid API key');
      if (!allowed.includes(kind)) {
        throw new ApiError(403, 'authentication_error', 'secret_key_required',
          kind === 'publishable'
            ? 'This request needs your secret key. Never use a secret key in the browser.'
            : 'This request must be made with a publishable key.');
      }
      res.locals.merchant = merchant;
      res.locals.keyKind = kind;
      next();
    } catch (err) {
      next(err);
    }
  };
}
