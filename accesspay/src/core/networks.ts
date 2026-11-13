/**
 * Card network detection from the IIN (Issuer Identification Number), i.e.
 * the leading digits of a card number.
 *
 * Each network is described by prefix ranges. A range like [2221, 2720]
 * means "the first 4 digits are between 2221 and 2720".
 *
 * Note: real IIN tables are larger and change over time. This list covers
 * the common ranges for the networks this demo supports.
 */

export type NetworkId = 'visa' | 'mastercard' | 'amex' | 'rupay';

export interface CardNetwork {
  id: NetworkId;
  /** Human-readable name, used in screen-reader announcements. */
  name: string;
  /** Prefix ranges as [low, high] (inclusive); both ends have the same digit count. */
  ranges: Array<[number, number]>;
  /** Valid total lengths of the card number. */
  lengths: number[];
  /** Digit positions after which a space is shown, e.g. [4, 8, 12] -> "4111 1111 1111 1111". */
  gaps: number[];
  /** Security code length. */
  cvvLength: number;
}

export const NETWORKS: CardNetwork[] = [
  {
    id: 'amex',
    name: 'American Express',
    ranges: [[34, 34], [37, 37]],
    lengths: [15],
    gaps: [4, 10],
    cvvLength: 4,
  },
  {
    id: 'rupay',
    name: 'RuPay',
    // 60 and 65 overlap with Discover's ranges; Discover isn't supported here,
    // so they are treated as RuPay. More specific ranges are listed first.
    ranges: [[508, 508], [353, 353], [356, 356], [60, 60], [65, 65], [81, 82]],
    lengths: [16],
    gaps: [4, 8, 12],
    cvvLength: 3,
  },
  {
    id: 'mastercard',
    name: 'Mastercard',
    ranges: [[51, 55], [2221, 2720]],
    lengths: [16],
    gaps: [4, 8, 12],
    cvvLength: 3,
  },
  {
    id: 'visa',
    name: 'Visa',
    ranges: [[4, 4]],
    lengths: [13, 16, 19],
    gaps: [4, 8, 12],
    cvvLength: 3,
  },
];

/** Format used while the network is still unknown. */
export const DEFAULT_GAPS = [4, 8, 12];
export const MAX_CARD_LENGTH = 19;

function matchesRange(digits: string, [low, high]: [number, number]): boolean {
  const prefixLength = String(low).length;
  if (digits.length < prefixLength) return false; // not enough digits to decide yet
  const prefix = Number(digits.slice(0, prefixLength));
  return prefix >= low && prefix <= high;
}

/**
 * Returns the network for the given digits, or null if it can't be
 * determined (yet). Only call this with digits, no spaces.
 */
export function detectNetwork(digits: string): CardNetwork | null {
  if (!digits) return null;
  // The longest (most specific) matching prefix wins.
  let best: { network: CardNetwork; prefixLength: number } | null = null;
  for (const network of NETWORKS) {
    for (const range of network.ranges) {
      if (!matchesRange(digits, range)) continue;
      const prefixLength = String(range[0]).length;
      if (!best || prefixLength > best.prefixLength) best = { network, prefixLength };
    }
  }
  return best?.network ?? null;
}

export function maxLengthFor(network: CardNetwork | null): number {
  return network ? Math.max(...network.lengths) : MAX_CARD_LENGTH;
}
