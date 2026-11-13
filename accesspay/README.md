# AccessPay

**A test-mode payment platform any website can plug into, built accessible from the ground up.**

A website owner signs up, gets API keys, and adds a "Pay" button. Their customers pay on AccessPay's hosted checkout page, which meets WCAG 2.2 AA and includes a bank OTP step. Then they're sent back to the merchant's site, and the merchant's server is told by a signed webhook. Under the hood is a Stripe-style API with card tokenization, authorise/capture, refunds, idempotency keys and per-merchant isolation.

[![CI](https://github.com/princemiller05/accesspay/actions/workflows/ci.yml/badge.svg)](https://github.com/princemiller05/accesspay/actions/workflows/ci.yml)

**[Live platform →](https://accesspay.onrender.com)** · [Docs](https://accesspay.onrender.com/docs/) · [Example shop that uses it](https://princemiller05.github.io/accesspay/)
Test mode only, so no real money moves. The free host sleeps when idle, so the first load can take up to a minute.

<!-- TODO: add a GIF: example shop → Buy → hosted checkout → OTP → back to the shop -->

## Use it on your website

1. **[Create a test account](https://accesspay.onrender.com/dashboard/#signup)** with your website's address. You get a publishable key, a secret key (shown once) and a webhook signing secret.
2. Pick how to connect:
   - **Payment link, no code.** Create a link for a product and price in the dashboard, then put it behind any button: `<a href="https://accesspay.onrender.com/l/plink_…">Buy – ₹299</a>`
   - **Checkout session, a few lines of server code.** For carts and changing amounts:
     ```js
     const session = await fetch('https://accesspay.onrender.com/v1/checkout/sessions', {
       method: 'POST',
       headers: { Authorization: `Bearer ${process.env.ACCESSPAY_SECRET_KEY}`, 'Content-Type': 'application/json' },
       body: JSON.stringify({ name: 'Order #1042', amount: 29900, currency: 'inr',
                              success_url: 'https://myshop.com/thanks', cancel_url: 'https://myshop.com/cart' }),
     }).then((r) => r.json());
     res.redirect(303, session.url);
     ```
3. Optionally, add a webhook URL to get `checkout.session.completed` and the other events, signed with HMAC-SHA256.

**Why the price can't live in the button's HTML:** anyone can edit a page in their browser and change ₹299 to ₹1. Prices come from the merchant's server (sessions) or from AccessPay's database (payment links).

[`examples/bookshop`](examples/bookshop) is a plain HTML website, with **no payment code at all**, that takes payments this way. It's published on GitHub Pages by its own workflow.

## How a payment flows

```
 Merchant's site            Merchant's server            AccessPay                       Customer
 ───────────────            ─────────────────            ─────────                       ────────
 "Buy" button ─── payment link or ── POST /v1/checkout/sessions (sk_) ─► session + PaymentIntent
                                                                         hosted page /pay/?s=cs_… ◄── opens
                                                                         card → tokenize → mock bank
                                                                         OTP dialog ◄──────────────── enters code
                  ◄──── signed webhook: checkout.session.completed ────── authorised / paid
 /thanks?session_id=cs_… ◄────────────────────── redirect (only to the merchant's own website)
```

The repo also contains the original single-shop demo: **Chai & Co.**, a fictional shop that uses the embeddable checkout components directly, with a merchant dashboard for capture and refunds.

## Highlights

**Accessibility (frontend)**
- Every field has a real label, a hint and an error linked with `aria-describedby`. Errors use an icon, text and border, not just colour.
- Validation never interrupts typing. Errors appear when you leave a field or submit, and clear as soon as they're fixed.
- On submit, an **error summary** receives focus, with links to each field. A declined card shows the same way.
- The **OTP dialog** uses the native `<dialog>` element, so the browser traps focus and Esc closes it. It has **one** input with `autocomplete="one-time-code"`, not six boxes, so SMS autofill and paste work. Focus returns to where it was when the dialog closes.
- Screen readers hear updates through live regions: "Visa card detected", "Processing payment", "A new code has been sent".
- The card number formats as you type **without the cursor jumping**. Backspace after a space deletes the digit, not the space.
- Works with keyboard only, at 320px wide, at 400% zoom, in dark mode and in Windows High Contrast.

**Platform (multi-merchant)**
- **Self-serve sign-up** with per-merchant test keys. The secret key is shown once and only its hash is stored. You can roll it at any time, and the old key dies immediately.
- **Every query is scoped to the merchant**, and tests prove one merchant can't read another's payments.
- **Hosted checkout sessions** expire after 30 minutes. A session id has 96 random bits, and the page is served with `Cache-Control: no-store`.
- **Open redirects are blocked:** `success_url` and `cancel_url` must be on the merchant's registered website.
- **SSRF protection:** in production, webhook URLs must be public HTTPS addresses. Private, loopback and cloud-metadata addresses (169.254.169.254) are rejected when saved and checked again on every delivery. Redirects aren't followed.
- **Rate limits** on sign-up, login and payment-link visits.

**Payments (backend)**
- **Two kinds of API key, like Stripe.** Secret keys (`sk_`) stay on the merchant's server and can do everything. Publishable keys (`pk_`) are safe in the browser but can only confirm a payment, and only with its `client_secret`.
- **Card data is never stored.** The full number and CVV are used once to ask the bank, then dropped. Only a token, the brand, the last 4 digits and an HMAC fingerprint are kept. Request logs never include bodies.
- **The server re-validates every card** with the same Luhn/IIN code the browser uses. It never trusts the client.
- **No double charges.**
  - Every state change runs in a transaction with `SELECT … FOR UPDATE`, so two simultaneous confirms can't both succeed. There's a test for this.
  - **Idempotency keys** make create, capture and refund safe to retry. The same key replays the first response; reusing a key with different parameters returns `422`.
- **OTP:** 6 digits, stored only as an HMAC. It expires after 5 minutes, allows 3 wrong attempts, and at most 3 codes can be sent.
- **Webhooks:**
  - Signed with HMAC-SHA256 over the timestamp and body, so they can't be forged or replayed.
  - Saved in the **same transaction** as the payment change they describe (the "transactional outbox" pattern), so a successful payment always produces its event.
  - Failed deliveries are retried with exponential backoff, and every attempt is logged in the dashboard.
- **Money is stored as integer paise**, never floats. The dashboard even parses "499.50" as a string, so floating point never touches an amount.
- **Dashboard security:**
  - scrypt password hashing
  - HttpOnly + SameSite session cookies
  - same-origin and JSON checks against cross-site request forgery (CSRF)
  - login rate limiting
  - the same error for "no such email" and "wrong password"
- **Security headers:** a strict Content-Security-Policy (no inline scripts), `nosniff` and `frame-ancestors 'none'`.

## Test cards

| Card number | Result |
|---|---|
| `4111 1111 1111 1111` | Visa: asks for OTP, then approved |
| `4242 4242 4242 4242` | Visa: approved without OTP |
| `5555 5555 5555 4444` | Mastercard: OTP |
| `6080 3200 0000 0002` | RuPay: OTP |
| `3782 822463 10005` | American Express: approved without OTP (4-digit CVV) |
| `4000 0000 0000 0002` | Declined |
| `4000 0000 0000 9995` | Declined: insufficient funds |
| `4000 0000 0000 0127` | Declined: incorrect CVC |

Any future expiry date works. In test mode, the OTP is shown in the dialog.

**Dashboard login:** `demo@chaiandco.test` / `chai-demo-2026`

## Run it locally

Needs **Node.js 22.18 or newer**. No database to install: when `DATABASE_URL` isn't set, it uses an embedded PostgreSQL ([PGlite](https://pglite.dev)) running in memory.

```bash
npm install
npm run dev        # http://localhost:5173 (shop) and http://localhost:5173/dashboard/
```

`npm run dev` starts the API server on :3000 and the Vite dev server on :5173 together.

| Command | What it does |
|---|---|
| `npm test` | 100+ unit, component and API tests (Vitest) |
| `npx playwright install` then `npm run test:e2e` | Browser tests in Chromium, Firefox, WebKit and a phone viewport, each with an axe-core accessibility scan |
| `npm run build && npm start` | Production mode on http://localhost:3000 |
| `npm run typecheck` | TypeScript strict-mode check |

To use real PostgreSQL, set `DATABASE_URL=postgres://…`. The schema is created automatically.

## API

All endpoints are under `/v1`. Authenticate with `Authorization: Bearer <key>`. Amounts are in paise (₹1 = 100).

| Method & path | Key | Description |
|---|---|---|
| `POST /v1/payment_intents` | sk | Create: `{ amount, currency: "inr", capture_method?: "automatic" \| "manual", description? }` |
| `GET /v1/payment_intents` | sk | List, newest first: `?limit=&starting_after=&status=` |
| `GET /v1/payment_intents/:id` | sk, or pk + `?client_secret=` | Retrieve |
| `POST /v1/payment_intents/:id/confirm` | pk | `{ client_secret, card: { number, exp_month, exp_year, cvc, name } }` |
| `POST /v1/payment_intents/:id/verify_otp` | pk | `{ client_secret, otp }` |
| `POST /v1/payment_intents/:id/resend_otp` | pk | `{ client_secret }` |
| `POST /v1/payment_intents/:id/capture` | sk | `{ amount_to_capture? }`: full or partial |
| `POST /v1/payment_intents/:id/cancel` | sk | Release an authorisation |
| `POST /v1/refunds` | sk | `{ payment_intent, amount?, reason? }`: full or partial |

Send an `Idempotency-Key` header on POSTs with a secret key to make them safe to retry.

Errors always look like this:
```json
{ "error": { "type": "card_error", "code": "card_declined", "decline_code": "insufficient_funds", "message": "Your card has insufficient funds. Try a different card." } }
```

Example:
```bash
curl -X POST http://localhost:3000/v1/payment_intents \
  -H "Authorization: Bearer sk_test_chaiandco_demo_secret" \
  -H "Idempotency-Key: order-1001" \
  -H "Content-Type: application/json" \
  -d '{"amount": 249900, "currency": "inr", "capture_method": "manual"}'
```

**Payment states**

```
requires_payment_method ──confirm──► requires_action ──OTP ok──┐
        ▲     │                             │                  │
        │     └─────────(no OTP needed)─────┼──────────────────┤
        │                                   │                  ▼
        └──── declined / 3 wrong OTPs ◄─────┘     manual? ── requires_capture ──capture──► succeeded ──► refunds
                                                  automatic? ─────────────────────────────►
        any unpaid state ──cancel──► canceled
```

## Project structure

```
src/core/            shared logic used by BOTH browser and server: Luhn, card networks, formatting, validation
src/components/      <ap-card-number> <ap-expiry> <ap-cvv> <ap-text-field> <ap-checkout-form> <ap-otp-dialog>
src/client/          browser client for the gateway (publishable key only)
src/styles/          themeable CSS: dark mode, forced colours, reduced motion
server/gateway/      API: auth, idempotency, payment intents, checkout sessions + payment links, mock bank, events, webhooks
server/dashboard/    merchant dashboard API (session cookie login)
server/demo-merchant/  the fictional shop, which uses the gateway over HTTP like any outside merchant
server/db/           schema + Postgres/PGlite adapter
demo/                demo shop, merchant dashboard, hosted checkout (/pay), docs (/docs)
examples/bookshop/   a plain HTML website that takes payments through AccessPay payment links
tests/               Vitest: unit, component (jsdom) and API tests
e2e/                 Playwright + axe-core browser tests
```

## Design decisions

- **Web Components in light DOM, not React and not Shadow DOM.** They work inside any framework. Shadow DOM would break `<label for>`, browser autofill and native form submission, and accessibility matters more here than style isolation.
- **The demo shop is a separate "company."** It only talks to the gateway over HTTP with its secret key, to show that the card never touches the merchant (which keeps them out of PCI DSS scope).
- **Shared validation code.** The browser gives instant feedback; the server enforces the same rules.
- **PGlite for development and tests.** It's real PostgreSQL in WebAssembly, so `npm install` is all you need, and each test file gets a fresh database.
- **Node runs the TypeScript directly** (type stripping), so there is no build step for the server.

## Limitations (honest list)

- The bank is simulated; no real card network is involved.
- Webhook retries are scheduled in memory, so pending retries are lost if the server restarts. Production would use a job queue or a worker polling the events table.
- Rate limiting is in memory (per server instance).
- Test mode only. Taking real payments for other businesses requires RBI authorisation as a payment aggregator, PCI DSS certification and bank partnerships.

## Roadmap

- [ ] Usability study with 5 participants → findings in `research/`
- [ ] Manual screen reader pass logged in [ACCESSIBILITY.md](ACCESSIBILITY.md)
- [ ] Saved cards (reusing the fingerprint)

## License

MIT
