// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import '../../src/index.ts';

function setup() {
  document.title = 'Checkout';
  document.body.innerHTML = `
    <ap-checkout-form>
      <form>
        <ap-text-field name="cardholder" label="Name on card"></ap-text-field>
        <ap-card-number name="cardNumber"></ap-card-number>
        <ap-expiry name="expiry"></ap-expiry>
        <ap-cvv name="cvv"></ap-cvv>
        <button type="submit">Pay</button>
      </form>
    </ap-checkout-form>`;
  const q = <T extends Element>(s: string) => document.querySelector<T>(s)!;
  return {
    form: q<HTMLFormElement>('form'),
    name: q<HTMLInputElement>('ap-text-field input'),
    card: q<HTMLInputElement>('ap-card-number input'),
    expiry: q<HTMLInputElement>('ap-expiry input'),
    cvv: q<HTMLInputElement>('ap-cvv input'),
    summary: q<HTMLDivElement>('.ap-error-summary'),
  };
}

function type(input: HTMLInputElement, value: string) {
  input.focus();
  input.value = value;
  input.setSelectionRange(value.length, value.length);
  input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText' }));
}

describe('field markup', () => {
  beforeEach(setup);

  it('every input has a label, a description link and required', () => {
    for (const input of document.querySelectorAll('input')) {
      expect(document.querySelector(`label[for="${input.id}"]`)).not.toBeNull();
      const [hint, error] = input.getAttribute('aria-describedby')!.split(' ');
      expect(document.getElementById(hint)).not.toBeNull();
      expect(document.getElementById(error)).not.toBeNull();
      expect(input.required).toBe(true);
    }
  });

  it('card number uses the right autofill and keyboard hints', () => {
    const card = document.querySelector<HTMLInputElement>('ap-card-number input')!;
    expect(card.type).toBe('text');
    expect(card.inputMode).toBe('numeric');
    expect(card.getAttribute('autocomplete')).toBe('cc-number');
  });
});

describe('card number field', () => {
  it('formats as you type', () => {
    const { card } = setup();
    type(card, '4111111111111111');
    expect(card.value).toBe('4111 1111 1111 1111');
  });

  it('uses Amex grouping', () => {
    const { card } = setup();
    type(card, '378282246310005');
    expect(card.value).toBe('3782 822463 10005');
  });

  it('switches the CVV to 4 digits for Amex', () => {
    const { card, cvv } = setup();
    type(card, '3782');
    expect(cvv.maxLength).toBe(4);
    expect(document.getElementById(cvv.getAttribute('aria-describedby')!.split(' ')[0])!.textContent).toMatch(/front/);
  });
});

describe('validation timing', () => {
  it('does not show an error while typing, only on blur', () => {
    const { card } = setup();
    type(card, '4111');
    expect(card.hasAttribute('aria-invalid')).toBe(false);
    card.dispatchEvent(new FocusEvent('blur'));
    expect(card.getAttribute('aria-invalid')).toBe('true');
  });

  it('clears the error as soon as the value is fixed', () => {
    const { card } = setup();
    type(card, '4111');
    card.dispatchEvent(new FocusEvent('blur'));
    type(card, '4111111111111111');
    expect(card.hasAttribute('aria-invalid')).toBe(false);
  });
});

describe('submitting', () => {
  it('shows a focused error summary linking to each invalid field', () => {
    const { form, summary, card } = setup();
    form.requestSubmit();
    expect(summary.hidden).toBe(false);
    expect(document.activeElement).toBe(summary);
    const links = summary.querySelectorAll('a');
    expect(links).toHaveLength(4);
    expect(links[1].getAttribute('href')).toBe(`#${card.id}`);
    expect(document.title).toBe('Error: Checkout');
  });

  it('emits ap-submit with masked data only when valid', () => {
    const { form, name, card, expiry, cvv, summary } = setup();
    type(name, 'Prince Verma');
    type(card, '4111111111111111');
    type(expiry, '0835');
    type(cvv, '123');

    let detail: any = null;
    document.querySelector('ap-checkout-form')!.addEventListener('ap-submit', (e) => {
      detail = (e as CustomEvent).detail;
    });
    form.requestSubmit();

    expect(summary.hidden).toBe(true);
    expect(detail).toMatchObject({ network: 'visa', last4: '1111', expiry: '08/35' });
    expect(JSON.stringify(detail)).not.toContain('4111111111111111');
    expect(JSON.stringify(detail)).not.toContain('123"');
  });
});
