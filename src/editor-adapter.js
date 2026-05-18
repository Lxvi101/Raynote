// Editor abstraction so the app can target either the raw textarea or
// the live-preview CodeMirror view through a single API.
//
// Backends implement:
//   getText(): string
//   setText(text): void                  — replaces doc, no input event
//   getSelection(): { start, end }
//   setSelection(start, end): void
//   replaceRange(from, to, text): void   — fires the input listener
//   focus(): void
//   show(): void  / hide(): void
//   onInput(fn): void                    — wires into the backend's user-input signal

class EditorAdapter {
  constructor() {
    this._backends = {};
    this._activeName = null;
    this._listeners = [];
  }

  register(name, backend) {
    this._backends[name] = backend;
    backend.onInput(() => this._emit());
  }

  hasBackend(name) {
    return !!this._backends[name];
  }

  getBackend(name) {
    return this._backends[name];
  }

  active() {
    return this._activeName ? this._backends[this._activeName] : null;
  }

  activeName() {
    return this._activeName;
  }

  setActive(name) {
    if (!this._backends[name]) return;
    this._activeName = name;
  }

  // Move doc text from current active backend to `name`, then activate it.
  // Cursor position is carried across so the user doesn't get yanked back to
  // the top when toggling editor styles mid-session.
  switchTo(name) {
    if (this._activeName === name) return;
    const text = this.getText();
    const sel = this.getSelection();
    const target = this._backends[name];
    if (!target) return;
    target.setText(text);
    target.setSelection(sel.start, sel.end);
    this._activeName = name;
  }

  // ─── Delegated doc API ───
  getText() {
    return this.active()?.getText() ?? "";
  }
  setText(text) {
    this.active()?.setText(text);
  }
  getSelection() {
    return this.active()?.getSelection() ?? { start: 0, end: 0 };
  }
  setSelection(start, end) {
    this.active()?.setSelection(start, end);
  }
  replaceRange(from, to, text) {
    this.active()?.replaceRange(from, to, text);
  }
  focus() {
    this.active()?.focus();
  }

  // ─── Listener API ───
  onInput(fn) {
    this._listeners.push(fn);
  }
  _emit() {
    for (const fn of this._listeners) fn();
  }
}

export const editor = new EditorAdapter();

// ─── Textarea backend ───
export class TextareaBackend {
  constructor(el) {
    this.el = el;
    this._listeners = [];
    el.addEventListener("input", () => {
      for (const fn of this._listeners) fn();
    });
  }

  getText() {
    return this.el.value;
  }

  setText(text) {
    this.el.value = text;
  }

  getSelection() {
    return { start: this.el.selectionStart, end: this.el.selectionEnd };
  }

  setSelection(start, end) {
    this.el.setSelectionRange(start, end);
  }

  replaceRange(from, to, text) {
    const v = this.el.value;
    this.el.value = v.slice(0, from) + text + v.slice(to);
    const pos = from + text.length;
    this.el.setSelectionRange(pos, pos);
    // Programmatic edit but mirrors a user edit — fire input so save runs.
    this.el.dispatchEvent(new Event("input", { bubbles: true }));
  }

  focus() {
    this.el.focus();
  }

  show() {
    this.el.classList.add("visible");
  }

  hide() {
    this.el.classList.remove("visible");
  }

  onInput(fn) {
    this._listeners.push(fn);
  }
}
