// Inline live-preview layer (ViewPlugin, visible ranges only).
//
// Walks the markdown syntax tree over `view.visibleRanges` and emits:
//   - line classes (headings, blockquotes, code blocks, task-done)
//   - mark classes (emphasis, inline code, links)
//   - replace decorations that hide syntax markers while the selection is
//     away, and dim them (cm-formatting) while it's touching the element
//   - inline widgets (checkboxes, bullets, inline images, inline KaTeX)
//
// Anything that changes vertical layout across lines (tables, multi-line
// math, whole-line images, HR, fence chrome) lives in blocks.js, because
// CM6 only allows block decorations from a StateField.

import { ViewPlugin, Decoration, EditorView } from "@codemirror/view";
import { syntaxTree } from "@codemirror/language";
import { RangeSet } from "@codemirror/state";
import { selectionTouches, selectionTouchesLines } from "./reveal.js";
import {
  CheckboxWidget,
  BulletWidget,
  ImageWidget,
  MathWidget,
  parseAlt,
} from "./widgets.js";

const formattingMark = Decoration.mark({ class: "cm-formatting" });

const CODE_NODE_RE = /^(FencedCode|CodeBlock|InlineCode|CodeText)$/;

function insideCode(state, pos) {
  for (
    let node = syntaxTree(state).resolveInner(pos, 1);
    node;
    node = node.parent
  ) {
    if (CODE_NODE_RE.test(node.name)) return true;
  }
  return false;
}

// Find single-line $...$ / $$...$$ spans in `text` (multi-line $$ blocks are
// the block layer's job). Returns absolute positions.
export function findInlineMath(text, baseOffset) {
  const out = [];
  const blockSpans = [];
  const blockRe = /\$\$([\s\S]+?)\$\$/g;
  let m;
  while ((m = blockRe.exec(text)) !== null) {
    blockSpans.push({ index: m.index, length: m[0].length });
    if (!m[1].includes("\n")) {
      out.push({
        from: baseOffset + m.index,
        to: baseOffset + m.index + m[0].length,
        source: m[1].trim(),
        display: true,
      });
    }
  }
  // Mask $$ spans so the inline pass can't match half a block delimiter.
  let masked = text;
  for (const b of blockSpans) {
    masked =
      masked.slice(0, b.index) +
      " ".repeat(b.length) +
      masked.slice(b.index + b.length);
  }
  // Pandoc-style: no space just inside either delimiter, so dollar amounts
  // ("$5 and $6") don't get eaten as math.
  const inlineRe = /\$(?!\s)([^$\n]*?[^$\s])\$/g;
  while ((m = inlineRe.exec(masked)) !== null) {
    out.push({
      from: baseOffset + m.index,
      to: baseOffset + m.index + m[0].length,
      source: m[1].trim(),
      display: false,
    });
  }
  out.sort((a, b) => a.from - b.from);
  return out;
}

