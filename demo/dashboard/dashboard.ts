// Styles are imported here (not <link>ed) so Vite finds them in dev and production.
import '../fonts.ts';
import '../../src/styles/accesspay.css';
import '../demo.css';
import './dashboard.css';
import '../../src/index.ts';
import type { ApCheckoutForm, CheckoutSubmitDetail } from '../../src/index.ts';

/**
 * Merchant dashboard (one page, hash routes):
 *   #login  #signup  #keys     when logged out / just signed up
 *   #payments  #links  #developers   when logged in
 * Talks to /dashboard/api with a session cookie; never holds a secret key
 * except for the moment one is shown to the merchant.
 */
interface Payment {
  id: string; amount: number; currency: string; status: string; description: string | null;
  amount_capturable: number; amount_received: number; amount_refunded: number;
  payment_method: { brand: string; last4: string } | null; last_payment_error: { message: string } | null; created: number;
}
interface Link { id: string; url: string; name: string; amount: number; active: boolean; success_url: string | null }
interface Me { name: string; email: string; publishable_key: string; secret_key_hint: string; webhook_url: string | null; webhook_secret: string; website_url: string | null }

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const inr = (paise: number) => new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR' }).format(paise / 100);
const brands: Record<string, string> = { visa: 'Visa', mastercard: 'Mastercard', amex: 'Amex', rupay: 'RuPay' };
const dateFmt = new Intl.DateTimeFormat('en-IN', { dateStyle: 'medium', timeStyle: 'short' });

let me: Me | null = null;

async function api<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const res = await fetch(`/dashboard/api${path}`, {
    method: init.method ?? 'GET',
    headers: init.body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(json.error?.message ?? 'Request failed'), { status: res.status, param: json.error?.param });
  return json as T;
}

function announce(msg: string) {
  const s = $('dash-status');
  s.textContent = '';
  setTimeout(() => (s.textContent = msg), 100);
}

/** "1,234.50" -> 123450 paise, parsed as a string so floating point never touches money. */
function toPaise(input: string): number | null {
  const m = /^(\d+)(?:\.(\d{1,2}))?$/.exec(input.replace(/[,₹\s]/g, ''));
  if (!m) return null;
  return Number(m[1]) * 100 + Number((m[2] ?? '').padEnd(2, '0'));
}

function cell(text: string, className?: string) {
  const td = document.createElement('td');
  td.textContent = text;
  if (className) td.className = className;
  return td;
}

/** Visible label + hidden context, so repeated buttons ("Refund") say WHICH row to screen-reader users. */
function rowButton(label: string, context: string, onClick: () => void, secondary = false) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = `${secondary ? 'ap-secondary-button' : 'ap-pay-button'} btn-small`;
  b.textContent = label;
  const hidden = document.createElement('span');
  hidden.className = 'ap-visually-hidden';
  hidden.textContent = ` ${context}`;
  b.append(hidden);
  b.addEventListener('click', onClick);
  return b;
}

async function copy(text: string, what: string) {
  try {
    await navigator.clipboard.writeText(text);
    announce(`${what} copied`);
  } catch {
    announce(`Could not copy. Select the ${what.toLowerCase()} and copy it manually.`);
  }
}

// ───────── routing ─────────

const LOGGED_OUT = ['login', 'signup', 'keys'];
const LOGGED_IN = ['payments', 'links', 'developers'];
const TITLES: Record<string, string> = {
  login: 'Log in', signup: 'Create account', keys: 'Your API keys', payments: 'Payments', links: 'Payment links', developers: 'Developers',
};

async function route(focus = true) {
  let view = location.hash.slice(1);
  if (me) {
    if (view === 'keys' && $('new-keys').childElementCount) {
      // allowed right after sign-up
    } else if (!LOGGED_IN.includes(view)) view = 'payments';
  } else if (!LOGGED_OUT.includes(view) || view === 'keys') view = 'login';

  for (const v of [...LOGGED_OUT, ...LOGGED_IN]) $(`${v}-view`).hidden = v !== view;
  $('app-view').hidden = !me || !LOGGED_IN.includes(view);
  $('logout-item').hidden = !me;
  document.querySelectorAll<HTMLAnchorElement>('.tabs a').forEach((a) => {
    if (a.hash === `#${view}`) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  });
  document.title = `${TITLES[view]} – AccessPay`;

  if (view === 'payments') await loadPayments();
  if (view === 'links') await loadLinks();
  if (view === 'developers') await loadDevelopers();
  // Single-page navigation: move focus to the new heading so screen readers announce the page change.
  if (focus) $(`${view}-title`).focus();
}

