import type { ApField } from './base-field.ts';
import type { ApCardNumber, NetworkChangeDetail } from './card-number.ts';
import type { NetworkId } from '../core/networks.ts';
import { onlyDigits } from '../core/format.ts';
import { parseExpiry } from '../core/validation.ts';
import { GatewayError, type GatewayClient, type PaymentIntent } from '../client/gateway.ts';
import { ApOtpDialog } from './otp-dialog.ts';

export interface CheckoutSubmitDetail {
  /** Only non-sensitive data leaves the component: never the full card number or CVV. */
  network: NetworkId | null;
  last4: string;
  expiry: string;
  fields: Record<string, string>;
}

/**
 * <ap-checkout-form>
 *   <form> …ap-* fields… <button>Pay</button> </form>
 * </ap-checkout-form>
 *
 * Wraps a normal <form> (keeps native Enter-to-submit). Adds:
 *  - an error summary that receives focus on a failed submit, with links to each field;
 *  - "Error:" prefixed to the page title while errors are shown;
 *  - a polite live region for status announcements ("Visa card detected", "Processing payment");
 *  - an `ap-submit` event with masked data when everything is valid;
 *  - confirmPayment(): sends the card straight to the gateway and runs the OTP step.
 */
export class ApCheckoutForm extends HTMLElement {
  private form!: HTMLFormElement;
  private summary!: HTMLDivElement;
  private summaryList!: HTMLUListElement;
  private summaryHeading!: HTMLHeadingElement;
  private liveRegion!: HTMLDivElement;
  private submitButton: HTMLButtonElement | null = null;
  private submitLabel = '';
  private originalTitle = '';
  private announceTimer?: number;
  private _busy = false;

  connectedCallback(): void {
    if (this.form) return;
    const form = this.querySelector('form');
    if (!form) {
      console.error('<ap-checkout-form> needs a <form> inside it');
      return;
    }
    this.form = form;
    this.form.noValidate = true; // we show accessible errors instead of browser bubbles
    this.originalTitle = document.title;
    this.submitButton = form.querySelector('button[type="submit"], button:not([type])');
    this.submitLabel = this.submitButton?.textContent ?? '';
    this.buildSummary();
    this.buildLiveRegion();

    this.form.addEventListener('submit', (e) => this.onSubmit(e));
    this.form.addEventListener('ap-network-change', (e) => {
      const { network } = (e as CustomEvent<NetworkChangeDetail>).detail;
      if (network) this.announce(`${network.name} card detected`);
    });
  }

  /** While busy, the Pay button is disabled and further submits are ignored (no double charges). */
  get busy(): boolean {
    return this._busy;
  }

  set busy(value: boolean) {
    this._busy = value;
    this.toggleAttribute('aria-busy', value);
    if (this.submitButton) {
      // aria-disabled instead of disabled: the button keeps focus, so keyboard users don't get lost.
      this.submitButton.setAttribute('aria-disabled', String(value));
      this.submitButton.textContent = value ? 'Processing payment…' : this.submitLabel;
    }
    if (value) this.announce('Processing payment, please wait');
  }

  /** Politely announce a message to screen-reader users. */
  announce(message: string): void {
    // Clear first so the same message is read again if repeated.
    this.liveRegion.textContent = '';
    window.clearTimeout(this.announceTimer);
    this.announceTimer = window.setTimeout(() => {
      this.liveRegion.textContent = message;
    }, 150);
  }

  /** Show a payment-level problem (e.g. declined card) in the summary box and move focus to it. */
  showPaymentError(message: string, title = 'Your payment was not completed'): void {
    this.showSummary(title, [{ message }]);
  }

  /**
   * Send the card details directly to the gateway (never to the shop's server),
   * handle the OTP step, and resolve with the final PaymentIntent,
   * or null if the payment failed or was cancelled (an error is already shown).
   */
  async confirmPayment(opts: { client: GatewayClient; paymentIntent: string; clientSecret: string }): Promise<PaymentIntent | null> {
    const { client, paymentIntent: id, clientSecret } = opts;
    try {
      let pi = await client.confirm(id, clientSecret, this.readCard());
      if (pi.status === 'requires_action' && pi.next_action?.type === 'otp') {
        this.emitStep('otp');
        const outcome = await this.runOtp(client, id, clientSecret, pi.next_action.otp.test_code);
        if (outcome.result !== 'verified') this.emitStep('card');
        if (outcome.result === 'canceled') {
          this.showPaymentError('You cancelled the payment. You have not been charged. You can try again.', 'Payment cancelled');
          return null;
        }
        if (outcome.result === 'failed') {
          this.showPaymentError(outcome.message ?? 'The payment could not be verified. Try again.');
          return null;
        }
        pi = outcome.pi!;
      }
      if (pi.status === 'succeeded' || pi.status === 'requires_capture') {
        this.hideSummary();
        return pi;
      }
      this.showPaymentError(pi.last_payment_error?.message ?? 'The payment could not be completed. Try again.');
      return null;
    } catch (err) {
      const message = err instanceof GatewayError ? err.message : 'Something went wrong. Try again.';
      // A field-specific card error (e.g. invalid number) links back to the field.
      const field = err instanceof GatewayError ? this.fieldForParam(err.param) : null;
      this.showSummary('Your payment was not completed', [{ message, field: field ?? undefined }]);
      return null;
    }
  }

  /** Tells the page which step the customer is on ("card" | "otp"), e.g. to update a step indicator. */
  private emitStep(step: 'card' | 'otp') {
    this.dispatchEvent(new CustomEvent('ap-step', { detail: { step }, bubbles: true }));
  }

