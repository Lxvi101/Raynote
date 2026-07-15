// Reveal semantics shared by the inline and block decoration layers.
//
// Live preview hides markdown syntax until the user "touches" an element
// with the selection. Inline elements (emphasis, links, inline code) reveal
// at character granularity; block elements (headings, fences, tables, math)
// reveal when the selection lands on any line they span.

/** True if any selection range intersects [from, to] (inclusive edges). */
export function selectionTouches(state, from, to) {
  for (const r of state.selection.ranges) {
    if (r.from <= to && r.to >= from) return true;
  }
  return false;
}

/** True if any selection range lands on the lines spanned by [from, to]. */
export function selectionTouchesLines(state, from, to) {
  const doc = state.doc;
  return selectionTouches(state, doc.lineAt(from).from, doc.lineAt(to).to);
}
