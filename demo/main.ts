// Styles are imported here (not <link>ed) so Vite finds them in dev and production.
import './fonts.ts';
import '../src/styles/accesspay.css';
import './demo.css';
import '../src/index.ts';
import { GatewayClient, type ApCheckoutForm, type PaymentIntent } from '../src/index.ts';
import { attachGlow } from './glow.ts';
import { setStep } from './steps.ts';

/**
 * The demo shop's checkout page. Flow:
 *  1. ap-submit (all fields valid) -> ask the SHOP's server to create an order.
 *     The shop creates a PaymentIntent with its secret key and returns a client_secret.
 *  2. The component sends the card straight to the GATEWAY with the publishable key.
 *  3. OTP step if the bank asks for it.
 *  4. Show the result, then show the order status the shop learned via webhook.
 */
const checkout = document.getElementById('checkout') as ApCheckoutForm;
const formArea = document.getElementById('pay-form-area')!;
const confirmation = document.getElementById('confirmation')!;
const title = document.getElementById('confirmation-title')!;
const text = document.getElementById('confirmation-text')!;
const webhookStatus = document.getElementById('webhook-status')!;

const names: Record<string, string> = { visa: 'Visa', mastercard: 'Mastercard', amex: 'American Express', rupay: 'RuPay' };

interface Order {
  order_id: string;
  payment_intent: string;
  client_secret: string;
  publishable_key: string;
}
// Reuse the same order (and PaymentIntent) if the first card is declined.
let order: Order | null = null;

async function createOrder(): Promise<Order> {
  const res = await fetch('/shop/api/orders', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  if (!res.ok) throw new Error('Could not start checkout');
  return res.json();
}

checkout.addEventListener('ap-submit', async () => {
  checkout.busy = true;
  try {
    order ??= await createOrder();
    const client = new GatewayClient({ publishableKey: order.publishable_key });
    const pi = await checkout.confirmPayment({ client, paymentIntent: order.payment_intent, clientSecret: order.client_secret });
    if (pi) showConfirmation(pi);
  } catch {
    checkout.showPaymentError("We couldn't reach the shop. Check your connection and try again.");
  } finally {
    checkout.busy = false;
  }
});

function showConfirmation(pi: PaymentIntent) {
  const card = pi.payment_method ? `${names[pi.payment_method.brand] ?? 'card'} ending ${pi.payment_method.last4}` : 'your card';
  const amount = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR' }).format(pi.amount / 100);
  title.textContent = 'Order placed';
  text.textContent =
    pi.status === 'requires_capture'
      ? `${amount} has been authorised on ${card}. You'll be charged when your order ships. This is a demo, so no real money moves.`
      : `${amount} paid with ${card}. This is a demo, so no real money moves.`;
  formArea.hidden = true;
  confirmation.hidden = false;
  setStep('done');
  title.focus(); // move focus to the result so screen-reader users hear it
  void pollOrder();
}

/** Shows that the shop's server learned about the payment from a signed webhook. */
async function pollOrder() {
  for (let i = 0; i < 10 && order; i++) {
    const res = await fetch(`/shop/api/orders/${order.order_id}`);
    const o = (await res.json()) as { status: string };
    if (o.status !== 'awaiting_payment') {
      webhookStatus.textContent = `Chai & Co.'s server was notified by webhook: order ${order.order_id} is "${o.status}".`;
      return;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
}

document.getElementById('restart')!.addEventListener('click', () => location.reload());

attachGlow(document.querySelector<HTMLElement>('.cb-side'));
