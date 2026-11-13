/**
 * Shared behaviour for every AccessPay input field.
 *
 * Renders (in light DOM, so labels, autofill and native forms keep working):
 *
 *   <div class="ap-field">
 *     <label for="ap-3">Card number</label>
 *     <p class="ap-hint"  id="ap-3-hint">…</p>
 *     <p class="ap-error" id="ap-3-error" hidden>…</p>
 *     <div class="ap-input-wrap"><input id="ap-3" aria-describedby="ap-3-hint ap-3-error"></div>
 *   </div>
 *
 * Validation timing ("reward early, punish late"):
 *  - errors are first shown on blur or submit, never while someone is still typing;
 *  - once a field shows an error, it re-checks on every keystroke so the error
 *    disappears as soon as it's fixed.
 */

let uid = 0;
const nextId = () => `ap-${++uid}`;

export abstract class ApField extends HTMLElement {
  protected input!: HTMLInputElement;
  protected hintEl!: HTMLParagraphElement;
  protected errorEl!: HTMLParagraphElement;
  protected errorText!: HTMLSpanElement;
  protected wrap!: HTMLDivElement;
  private rendered = false;
  private currentError: string | null = null;

  /** Default label when the `label` attribute is missing. */
  protected abstract defaultLabel: string;
  /** Return an error message, or null if the value is valid. */
  protected abstract getError(): string | null;
  /** Set type, inputmode, autocomplete etc. on the native input. */
  protected abstract configureInput(input: HTMLInputElement): void;

  /** Optional hook that runs once the DOM is built. */
  protected afterRender(): void {}

  /** Optional per-keystroke hook (formatting). */
  protected onInput(_e: Event): void {}

  connectedCallback(): void {
    if (this.rendered) return;
    this.rendered = true;
    this.dataset.apField = '';
    this.render();
  }

  get value(): string {
    return this.input?.value ?? '';
  }

  get inputId(): string {
    return this.input.id;
  }

  get label(): string {
    return this.getAttribute('label') ?? this.defaultLabel;
  }

  get hasError(): boolean {
    return this.currentError !== null;
  }

  focusInput(): void {
    this.input.focus();
  }

  /** Validate and show/clear the error immediately. Returns the error or null. */
  validate(): string | null {
    const error = this.getError();
    this.showError(error);
    return error;
  }

  protected setHint(text: string): void {
    this.hintEl.textContent = text;
    this.hintEl.hidden = !text;
  }

  protected showError(message: string | null): void {
    this.currentError = message;
    if (message) {
      this.errorText.textContent = message;
      this.errorEl.hidden = false;
      this.input.setAttribute('aria-invalid', 'true');
    } else {
      this.errorText.textContent = '';
      this.errorEl.hidden = true;
      this.input.removeAttribute('aria-invalid');
    }
    this.classList.toggle('ap-has-error', !!message);
  }

  private render(): void {
    const id = nextId();
    const field = document.createElement('div');
    field.className = 'ap-field';

    const label = document.createElement('label');
    label.className = 'ap-label';
    label.htmlFor = id;
    label.textContent = this.label;

    this.hintEl = document.createElement('p');
    this.hintEl.className = 'ap-hint';
    this.hintEl.id = `${id}-hint`;
    this.setHint(this.getAttribute('hint') ?? '');

    this.errorEl = document.createElement('p');
    this.errorEl.className = 'ap-error';
    this.errorEl.id = `${id}-error`;
    this.errorEl.hidden = true;
    // Icon + "Error:" prefix: never rely on colour alone (WCAG 1.4.1).
    this.errorEl.innerHTML =
      '<span class="ap-error-icon" aria-hidden="true">!</span>' +
      '<span class="ap-visually-hidden">Error: </span>';
    this.errorText = document.createElement('span');
    this.errorEl.append(this.errorText);

    this.wrap = document.createElement('div');
    this.wrap.className = 'ap-input-wrap';

    this.input = document.createElement('input');
    this.input.id = id;
    this.input.className = 'ap-input';
    this.input.name = this.getAttribute('name') ?? '';
    this.input.setAttribute('aria-describedby', `${this.hintEl.id} ${this.errorEl.id}`);
    if (!this.hasAttribute('optional')) this.input.required = true; // announced as "required"

    this.configureInput(this.input);

    this.wrap.append(this.input);
    field.append(label, this.hintEl, this.errorEl, this.wrap);
    this.replaceChildren(field);
    this.afterRender();

    this.input.addEventListener('input', (e) => {
      this.onInput(e);
      if (this.hasError) this.validate(); // reward early
    });
    this.input.addEventListener('blur', () => {
      if (this.value.trim()) this.validate(); // punish late
    });
  }
}
