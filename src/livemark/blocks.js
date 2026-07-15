// Block live-preview layer (StateField).
//
// CM6 only allows decorations that change vertical layout (block widgets,
// multi-line replacements) to come from the state, not from a ViewPlugin —
// so tables, multi-line $$ math, whole-line images, horizontal rules and
// code-fence chrome live here.
//
// Cost stays bounded despite being full-document:
//   - the syntax tree is incremental; iteration is cheap
//   - widget DOM is only materialized inside the viewport by CM6
//   - selection-only updates rebuild only when some region's touch-state
//     actually flipped (tracked in `regions`)

import { StateField } from "@codemirror/state";
import { Decoration, EditorView } from "@codemirror/view";
import { syntaxTree } from "@codemirror/language";
import { selectionTouchesLines } from "./reveal.js";
import {
  HRWidget,
  TableWidget,
  MathWidget,
  ImageWidget,
  CodeHeaderWidget,
  CodeCapWidget,
  parseAlt,
} from "./widgets.js";

// Skip the whole-document math scan for absurdly large docs.
const MATH_SCAN_MAX_DOC = 512 * 1024;

function insideCode(state, pos) {
  for (
    let node = syntaxTree(state).resolveInner(pos, 1);
    node;
    node = node.parent
  ) {
    if (/^(FencedCode|CodeBlock|InlineCode|CodeText)$/.test(node.name)) {
      return true;
    }
  }
  return false;
}

function build(state) {
  const doc = state.doc;
  const decos = [];
  const regions = [];

  // Track every candidate region with its current touch-state so
  // selection-only transactions can cheaply decide whether to rebuild.
  const track = (from, to) => {
    const touched = selectionTouchesLines(state, from, to);
    regions.push({ from, to, touched });
    return touched;
  };

  syntaxTree(state).iterate({
    enter: (node) => {
      const name = node.name;

      if (name === "HorizontalRule") {
        const line = doc.lineAt(node.from);
        if (!track(line.from, line.to)) {
          decos.push(
            Decoration.replace({ widget: new HRWidget(), block: true }).range(
              line.from,
              line.to,
            ),
          );
        }
        return false;
      }

      if (name === "Table") {
        const first = doc.lineAt(node.from);
        const last = doc.lineAt(node.to);
        if (!track(first.from, last.to)) {
          decos.push(
            Decoration.replace({
              widget: new TableWidget(doc.sliceString(first.from, last.to)),
              block: true,
            }).range(first.from, last.to),
          );
        }
        return false;
      }

      if (name === "FencedCode") {
        const first = doc.lineAt(node.from);
        const last = doc.lineAt(node.to);
        if (!track(first.from, last.to)) {
          // Language from the opening fence: ```lang
          const fenceText = doc.sliceString(first.from, first.to);
          const fm = /^\s*(`{3,}|~{3,})\s*(\S*)/.exec(fenceText);
          const lang = fm ? fm[2] : "";
          decos.push(
            Decoration.replace({ widget: new CodeHeaderWidget(lang) }).range(
              first.from,
              first.to,
            ),
          );
          // Only cap the block if the closing fence actually exists.
          if (last.number > first.number && fm) {
            const closing = doc.sliceString(last.from, last.to);
            if (new RegExp(`^\\s*${fm[1][0]}{3,}\\s*$`).test(closing)) {
              decos.push(
                Decoration.replace({ widget: new CodeCapWidget() }).range(
                  last.from,
                  last.to,
                ),
              );
            }
          }
        }
        return false;
      }

      if (name === "Image") {
        const line = doc.lineAt(node.from);
        const wholeLine =
          doc.lineAt(node.to).number === line.number &&
          doc.sliceString(line.from, node.from).trim() === "" &&
          doc.sliceString(node.to, line.to).trim() === "";
        if (!wholeLine) return false;
        if (!track(line.from, line.to)) {
          const text = doc.sliceString(node.from, node.to);
          const m = /^!\[([^\]]*)\]\(([^)]*)\)/.exec(text);
          if (m) {
            const { alt, width, align } = parseAlt(m[1]);
            decos.push(
              Decoration.replace({
                widget: new ImageWidget(m[2].trim(), alt, width, align, true),
                block: true,
              }).range(line.from, line.to),
            );
          }
        }
        return false;
      }
    },
  });

  // ─── Multi-line $$ math (regex — lang-markdown has no math syntax) ───
  if (doc.length <= MATH_SCAN_MAX_DOC) {
    const text = doc.toString();
    if (text.includes("$$")) {
      const re = /\$\$([\s\S]+?)\$\$/g;
      let m;
      while ((m = re.exec(text)) !== null) {
        if (!m[1].includes("\n")) continue; // single-line → inline layer
        if (insideCode(state, m.index)) continue;
        const first = doc.lineAt(m.index);
        const last = doc.lineAt(m.index + m[0].length);
        if (!track(first.from, last.to)) {
          decos.push(
            Decoration.replace({
              widget: new MathWidget(m[1].trim(), true),
              block: true,
            }).range(first.from, last.to),
          );
        }
      }
    }
  }

  return {
    decos: Decoration.set(decos, true),
    regions,
  };
}

function touchStateChanged(value, state) {
  for (const r of value.regions) {
    if (selectionTouchesLines(state, r.from, r.to) !== r.touched) return true;
  }
  return false;
}

export const blockField = StateField.define({
  create(state) {
    return build(state);
  },
  update(value, tr) {
    if (tr.docChanged) return build(tr.state);
    if (tr.selection && touchStateChanged(value, tr.state)) {
      return build(tr.state);
    }
    return value;
  },
  provide: (f) => [
    EditorView.decorations.from(f, (v) => v.decos),
    // The block layer emits only replace decorations, so the decoration set
    // doubles as the atomic-range set.
    EditorView.atomicRanges.of((view) => view.state.field(f).decos),
  ],
});
