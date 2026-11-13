/**
 * Keeps the "Card → Bank OTP → Done" pills in sync with the payment.
 * <ap-checkout-form> fires `ap-step` (bubbling) when the OTP step starts or ends;
 * pages call setStep('done') on success. aria-current="step" marks the current one
 * for screen readers; finished steps get a ✓ and a "completed" label.
 */
const ORDER = ['card', 'otp', 'done'];

export function setStep(step: string): void {
  const list = document.getElementById('steps');
  if (!list) return;
  const current = ORDER.indexOf(step);
  list.querySelectorAll<HTMLLIElement>('li[data-step]').forEach((li, i) => {
    const num = li.querySelector('.num');
    li.classList.toggle('done', i < current);
    if (i === current) li.setAttribute('aria-current', 'step');
    else li.removeAttribute('aria-current');
    if (num) num.textContent = i < current ? '✓' : String(i + 1);
    let hidden = li.querySelector<HTMLSpanElement>('.ap-visually-hidden');
    if (i < current) {
      if (!hidden) {
        hidden = document.createElement('span');
        hidden.className = 'ap-visually-hidden';
        li.append(hidden);
      }
      hidden.textContent = ', completed';
    } else hidden?.remove();
  });
}

document.addEventListener('ap-step', (e) => setStep((e as CustomEvent<{ step: string }>).detail.step));
