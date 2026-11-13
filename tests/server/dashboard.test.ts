import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startServer, type TestServer } from './helpers.ts';

let s: TestServer;
beforeAll(async () => {
  s = await startServer();
});
afterAll(async () => {
  await s.close();
});

const login = (email: string, password: string, headers: Record<string, string> = {}) =>
  fetch(`${s.url}/dashboard/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify({ email, password }),
  });

describe('dashboard auth', () => {
  it('needs a session', async () => {
    expect((await fetch(`${s.url}/dashboard/api/me`)).status).toBe(401);
  });

  it('gives the same error for unknown email and wrong password', async () => {
    const a = await (await login('nobody@example.com', 'x')).json();
    const b = await (await login('demo@chaiandco.test', 'wrong', { 'X-Forwarded-For': '10.0.0.9' })).json();
    expect(a.error.message).toBe(b.error.message);
  });

  it('logs in with an HttpOnly, SameSite cookie and shows the account', async () => {
    const res = await login('demo@chaiandco.test', 'chai-demo-2026');
    expect(res.status).toBe(200);
    const cookie = res.headers.get('set-cookie')!;
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Lax/i);
    const me = await (await fetch(`${s.url}/dashboard/api/me`, { headers: { cookie: cookie.split(';')[0] } })).json();
    expect(me.email).toBe('demo@chaiandco.test');
    expect(JSON.stringify(me)).not.toContain('sk_test_chaiandco_demo_secret'); // full secret key never shown
  });

  it('rejects a forged session cookie', async () => {
    const res = await fetch(`${s.url}/dashboard/api/me`, { headers: { cookie: 'ap_session=acct_x.9999999999999.forged' } });
    expect(res.status).toBe(401);
  });

  it('blocks cross-site POSTs', async () => {
    const res = await login('demo@chaiandco.test', 'chai-demo-2026', { Origin: 'https://evil.example' });
    expect(res.status).toBe(403);
  });

  it('rate-limits repeated wrong passwords', async () => {
    const ip = { 'X-Forwarded-For': '10.0.0.77' };
    for (let i = 0; i < 5; i++) await login('demo@chaiandco.test', 'nope', ip);
    const res = await login('demo@chaiandco.test', 'chai-demo-2026', ip);
    expect(res.status).toBe(429);
  });
});
