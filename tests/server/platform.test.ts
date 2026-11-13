import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startServer, card, type TestServer } from './helpers.ts';
import { verifySignature } from '../../server/gateway/webhooks.ts';
import { resolvesToPrivateAddress, assertSameSite } from '../../server/lib/urls.ts';
import express from 'express';
import type { AddressInfo } from 'node:net';

let s: TestServer;
beforeAll(async () => {
  s = await startServer();
});
afterAll(async () => {
  await s.close();
});

/** Sign up a merchant and return its keys + a cookie for the dashboard. */
async function signUp(email: string, website = 'https://shop.example') {
  const res = await fetch(`${s.url}/dashboard/api/signup`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': `10.1.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}` },
    body: JSON.stringify({ name: 'Test Shop', email, password: 'a-long-password', website_url: website }),
  });
  const body = await res.json();
  return { status: res.status, body, cookie: res.headers.get('set-cookie')?.split(';')[0] ?? '' };
}

const createSession = (sk: string, body: Record<string, unknown>) =>
  s.api('POST', '/v1/checkout/sessions', { key: sk, body: { name: 'Order #1', amount: 29900, currency: 'inr', ...body } });

describe('merchant sign-up', () => {
  it('creates an account with fresh test keys, shown once', async () => {
    const r = await signUp('a@shop.example');
    expect(r.status).toBe(201);
    expect(r.body.keys.secret_key).toMatch(/^sk_test_/);
    expect(r.body.keys.publishable_key).toMatch(/^pk_test_/);
    const me = await (await fetch(`${s.url}/dashboard/api/me`, { headers: { cookie: r.cookie } })).json();
    expect(JSON.stringify(me)).not.toContain(r.body.keys.secret_key);
    expect(me.website_url).toBe('https://shop.example');
  });

  it.each([
    [{ email: 'bad' }, 'email_invalid'],
    [{ password: 'short' }, 'password_too_short'],
    [{ website_url: 'not a url' }, 'url_invalid'],
    [{ website_url: 'http://shop.example' }, 'url_insecure'],
  ])('rejects %o', async (override, code) => {
    const res = await fetch(`${s.url}/dashboard/api/signup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': '10.9.9.9' },
      body: JSON.stringify({ name: 'X', email: 'x@shop.example', password: 'a-long-password', website_url: 'https://shop.example', ...override }),
    });
    expect((await res.json()).error.code).toBe(code);
  });

  it('rejects a duplicate email', async () => {
    await signUp('dup@shop.example');
    expect((await signUp('dup@shop.example')).status).toBe(409);
  });

  it('keeps merchants separate: one cannot see another\'s payments', async () => {
    const a = await signUp('iso-a@shop.example');
    const b = await signUp('iso-b@shop.example');
    const session = await createSession(a.body.keys.secret_key, {});
    const asB = await s.api('GET', `/v1/payment_intents/${session.body.payment_intent}`, { key: b.body.keys.secret_key });
    expect(asB.status).toBe(404);
    const listB = await s.api('GET', '/v1/payment_intents', { key: b.body.keys.secret_key });
    expect(listB.body.data).toHaveLength(0);
  });

  it('rolling the secret key disables the old one immediately', async () => {
    const m = await signUp('roll@shop.example');
    const res = await fetch(`${s.url}/dashboard/api/keys/roll`, { method: 'POST', headers: { cookie: m.cookie, 'Content-Type': 'application/json' }, body: '{}' });
    const { secret_key } = await res.json();
    expect((await s.api('GET', '/v1/payment_intents', { key: m.body.keys.secret_key })).status).toBe(401);
    expect((await s.api('GET', '/v1/payment_intents', { key: secret_key })).status).toBe(200);
  });
});

describe('checkout sessions', () => {
  it('only redirects to the merchant\'s own website (no open redirect)', async () => {
    const m = await signUp('redir@shop.example');
    const sk = m.body.keys.secret_key;
    expect((await createSession(sk, { success_url: 'https://shop.example/thanks' })).status).toBe(200);
    for (const url of ['https://evil.example/thanks', 'https://shop.example.evil.example/x', 'javascript:alert(1)', 'http://shop.example/x']) {
      const r = await createSession(sk, { success_url: url });
      expect(r.status, url).toBe(400);
    }
  });

  it('gives the hosted page what it needs, without secrets of the merchant', async () => {
    const m = await signUp('public@shop.example');
    const sess = await createSession(m.body.keys.secret_key, { success_url: 'https://shop.example/thanks' });
    expect(sess.body.url).toContain(`/pay/?s=${sess.body.id}`);
    const pub = await s.api('GET', `/checkout/api/sessions/${sess.body.id}`);
    expect(pub.body).toMatchObject({ status: 'open', merchant_name: 'Test Shop', amount: 29900 });
    expect(pub.body.success_url).toBe(`https://shop.example/thanks?session_id=${sess.body.id}`);
    expect(pub.headers.get('cache-control')).toBe('no-store');
    expect(JSON.stringify(pub.body)).not.toContain(m.body.keys.secret_key);
    expect(JSON.stringify(pub.body)).not.toContain(m.body.keys.webhook_secret);
  });

  it('completes when paid and sends checkout.session.completed to the merchant', async () => {
    // A tiny "merchant server" that records signed webhooks.
    const received: Array<{ type: string; valid: boolean }> = [];
    const m = await signUp('hooks@shop.example');
    const app = express();
    app.post('/hooks', express.raw({ type: 'application/json' }), (req, res) => {
      const raw = req.body.toString();
      received.push({ type: JSON.parse(raw).type, valid: verifySignature(m.body.keys.webhook_secret, raw, req.get('AccessPay-Signature')) });
      res.json({ ok: true });
    });
    const server = await new Promise<import('node:http').Server>((r) => { const x = app.listen(0, () => r(x)); });
    const hookUrl = `http://localhost:${(server.address() as AddressInfo).port}/hooks`;
    await fetch(`${s.url}/dashboard/api/settings`, {
      method: 'POST',
      headers: { cookie: m.cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ webhook_url: hookUrl }),
    });

    const sess = await createSession(m.body.keys.secret_key, {});
    const pub = await s.api('GET', `/checkout/api/sessions/${sess.body.id}`);
    const confirm = await s.api('POST', `/v1/payment_intents/${pub.body.payment_intent}/confirm`, {
      key: pub.body.publishable_key,
      body: { client_secret: pub.body.client_secret, card: card('4242424242424242') },
    });
    expect(confirm.body.status).toBe('succeeded');

    const after = await s.api('GET', `/v1/checkout/sessions/${sess.body.id}`, { key: m.body.keys.secret_key });
    expect(after.body).toMatchObject({ status: 'complete', payment_status: 'paid' });
    expect((await s.api('GET', `/checkout/api/sessions/${sess.body.id}`)).body.client_secret).toBeNull();

    await s.webhooks.idle();
    server.close();
    expect(received.map((r) => r.type)).toContain('checkout.session.completed');
    expect(received.every((r) => r.valid)).toBe(true);
  });

  it('refuses payment on an expired session', async () => {
    const m = await signUp('expired@shop.example');
    const sess = await createSession(m.body.keys.secret_key, {});
    const pub = await s.api('GET', `/checkout/api/sessions/${sess.body.id}`);
    await s.db.query("UPDATE checkout_sessions SET expires_at = now() - interval '1 minute' WHERE id = $1", [sess.body.id]);
    expect((await s.api('GET', `/checkout/api/sessions/${sess.body.id}`)).body.status).toBe('expired');
    const r = await s.api('POST', `/v1/payment_intents/${pub.body.payment_intent}/confirm`, {
      key: pub.body.publishable_key,
      body: { client_secret: pub.body.client_secret, card: card('4242424242424242') },
    });
    expect(r.body.error.code).toBe('checkout_session_expired');
  });
});

