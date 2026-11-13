import { test, expect, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

/**
 * Fails the test on ANY WCAG 2.x A/AA violation found by axe-core.
 *
 * Skipped in Firefox only: on GitHub's runners, injecting axe-core made Firefox
 * crash ("Page crashed") in pages that pass every scan in Chromium, WebKit and
 * mobile. axe checks the DOM, which is identical across engines, so the scan
 * still runs three times; Firefox keeps running all the functional checks.
 */
async function expectNoA11yViolations(page: Page) {
  if (test.info().project.name === 'firefox') {
    test.info().annotations.push({ type: 'note', description: 'axe scan skipped in Firefox (see expectNoA11yViolations)' });
    return;
  }
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
    .analyze();
  const summary = results.violations.map((v) => `${v.id}: ${v.help} (${v.nodes.length} nodes)`);
  expect(summary, 'axe-core violations').toEqual([]);
}

test.beforeEach(async ({ page }) => {
  await page.goto('/');
});

test('page has no accessibility violations on load', async ({ page }) => {
  await expectNoA11yViolations(page);
});

test('error state has no accessibility violations', async ({ page }) => {
  await page.getByRole('button', { name: /pay/i }).click();
  await expect(page.getByRole('group', { name: /problems with 4 fields/i })).toBeVisible();
  await expectNoA11yViolations(page);
});

test('dark mode has no accessibility violations', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.getByRole('button', { name: /pay/i }).click();
  await expectNoA11yViolations(page);
});

test('empty submit focuses the error summary, and links jump to fields', async ({ page }) => {
  await page.getByRole('button', { name: /pay/i }).click();

  const summary = page.getByRole('group', { name: /problems with 4 fields/i });
  await expect(summary).toBeFocused();
  await expect(page).toHaveTitle(/^Error:/);

  await summary.getByRole('link', { name: 'Enter your card number' }).click();
  await expect(page.getByLabel('Card number')).toBeFocused();
});

test('formats the card number and detects the network', async ({ page }) => {
  const card = page.getByLabel('Card number');
  await card.pressSequentially('378282246310005');
  await expect(card).toHaveValue('3782 822463 10005');
  // CVV hint adapts for American Express
  await expect(page.getByText('4 digits on the front of your card')).toBeVisible();
});

test('Backspace right after a space deletes the digit before it', async ({ page }) => {
  const card = page.getByLabel('Card number');
  await card.pressSequentially('41112');
  await expect(card).toHaveValue('4111 2');
  await card.press('ArrowLeft'); // caret now sits just after the space: "4111 |2"
  await card.press('Backspace'); // should delete the last "1", not get stuck on the space
  await expect(card).toHaveValue('4112');
  // caret stays where the user was editing, so typing continues in place
  await card.press('9');
  await expect(card).toHaveValue('4119 2');
});

test('completes checkout with OTP using only the keyboard', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name === 'mobile', 'keyboard-only flow is a desktop scenario');
  // Skip link is the first tab stop
  await page.keyboard.press('Tab');
  await expect(page.getByRole('link', { name: 'Skip to payment form' })).toBeFocused();
  await page.keyboard.press('Enter');

  // Tab into the first field
  await page.keyboard.press('Tab');
  await page.keyboard.press('Tab');
  await expect(page.getByLabel('Name on card')).toBeFocused();
  await page.keyboard.type('Prince Verma');
  await page.keyboard.press('Tab');
  await page.keyboard.type('4111111111111111');
  await page.keyboard.press('Tab');
  await page.keyboard.type('0835');
  await page.keyboard.press('Tab');
  await page.keyboard.type('123');
  await page.keyboard.press('Enter'); // native Enter-to-submit still works

  // OTP dialog opens with focus in the code field
  const dialog = page.getByRole('dialog', { name: "Confirm it's you" });
  await expect(dialog).toBeVisible();
  await expect(page.getByLabel('One-time code')).toBeFocused();
  await expectNoA11yViolations(page);

  const code = (await dialog.getByText(/Test mode: your code is/).textContent())!.match(/\d{6}/)![0];
  await page.keyboard.type(code);
  await page.keyboard.press('Enter');

  const heading = page.getByRole('heading', { name: 'Order placed' });
  await expect(heading).toBeFocused();
  await expect(page.getByText(/Visa ending 1111/)).toBeVisible();
  await expect(page.getByText(/notified by webhook/)).toBeVisible();
  await expectNoA11yViolations(page);
});

async function fillCard(page: Page, number: string) {
  await page.getByLabel('Name on card').fill('Test Customer');
  await page.getByLabel('Card number').pressSequentially(number);
  await page.getByLabel('Expiry date').pressSequentially('0835');
  await page.getByLabel('Security code').pressSequentially('123');
  await page.getByRole('button', { name: /pay/i }).click();
}

test('a declined card shows a focused, accessible error', async ({ page }) => {
  await fillCard(page, '4000000000009995');
  const summary = page.getByRole('group', { name: 'Your payment was not completed' });
  await expect(summary).toBeFocused();
  await expect(summary).toContainText('insufficient funds');
  await expectNoA11yViolations(page);
});

