/**
 * Caret-safe formatting.
 *
 * The classic bug with auto-formatted inputs: when you insert a space the
 * browser's cursor ends up in the wrong place, so typing in the middle of a
 * number makes the cursor jump to the end. The fix is to remember how many
 * DIGITS were before the cursor, reformat, and then put the cursor back after
 * that same number of digits.
 */

export interface FormatResult {
  value: string;
  caret: number;
}

export const onlyDigits = (s: string): string => s.replace(/\D/g, '');

/** Insert a space after each gap position: ("4111111111111111", [4,8,12]) -> "4111 1111 1111 1111". */
export function groupDigits(digits: string, gaps: number[]): string {
  let out = '';
  for (let i = 0; i < digits.length; i++) {
    if (i > 0 && gaps.includes(i)) out += ' ';
    out += digits[i];
  }
  return out;
}

/** Number of digits in `text` before index `caret`. */
export function digitsBefore(text: string, caret: number): number {
  return onlyDigits(text.slice(0, caret)).length;
}

/** Index in `formatted` that sits right after the `n`th digit. */
export function caretAfterDigits(formatted: string, n: number): number {
  if (n <= 0) return 0;
  let seen = 0;
  for (let i = 0; i < formatted.length; i++) {
    if (/\d/.test(formatted[i])) {
      seen++;
      if (seen === n) return i + 1;
    }
  }
  return formatted.length;
}

/**
 * Reformat a raw input value as a grouped card number and work out where the
 * caret should go.
 */
export function formatCardNumber(
  raw: string,
  caret: number,
  gaps: number[],
  maxLength: number,
): FormatResult {
  const digits = onlyDigits(raw).slice(0, maxLength);
  const keep = Math.min(digitsBefore(raw, caret), digits.length);
  const value = groupDigits(digits, gaps);
  return { value, caret: caretAfterDigits(value, keep) };
}

/**
 * Format an expiry date as "MM/YY".
 * A single digit 2-9 is treated as a month and padded ("4" -> "04/").
 */
export function formatExpiry(raw: string, caret: number): FormatResult {
  let digits = onlyDigits(raw);
  let keep = digitsBefore(raw, caret);
  if (digits.length === 1 && Number(digits) > 1) {
    digits = '0' + digits;
    keep += 1;
  }
  digits = digits.slice(0, 4);
  keep = Math.min(keep, digits.length);

  // The slash appears once the year starts. Adding it earlier (right after
  // the month) makes Backspace feel broken: deleting the slash re-adds it.
  const value = digits.length > 2 ? `${digits.slice(0, 2)}/${digits.slice(2)}` : digits;
  return { value, caret: caretAfterDigits(value, keep) };
}