describe('payment links', () => {
  it('each visit creates a fresh session and redirects to the hosted page', async () => {
    const m = await signUp('links@shop.example');
    const link = await s.api('POST', '/v1/payment_links', { key: m.body.keys.secret_key, body: { name: 'Book', amount: 29900 } });
    expect(link.body.url).toContain(`/l/${link.body.id}`);
    const visit = () => fetch(`${s.url}/l/${link.body.id}`, { redirect: 'manual' });
    const [r1, r2] = [await visit(), await visit()];
    expect(r1.status).toBe(303);
    expect(r1.headers.get('location')).toMatch(/^\/pay\/\?s=cs_/);
    expect(r1.headers.get('location')).not.toBe(r2.headers.get('location'));
  });

  it('deactivated links stop working', async () => {
    const m = await signUp('deact@shop.example');
    const link = await s.api('POST', '/v1/payment_links', { key: m.body.keys.secret_key, body: { name: 'Book', amount: 29900 } });
    await fetch(`${s.url}/dashboard/api/links/${link.body.id}/active`, {
      method: 'POST',
      headers: { cookie: m.cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ active: false }),
    });
    const r = await fetch(`${s.url}/l/${link.body.id}`, { redirect: 'manual' });
    expect(r.status).toBe(410);
  });

  it('a link\'s price comes from our database, not the web page', async () => {
    const m = await signUp('price@shop.example');
    const link = await s.api('POST', '/v1/payment_links', { key: m.body.keys.secret_key, body: { name: 'Book', amount: 29900 } });
    const r = await fetch(`${s.url}/l/${link.body.id}?amount=100`, { redirect: 'manual' });
    const id = new URLSearchParams(r.headers.get('location')!.split('?')[1]).get('s');
    expect((await s.api('GET', `/checkout/api/sessions/${id}`)).body.amount).toBe(29900);
  });
});

describe('URL safety helpers', () => {
  it.each(['http://127.0.0.1/x', 'http://169.254.169.254/latest', 'http://10.0.0.5', 'http://192.168.1.1', 'http://[::1]/', 'http://localhost/'])(
    'treats %s as private (SSRF guard)',
    async (url) => expect(await resolvesToPrivateAddress(url)).toBe(true),
  );

  it('allows http://localhost redirects only while testing', () => {
    expect(() => assertSameSite('http://localhost:8080/thanks', 'http://localhost:8080', 'success_url', true)).not.toThrow();
    expect(() => assertSameSite('http://localhost:8080/thanks', 'http://localhost:8080', 'success_url', false)).toThrow();
  });
});
