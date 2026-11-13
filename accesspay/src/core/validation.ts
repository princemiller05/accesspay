import { isValidLuhn } from './luhn.ts';
import { detectNetwork, type CardNetwork } from './networks.ts';
import { onlyDigits } from './format.ts';

/**
 * Validators return an error message, or null when the value is valid.
 * Messages say what's wrong AND how to fix it (WCAG 3.3.3 Error Suggestion).
 */

export function validateCardNumber(value: string): string | null {
  const digits = onlyDigits(value);
  if (!digits) return 'Enter your card number';
  const network = detectNetwork(digits);
  if (!network) return 'Enter a Visa, Mastercard, RuPay or American Express card number';
  if (!network.lengths.includes(digits.length)) {
    const lengths = network.lengths.join(' or ');
    return `${network.name} card numbers are ${lengths} digits long. You entered ${digits.length}`;
  }
  if (!isValidLuhn(digits)) return 'Card number is not valid. Check it for typos';
  return null;
}

export interface Expiry {
  month: number;
  year: number; // four digits
}

export function parseExpiry(value: string): Expiry | null {
  const m = /^(\d{2})\s*\/\s*(\d{2})$/.exec(value.trim());
  if (!m) return null;
  return { month: Number(m[1]), year: 2000 + Number(m[2]) };
}

/** `now` is a parameter so tests don't depend on today's date. */
export function validateExpiry(value: string, now: Date = new Date()): string | null {
  if (!value.trim()) return 'Enter the expiry date';
  const exp = parseExpiry(value);
  if (!exp) return 'Enter the expiry date as month and year, for example 08/29';
  if (exp.month < 1 || exp.month > 12) return 'Expiry month must be between 01 and 12';

  // A card is valid until the last day of its expiry month.
  const thisMonth = now.getFullYear() * 12 + now.getMonth(); // getMonth() is 0-based
  const expMonth = exp.year * 12 + (exp.month - 1);
  if (expMonth < thisMonth) return 'This card has expired. Check the date or use a different card';
  if (expMonth > thisMonth + 20 * 12) return 'Expiry date is too far in the future. Check the year';
  return null;
}

export function validateCvv(value: string, network: CardNetwork | null): string | null {
  const digits = onlyDigits(value);
  const expected = network?.cvvLength ?? 3;
  if (!digits) return 'Enter the security code';
  if (digits.length !== expected) {
    const where = network?.id === 'amex' ? 'on the front of your card' : 'on the back of your card';
    return `Security code must be ${expected} digits. It's ${where}`;
  }
  return null;
}
