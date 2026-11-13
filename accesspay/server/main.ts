/**
 * Starts the AccessPay server: gateway API, merchant dashboard, demo shop,
 * and (if built) the frontend.
 *
 *   npm run server          # API on http://localhost:3000
 *   npm run dev             # API + Vite dev server with hot reload
 *   npm start               # production: serves the built frontend too
 */
import { resolve } from 'node:path';
import type { AddressInfo } from 'node:net';
import { loadConfig } from './config.ts';
import { connect } from './db/index.ts';
import { createApp } from './app.ts';
import { seedDemoMerchant } from './gateway/merchants.ts';

const cfg = loadConfig();
const db = await connect({ databaseUrl: cfg.databaseUrl, pgliteDir: cfg.pgliteDir });

let port = cfg.port;
const { app } = createApp({
  db,
  cfg,
  gatewayUrl: () => `http://127.0.0.1:${port}`,
  staticDir: resolve(import.meta.dirname, '..', 'dist'),
  log: true,
});

const server = app.listen(cfg.port, async () => {
  port = (server.address() as AddressInfo).port;
  await seedDemoMerchant(db, cfg);
  console.log(`AccessPay listening on ${cfg.publicUrl}`);
  console.log(`Database: ${cfg.databaseUrl ? 'PostgreSQL' : `embedded PGlite (${cfg.pgliteDir || 'in-memory'})`}`);
  if (!cfg.production) {
    console.log(`Dashboard login: demo@chaiandco.test / ${cfg.demoMerchantPassword}`);
  }
});

const shutdown = async () => {
  server.close();
  await db.close();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
