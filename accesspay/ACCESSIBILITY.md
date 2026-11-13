# Accessibility conformance

Target: **WCAG 2.2 Level AA** (which also covers the US Section 508 requirements for web content).

Automated checks (axe-core, Lighthouse) catch roughly a third of real issues. The rest needs manual testing, recorded below.

## Success criteria and how they're met

| WCAG | Criterion | How AccessPay meets it |
|---|---|---|
| 1.3.1 | Info and Relationships | Real `<label for>` on every input; hints and errors linked with `aria-describedby`; error summary is a labelled group |
| 1.3.5 | Identify Input Purpose | `autocomplete` = `cc-name`, `cc-number`, `cc-exp`, `cc-csc` |
| 1.4.1 | Use of Color | Errors use an icon, an "Error:" prefix (for screen readers), text and a thicker border, not just red |
| 1.4.3 | Contrast (Minimum) | All text ≥ 4.5:1 in light and dark themes (values documented in the CSS) |
| 1.4.10 | Reflow | No horizontal scrolling at 320px wide (tested in E2E) |
| 1.4.11 | Non-text Contrast | Input borders ≥ 3:1 against the background |
| 1.4.12 | Text Spacing | No fixed heights on text containers |
| 2.1.1 | Keyboard | Full checkout works with keyboard only (tested in E2E) |
| 2.4.1 | Bypass Blocks | "Skip to checkout" link (demo page) |
| 2.4.2 | Page Titled | Title gets an "Error:" prefix while errors are shown |
| 2.4.3 | Focus Order | DOM order = visual order; focus moves to the error summary, then to the field you pick |
| 2.4.7 / 2.4.11 | Focus Visible / Not Obscured | Two-colour focus ring visible on any background |
| 2.5.8 | Target Size (Minimum) | Inputs 44px tall, buttons 48px |
| 3.3.1 | Error Identification | Inline error text per field plus a summary |
| 3.3.2 | Labels or Instructions | Visible labels; hints for expiry format and security code location |
| 3.3.3 | Error Suggestion | Messages say how to fix the problem |
| 4.1.2 | Name, Role, Value | Native inputs; `aria-invalid` toggled with errors; `required` exposed |
| 4.1.3 | Status Messages | Card network, "Processing payment", "A new code has been sent" and dashboard actions announced through polite live regions |
| 2.2.1 | Timing Adjustable | The OTP expires (a security requirement), but the user can request a new code; the countdown isn't announced every second |
| 2.1.2 | No Keyboard Trap | OTP and refund dialogs use native `<dialog>`; Esc closes them and focus returns to where it was |
| 1.3.1 | Tables | Dashboard tables have captions and `<th scope="col">`; wide tables scroll inside a labelled, focusable region |
| 2.4.6 | Headings and Labels | Repeated "Refund"/"Capture" buttons include hidden text naming the payment, so screen-reader users know which row they act on |

Also supported: `prefers-color-scheme: dark`, `prefers-reduced-motion`, `forced-colors` (Windows High Contrast).

## Manual testing log

Fill this in as you test. Note the date, what you tried and what happened.

| Screen reader + browser | Device | Date | Result / issues found |
|---|---|---|---|
| NVDA + Chrome | Windows | | |
| NVDA + Firefox | Windows | | |
| VoiceOver + Safari | macOS | | |
| VoiceOver + Safari | iPhone | | |
| TalkBack + Chrome | Android | | |

Things to check each time (shop):
1. Each field announces its label, hint and "required".
2. Typing a Visa number announces "Visa card detected".
3. Submitting empty moves to the error summary and reads the heading.
4. Activating a summary link moves to the field, and the field reads its error.
5. 200% and 400% browser zoom: nothing cut off or overlapping.
6. Windows High Contrast mode: borders, focus ring and error icon still visible.
7. OTP dialog: focus starts in the code field, the test-mode hint and errors are read, Esc cancels, focus returns.
8. SMS autofill of the OTP on a real phone (Android Chrome / iOS Safari).

Dashboard:
1. Log in with keyboard only; errors are announced.
2. Navigate the payments table by row/column with the screen reader's table commands.
3. Each Capture/Refund button announces which payment it's for.
4. After capture or refund, the result is announced and focus lands on the "Payments" heading.