window.addEventListener('hashchange', () => void route());

async function refreshMe() {
  try {
    me = await api<Me>('/me');
    $('account').textContent = `${me.name} · ${me.email}`;
  } catch {
    me = null;
  }
}

// ───────── log in / sign up / log out ─────────

$<ApCheckoutForm>('login-form').addEventListener('ap-submit', async (e) => {
  const form = e.currentTarget as ApCheckoutForm;
  const { fields } = (e as CustomEvent<CheckoutSubmitDetail>).detail;
  form.busy = true;
  try {
    await api('/login', { method: 'POST', body: { email: fields.email, password: fields.password } });
    await refreshMe();
    location.hash = '#payments';
    await route();
  } catch (err) {
    form.showPaymentError((err as Error).message, 'Could not log in');
  } finally {
    form.busy = false;
  }
});

$<ApCheckoutForm>('signup-form').addEventListener('ap-submit', async (e) => {
  const form = e.currentTarget as ApCheckoutForm;
  const { fields } = (e as CustomEvent<CheckoutSubmitDetail>).detail;
  form.busy = true;
  try {
    const { keys } = await api<{ keys: { publishable_key: string; secret_key: string; webhook_secret: string } }>('/signup', { method: 'POST', body: fields });
    await refreshMe();
    showNewKeys(keys);
    location.hash = '#keys';
    await route();
  } catch (err) {
    form.showPaymentError((err as Error).message, 'Could not create your account');
  } finally {
    form.busy = false;
  }
});

function showNewKeys(keys: Record<string, string>) {
  const labels: Record<string, string> = { publishable_key: 'Publishable key', secret_key: 'Secret key', webhook_secret: 'Webhook signing secret' };
  $('new-keys').replaceChildren(
    ...Object.entries(labels).flatMap(([k, label]) => {
      const dt = document.createElement('dt');
      dt.textContent = label;
      const dd = document.createElement('dd');
      const code = document.createElement('code');
      code.className = 'break';
      code.textContent = keys[k];
      dd.append(code, ' ', rowButton('Copy', label, () => void copy(keys[k], label), true));
      return [dt, dd];
    }),
  );
}

$('logout').addEventListener('click', async () => {
  await api('/logout', { method: 'POST', body: {} });
  me = null;
  $('new-keys').replaceChildren();
  location.hash = '#login';
  await route();
});

// ───────── payments ─────────

function statusLabel(p: Payment): string {
  switch (p.status) {
    case 'requires_capture': return 'Authorised';
    case 'succeeded':
      if (p.amount_refunded >= p.amount_received) return 'Refunded';
      if (p.amount_refunded > 0) return `Partly refunded (${inr(p.amount_refunded)})`;
      return 'Succeeded';
    case 'requires_payment_method': return p.last_payment_error ? 'Failed' : 'Incomplete';
    case 'requires_action': return 'Waiting for OTP';
    case 'canceled': return 'Cancelled';
    default: return p.status;
  }
}

async function loadPayments() {
  const filter = $<HTMLSelectElement>('status-filter').value;
  const { data } = await api<{ data: Payment[] }>(`/payments${filter ? `?status=${encodeURIComponent(filter)}` : ''}`);
  $('payments-empty').hidden = data.length > 0;
  $('payments-body').replaceChildren(
    ...data.map((p) => {
      const card = p.payment_method ? `${brands[p.payment_method.brand] ?? p.payment_method.brand} •••• ${p.payment_method.last4}` : '—';
      const context = `${inr(p.amount)} payment, ${p.description ?? card}`;
      const statusTd = cell('');
      const badge = document.createElement('span');
      badge.className = `badge badge--${p.status}`;
      badge.textContent = statusLabel(p);
      statusTd.append(badge);
      if (p.last_payment_error) {
        const note = document.createElement('span');
        note.className = 'badge-note';
        note.textContent = p.last_payment_error.message;
        statusTd.append(note);
      }
      const actionsTd = document.createElement('td');
      const actions = document.createElement('div'); // flex on the <td> itself would break the table layout
      actions.className = 'actions';
      actionsTd.append(actions);
      if (p.status === 'requires_capture') {
        actions.append(
          rowButton('Capture', context, () => void act(`/payments/${p.id}/capture`, `Captured ${inr(p.amount_capturable)}.`)),
          rowButton('Cancel', context, () => void act(`/payments/${p.id}/cancel`, 'Payment cancelled. The hold on the card is released.'), true),
        );
      }
      if (p.status === 'succeeded' && p.amount_refunded < p.amount_received) {
        actions.append(rowButton('Refund', context, () => openRefund(p), true));
      }
      const tr = document.createElement('tr');
      tr.append(cell(dateFmt.format(p.created * 1000)), cell(inr(p.amount), 'num'), statusTd, cell(card), cell(p.description ?? ''), actionsTd);
      return tr;
    }),
  );
}

