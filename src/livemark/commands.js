// Formatting commands for the live editor: ⌘B bold, ⌘I italic, ⌘⇧X strike.
// Each toggles the wrapping markers around every selection range, unwrapping
// when the range (or its immediate surroundings) is already wrapped.

import { EditorSelection } from "@codemirror/state";

function toggleWrap(view, marker) {
  const { state } = view;
  const len = marker.length;
  const spec = state.changeByRange((range) => {
    const inner = state.sliceDoc(range.from, range.to);
    const before = state.sliceDoc(Math.max(0, range.from - len), range.from);
    const after = state.sliceDoc(
      range.to,
      Math.min(state.doc.length, range.to + len),
    );

    // Markers included in the selection → unwrap.
    if (
      inner.length >= len * 2 &&
      inner.startsWith(marker) &&
      inner.endsWith(marker)
    ) {
      return {
        changes: [
          { from: range.from, to: range.from + len },
          { from: range.to - len, to: range.to },
        ],
        range: EditorSelection.range(range.from, range.to - len * 2),
      };
    }
    // Markers directly around the selection (or cursor) → unwrap.
    if (before === marker && after === marker) {
      return {
        changes: [
          { from: range.from - len, to: range.from },
          { from: range.to, to: range.to + len },
        ],
        range: EditorSelection.range(range.from - len, range.to - len),
      };
    }
    // Otherwise wrap, keeping the selection on the inner text.
    return {
      changes: [
        { from: range.from, insert: marker },
        { from: range.to, insert: marker },
      ],
      range: EditorSelection.range(range.from + len, range.to + len),
    };
  });
  view.dispatch(
    state.update(spec, { userEvent: "input", scrollIntoView: true }),
  );
  return true;
}

export const formatKeymap = [
  { key: "Mod-b", run: (v) => toggleWrap(v, "**") },
  { key: "Mod-i", run: (v) => toggleWrap(v, "*") },
  { key: "Mod-Shift-x", run: (v) => toggleWrap(v, "~~") },
];
