import type { Db } from '../db/index.ts';
import type { Config } from '../config.ts';
import { hashPassword, newId, randomToken, sha256 } from '../lib/crypto.ts';

export interface Merchant {
  id: string;
  name: string;
  email: string;
  password_hash: string;
  publishable_key: string;
  secret_key_hash: string;
  secret_key_last4: string;
  webhook_url: string | null;
  webhook_secret: string;
  website_url: string | null;
}

/** Shown to the merchant ONCE. We only keep a hash of the secret key, so we can't show it again. */
export interface NewKeys {
  publishable_key: string;
  secret_key: string;
  webhook_secret: string;
}

export const generateKeys = (): NewKeys => ({
  publishable_key: `pk_test_${randomToken(18)}`,
  secret_key: `sk_test_${randomToken(24)}`,
  webhook_secret: `whsec_${randomToken(24)}`,
});

export const DEMO_MERCHANT_EMAIL = 'demo@chaiandco.test';

/**
 * Creates the demo merchant ("Chai & Co.") on first start, and keeps its keys
 * and webhook URL in sync with the config on later starts.
 *
 * Secret keys are stored only as a SHA-256 hash, like passwords: if the
 * database leaks, the keys can't be used.
 */
export async function seedDemoMerchant(db: Db, cfg: Config): Promise<Merchant> {
  const webhookUrl = `${cfg.publicUrl}/shop/webhooks`;
  const [existing] = await db.query<Merchant>('SELECT * FROM merchants WHERE email = $1', [DEMO_MERCHANT_EMAIL]);
  if (existing) {
    const [updated] = await db.query<Merchant>(
      `UPDATE merchants SET publishable_key = $2, secret_key_hash = $3, secret_key_last4 = $4,
              webhook_url = $5, webhook_secret = $6, website_url = $7
       WHERE id = $1 RETURNING *`,
      [existing.id, cfg.demoPublishableKey, sha256(cfg.demoSecretKey), cfg.demoSecretKey.slice(-4), webhookUrl, cfg.demoWebhookSecret, cfg.publicUrl],
    );
    return updated;
  }
  const [created] = await db.query<Merchant>(
    `INSERT INTO merchants (id, name, email, password_hash, publishable_key, secret_key_hash,
                            secret_key_last4, webhook_url, webhook_secret, website_url)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *`,
    [
      newId('acct'),
      'Chai & Co.',
      DEMO_MERCHANT_EMAIL,
      await hashPassword(cfg.demoMerchantPassword),
      cfg.demoPublishableKey,
      sha256(cfg.demoSecretKey),
      cfg.demoSecretKey.slice(-4),
      webhookUrl,
      cfg.demoWebhookSecret,
      cfg.publicUrl,
    ],
  );
  return created;
}

export async function findBySecretKey(db: Db, key: string): Promise<Merchant | undefined> {
  const [m] = await db.query<Merchant>('SELECT * FROM merchants WHERE secret_key_hash = $1', [sha256(key)]);
  return m;
}

export async function findByPublishableKey(db: Db, key: string): Promise<Merchant | undefined> {
  const [m] = await db.query<Merchant>('SELECT * FROM merchants WHERE publishable_key = $1', [key]);
  return m;
}

export async function findById(db: Db, id: string): Promise<Merchant | undefined> {
  const [m] = await db.query<Merchant>('SELECT * FROM merchants WHERE id = $1', [id]);
  return m;
}

export async function findByEmail(db: Db, email: string): Promise<Merchant | undefined> {
  const [m] = await db.query<Merchant>('SELECT * FROM merchants WHERE lower(email) = lower($1)', [email]);
  return m;
}

export async function createMerchant(
  db: Db,
  input: { name: string; email: string; password: string; websiteUrl: string },
): Promise<{ merchant: Merchant; keys: NewKeys }> {
  const keys = generateKeys();
  const [merchant] = await db.query<Merchant>(
    `INSERT INTO merchants (id, name, email, password_hash, publishable_key, secret_key_hash,
                            secret_key_last4, webhook_url, webhook_secret, website_url)
     VALUES ($1, $2, $3, $4, $5, $6, $7, NULL, $8, $9) RETURNING *`,
    [
      newId('acct'),
      input.name,
      input.email.toLowerCase(),
      await hashPassword(input.password),
      keys.publishable_key,
      sha256(keys.secret_key),
      keys.secret_key.slice(-4),
      keys.webhook_secret,
      input.websiteUrl,
    ],
  );
  return { merchant, keys };
}

/** Replace the secret key (e.g. it leaked). The old one stops working immediately. */
export async function rollSecretKey(db: Db, merchantId: string): Promise<string> {
  const key = `sk_test_${randomToken(24)}`;
  await db.query('UPDATE merchants SET secret_key_hash = $2, secret_key_last4 = $3 WHERE id = $1', [merchantId, sha256(key), key.slice(-4)]);
  return key;
}

export async function updateSettings(db: Db, merchantId: string, s: { websiteUrl?: string; webhookUrl?: string | null }) {
  if (s.websiteUrl !== undefined) await db.query('UPDATE merchants SET website_url = $2 WHERE id = $1', [merchantId, s.websiteUrl]);
  if (s.webhookUrl !== undefined) await db.query('UPDATE merchants SET webhook_url = $2 WHERE id = $1', [merchantId, s.webhookUrl]);
}