async function act(path: string, success: string, body: unknown = {}) {
  try {
    await api(path, { method: 'POST', body });
    await loadPayments();
    announce(success);
  } catch (err) {
    announce(`Error: ${(err as Error).message}`);
  }
  $('payments-title').focus(); // the clicked button may be gone after re-rendering
}

$('status-filter').addEventListener('change', () => void loadPayments().then(() => announce('Payments updated')));
$('refresh').addEventListener('click', () => void loadPayments().then(() => announce('Payments updated')));

// Refund dialog
const refundDialog = $<HTMLDialogElement>('refund-dialog');
const amountInput = $<HTMLInputElement>('refund-amount');
let refundTarget: Payment | null = null;
let refundOpener: HTMLElement | null = null;

function setRefundError(msg: string | null) {
  $('refund-error').hidden = !msg;
  $('refund-error-text').textContent = msg ?? '';
  amountInput.toggleAttribute('aria-invalid', !!msg);
}
function openRefund(p: Payment) {
  refundTarget = p;
  refundOpener = document.activeElement as HTMLElement;
  const remaining = p.amount_received - p.amount_refunded;
  $('refund-desc').textContent = `${inr(p.amount_received)} payment${p.payment_method ? ` from card ending ${p.payment_method.last4}` : ''}.`;
  $('refund-hint').textContent = `Up to ${inr(remaining)}. Leave as is for a full refund.`;
  amountInput.value = (remaining / 100).toFixed(2);
  setRefundError(null);
  refundDialog.showModal();
  amountInput.select();
}
function closeRefund() {
  refundDialog.close();
  refundOpener?.focus();
}
$('refund-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const p = refundTarget!;
  const remaining = p.amount_received - p.amount_refunded;
  const paise = toPaise(amountInput.value);
  if (paise === null || paise < 1) return setRefundError('Enter an amount in rupees, for example 500 or 499.50');
  if (paise > remaining) return setRefundError(`You can refund at most ${inr(remaining)}`);
  try {
    await api(`/payments/${p.id}/refund`, { method: 'POST', body: { amount: paise } });
    refundDialog.close();
    await loadPayments();
    announce(`Refunded ${inr(paise)}.`);
    $('payments-title').focus();
  } catch (err) {
    setRefundError((err as Error).message);
  }
});
$('refund-cancel').addEventListener('click', closeRefund);
refundDialog.addEventListener('cancel', (e) => {
  e.preventDefault();
  closeRefund();
});

// ───────── payment links ─────────

async function loadLinks() {
  const { data } = await api<{ data: Link[] }>('/links');
  $('links-empty').hidden = data.length > 0;
  $('links-body').replaceChildren(
    ...data.map((l) => {
      // Show the link on the host the merchant is using (handy in local development).
      const url = `${location.origin}/l/${l.id}`;
      const linkTd = cell('');
      const a = document.createElement('a');
      a.href = url;
      a.textContent = url;
      a.className = 'break';
      linkTd.append(a);
      const actionsTd = document.createElement('td');
      const actions = document.createElement('div');
      actions.className = 'actions';
      actionsTd.append(actions);
      actions.append(
        rowButton('Copy link', `for ${l.name}`, () => void copy(url, 'Link')),
        rowButton(l.active ? 'Deactivate' : 'Activate', l.name, async () => {
          await api(`/links/${l.id}/active`, { method: 'POST', body: { active: !l.active } });
          await loadLinks();
          announce(`${l.name} ${l.active ? 'deactivated' : 'activated'}`);
          $('links-title').focus();
        }, true),
      );
      const tr = document.createElement('tr');
      tr.append(cell(l.name), cell(inr(l.amount), 'num'), linkTd, cell(l.active ? 'Active' : 'Inactive'), actionsTd);
      return tr;
    }),
  );
  if (data[0]) $('link-snippet').textContent = `<a href="${location.origin}/l/${data[0].id}">Buy now – ${inr(data[0].amount)}</a>`;
}

