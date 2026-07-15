// Block live-preview layer (StateField).
//
// CM6 only allows decorations that change vertical layout (block widgets,
// multi-line replacements) to come from the state, not from a ViewPlugin —
// so tables, multi-line $$ math, whole-line images, horizontal rules and
// code-fence chrome live here.
//
// Cost stays bounded despite being full-document:
//   - keystrokes take the cheap path: existing decorations are MAPPED through
//     the change; the scheduler plugin below dispatches a throttled full
//     rebuild once ~120ms have passed
//   - the syntax tree is incremental; iteration is cheap
//   - widget DOM is only materialized inside the viewport by CM6
//   - selection-only updates rebuild only when some region's touch-state
//     actually flipped (tracked in `regions`)
//
// The scheduler also watches the syntax-tree identity, because CM6's
// background parser extends the tree via transactions with no doc/selection
// change — without that, blocks beyond the initial parse budget would never
// get widgets in long notes.

import { StateField, StateEffect } from "@codemirror/state";
import { Decoration, EditorView, ViewPlugin } from "@codemirror/view";
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

export const rebuildBlocks = StateEffect.define();

export const blockField = StateField.define({
  create(state) {
    return build(state);
  },
  update(value, tr) {
    for (const e of tr.effects) {
      if (e.is(rebuildBlocks)) return build(tr.state);
    }
    if (tr.docChanged) {
      // Cheap keystroke path: shift existing decorations along with the edit.
      // The scheduler plugin dispatches rebuildBlocks shortly after.
      return {
        decos: value.decos.map(tr.changes),
        regions: value.regions.map((r) => ({
          from: tr.changes.mapPos(r.from, -1),
          to: tr.changes.mapPos(r.to, 1),
          touched: r.touched,
        })),
      };
    }
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

// Throttles full rebuilds of blockField: at most one per REBUILD_MS, fired
// after doc changes or whenever the background parser has extended the
// syntax tree (tree identity change with no doc edit).
const REBUILD_MS = 120;

export const blockRebuildScheduler = ViewPlugin.fromClass(
  class {
    constructor(view) {
      this.view = view;
      this.timer = null;
      this.tree = syntaxTree(view.state);
    }
    update(update) {
      const tree = syntaxTree(update.state);
      if (update.docChanged || tree !== this.tree) {
        this.tree = tree;
        this.schedule();
      }
    }
    schedule() {
      if (this.timer !== null) return;
      this.timer = setTimeout(() => {
        this.timer = null;
        this.view.dispatch({ effects: rebuildBlocks.of(null) });
      }, REBUILD_MS);
    }
    destroy() {
      if (this.timer !== null) clearTimeout(this.timer);
    }
  },
);
