import { describe, it, expect } from 'vitest';
import { isValidLuhn } from '../../src/core/luhn.ts';
import { detectNetwork } from '../../src/core/networks.ts';
import { formatCardNumber, formatExpiry, groupDigits, caretAfterDigits } from '../../src/core/format.ts';
import { validateCardNumber, validateExpiry, validateCvv } from '../../src/core/validation.ts';

describe('isValidLuhn', () => {
  it.each(['4111111111111111', '5555555555554444', '378282246310005', '6080320000000002'])(
    'accepts valid number %s',
    (n) => expect(isValidLuhn(n)).toBe(true),
  );
  it.each(['4111111111111112', '1234567812345678', '', '7', '4111-1111'])('rejects %s', (n) =>
    expect(isValidLuhn(n)).toBe(false),
  );
});

describe('detectNetwork', () => {
  it.each([
    ['4', 'visa'],
    ['4111', 'visa'],
    ['51', 'mastercard'],
    ['55', 'mastercard'],
    ['2221', 'mastercard'],
    ['2720', 'mastercard'],
    ['34', 'amex'],
    ['37', 'amex'],
    ['60', 'rupay'],
    ['508', 'rupay'],
    ['81', 'rupay'],
  ])('%s -> %s', (digits, id) => expect(detectNetwork(digits)?.id).toBe(id));

  it.each([
    ['', 'empty'],
    ['5', 'not enough digits yet'],
    ['50', 'outside 51-55'],
    ['56', 'outside 51-55'],
    ['2220', 'just below the 2-series range'],
    ['2721', 'just above the 2-series range'],
    ['35', 'unsupported (JCB)'],
  ])('%s -> null (%s)', (digits) => expect(detectNetwork(digits)).toBeNull());
});

describe('groupDigits', () => {
  it('groups 4-4-4-4', () => expect(groupDigits('4111111111111111', [4, 8, 12])).toBe('4111 1111 1111 1111'));
  it('groups Amex 4-6-5', () => expect(groupDigits('378282246310005', [4, 10])).toBe('3782 822463 10005'));
  it('does not add a trailing space', () => expect(groupDigits('4111', [4, 8, 12])).toBe('4111'));
});

describe('caretAfterDigits', () => {
  it('skips over spaces', () => expect(caretAfterDigits('4111 1111', 5)).toBe(6));
  it('handles 0', () => expect(caretAfterDigits('4111 1111', 0)).toBe(0));
});

describe('formatCardNumber (caret handling)', () => {
  const gaps = [4, 8, 12];

  it('adds a space and keeps the caret at the end while typing', () => {
    expect(formatCardNumber('41111', 5, gaps, 19)).toEqual({ value: '4111 1', caret: 6 });
  });

  it('keeps the caret in place when typing in the middle', () => {
    // "4111 1111" with caret after the 2nd digit, user types "9" -> "41911 1111"
    const r = formatCardNumber('41911 1111', 3, gaps, 19);
    expect(r.value).toBe('4191 1111 1');
    expect(r.caret).toBe(3); // right after the "9", not at the end
  });

  it('handles pasted numbers with dashes and spaces', () => {
    const r = formatCardNumber('4111-1111 1111-1111', 19, gaps, 19);
    expect(r.value).toBe('4111 1111 1111 1111');
    expect(r.caret).toBe(19);
  });

  it('truncates to the maximum length', () => {
    expect(formatCardNumber('41111111111111119999', 20, gaps, 16).value).toBe('4111 1111 1111 1111');
  });
});

describe('formatExpiry', () => {
  it('pads a single month digit above 1', () => expect(formatExpiry('4', 1)).toEqual({ value: '04', caret: 2 }));
  it('leaves "1" alone (could be 10-12)', () => expect(formatExpiry('1', 1).value).toBe('1'));
  it('adds the slash once the year starts', () => expect(formatExpiry('082', 3)).toEqual({ value: '08/2', caret: 4 }));
  it('accepts typed slashes and spaces', () => expect(formatExpiry('08 / 29', 7).value).toBe('08/29'));
  it('limits to 4 digits', () => expect(formatExpiry('082999', 6).value).toBe('08/29'));
});

describe('validateCardNumber', () => {
  it('passes a valid Visa', () => expect(validateCardNumber('4111 1111 1111 1111')).toBeNull());
  it('asks for a number when empty', () => expect(validateCardNumber('')).toBe('Enter your card number'));
  it('rejects unsupported networks', () => expect(validateCardNumber('3600 0000 0000 08')).toMatch(/Visa, Mastercard/));
  it('explains wrong length', () =>
    expect(validateCardNumber('4111 1111 1111')).toBe('Visa card numbers are 13 or 16 or 19 digits long. You entered 12'));
  it('catches typos with Luhn', () => expect(validateCardNumber('4111 1111 1111 1112')).toMatch(/typos/));
});

describe('validateExpiry', () => {
  const now = new Date(2026, 10, 13); // 13 Nov 2026

  it('accepts the current month', () => expect(validateExpiry('11/26', now)).toBeNull());
  it('accepts a future date', () => expect(validateExpiry('08/29', now)).toBeNull());
  it('rejects last month', () => expect(validateExpiry('10/26', now)).toMatch(/expired/));
  it('rejects month 13', () => expect(validateExpiry('13/27', now)).toMatch(/between 01 and 12/));
  it('rejects month 00', () => expect(validateExpiry('00/27', now)).toMatch(/between 01 and 12/));
  it('rejects bad format', () => expect(validateExpiry('8/2', now)).toMatch(/for example/));
  it('rejects > 20 years ahead', () => expect(validateExpiry('12/99', now)).toMatch(/too far/));
});

describe('validateCvv', () => {
  const amex = detectNetwork('34');
  const visa = detectNetwork('4');
  it('needs 3 digits for Visa', () => expect(validateCvv('123', visa)).toBeNull());
  it('needs 4 digits for Amex', () => expect(validateCvv('123', amex)).toMatch(/4 digits.*front/));
  it('defaults to 3 when unknown', () => expect(validateCvv('12', null)).toMatch(/3 digits.*back/));
  it('asks when empty', () => expect(validateCvv('', visa)).toBe('Enter the security code'));
});
