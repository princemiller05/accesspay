import { ApField } from './base-field.ts';
import { onlyDigits } from '../core/format.ts';
import { validateCvv } from '../core/validation.ts';
import type { CardNetwork } from '../core/networks.ts';
import type { NetworkChangeDetail } from './card-number.ts';

/**
 * <ap-cvv name="cvv" label="Security code"></ap-cvv>
 *
 * Listens for `ap-network-change` from the card number field in the same form
 * and adapts: 4 digits on the front for Amex, 3 on the back for others.
 */
export class ApCvv extends ApField {
  protected defaultLabel = 'Security code';
  private network: CardNetwork | null = null;
  private root: Element | null = null;

  private onNetworkChange = (e: Event) => {
    this.network = (e as CustomEvent<NetworkChangeDetail>).detail.network;
    this.input.maxLength = this.network?.cvvLength ?? 4;
    this.setHint(this.hintText());
    if (this.hasError) this.validate();
  };

  connectedCallback(): void {
    super.connectedCallback();
    this.root = this.closest('form') ?? document.body;
    this.root.addEventListener('ap-network-change', this.onNetworkChange);
    this.setHint(this.hintText());
  }

  disconnectedCallback(): void {
    this.root?.removeEventListener('ap-network-change', this.onNetworkChange);
  }

  private hintText(): string {
    return this.network?.id === 'amex'
      ? '4 digits on the front of your card'
      : 'Last 3 digits on the back of your card';
  }

  protected configureInput(input: HTMLInputElement): void {
    input.type = 'text';
    input.inputMode = 'numeric';
    input.autocomplete = 'cc-csc';
    input.maxLength = 4;
    input.spellcheck = false;
    input.classList.add('ap-input--short');
  }

  protected getError(): string | null {
    return validateCvv(this.value, this.network);
  }

  protected onInput(): void {
    const digits = onlyDigits(this.input.value);
    if (digits !== this.input.value) this.input.value = digits;
  }
}
