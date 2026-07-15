import { EditorSelection, Transaction } from "@codemirror/state";

// Backend implementation for the EditorAdapter — wraps a CM6 EditorView so
// the rest of the app can read/write doc text without knowing about CM6.
export class LiveBackend {
  constructor() {
    this.view = null;
    this._listeners = [];
    this._suppress = 0;
  }

  setView(view) {
    this.view = view;
  }

  getText() {
    return this.view ? this.view.state.doc.toString() : "";
  }

  setText(text) {
    if (!this.view) return;
    this._suppress++;
    try {
      const len = this.view.state.doc.length;
      this.view.dispatch({
        changes: { from: 0, to: len, insert: text },
        selection: EditorSelection.cursor(0),
        // Loading a doc shouldn't be undoable — undo would empty the editor
        // and confuse the user.
        annotations: Transaction.addToHistory.of(false),
      });
    } finally {
      this._suppress--;
    }
  }

  getSelection() {
    if (!this.view) return { start: 0, end: 0 };
    const sel = this.view.state.selection.main;
    return { start: sel.from, end: sel.to };
  }

  setSelection(start, end) {
    if (!this.view) return;
    const docLen = this.view.state.doc.length;
    const s = Math.max(0, Math.min(start, docLen));
    const e = Math.max(0, Math.min(end, docLen));
    this.view.dispatch({
      selection:
        s === e ? EditorSelection.cursor(s) : EditorSelection.range(s, e),
      scrollIntoView: true,
    });
  }

  replaceRange(from, to, text) {
    if (!this.view) return;
    const newPos = from + text.length;
    this.view.dispatch({
      changes: { from, to, insert: text },
      selection: EditorSelection.cursor(newPos),
      userEvent: "input",
    });
  }

  focus() {
    this.view?.focus();
  }

  onInput(fn) {
    this._listeners.push(fn);
  }

  // Called by CM6's updateListener on every transaction.
  _emit(update) {
    if (this._suppress > 0) return;
    if (!update.docChanged) return;
    for (const fn of this._listeners) fn();
  }
}