$<ApCheckoutForm>('link-form').addEventListener('ap-submit', async (e) => {
  const form = e.currentTarget as ApCheckoutForm;
  const { fields } = (e as CustomEvent<CheckoutSubmitDetail>).detail;
  const amount = toPaise(fields.price);
  if (amount === null || amount < 100) {
    form.showPaymentError('Enter a price of at least ₹1, for example 299 or 299.50', 'Check the price');
    return;
  }
  form.busy = true;
  try {
    const link = await api<Link>('/links', {
      method: 'POST',
      body: { name: fields.name, amount, success_url: fields.success_url || undefined },
    });
    form.querySelectorAll('input').forEach((i) => (i.value = ''));
    await loadLinks();
    announce(`Payment link created for ${link.name}`);
    $('links-title').focus();
  } catch (err) {
    form.showPaymentError((err as Error).message, 'Could not create the link');
  } finally {
    form.busy = false;
  }
});

// ───────── developers ─────────

async function loadDevelopers() {
  await refreshMe();
  if (!me) return;
  $('pk').textContent = me.publishable_key;
  $('sk-hint').textContent = me.secret_key_hint;
  const set = (name: string, value: string | null) => {
    const input = document.querySelector<HTMLInputElement>(`#settings-form ap-text-field[name="${name}"] input`);
    if (input) input.value = value ?? '';
  };
  set('website_url', me.website_url);
  set('webhook_url', me.webhook_url);

  const { data } = await api<{ data: Array<{ created_at: string; event_type: string; attempt: number; success: boolean; status_code: number | null; error: string | null }> }>('/webhooks');
  $('webhooks-empty').hidden = data.length > 0;
  $('webhooks-body').replaceChildren(
    ...data.map((d) => {
      const tr = document.createElement('tr');
      const result = d.success ? `Delivered (HTTP ${d.status_code})` : `Failed (${d.status_code ? `HTTP ${d.status_code}` : d.error ?? 'no response'})`;
      tr.append(cell(dateFmt.format(new Date(d.created_at))), cell(d.event_type), cell(String(d.attempt), 'num'), cell(result));
      return tr;
    }),
  );
}

$('reveal').addEventListener('click', () => {
  const btn = $('reveal');
  const show = btn.getAttribute('aria-pressed') !== 'true';
  btn.setAttribute('aria-pressed', String(show));
  btn.textContent = show ? 'Hide' : 'Show';
  $('whsec').textContent = show && me ? me.webhook_secret : '••••••••••••';
});

$<ApCheckoutForm>('settings-form').addEventListener('ap-submit', async (e) => {
  const form = e.currentTarget as ApCheckoutForm;
  const { fields } = (e as CustomEvent<CheckoutSubmitDetail>).detail;
  form.busy = true;
  try {
    await api('/settings', { method: 'POST', body: { website_url: fields.website_url, webhook_url: fields.webhook_url ?? '' } });
    await loadDevelopers();
    announce('Settings saved');
  } catch (err) {
    form.showPaymentError((err as Error).message, 'Could not save settings');
  } finally {
    form.busy = false;
  }
});

// Roll secret key (with confirmation)
const rollDialog = $<HTMLDialogElement>('roll-dialog');
$('roll').addEventListener('click', () => {
  $('roll-result').hidden = true;
  $('roll-confirm').hidden = false;
  $('roll-cancel').hidden = false;
  rollDialog.showModal();
  $('roll-cancel').focus(); // safest default for a destructive action
});
$('roll-cancel').addEventListener('click', () => {
  rollDialog.close();
  $('roll').focus();
});
$('roll-confirm').addEventListener('click', async () => {
  const { secret_key } = await api<{ secret_key: string }>('/keys/roll', { method: 'POST', body: {} });
  $('new-sk').textContent = secret_key;
  $('roll-confirm').hidden = true;
  $('roll-cancel').hidden = true;
  $('roll-result').hidden = false;
  $('roll-done').focus();
  await refreshMe();
  if (me) $('sk-hint').textContent = me.secret_key_hint;
});
$('roll-done').addEventListener('click', () => {
  $('new-sk').textContent = '';
  rollDialog.close();
  $('roll').focus();
});

// ───────── start ─────────
await refreshMe();
await route(false);
