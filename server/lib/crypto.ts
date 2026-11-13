/**
 * Small crypto helpers built only on node:crypto (no native add-ons, so
 * `npm install` works the same on Windows, macOS and Linux).
 */
import { createHash, createHmac, randomBytes, randomInt, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scryptAsync = promisify(scrypt) as (pw: string, salt: Buffer, len: number) => Promise<Buffer>;

/** Random URL-safe string, e.g. for IDs and secrets. */
export const randomToken = (bytes = 18): string => randomBytes(bytes).toString('base64url');

/** Prefixed IDs like Stripe's ("pi_…", "card_…"), so you can tell objects apart in logs. */
export const newId = (prefix: string): string => `${prefix}_${randomToken(12)}`;

export const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex');

export const hmac = (secret: string, s: string): string =>
  createHmac('sha256', secret).update(s).digest('hex');

/** Constant-time comparison, so attackers can't guess secrets by timing responses. */
export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

/** Passwords: scrypt with a random salt. Stored as "scrypt$<salt>$<hash>". */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await scryptAsync(password, salt, 32);
  return `scrypt$${salt.toString('base64url')}$${hash.toString('base64url')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, saltB64, hashB64] = stored.split('$');
  if (scheme !== 'scrypt' || !saltB64 || !hashB64) return false;
  const hash = await scryptAsync(password, Buffer.from(saltB64, 'base64url'), 32);
  return safeEqual(hash.toString('base64url'), hashB64);
}

/** 6-digit one-time password. */
export const newOtp = (): string => String(randomInt(0, 1_000_000)).padStart(6, '0');