export const inlinePlugin = ViewPlugin.fromClass(
  class {
    constructor(view) {
      this.build(view);
    }

    update(update) {
      if (update.docChanged || update.viewportChanged || update.selectionSet) {
        this.build(update.view);
      }
    }

    build(view) {
      const decos = [];
      const atomics = [];
      const state = view.state;
      const doc = state.doc;

      const touches = (from, to) => selectionTouches(state, from, to);
      const touchesLines = (from, to) => selectionTouchesLines(state, from, to);

      // Hide a marker when the selection is away; dim it when touching.
      const hideOrDim = (from, to, touched) => {
        if (from >= to) return;
        if (touched) {
          decos.push(formattingMark.range(from, to));
        } else {
          const d = Decoration.replace({}).range(from, to);
          decos.push(d);
          atomics.push(Decoration.replace({}).range(from, to));
        }
      };

      const replaceWith = (from, to, widget) => {
        const d = Decoration.replace({ widget }).range(from, to);
        decos.push(d);
        atomics.push(Decoration.replace({}).range(from, to));
      };

      const lineClass = (pos, cls) =>
        decos.push(
          Decoration.line({ attributes: { class: cls } }).range(
            doc.lineAt(pos).from,
          ),
        );

      const tree = syntaxTree(state);

      for (const { from: vFrom, to: vTo } of view.visibleRanges) {
        tree.iterate({
          from: vFrom,
          to: vTo,
          enter: (node) => {
            const name = node.name;

            // ─── Headings ───
            const atx = /^ATXHeading([1-6])$/.exec(name);
            if (atx) {
              lineClass(node.from, `cm-heading cm-h${atx[1]}`);
              return; // descend for HeaderMark
            }
            const setext = /^SetextHeading([12])$/.exec(name);
            if (setext) {
              lineClass(node.from, `cm-heading cm-h${setext[1]}`);
              return;
            }
            if (name === "HeaderMark") {
              const line = doc.lineAt(node.from);
              const touched = touchesLines(line.from, line.to);
              // ATX `#` marks own the following space; setext underlines are
              // a whole line of their own.
              let to = node.to;
              if (doc.sliceString(to, to + 1) === " ") to += 1;
              hideOrDim(node.from, to, touched);
              return;
            }

            // ─── Inline emphasis family ───
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
              const parent = node.node.parent;
              const touched = parent
                ? touches(parent.from, parent.to)
                : touches(node.from, node.to);
              hideOrDim(node.from, node.to, touched);
              return;
            }

            // ─── Inline code ───
            if (name === "InlineCode") {
              decos.push(
                Decoration.mark({ class: "cm-inline-code" }).range(
                  node.from,
                  node.to,
                ),
              );
              return; // descend for CodeMark
            }
            if (name === "CodeMark") {
              const parent = node.node.parent;
              if (parent && parent.name === "InlineCode") {
                hideOrDim(node.from, node.to, touches(parent.from, parent.to));
              }
              // Fenced-code marks are handled by the block layer's chrome.
              return;
            }

            // ─── Escapes: hide the backslash ───
            if (name === "Escape") {
              hideOrDim(
                node.from,
                node.from + 1,
                touches(node.from, node.to),
              );
              return;
            }

            // ─── Links ───
            if (name === "Link") {
              this.decorateLink(node.node, doc, touches, decos, atomics);
              return false; // handled all children
            }
            if (name === "URL" && node.node.parent?.name !== "Link") {
              // Bare autolinked URL — style it, keep the text.
              const url = doc.sliceString(node.from, node.to);
              decos.push(
                Decoration.mark({
                  class: "cm-link",
                  attributes: { "data-url": url, title: url },
                }).range(node.from, node.to),
              );
              return;
            }

            // ─── Inline images (whole-line ones render in the block layer) ───
            if (name === "Image") {
              const fromLine = doc.lineAt(node.from);
              const toLine = doc.lineAt(node.to);
              const wholeLine =
                fromLine.number === toLine.number &&
                doc.sliceString(fromLine.from, node.from).trim() === "" &&
                doc.sliceString(node.to, fromLine.to).trim() === "";
              if (wholeLine) return false; // block layer owns it
              if (touchesLines(node.from, node.to)) return false; // raw for editing
              const text = doc.sliceString(node.from, node.to);
              const m = /^!\[([^\]]*)\]\(([^)]*)\)/.exec(text);
              if (!m) return false;
              const { alt, width, align } = parseAlt(m[1]);
              replaceWith(
                node.from,
                node.to,
                new ImageWidget(m[2].trim(), alt, width, align, false),
              );
              return false;
            }

            // ─── Lists ───
            if (name === "ListMark") {
              const line = doc.lineAt(node.from);
              const touched = touchesLines(line.from, line.to);
              const markText = doc.sliceString(node.from, node.to);
              const isBullet = /^[-*+]$/.test(markText);
              const isTask = /^\s\[[ xX]\]/.test(
                doc.sliceString(node.to, node.to + 4),
              );
              if (isTask) {
                // Checkbox widget replaces `[ ]`; the list marker vanishes.
                if (!touched) hideOrDim(node.from, node.to + 1, false);
                return;
              }
              if (isBullet) {
                if (!touched) {
                  const depth = this.listDepth(node.node);
                  replaceWith(node.from, node.to, new BulletWidget(depth));
                }
                return;
              }
              // Ordered list numbers stay as text, just styled.
              decos.push(
                Decoration.mark({ class: "cm-list-mark" }).range(
                  node.from,
                  node.to,
                ),
              );
              return;
            }

            if (name === "TaskMarker") {
              const line = doc.lineAt(node.from);
              const touched = touchesLines(line.from, line.to);
              const checked = /\[[xX]\]/.test(
                doc.sliceString(node.from, node.to),
              );
              if (checked) {
                // Strike the task text (not the checkbox) once done.
                const textFrom = Math.min(node.to + 1, line.to);
                if (textFrom < line.to) {
                  decos.push(
                    Decoration.mark({ class: "cm-task-done" }).range(
                      textFrom,
                      line.to,
                    ),
                  );
                }
              }
              if (!touched) {
                let to = node.to;
                if (doc.sliceString(to, to + 1) === " ") to += 1;
                replaceWith(node.from, to, new CheckboxWidget(checked));
              }
              return;
            }

            // ─── Blockquotes ───
            if (name === "Blockquote") {
              const startLine = doc.lineAt(node.from);
              const endLine = doc.lineAt(node.to);
              for (let n = startLine.number; n <= endLine.number; n++) {
                decos.push(
                  Decoration.line({
                    attributes: { class: "cm-blockquote-line" },
                  }).range(doc.line(n).from),
                );
              }
              return;
            }
            if (name === "QuoteMark") {
              const line = doc.lineAt(node.from);
              let to = node.to;
              if (doc.sliceString(to, to + 1) === " ") to += 1;
              hideOrDim(node.from, to, touchesLines(line.from, line.to));
              return;
            }

            // ─── Code blocks: line chrome (fence widgets live in blocks.js) ───
            if (name === "FencedCode" || name === "CodeBlock") {
              const startLine = doc.lineAt(node.from);
              const endLine = doc.lineAt(node.to);
              for (let n = startLine.number; n <= endLine.number; n++) {
                let cls = "cm-codeblock-line";
                if (n === startLine.number) cls += " cm-codeblock-first";
                if (n === endLine.number) cls += " cm-codeblock-last";
                decos.push(
                  Decoration.line({ attributes: { class: cls } }).range(
                    doc.line(n).from,
                  ),
                );
              }
              return; // descend so nested language highlighting still applies
            }
          },
        });

        // ─── Inline KaTeX (regex — lang-markdown has no math syntax) ───
        const text = doc.sliceString(vFrom, vTo);
        for (const m of findInlineMath(text, vFrom)) {
          if (touches(m.from, m.to)) continue;
          if (insideCode(state, m.from)) continue;
          replaceWith(m.from, m.to, new MathWidget(m.source, m.display));
        }
      }

      this.decorations = Decoration.set(decos, true);
      this.atomics = RangeSet.of(atomics, true);
    }

    decorateLink(linkNode, doc, touches, decos, atomics) {
      const touched = touches(linkNode.from, linkNode.to);
      let url = "";
      for (let c = linkNode.firstChild; c; c = c.nextSibling) {
        if (c.name === "URL") url = doc.sliceString(c.from, c.to);
      }
      decos.push(
        Decoration.mark({
          class: "cm-link",
          attributes: { "data-url": url, title: url },
        }).range(linkNode.from, linkNode.to),
      );
      for (let c = linkNode.firstChild; c; c = c.nextSibling) {
        if (c.name === "LinkMark" || c.name === "URL" || c.name === "LinkTitle") {
          if (touched) {
            decos.push(formattingMark.range(c.from, c.to));
          } else {
            decos.push(Decoration.replace({}).range(c.from, c.to));
            atomics.push(Decoration.replace({}).range(c.from, c.to));
          }
        }
      }
    }

    listDepth(markNode) {
      let depth = 0;
      for (let n = markNode.parent; n; n = n.parent) {
        if (n.name === "BulletList" || n.name === "OrderedList") depth++;
      }
      return depth;
    }
  },
  {
    decorations: (v) => v.decorations,
    provide: (plugin) =>
      EditorView.atomicRanges.of((view) => {
        const inst = view.plugin(plugin);
        return inst ? inst.atomics : RangeSet.empty;
      }),
  },
);
