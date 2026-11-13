/**
 * Database schema. Safe to run on every start (IF NOT EXISTS).
 *
 * Money is stored as integers in the smallest unit (paise), never as floats:
 * 0.1 + 0.2 !== 0.3 in floating point, and that's not OK for money.
 *
 * Card numbers and CVVs are NEVER stored. A card is kept as a token with the
 * brand, last 4 digits, expiry and an HMAC fingerprint (to spot the same card
 * again without being able to recover the number).
 */
export const SCHEMA = /* sql */ `
CREATE TABLE IF NOT EXISTS merchants (
  id               TEXT PRIMARY KEY,
  name             TEXT NOT NULL,
  email            TEXT NOT NULL UNIQUE,
  password_hash    TEXT NOT NULL,
  publishable_key  TEXT NOT NULL UNIQUE,
  secret_key_hash  TEXT NOT NULL UNIQUE,
  secret_key_last4 TEXT NOT NULL,
  webhook_url      TEXT,
  webhook_secret   TEXT NOT NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS cards (
  id          TEXT PRIMARY KEY,
  merchant_id TEXT NOT NULL REFERENCES merchants(id),
  fingerprint TEXT NOT NULL,
  brand       TEXT NOT NULL,
  last4       TEXT NOT NULL,
  exp_month   INT  NOT NULL,
  exp_year    INT  NOT NULL,
  cardholder  TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS payment_intents (
  id                TEXT PRIMARY KEY,
  merchant_id       TEXT NOT NULL REFERENCES merchants(id),
  amount            BIGINT NOT NULL CHECK (amount > 0),
  currency          TEXT NOT NULL,
  description       TEXT,
  status            TEXT NOT NULL,
  capture_method    TEXT NOT NULL CHECK (capture_method IN ('automatic', 'manual')),
  client_secret     TEXT NOT NULL,
  card_id           TEXT REFERENCES cards(id),
  amount_capturable BIGINT NOT NULL DEFAULT 0,
  amount_received   BIGINT NOT NULL DEFAULT 0,
  amount_refunded   BIGINT NOT NULL DEFAULT 0,
  last_error_code   TEXT,
  last_error_message TEXT,
  otp_hash          TEXT,
  otp_expires_at    TIMESTAMPTZ,
  otp_attempts      INT NOT NULL DEFAULT 0,
  otp_sends         INT NOT NULL DEFAULT 0,
  pending_card_id   TEXT REFERENCES cards(id),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (amount_refunded <= amount_received)
);
CREATE INDEX IF NOT EXISTS payment_intents_merchant_created
  ON payment_intents (merchant_id, created_at DESC);

CREATE TABLE IF NOT EXISTS refunds (
  id                TEXT PRIMARY KEY,
  merchant_id       TEXT NOT NULL REFERENCES merchants(id),
  payment_intent_id TEXT NOT NULL REFERENCES payment_intents(id),
  amount            BIGINT NOT NULL CHECK (amount > 0),
  reason            TEXT,
  status            TEXT NOT NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS idempotency_keys (
  merchant_id     TEXT NOT NULL REFERENCES merchants(id),
  key             TEXT NOT NULL,
  request_hash    TEXT NOT NULL,
  response_status INT,
  response_body   JSONB,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (merchant_id, key)
);

CREATE TABLE IF NOT EXISTS events (
  id          TEXT PRIMARY KEY,
  merchant_id TEXT NOT NULL REFERENCES merchants(id),
  type        TEXT NOT NULL,
  data        JSONB NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS webhook_deliveries (
  id          TEXT PRIMARY KEY,
  event_id    TEXT NOT NULL REFERENCES events(id),
  merchant_id TEXT NOT NULL REFERENCES merchants(id),
  attempt     INT  NOT NULL,
  url         TEXT NOT NULL,
  status_code INT,
  success     BOOLEAN NOT NULL,
  error       TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS webhook_deliveries_merchant_created
  ON webhook_deliveries (merchant_id, created_at DESC);

-- The merchant's website. Customers are only ever redirected back to this
-- origin (e.g. https://myshop.com), so the checkout can't be abused to send
-- people to a phishing site ("open redirect").
ALTER TABLE merchants ADD COLUMN IF NOT EXISTS website_url TEXT;

-- No-code payments: a fixed product + price behind a shareable URL.
CREATE TABLE IF NOT EXISTS payment_links (
  id          TEXT PRIMARY KEY,
  merchant_id TEXT NOT NULL REFERENCES merchants(id),
  name        TEXT NOT NULL,
  description TEXT,
  amount      BIGINT NOT NULL CHECK (amount > 0),
  currency    TEXT NOT NULL,
  success_url TEXT,
  active      BOOLEAN NOT NULL DEFAULT true,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS payment_links_merchant ON payment_links (merchant_id, created_at DESC);

-- One visit to the hosted checkout page. Wraps a PaymentIntent and knows
-- where to send the customer afterwards.
CREATE TABLE IF NOT EXISTS checkout_sessions (
  id                TEXT PRIMARY KEY,
  merchant_id       TEXT NOT NULL REFERENCES merchants(id),
  payment_intent_id TEXT NOT NULL UNIQUE REFERENCES payment_intents(id),
  payment_link_id   TEXT REFERENCES payment_links(id),
  name              TEXT NOT NULL,
  success_url       TEXT,
  cancel_url        TEXT,
  expires_at        TIMESTAMPTZ NOT NULL,
  completed_at      TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
`;
