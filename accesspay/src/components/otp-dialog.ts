/**
 * <ap-otp-dialog>: the "enter the code your bank sent you" step (3-D Secure / RBI AFA).
 *
 * Accessibility choices:
 *  - Native <dialog> with showModal(): the browser traps focus, makes the page
 *    behind inert, and Esc closes it. No hand-rolled focus trap to get wrong.
 *  - ONE input with autocomplete="one-time-code", not six separate boxes. Six
 *    boxes break paste, SMS autofill, and screen readers announce six fields.
 *  - Resend countdown is shown visually but not announced every second (that
 *    would be noise); we announce once when resending becomes possible.
 *  - Focus returns to where it was when the dialog closes.
 *
 * Usage:
 *   const result = await dialog.open({
 *     testCode, onVerify: async (otp) => ({ ok: true } | { ok: false, message, fatal? }),
 *     onResend: async () => ({ ok: true, testCode } | { ok: false, message }),
 *   });  // -> 'verified' | 'canceled' | 'failed'
 */

export type VerifyResult = { ok: true } | { ok: false; message: string; fatal?: boolean };
export type ResendResult = { ok: true; testCode?: string } | { ok: false; message: string };
export type OtpOutcome = 'verified' | 'canceled' | 'failed';

export interface OtpDialogOptions {
  testCode?: string;
  onVerify: (otp: string) => Promise<VerifyResult>;
  onResend: () => Promise<ResendResult>;
  resendAfterSeconds?: number;
}

let uid = 0;

export class ApOtpDialog extends HTMLElement {
  private dialog!: HTMLDialogElement;
  private input!: HTMLInputElement;
  private error!: HTMLParagraphElement;
  private errorText!: HTMLSpanElement;
  private testHint!: HTMLParagraphElement;
  private verifyBtn!: HTMLButtonElement;
  private resendBtn!: HTMLButtonElement;
  private resendWait!: HTMLParagraphElement;
  private live!: HTMLParagraphElement;
  private timer?: number;
  private opts?: OtpDialogOptions;
  private resolve?: (o: OtpOutcome) => void;
  private returnFocus: HTMLElement | null = null;

  connectedCallback(): void {
    if (this.dialog) return;
    const id = `ap-otp-${++uid}`;
    this.innerHTML = `
      <dialog class="ap-otp" aria-labelledby="${id}-title" aria-describedby="${id}-desc">
        <h2 class="ap-otp__title" id="${id}-title">Confirm it's you</h2>
        <p id="${id}-desc">Your bank sent a 6-digit code to your registered mobile number.</p>
        <p class="ap-otp__test" hidden></p>
        <form class="ap-otp__form" novalidate>
          <div class="ap-field">
            <label class="ap-label" for="${id}-input">One-time code</label>
            <p class="ap-error" id="${id}-error" hidden>
              <span class="ap-error-icon" aria-hidden="true">!</span><span class="ap-visually-hidden">Error: </span><span class="ap-otp__error-text"></span>
            </p>
            <div class="ap-input-wrap">
              <input class="ap-input ap-input--short ap-otp__input" id="${id}-input" type="text"
                inputmode="numeric" autocomplete="one-time-code" maxlength="6" spellcheck="false"
                aria-describedby="${id}-error" required>
            </div>
          </div>
          <div class="ap-otp__actions">
            <button type="submit" class="ap-pay-button ap-otp__verify">Verify and pay</button>
            <button type="button" class="ap-secondary-button ap-otp__cancel">Cancel payment</button>
          </div>
        </form>
        <div class="ap-otp__resend">
          <p class="ap-otp__wait" aria-hidden="true"></p>
          <button type="button" class="ap-link-button ap-otp__resend-btn" hidden>Send a new code</button>
        </div>
        <p class="ap-visually-hidden" aria-live="polite"></p>
      </dialog>`;
    const q = <T extends Element>(s: string) => this.querySelector<T>(s)!;
    this.dialog = q('dialog');
    this.input = q('.ap-otp__input');
    this.error = q('.ap-error');
    this.errorText = q('.ap-otp__error-text');
    this.testHint = q('.ap-otp__test');
    this.verifyBtn = q('.ap-otp__verify');
    this.resendBtn = q('.ap-otp__resend-btn');
    this.resendWait = q('.ap-otp__wait');
    this.live = q('[aria-live]');

    q<HTMLFormElement>('form').addEventListener('submit', (e) => {
      e.preventDefault();
      void this.verify();
    });
    q<HTMLButtonElement>('.ap-otp__cancel').addEventListener('click', () => this.finish('canceled'));
    this.resendBtn.addEventListener('click', () => void this.resend());
    // Esc fires "cancel": treat it like the Cancel button.
    this.dialog.addEventListener('cancel', (e) => {
      e.preventDefault();
      this.finish('canceled');
    });
    this.input.addEventListener('input', () => {
      const digits = this.input.value.replace(/\D/g, '').slice(0, 6);
      if (digits !== this.input.value) this.input.value = digits;
      if (!this.error.hidden) this.setError(null);
    });
  }