  private async runOtp(client: GatewayClient, id: string, clientSecret: string, testCode?: string) {
    let dialog = this.querySelector<ApOtpDialog>('ap-otp-dialog');
    if (!dialog) {
      dialog = document.createElement('ap-otp-dialog') as ApOtpDialog;
      this.append(dialog);
    }
    let finalPi: PaymentIntent | undefined;
    let fatalMessage: string | undefined;
    const result = await dialog.open({
      testCode,
      onVerify: async (otp) => {
        try {
          finalPi = await client.verifyOtp(id, clientSecret, otp);
          return { ok: true };
        } catch (err) {
          const e = err as GatewayError;
          if (e.code === 'incorrect_otp' || e.code === 'otp_invalid' || e.code === 'otp_expired') {
            return { ok: false, message: e.message };
          }
          fatalMessage = e.message;
          return { ok: false, message: e.message, fatal: true };
        }
      },
      onResend: async () => {
        try {
          const pi = await client.resendOtp(id, clientSecret);
          return { ok: true, testCode: pi.next_action?.otp.test_code };
        } catch (err) {
          return { ok: false, message: (err as Error).message };
        }
      },
    });
    return { result, pi: finalPi, message: fatalMessage };
  }

  private readCard() {
    const card = this.form.querySelector<ApCardNumber>('ap-card-number')!;
    const expiry = parseExpiry(this.form.querySelector<ApField>('ap-expiry')!.value)!;
    const nameField =
      this.form.querySelector<ApField>('ap-text-field[autocomplete="cc-name"]') ??
      this.form.querySelector<ApField>('ap-text-field[name="cardholder"]');
    return {
      number: card.digits,
      exp_month: expiry.month,
      exp_year: expiry.year,
      cvc: onlyDigits(this.form.querySelector<ApField>('ap-cvv')!.value),
      name: nameField?.value.trim() ?? '',
    };
  }

  private fieldForParam(param?: string): ApField | null {
    const map: Record<string, string> = {
      'card.number': 'ap-card-number',
      'card.exp_month': 'ap-expiry',
      'card.cvc': 'ap-cvv',
      'card.name': 'ap-text-field[autocomplete="cc-name"]',
    };
    return param && map[param] ? this.form.querySelector<ApField>(map[param]) : null;
  }

  private get fields(): ApField[] {
    return Array.from(this.form.querySelectorAll<ApField>('[data-ap-field]'));
  }

  private onSubmit(e: SubmitEvent): void {
    e.preventDefault();
    if (this._busy) return; // ignore double clicks while a payment is running

    const errors = this.fields
      .map((field) => ({ field, message: field.validate() }))
      .filter((r): r is { field: ApField; message: string } => r.message !== null);

    if (errors.length) {
      const n = errors.length;
      this.showSummary(n === 1 ? 'There is a problem with 1 field' : `There are problems with ${n} fields`, errors);
      return;
    }
    this.hideSummary();

    const card = this.form.querySelector<ApCardNumber>('ap-card-number');
    const values: Record<string, string> = {};
    for (const f of this.fields) {
      const name = f.getAttribute('name');
      // Card number and CVV are deliberately excluded (PCI DSS: don't spread card data around).
      if (name && !['ap-card-number', 'ap-cvv'].includes(f.localName)) values[name] = f.value;
    }
    this.dispatchEvent(
      new CustomEvent<CheckoutSubmitDetail>('ap-submit', {
        bubbles: true,
        detail: {
          network: card?.detectedNetwork?.id ?? null,
          last4: card?.digits.slice(-4) ?? '',
          expiry: this.form.querySelector<ApField>('ap-expiry')?.value ?? '',
          fields: values,
        },
      }),
    );
  }

  private showSummary(title: string, items: Array<{ message: string; field?: ApField }>): void {
    this.summaryHeading.textContent = title;
    this.summaryList.replaceChildren(
      ...items.map(({ field, message }) => {
        const li = document.createElement('li');
        if (!field) {
          li.textContent = message;
          return li;
        }
        const a = document.createElement('a');
        a.href = `#${field.inputId}`;
        a.textContent = message;
        a.addEventListener('click', (ev) => {
          ev.preventDefault();
          field.focusInput();
          field.scrollIntoView({ block: 'center', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
        });
        li.append(a);
        return li;
      }),
    );
    this.summary.hidden = false;
    document.title = `Error: ${this.originalTitle}`;
    // Move focus so keyboard and screen-reader users land on the summary.
    this.summary.focus();
  }

  private hideSummary(): void {
    this.summary.hidden = true;
    document.title = this.originalTitle;
  }

  private buildSummary(): void {
    this.summary = document.createElement('div');
    this.summary.className = 'ap-error-summary';
    this.summary.tabIndex = -1; // focusable by script, not in the tab order
    this.summary.hidden = true;
    this.summary.setAttribute('role', 'group');
    this.summaryHeading = document.createElement('h2');
    this.summaryHeading.className = 'ap-error-summary__title';
    this.summaryHeading.id = `ap-summary-${Math.random().toString(36).slice(2, 8)}`;
    this.summary.setAttribute('aria-labelledby', this.summaryHeading.id);
    this.summaryList = document.createElement('ul');
    this.summaryList.className = 'ap-error-summary__list';
    this.summary.append(this.summaryHeading, this.summaryList);
    this.form.prepend(this.summary);
  }

  private buildLiveRegion(): void {
    this.liveRegion = document.createElement('div');
    this.liveRegion.className = 'ap-visually-hidden';
    this.liveRegion.setAttribute('aria-live', 'polite');
    this.liveRegion.setAttribute('aria-atomic', 'true');
    this.append(this.liveRegion);
  }
}
