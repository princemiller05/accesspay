import express, { type Express, type RequestHandler } from 'express';
import { existsSync } from 'node:fs';
import type { Db } from './db/index.ts';
import type { Config } from './config.ts';
import { errorHandler, notFound } from './lib/errors.ts';
import { PaymentIntents } from './gateway/payment-intents.ts';
import { WebhookDispatcher } from './gateway/webhooks.ts';
import { gatewayRouter } from './gateway/routes.ts';
import { dashboardRouter } from './dashboard/routes.ts';
import { demoMerchantRouter } from './demo-merchant/routes.ts';
import { Checkout } from './gateway/checkout.ts';
import { publicCheckoutRouter } from './gateway/public-checkout.ts';

export interface AppDeps {
  db: Db;
  cfg: Config;
  /** Where the demo shop reaches the gateway (itself). Set after the server starts listening. */
  gatewayUrl: () => string;
  webhookRetryDelaysMs?: number[];
  /** Folder with the built frontend (vite build). Optional. */
  staticDir?: string;
  log?: boolean;
}

export function createApp(deps: AppDeps): { app: Express; webhooks: WebhookDispatcher } {
  const { db, cfg } = deps;
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1); // behind Render's proxy: req.ip is the real client

  const intents = new PaymentIntents(db, cfg);
  const checkout = new Checkout(db, cfg, intents);
  const webhooks = new WebhookDispatcher(db, { retryDelaysMs: deps.webhookRetryDelaysMs, blockPrivateAddresses: cfg.production });

  app.use(securityHeaders);
  if (deps.log) app.use(requestLog);

  app.get('/healthz', (_req, res) => {
    res.json({ ok: true });
  });

  app.use('/v1', express.json({ limit: '10kb' }), gatewayRouter(db, intents, checkout, webhooks));
  app.use('/v1', (_req, _res, next) => next(notFound('endpoint')));
  app.use('/dashboard/api', dashboardRouter(db, cfg, intents, checkout, webhooks));
  app.use(publicCheckoutRouter(checkout, webhooks));
  app.use('/shop', demoMerchantRouter(cfg, deps.gatewayUrl));

  if (deps.staticDir && existsSync(deps.staticDir)) {
    app.use(express.static(deps.staticDir, { index: 'index.html', extensions: ['html'] }));
    app.get('/dashboard', (_req, res) => res.redirect(301, '/dashboard/'));
  }

  app.use(errorHandler);
  return { app, webhooks };
}

const securityHeaders: RequestHandler = (_req, res, next) => {
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; " +
      "frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
  );
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=(self)');
  next();
};

/** Logs method, path, status and time. Never logs bodies: they can contain card numbers. */
const requestLog: RequestHandler = (req, res, next) => {
  const start = performance.now();
  res.on('finish', () => {
    console.log(`${req.method} ${req.originalUrl.split("?")[0]} ${res.statusCode} ${(performance.now() - start).toFixed(0)}ms`);
  });
  next();
};