  open(opts: OtpDialogOptions): Promise<OtpOutcome> {
    this.opts = opts;
    this.returnFocus = document.activeElement as HTMLElement | null;
    this.input.value = '';
    this.setError(null);
    this.setTestCode(opts.testCode);
    this.dialog.showModal();
    this.input.focus();
    this.startResendTimer(opts.resendAfterSeconds ?? 30);
    return new Promise((resolve) => (this.resolve = resolve));
  }

  private async verify() {
    const otp = this.input.value;
    if (!/^\d{6}$/.test(otp)) {
      this.setError('Enter the 6-digit code from your bank');
      this.input.focus();
      return;
    }
    this.setBusy(true);
    const result = await this.opts!.onVerify(otp);
    this.setBusy(false);
    if (result.ok) return this.finish('verified');
    if (result.fatal) return this.finish('failed');
    this.setError(result.message);
    this.input.focus();
    this.input.select();
  }

  private async resend() {
    const result = await this.opts!.onResend();
    if (!result.ok) {
      this.setError(result.message);
      return;
    }
    this.setError(null);
    this.input.value = '';
    this.setTestCode(result.testCode);
    this.announce('A new code has been sent.');
    this.input.focus();
    this.startResendTimer(this.opts!.resendAfterSeconds ?? 30);
  }

  private finish(outcome: OtpOutcome) {
    window.clearInterval(this.timer);
    if (this.dialog.open) this.dialog.close();
    this.returnFocus?.focus?.();
    this.resolve?.(outcome);
    this.resolve = undefined;
  }

  private startResendTimer(seconds: number) {
    window.clearInterval(this.timer);
    this.resendBtn.hidden = true;
    let left = seconds;
    const render = () => {
      this.resendWait.textContent = `Didn't get it? You can request a new code in ${left} s.`;
    };
    render();
    this.resendWait.hidden = false;
    this.timer = window.setInterval(() => {
      left -= 1;
      if (left > 0) return render();
      window.clearInterval(this.timer);
      this.resendWait.hidden = true;
      this.resendBtn.hidden = false;
      this.announce('You can now request a new code.');
    }, 1000);
  }

  private setTestCode(code?: string) {
    this.testHint.hidden = !code;
    this.testHint.textContent = code ? `Test mode: your code is ${code}` : '';
  }

  private setError(message: string | null) {
    this.error.hidden = !message;
    this.errorText.textContent = message ?? '';
    if (message) this.input.setAttribute('aria-invalid', 'true');
    else this.input.removeAttribute('aria-invalid');
  }

  private setBusy(busy: boolean) {
    this.verifyBtn.disabled = busy;
    this.verifyBtn.textContent = busy ? 'Verifying…' : 'Verify and pay';
    if (busy) this.announce('Verifying code…');
  }

  private announce(msg: string) {
    this.live.textContent = '';
    window.setTimeout(() => (this.live.textContent = msg), 100);
  }
}
