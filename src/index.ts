import { ApCardNumber } from './components/card-number.ts';
import { ApExpiry } from './components/expiry.ts';
import { ApCvv } from './components/cvv.ts';
import { ApTextField } from './components/text-field.ts';
import { ApCheckoutForm } from './components/checkout-form.ts';
import { ApOtpDialog } from './components/otp-dialog.ts';

export { ApCardNumber, ApExpiry, ApCvv, ApTextField, ApCheckoutForm, ApOtpDialog };
export { GatewayClient, GatewayError } from './client/gateway.ts';
export type { PaymentIntent, CardDetails } from './client/gateway.ts';
export * from './core/luhn.ts';
export * from './core/networks.ts';
export * from './core/format.ts';
export * from './core/validation.ts';
export type { CheckoutSubmitDetail } from './components/checkout-form.ts';

const elements: Array<[string, CustomElementConstructor]> = [
  ['ap-card-number', ApCardNumber],
  ['ap-expiry', ApExpiry],
  ['ap-cvv', ApCvv],
  ['ap-text-field', ApTextField],
  ['ap-checkout-form', ApCheckoutForm],
  ['ap-otp-dialog', ApOtpDialog],
];

/** Registers all AccessPay elements. Safe to call more than once. */
export function defineAccessPay(): void {
  for (const [name, ctor] of elements) {
    if (!customElements.get(name)) customElements.define(name, ctor);
  }
}

defineAccessPay();
