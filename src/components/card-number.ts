import { ApField } from './base-field.ts';
import { detectNetwork, maxLengthFor, DEFAULT_GAPS, type CardNetwork } from '../core/networks.ts';
import { formatCardNumber, onlyDigits } from '../core/format.ts';
import { validateCardNumber } from '../core/validation.ts';

export interface NetworkChangeDetail {
  network: CardNetwork | null;
}

/**
 * <ap-card-number name="cardNumber" label="Card number"></ap-card-number>
 *
 * Fires `ap-network-change` (bubbles) when the detected card network changes.
 */
export class ApCardNumber extends ApField {
  protected defaultLabel = 'Card number';
  private network: CardNetwork | null = null;
  private badge!: HTMLSpanElement;

  get detectedNetwork(): CardNetwork | null {
    return this.network;
  }

  /** Digits only, no spaces. */
  get digits(): string {
    return onlyDigits(this.value);
  }

  protected configureInput(input: HTMLInputElement): void {
    input.type = 'text'; // not type="number": that adds spinners and drops leading zeros
    input.inputMode = 'numeric';
    input.autocomplete = 'cc-number';
    input.spellcheck = false;
    input.setAttribute('autocorrect', 'off');

    // Backspace right after a space: delete the digit before it. Otherwise the
    // browser deletes the space, we re-insert it, and Backspace appears dead.
    input.addEventListener('beforeinput', (e) => {
      if (e.inputType !== 'deleteContentBackward') return;
      const { selectionStart: s, selectionEnd: end, value } = input;
      if (s === null || s !== end || s === 0 || value[s - 1] !== ' ') return;
      e.preventDefault();
      const raw = value.slice(0, s - 2) + value.slice(s);
      this.applyFormat(raw, s - 2);
    });
  }

  protected afterRender(): void {
    // Visual badge only; screen readers get the network via a live announcement.
    this.badge = document.createElement('span');
    this.badge.className = 'ap-network-badge';
    this.badge.setAttribute('aria-hidden', 'true');
    this.badge.hidden = true;
    this.wrap.append(this.badge);
  }

  protected getError(): string | null {
    return validateCardNumber(this.value);
  }

  protected onInput(): void {
    this.applyFormat(this.input.value, this.input.selectionStart ?? this.input.value.length);
  }

  private applyFormat(raw: string, caret: number): void {
    const network = detectNetwork(onlyDigits(raw));
    const { value, caret: newCaret } = formatCardNumber(
      raw,
      caret,
      network?.gaps ?? DEFAULT_GAPS,
      maxLengthFor(network),
    );
    this.input.value = value;
    // Only move the caret if this input is focused (setSelectionRange can steal focus in Safari).
    if (document.activeElement === this.input) this.input.setSelectionRange(newCaret, newCaret);
    this.setNetwork(network);
  }

  private setNetwork(network: CardNetwork | null): void {
    if (network?.id === this.network?.id) return;
    this.network = network;
    this.badge.textContent = network?.name ?? '';
    this.badge.hidden = !network;
    this.badge.dataset.network = network?.id ?? '';
    this.dispatchEvent(
      new CustomEvent<NetworkChangeDetail>('ap-network-change', {
        detail: { network },
        bubbles: true,
      }),
    );
  }
}