test('wrong OTP shows an error in the dialog; Esc cancels and returns focus', async ({ page }) => {
  await fillCard(page, '5555555555554444');
  const dialog = page.getByRole('dialog');
  await page.getByLabel('One-time code').fill('000001');
  await dialog.getByRole('button', { name: 'Verify and pay' }).click();
  await expect(dialog.getByText(/incorrect.*2 attempts left/)).toBeVisible();
  await expect(page.getByLabel('One-time code')).toHaveAttribute('aria-invalid', 'true');

  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(page.getByRole('group', { name: 'Payment cancelled' })).toBeFocused();
});

test('merchant dashboard: log in, capture and refund', async ({ page }) => {
  // make an authorised payment first
  await fillCard(page, '4242424242424242');
  await expect(page.getByRole('heading', { name: 'Order placed' })).toBeVisible();
  // The shop shows the order id once the webhook arrives; use it to find this exact payment.
  const orderId = (await page.getByText(/notified by webhook/).textContent())!.match(/order_\w+/)![0];

  await page.goto('/dashboard/');
  const login = page.locator('#login-view');
  await login.getByLabel('Email').fill('demo@chaiandco.test');
  await login.getByLabel('Password').fill('chai-demo-2026');
  await login.getByRole('button', { name: 'Log in' }).click();
  await expect(page.getByRole('heading', { name: 'Payments' })).toBeFocused();
  await expectNoA11yViolations(page);

  const row = page.getByRole('row').filter({ hasText: orderId });
  await row.getByRole('button', { name: /^Capture/ }).click();
  await expect(row.getByText('Succeeded')).toBeVisible();

  await row.getByRole('button', { name: /^Refund/ }).click();
  const dialog = page.getByRole('dialog', { name: 'Refund payment' });
  await dialog.getByLabel(/Amount to refund/).fill('500');
  await dialog.getByRole('button', { name: 'Refund' }).click();
  await expect(row.getByText(/Partly refunded/)).toBeVisible();
  await expectNoA11yViolations(page);
});

test('reflows at 320px wide without horizontal scrolling (WCAG 1.4.10)', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 640 });
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
  );
  expect(overflow).toBe(false);
});

test('dashboard reflows at 320px wide, even with payments in the table', async ({ page }) => {
  await fillCard(page, '4242424242424242');
  await expect(page.getByRole('heading', { name: 'Order placed' })).toBeVisible();
  await page.setViewportSize({ width: 320, height: 640 });
  await page.goto('/dashboard/');
  const login = page.locator('#login-view');
  await login.getByLabel('Email').fill('demo@chaiandco.test');
  await login.getByLabel('Password').fill('chai-demo-2026');
  await login.getByRole('button', { name: 'Log in' }).click();
  await expect(page.getByRole('heading', { name: 'Payments' })).toBeVisible();
  // Wide tables scroll inside their own region; the PAGE must not scroll sideways.
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
  );
  expect(overflow).toBe(false);
});

// ───────── Platform: sign-up → payment link → hosted checkout → back to the merchant ─────────

test('a new merchant signs up, creates a payment link, and a customer pays through it', async ({ page }, testInfo) => {
  const email = `e2e-${testInfo.project.name}-${Date.now()}@shop.test`;
  const origin = new URL(page.url()).origin;

  await page.goto('/dashboard/#signup');
  const signup = page.locator('#signup-view');
  await expect(signup.getByRole('heading', { name: 'Create a test account' })).toBeVisible();
  await expectNoA11yViolations(page);
  await signup.getByLabel('Business name').fill('E2E Books');
  await signup.getByLabel('Email').fill(email);
  await signup.getByLabel('Password').fill('a-long-password');
  await signup.getByLabel('Your website').fill(origin);
  await signup.getByRole('button', { name: 'Create account' }).click();

  await expect(page.getByRole('heading', { name: 'Your API keys' })).toBeFocused();
  await expect(page.locator('#new-keys')).toContainText('sk_test_');
  await page.getByRole('link', { name: /saved my keys/ }).click();

  await expect(page.getByRole('heading', { name: 'Payment links' })).toBeFocused();
  await page.getByLabel('Product name').fill('Malgudi Days');
  await page.getByLabel('Price (₹)').fill('350');
  await page.getByLabel(/After payment/).fill(`${origin}/docs/`);
  await page.getByRole('button', { name: 'Create link' }).click();
  const link = page.locator('#links-body a').first();
  await expect(link).toBeVisible();
  await expectNoA11yViolations(page);
  const linkUrl = (await link.textContent())!;

  // Customer opens the link (e.g. from a "Buy" button on another site)
  await page.goto(linkUrl);
  await expect(page.getByRole('heading', { name: 'Malgudi Days' })).toBeVisible();
  await expect(page.getByText('E2E Books')).toBeVisible();
  await expectNoA11yViolations(page);
  await fillCard(page, '4242424242424242');

  // Sent back to the merchant's success_url with the session id
  await page.waitForURL(/\/docs\/\?session_id=cs_/);
});

test('hosted checkout shows a clear message for an unknown session', async ({ page }) => {
  await page.goto('/pay/?s=cs_doesnotexist');
  await expect(page.getByRole('heading', { name: 'Checkout not found' })).toBeFocused();
  await expectNoA11yViolations(page);
});

test('docs page has no accessibility violations', async ({ page }) => {
  await page.goto('/docs/');
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  await expectNoA11yViolations(page);
});
