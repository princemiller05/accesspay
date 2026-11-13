import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { loadConfig } from '../../server/config.ts';
import { connect, type Db } from '../../server/db/index.ts';
import { createApp } from '../../server/app.ts';
import { seedDemoMerchant } from '../../server/gateway/merchants.ts';
import type { WebhookDispatcher } from '../../server/gateway/webhooks.ts';

export const SK = 'sk_test_chaiandco_demo_secret';
export const PK = 'pk_test_chaiandco_demo';

export interface TestServer {
  url: string;
  db: Db;
  webhooks: WebhookDispatcher;
  close: () => Promise<void>;
  api: (method: string, path: string, opts?: { key?: string; body?: unknown; headers?: Record<string, string> }) => Promise<{ status: number; body: any; headers: Headers }>;
}

/** Fresh in-memory database + server on a random port for every test file. */
export async function startServer(): Promise<TestServer> {
  const cfg = loadConfig({ NODE_ENV: 'test' } as NodeJS.ProcessEnv);
  // TEST_DATABASE_URL runs the suite against real PostgreSQL (fresh schema per file).
  const pgUrl = process.env.TEST_DATABASE_URL;
  if (pgUrl) {
    const reset = await connect({ databaseUrl: pgUrl });
    await reset.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
    await reset.close();
  }
  const db = await connect(pgUrl ? { databaseUrl: pgUrl } : {});
  let url = '';
  const { app, webhooks } = createApp({ db, cfg, gatewayUrl: () => url, webhookRetryDelaysMs: [0, 10, 20] });
  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  await seedDemoMerchant(db, { ...cfg, publicUrl: url });

  const api: TestServer['api'] = async (method, path, opts = {}) => {
    const res = await fetch(url + path, {
      method,
      headers: {
        ...(opts.key && { Authorization: `Bearer ${opts.key}` }),
        ...(opts.body !== undefined && { 'Content-Type': 'application/json' }),
        ...opts.headers,
      },
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null, headers: res.headers };
  };

  return {
    url,
    db,
    webhooks,
    api,
    close: async () => {
      await webhooks.idle();
      await new Promise((r) => server.close(r));
      await db.close();
    },
  };
}

export const card = (number: string, extra: Record<string, unknown> = {}) => ({
  number,
  exp_month: 8,
  exp_year: new Date().getFullYear() + 3,
  cvc: number.startsWith('3') ? '1234' : '123',
  name: 'Test Customer',
  ...extra,
});
