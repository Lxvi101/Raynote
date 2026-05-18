import { ViewPlugin, Decoration, EditorView, WidgetType } from "@codemirror/view";
import { syntaxTree } from "@codemirror/language";
import { RangeSet } from "@codemirror/state";

// ─── Widgets ───
class CheckboxWidget extends WidgetType {
  constructor(checked) {
    super();
    this.checked = checked;
  }
  eq(other) {
    return other.checked === this.checked;
  }
  toDOM(view) {
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = this.checked;
    cb.className = "cm-task-checkbox";
    // mousedown causes a focus change before click — prevent so cursor stays put
    cb.addEventListener("mousedown", (e) => e.preventDefault());
    cb.addEventListener("click", (e) => {
      // Look up the live position of this widget so doc shifts since render
      // don't break the toggle.
      const pos = view.posAtDOM(cb);
      if (pos == null) return;
      const newChar = cb.checked ? "x" : " ";
      view.dispatch({
        changes: { from: pos + 1, to: pos + 2, insert: newChar },
        userEvent: "input",
      });
      e.stopPropagation();
    });
    return cb;
  }
  // Default ignoreEvent (returns true) is correct here — CM6 leaves the
  // widget's DOM events alone, our own click handler bubbles through.
}

class HRWidget extends WidgetType {
  toDOM() {
    const el = document.createElement("span");
    el.className = "cm-hr-widget";
    return el;
  }
  eq() {
    return true;
  }
}

// ─── Live preview plugin ───
// Walks the visible markdown syntax tree on every doc/viewport/selection
// update and emits decorations:
//   - line classes for headings / code blocks / blockquotes / hr
//   - mark classes for emphasis / inline code / links / strike
//   - replace decorations that hide markdown markers when the cursor isn't
//     on that line (the Obsidian Live Preview feel)
//   - widgets for task checkboxes and horizontal rules
export const livePreviewPlugin = ViewPlugin.fromClass(
  class {
    constructor(view) {
      this.decorations = this.build(view);
    }

    update(update) {
      if (update.docChanged || update.viewportChanged || update.selectionSet) {
        this.decorations = this.build(update.view);
      }
    }

    build(view) {
      const decos = [];
      const doc = view.state.doc;
      const sel = view.state.selection.main;
      const cursorLineFrom = doc.lineAt(sel.from).number;
      const cursorLineTo = doc.lineAt(sel.to).number;

      const isCursorOnLines = (fromPos, toPos) => {
        const a = doc.lineAt(fromPos).number;
        const b = doc.lineAt(toPos).number;
        return cursorLineTo >= a && cursorLineFrom <= b;
      };

      // Emit a decoration only if the marker should be hidden.
      const hideIfOffCursor = (from, to) => {
        if (from >= to) return;
        if (!isCursorOnLines(from, to)) {
          decos.push(Decoration.replace({}).range(from, to));
        }
      };

      const tree = syntaxTree(view.state);

      for (const { from: vFrom, to: vTo } of view.visibleRanges) {
        tree.iterate({
          from: vFrom,
          to: vTo,
          enter: (node) => {
            const name = node.name;

            // Headings — line decoration for size/weight.
            const headingMatch = /^ATXHeading([1-6])$/.exec(name);
            if (headingMatch) {
              const level = headingMatch[1];
              const lineFrom = doc.lineAt(node.from).from;
              decos.push(
                Decoration.line({
                  attributes: { class: `cm-heading cm-h${level}` },
                }).range(lineFrom),
              );
              return; // descend to find HeaderMark
            }

            if (name === "HeaderMark") {
              // Hide the leading `# ` chars (and the trailing space) when off-line.
              const line = doc.lineAt(node.from);
              if (!isCursorOnLines(line.from, line.to)) {
                // Trailing space character belongs to the marker visually.
                let to = node.to;
                if (doc.sliceString(to, to + 1) === " ") to += 1;
                decos.push(Decoration.replace({}).range(node.from, to));
              }
              return;
            }

            if (name === "Emphasis") {
              decos.push(
                Decoration.mark({ class: "cm-em" }).range(node.from, node.to),
              );
              return;
            }
            if (name === "StrongEmphasis") {
              decos.push(
                Decoration.mark({ class: "cm-strong" }).range(node.from, node.to),
              );
              return;
            }
            if (name === "Strikethrough") {
              decos.push(
                Decoration.mark({ class: "cm-strike" }).range(node.from, node.to),
              );
              return;
            }
            if (name === "EmphasisMark" || name === "StrikethroughMark") {
              hideIfOffCursor(node.from, node.to);
              return;
            }

            if (name === "InlineCode") {
              decos.push(
                Decoration.mark({ class: "cm-inline-code" }).range(
                  node.from,
                  node.to,
                ),
              );
              return;
            }
            if (name === "CodeMark") {
              // Only hide inline-code backticks; leave fenced-code ``` visible
              // so the boundary of the code block stays apparent.
              const parent = node.node.parent;
              if (parent && parent.name === "InlineCode") {
                hideIfOffCursor(node.from, node.to);
              }
              return;
            }

            if (name === "QuoteMark") {
              const line = doc.lineAt(node.from);
              if (!isCursorOnLines(line.from, line.to)) {
                let to = node.to;
                if (doc.sliceString(to, to + 1) === " ") to += 1;
                decos.push(Decoration.replace({}).range(node.from, to));
              }
              return;
            }

            if (name === "Blockquote") {
              const startLine = doc.lineAt(node.from);
              const endLine = doc.lineAt(node.to);
              for (let n = startLine.number; n <= endLine.number; n++) {
                const ln = doc.line(n);
                decos.push(
                  Decoration.line({
                    attributes: { class: "cm-blockquote-line" },
                  }).range(ln.from),
                );
              }
              return;
            }

            if (name === "TaskMarker") {
              const text = doc.sliceString(node.from, node.to);
              const checked = /\[[xX]\]/.test(text);
              decos.push(
                Decoration.replace({
                  widget: new CheckboxWidget(checked),
                }).range(node.from, node.to),
              );
              return;
            }

            if (name === "HorizontalRule") {
              const line = doc.lineAt(node.from);
              if (!isCursorOnLines(line.from, line.to)) {
                // CM6 forbids block:true from ViewPlugins; CSS display:block on
                // .cm-hr-widget makes the inline widget render as a block rule.
                decos.push(
                  Decoration.replace({
                    widget: new HRWidget(),
                  }).range(line.from, line.to),
                );
              }
              return;
            }

            if (name === "Link") {
              decos.push(
                Decoration.mark({ class: "cm-link" }).range(node.from, node.to),
              );
              return; // descend for LinkMark / URL
            }
            if (name === "LinkMark") {
              hideIfOffCursor(node.from, node.to);
              return;
            }
            if (name === "URL") {
              hideIfOffCursor(node.from, node.to);
              return;
            }

            if (name === "FencedCode") {
              const startLine = doc.lineAt(node.from);
              const endLine = doc.lineAt(node.to);
              for (let n = startLine.number; n <= endLine.number; n++) {
                const ln = doc.line(n);
                decos.push(
                  Decoration.line({
                    attributes: { class: "cm-fenced-code-line" },
                  }).range(ln.from),
                );
              }
              return;
            }
          },
        });
      }

      return Decoration.set(decos, true);
    }
  },
  {
    decorations: (v) => v.decorations,
    provide: (plugin) =>
      EditorView.atomicRanges.of((view) => {
        const inst = view.plugin(plugin);
        return inst ? inst.decorations : RangeSet.empty;
      }),
  },
);
