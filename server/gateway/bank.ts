/**
 * Mock issuing bank. A real gateway would forward the authorisation request
 * through the card network (e.g. VisaNet) to the bank that issued the card.
 * Here, special test card numbers trigger each outcome.
 *
 * In India, the RBI requires an Additional Factor of Authentication (usually
 * an OTP) for domestic card payments, so OTP is the default for unknown cards.
 */
export type BankDecision =
  | { result: 'approved' }
  | { result: 'otp_required' }
  | { result: 'declined'; declineCode: DeclineCode };

export type DeclineCode = 'generic_decline' | 'insufficient_funds' | 'incorrect_cvc' | 'lost_card';

export const TEST_CARDS: Record<string, { decision: BankDecision; note: string }> = {
  '4242424242424242': { decision: { result: 'approved' }, note: 'Visa: approved without OTP' },
  '378282246310005': { decision: { result: 'approved' }, note: 'American Express: approved without OTP' },
  '4111111111111111': { decision: { result: 'otp_required' }, note: 'Visa: asks for OTP, then approved' },
  '5555555555554444': { decision: { result: 'otp_required' }, note: 'Mastercard: asks for OTP, then approved' },
  '6080320000000002': { decision: { result: 'otp_required' }, note: 'RuPay: asks for OTP, then approved' },
  '4000000000000002': { decision: { result: 'declined', declineCode: 'generic_decline' }, note: 'Declined' },
  '4000000000009995': { decision: { result: 'declined', declineCode: 'insufficient_funds' }, note: 'Declined: insufficient funds' },
  '4000000000000127': { decision: { result: 'declined', declineCode: 'incorrect_cvc' }, note: 'Declined: wrong security code' },
  '4000000000009987': { decision: { result: 'declined', declineCode: 'lost_card' }, note: 'Declined: card reported lost' },
};

export function authorize(cardNumber: string): BankDecision {
  return TEST_CARDS[cardNumber]?.decision ?? { result: 'otp_required' };
}

/** Customer-facing messages: say what happened and what to do, without leaking fraud signals. */
export const DECLINE_MESSAGES: Record<DeclineCode, string> = {
  generic_decline: 'Your card was declined. Try a different card or contact your bank.',
  insufficient_funds: 'Your card has insufficient funds. Try a different card.',
  incorrect_cvc: "The security code doesn't match. Check it and try again.",
  // Don't tell a possible fraudster that the card was reported lost.
  lost_card: 'Your card was declined. Try a different card or contact your bank.',
};
