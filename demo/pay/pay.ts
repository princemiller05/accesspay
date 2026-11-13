// Styles are imported here (not <link>ed) so Vite finds them in dev and production.
import '../../src/styles/accesspay.css';
import '../demo.css';
import './pay.css';
import '../../src/index.ts';
import { GatewayClient, type ApCheckoutForm } from '../../src/index.ts';

/**
 * Hosted checkout page: /pay/?s=cs_…
 * Any merchant sends customers here (from a Checkout Session or a Payment Link).
 * After paying, the customer goes straight back to the merchant's success_url.
 */
interface PublicSession {
  id: string;
  status: 'open' | 'complete' | 'expired';
  merchant_name: string;
  name: string;
  amount: number;
  currency: string;
  publishable_key: string;
  payment_intent: string;
  client_secret: string | null;
  success_url: string | null;
  cancel_url: string | null;
}

const content = document.getElementById('content')!;
const loading = document.getElementById('loading')!;
const inr = (paise: number) => new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR' }).format(paise / 100);

/** Build elements with text set via textContent: merchant-provided names can never inject HTML. */
function el<K extends keyof HTMLElementTagNameMap>(tag: K, props: Partial<HTMLElementTagNameMap[K]> = {}, ...children: (Node | string)[]) {
  const e = Object.assign(document.createElement(tag), props);
  e.append(...children);
  return e;
}

function showMessage(title: string, text: string, link?: { href: string; label: string }) {
  loading.remove();
  const h1 = el('h1', { tabIndex: -1 }, title);
  content.replaceChildren(el('div', { className: 'pay-receipt' }, h1, el('p', {}, text), ...(link ? [el('p', {}, el('a', { href: link.href }, link.label))] : [])));
  document.title = `${title} – AccessPay`;
  h1.focus();
}

async function start() {
  const id = new URLSearchParams(location.search).get('s');
  if (!id) return showMessage('Checkout not found', 'This checkout link is incomplete. Go back to the shop and try again.');

  const res = await fetch(`/checkout/api/sessions/${encodeURIComponent(id)}`);
  if (!res.ok) return showMessage('Checkout not found', 'This checkout link is not valid. Go back to the shop and try again.');
  const s = (await res.json()) as PublicSession;
  const back = s.cancel_url ? { href: s.cancel_url, label: `Back to ${s.merchant_name}` } : undefined;

  if (s.status === 'complete') {
    if (s.success_url) return location.replace(s.success_url);
    return showMessage('Already paid', `This payment to ${s.merchant_name} is complete.`);
  }
  if (s.status === 'expired') {
    return showMessage('This checkout has expired', `Checkouts expire after 30 minutes for your security. Go back to ${s.merchant_name} and start again.`, back);
  }

  // Open: render the payment form.
  loading.remove();
  document.title = `Pay ${s.merchant_name} – AccessPay`;
  const form = document.createElement('ap-checkout-form') as ApCheckoutForm;
  // Built with innerHTML only from our own fixed markup and a number; no merchant text here.
  form.innerHTML = `
    <form>
      <ap-text-field name="cardholder" label="Name on card" autocomplete="cc-name" error-message="Enter the name as it appears on your card"></ap-text-field>
      <ap-card-number name="cardNumber"></ap-card-number>
      <div class="ap-row">
        <ap-expiry name="expiry"></ap-expiry>
        <ap-cvv name="cvv"></ap-cvv>
      </div>
      <button type="submit" class="ap-pay-button">Pay ${inr(s.amount)}</button>
    </form>`;

  content.replaceChildren(
    ...(back ? [el('a', { className: 'pay-back', href: back.href }, `← ${back.label}`)] : []),
    el('p', { className: 'pay-merchant' }, s.merchant_name),
    el('h1', {}, s.name),
    el('p', { className: 'pay-amount' }, el('span', { className: 'ap-visually-hidden' }, 'Amount: '), inr(s.amount)),
    form,
  );

  form.addEventListener('ap-submit', async () => {
    form.busy = true;
    try {
      const client = new GatewayClient({ publishableKey: s.publishable_key });
      const pi = await form.confirmPayment({ client, paymentIntent: s.payment_intent, clientSecret: s.client_secret! });
      if (!pi) return;
      if (s.success_url) {
        form.announce(`Payment successful. Returning to ${s.merchant_name}`);
        location.replace(s.success_url);
        return;
      }
      showMessage('Payment successful', `${inr(s.amount)} paid to ${s.merchant_name}. You can close this page.`);
    } finally {
      form.busy = false;
    }
  });
}

start().catch(() => showMessage('Something went wrong', 'We could not load this checkout. Check your connection and try again.'));
