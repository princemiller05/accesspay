import { ApField } from './base-field.ts';
import { formatExpiry } from '../core/format.ts';
import { validateExpiry } from '../core/validation.ts';

/** <ap-expiry name="expiry" label="Expiry date" hint="MM/YY, for example 08/29"></ap-expiry> */
export class ApExpiry extends ApField {
  protected defaultLabel = 'Expiry date';

  connectedCallback(): void {
    if (!this.hasAttribute('hint')) this.setAttribute('hint', 'MM/YY, for example 08/29');
    super.connectedCallback();
  }

  protected configureInput(input: HTMLInputElement): void {
    input.type = 'text';
    input.inputMode = 'numeric';
    input.autocomplete = 'cc-exp';
    input.spellcheck = false;
    input.classList.add('ap-input--short');
  }

  protected getError(): string | null {
    return validateExpiry(this.value);
  }

  protected onInput(e: Event): void {
    // Don't fight deletions: only reformat when text was added.
    if ((e as InputEvent).inputType?.startsWith('delete')) return;
    const { value, caret } = formatExpiry(this.input.value, this.input.selectionStart ?? 0);
    this.input.value = value;
    if (document.activeElement === this.input) this.input.setSelectionRange(caret, caret);
  }
}
