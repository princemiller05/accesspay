/**
 * All configuration comes from environment variables, with safe defaults for
 * local development. In production (NODE_ENV=production) the secrets MUST be set.
 */
export interface Config {
  port: number;
  production: boolean;
  /** Public URL of this server, used to build the demo merchant's webhook URL. */
  publicUrl: string;
  /** Postgres connection string. If empty, an embedded Postgres (PGlite) is used. */
  databaseUrl: string;
  /** Folder for the embedded database. Empty = in-memory (data lost on restart). */
  pgliteDir: string;
  /** Secret for HMAC: card fingerprints and dashboard session cookies. */
  appSecret: string;
  /** API keys of the seeded demo merchant ("Chai & Co."). */
  demoPublishableKey: string;
  demoSecretKey: string;
  demoWebhookSecret: string;
  demoMerchantPassword: string;
}

const DEV_ONLY = 'dev-only-not-secret';

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const production = env.NODE_ENV === 'production';
  const port = Number(env.PORT ?? 3000);

  const cfg: Config = {
    port,
    production,
    publicUrl: env.PUBLIC_URL ?? env.RENDER_EXTERNAL_URL ?? `http://localhost:${port}`,
    databaseUrl: env.DATABASE_URL ?? '',
    pgliteDir: env.PGLITE_DIR ?? '',
    appSecret: env.APP_SECRET ?? `${DEV_ONLY}-app-secret`,
    demoPublishableKey: env.DEMO_PUBLISHABLE_KEY ?? 'pk_test_chaiandco_demo',
    demoSecretKey: env.DEMO_SECRET_KEY ?? 'sk_test_chaiandco_demo_secret',
    demoWebhookSecret: env.DEMO_WEBHOOK_SECRET ?? 'whsec_chaiandco_demo',
    demoMerchantPassword: env.DEMO_MERCHANT_PASSWORD ?? 'chai-demo-2026',
  };

  if (production && cfg.appSecret.startsWith(DEV_ONLY)) {
    throw new Error('APP_SECRET must be set in production');
  }
  return cfg;
}
