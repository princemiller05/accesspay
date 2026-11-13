/**
 * Decorative: a soft light follows the pointer across the dark summary panel.
 * Off when the visitor asks for reduced motion, and off for touch (no hover).
 * Uses requestAnimationFrame so it never updates more than once per frame.
 */
export function attachGlow(panel: HTMLElement | null): void {
  if (!panel) return;
  const reduce = matchMedia('(prefers-reduced-motion: reduce)');
  const canHover = matchMedia('(hover: hover)');
  let frame = 0;
  panel.addEventListener('pointermove', (e) => {
    if (reduce.matches || !canHover.matches || frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      const r = panel.getBoundingClientRect();
      panel.style.setProperty('--mx', `${e.clientX - r.left}px`);
      panel.style.setProperty('--my', `${e.clientY - r.top}px`);
      panel.classList.add('glow');
    });
  });
  panel.addEventListener('pointerleave', () => panel.classList.remove('glow'));
}
