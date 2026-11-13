/**
 * Luhn (mod 10) checksum, used by every major card network to catch typos.
 *
 * Walk the digits from right to left, double every second digit, subtract 9
 * from any doubled value above 9, and add everything up. The number is valid
 * when the total is a multiple of 10.
 */
export function isValidLuhn(digits: string): boolean {
  if (!/^\d+$/.test(digits) || digits.length < 2) return false;

  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48; // '0' is char code 48
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}
