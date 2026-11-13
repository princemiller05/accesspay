/**
 * URL rules for anything a merchant gives us.
 *
 *  - Website / redirect URLs: must be https (http only for localhost while
 *    testing). Customers are redirected only to the merchant's own website
 *    origin, so a checkout link can't bounce people to a phishing site.
 *
 *  - Webhook URLs: our SERVER makes requests to them. If we allowed any URL,
 *    an attacker could point it at internal addresses (e.g. the cloud
 *    metadata service at 169.254.169.254) and use us to reach them: a
 *    Server-Side Request Forgery (SSRF). In production we block private,
 *    loopback and link-local addresses, checked again at delivery time
 *    (DNS can change between saving and sending).
 */
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { badRequest } from './errors.ts';

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

export function parseHttpUrl(raw: unknown, param: string, opts: { allowLocalHttp: boolean }): URL {
  let url: URL;
  try {
    url = new URL(String(raw ?? ''));
  } catch {
    throw badRequest('url_invalid', `${param} must be a full URL, like https://example.com`, param);
  }
  const isLocal = LOCAL_HOSTS.has(url.hostname);
  if (url.protocol === 'https:') return url;
  if (url.protocol === 'http:' && isLocal && opts.allowLocalHttp) return url;
  throw badRequest('url_insecure', `${param} must use https://`, param);
}

/** A success/cancel URL must be on the merchant's website (same origin). */
export function assertSameSite(raw: unknown, websiteUrl: string | null, param: string, allowLocalHttp: boolean): string {
  const url = parseHttpUrl(raw, param, { allowLocalHttp });
  if (!websiteUrl) {
    throw badRequest('website_not_set', 'Set your website URL in Developers → Settings before using redirects', param);
  }
  const site = new URL(websiteUrl);
  if (url.origin !== site.origin) {
    throw badRequest('url_not_allowed', `${param} must be on your website (${site.origin})`, param);
  }
  return url.toString();
}

function isPrivateIp(ip: string): boolean {
  if (ip.startsWith('::ffff:')) ip = ip.slice(7); // IPv4-mapped IPv6
  if (isIP(ip) === 4) {
    const [a, b] = ip.split('.').map(Number);
    return (
      a === 10 || a === 127 || a === 0 ||
      (a === 169 && b === 254) || // link-local, incl. cloud metadata
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127) // carrier-grade NAT
    );
  }
  const lower = ip.toLowerCase();
  return lower === '::1' || lower === '::' || lower.startsWith('fc') || lower.startsWith('fd') || lower.startsWith('fe80');
}

/** True if the URL's host is (or resolves to) a private/internal address. */
export async function resolvesToPrivateAddress(url: string): Promise<boolean> {
  const host = new URL(url).hostname.replace(/^\[|\]$/g, '');
  if (isIP(host)) return isPrivateIp(host);
  try {
    const addrs = await lookup(host, { all: true });
    return addrs.some((a) => isPrivateIp(a.address));
  } catch {
    return true; // can't resolve: don't send
  }
}
