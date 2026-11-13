/**
 * Browser client for the AccessPay gateway. Uses only the PUBLISHABLE key and
 * a payment's client_secret, so it is safe to run in the browser.
 */

export interface PaymentIntent {
  id: string;
  status: 'requires_payment_method' | 'requires_action' | 'requires_capture' | 'succeeded' | 'canceled';
  amount: number;
  currency: string;
  payment_method: { brand: string; last4: string } | null;
  next_action: { type: 'otp'; otp: { expires_at: number; test_code?: string } } | null;
  last_payment_error: { code: string; message: string } | null;
}

export interface CardDetails {
  number: string;
  exp_month: number;
  exp_year: number;
  cvc: string;
  name: string;
}

export class GatewayError extends Error {
  status: number;
  type: string;
  code: string;
  param?: string;
  attemptsRemaining?: number;

  constructor(status: number, body: { type?: string; code?: string; message?: string; param?: string; attempts_remaining?: number }) {
    super(body.message ?? 'Something went wrong. Try again.');
    this.status = status;
    this.type = body.type ?? 'api_error';
    this.code = body.code ?? 'unknown';
    this.param = body.param;
    this.attemptsRemaining = body.attempts_remaining;
  }
}

export class GatewayClient {
  private baseUrl: string;
  private publishableKey: string;

  constructor(opts: { publishableKey: string; baseUrl?: string }) {
    if (!opts.publishableKey.startsWith('pk_')) {
      throw new Error('Use a publishable key (pk_…) in the browser, never a secret key');
    }
    this.publishableKey = opts.publishableKey;
    this.baseUrl = opts.baseUrl ?? '';
  }

  confirm(id: string, clientSecret: string, card: CardDetails) {
    return this.post(`/v1/payment_intents/${id}/confirm`, { client_secret: clientSecret, card });
  }

  verifyOtp(id: string, clientSecret: string, otp: string) {
    return this.post(`/v1/payment_intents/${id}/verify_otp`, { client_secret: clientSecret, otp });
  }

  resendOtp(id: string, clientSecret: string) {
    return this.post(`/v1/payment_intents/${id}/resend_otp`, { client_secret: clientSecret });
  }

  private async post(path: string, body: unknown): Promise<PaymentIntent> {
    let res: Response;
    try {
      res = await fetch(this.baseUrl + path, {
        method: 'POST',
        headers: { Authorization: `Bearer ${this.publishableKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
    } catch {
      throw new GatewayError(0, { code: 'network_error', message: "We couldn't reach the payment service. Check your connection and try again." });
    }
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new GatewayError(res.status, json.error ?? {});
    return json as PaymentIntent;
  }
}
