import { ApField } from './base-field.ts';

/**
 * Generic required text field, e.g.
 * <ap-text-field name="name" label="Name on card" autocomplete="cc-name"></ap-text-field>
 *
 * Attributes: label, hint, autocomplete, type, error-message, optional.
 */
export class ApTextField extends ApField {
  protected defaultLabel = 'Text';

  protected configureInput(input: HTMLInputElement): void {
    input.type = this.getAttribute('type') ?? 'text';
    const ac = this.getAttribute('autocomplete');
    if (ac) input.setAttribute('autocomplete', ac);
  }

  protected getError(): string | null {
    if (this.hasAttribute('optional')) return null;
    if (this.value.trim()) return null;
    return this.getAttribute('error-message') ?? `Enter ${this.label.toLowerCase()}`;
  }
}
