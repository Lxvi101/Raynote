import { ViewPlugin, Decoration, EditorView, WidgetType } from "@codemirror/view";
import { RangeSet } from "@codemirror/state";
import katex from "katex";

// Per-block memoization keyed on math source so re-rendering on every keystroke
// is essentially free for blocks the user isn't actively editing. Cleared on
// note switch (see clearKatexCache) to bound memory.
const renderCache = new Map();
let cacheNoteId = null;

export function clearKatexCache() {
  renderCache.clear();
  cacheNoteId = null;
}

function renderKatex(source, displayMode) {
  const key = (displayMode ? "B:" : "I:") + source;
  const cached = renderCache.get(key);
  if (cached) return cached;
  let html;
  try {
    html = katex.renderToString(source, {
      displayMode,
      throwOnError: false,
      trust: true,
    });
  } catch {
    html = null;
  }
  renderCache.set(key, html);
  return html;
}

class KatexBlockWidget extends WidgetType {
  constructor(source) {
    super();
    this.source = source;
  }
  eq(other) {
    return other.source === this.source;
  }
  toDOM() {
    const el = document.createElement("div");
    el.className = "cm-katex-block";
    const html = renderKatex(this.source, true);
    if (html === null) {
      el.classList.add("error");
      el.textContent = this.source;
    } else {
      el.innerHTML = html;
    }
    return el;
  }
}

class KatexInlineWidget extends WidgetType {
  constructor(source) {
    super();
    this.source = source;
  }
  eq(other) {
    return other.source === this.source;
  }
  toDOM() {
    const el = document.createElement("span");
    el.className = "cm-katex-inline";
    const html = renderKatex(this.source, false);
    if (html === null) {
      el.classList.add("error");
      el.textContent = this.source;
    } else {
      el.innerHTML = html;
    }
    return el;
  }
}

// We don't use the markdown syntax tree for KaTeX because `lang-markdown`
// doesn't recognize `$...$` / `$$...$$` natively. Direct text scanning is
// fine because KaTeX-bearing notes are usually short, and we only ever
// scan the visible viewport.
function findMath(text, baseOffset) {
  const out = [];
  // Block: $$...$$ (multiline allowed)
  const blockRe = /\$\$([\s\S]+?)\$\$/g;
  let m;
  while ((m = blockRe.exec(text)) !== null) {
    out.push({
      kind: "block",
      from: baseOffset + m.index,
      to: baseOffset + m.index + m[0].length,
      source: m[1].trim(),
    });
  }
  // Inline: $...$ (no newline; not a $$). Run on text with block ranges removed
  // so we don't accidentally pick up a half of a $$ pair.
  const masked = text
    .split("")
    .map((c, i) => {
      const abs = baseOffset + i;
      for (const b of out) if (abs >= b.from && abs < b.to) return " ";
      return c;
    })
    .join("");
  const inlineRe = /\$([^$\n]+?)\$/g;
  while ((m = inlineRe.exec(masked)) !== null) {
    out.push({
      kind: "inline",
      from: baseOffset + m.index,
      to: baseOffset + m.index + m[0].length,
      source: m[1].trim(),
    });
  }
  out.sort((a, b) => a.from - b.from);
  return out;
}

export function katexPlugin({ getActiveNoteId } = {}) {
  return ViewPlugin.fromClass(
    class {
      constructor(view) {
        this.decorations = this.build(view);
      }
      update(update) {
        // Reset memoization when the loaded note changes — math sources
        // collide across notes and we'd otherwise leak memory unboundedly.
        if (getActiveNoteId) {
          const cur = getActiveNoteId();
          if (cur !== cacheNoteId) {
            renderCache.clear();
            cacheNoteId = cur;
          }
        }
        if (
          update.docChanged ||
          update.viewportChanged ||
          update.selectionSet
        ) {
          this.decorations = this.build(update.view);
        }
      }
      build(view) {
        const decos = [];
        const doc = view.state.doc;
        const sel = view.state.selection.main;
        const cursorLineFrom = doc.lineAt(sel.from).number;
        const cursorLineTo = doc.lineAt(sel.to).number;

        for (const { from: vFrom, to: vTo } of view.visibleRanges) {
          const text = doc.sliceString(vFrom, vTo);
          for (const m of findMath(text, vFrom)) {
            const lineFrom = doc.lineAt(m.from).number;
            const lineTo = doc.lineAt(m.to).number;
            // Cursor on the math source → leave raw for editing.
            if (cursorLineTo >= lineFrom && cursorLineFrom <= lineTo) continue;
            const fromLine = doc.lineAt(m.from);
            const toLine = doc.lineAt(m.to);
            // CM6 forbids block:true and multi-line replace from ViewPlugins.
            // Skip multi-line $$ blocks for now (rendered as raw markdown);
            // single-line $$x$$ and $x$ become widgets.
            if (fromLine.number !== toLine.number) continue;
            const widget =
              m.kind === "block"
                ? new KatexBlockWidget(m.source)
                : new KatexInlineWidget(m.source);
            decos.push(
              Decoration.replace({ widget }).range(m.from, m.to),
            );
          }
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
}
