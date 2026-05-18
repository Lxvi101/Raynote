import { ViewPlugin, Decoration, EditorView, WidgetType } from "@codemirror/view";
import { syntaxTree } from "@codemirror/language";
import { RangeSet } from "@codemirror/state";
import { getAssetBlobUrl } from "../asset-cache.js";

// Parse `![alt|100%|center](src)` — pipe-separated size/align hints.
function parseAlt(raw) {
  const parts = (raw || "").split("|").map((s) => s.trim());
  const alt = parts[0];
  let width = "100%";
  let align = "center";
  for (let i = 1; i < parts.length; i++) {
    const p = parts[i];
    if (/^\d+%$/.test(p)) width = p;
    else if (/^(left|center|right)$/i.test(p)) align = p.toLowerCase();
  }
  return { alt, width, align };
}

function alignStyle(width, align) {
  const margin =
    align === "left"
      ? "0 auto 0 0"
      : align === "right"
        ? "0 0 0 auto"
        : "0 auto";
  return `width:${width};margin:${margin};display:block`;
}

class ImageWidget extends WidgetType {
  constructor(src, alt, width, align, asBlock) {
    super();
    this.src = src;
    this.alt = alt;
    this.width = width;
    this.align = align;
    this.asBlock = asBlock;
  }
  eq(other) {
    // Equality on src is what avoids thrashing — alt/width/align changes
    // re-render via a different widget instance anyway.
    return (
      other.src === this.src &&
      other.alt === this.alt &&
      other.width === this.width &&
      other.align === this.align &&
      other.asBlock === this.asBlock
    );
  }
  toDOM() {
    const wrapper = document.createElement(this.asBlock ? "div" : "span");
    wrapper.className = "cm-image-widget placeholder";
    wrapper.style.cssText = alignStyle(this.width, this.align);
    wrapper.textContent = this.alt || this.src;

    if (this.src.startsWith("asset:")) {
      const assetName = this.src.slice(6);
      getAssetBlobUrl(assetName)
        .then((blobUrl) => {
          wrapper.classList.remove("placeholder");
          wrapper.textContent = "";
          const img = document.createElement("img");
          img.src = blobUrl;
          img.alt = this.alt || assetName;
          wrapper.appendChild(img);
        })
        .catch(() => {
          wrapper.textContent = "Failed to load image";
        });
    } else {
      // Plain http(s) URL — let the browser fetch it directly.
      wrapper.classList.remove("placeholder");
      wrapper.textContent = "";
      const img = document.createElement("img");
      img.src = this.src;
      img.alt = this.alt;
      img.loading = "lazy";
      wrapper.appendChild(img);
    }
    return wrapper;
  }
}

// Replaces `![alt](src)` with an image widget when the cursor isn't on the
// same line. When the cursor IS on the line we leave the raw markdown so
// the user can edit it.
export function imagePlugin() {
  return ViewPlugin.fromClass(
    class {
      constructor(view) {
        this.decorations = this.build(view);
      }
      update(update) {
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

        const tree = syntaxTree(view.state);

        for (const { from: vFrom, to: vTo } of view.visibleRanges) {
          tree.iterate({
            from: vFrom,
            to: vTo,
            enter: (node) => {
              if (node.name !== "Image") return;
              const lineFrom = doc.lineAt(node.from).number;
              const lineTo = doc.lineAt(node.to).number;
              // If cursor is on any line spanned by the image syntax, leave it raw.
              if (cursorLineTo >= lineFrom && cursorLineFrom <= lineTo) return;

              // Extract alt and url from the children.
              let altText = "";
              let url = "";
              const child = node.node.firstChild;
              for (let c = child; c; c = c.nextSibling) {
                if (c.name === "URL") {
                  url = doc.sliceString(c.from, c.to);
                }
              }
              // The link label is between the first `[` (LinkMark, after `!`)
              // and the closing `]`. The Image node contains LinkMark nodes —
              // walk to find the text region.
              const text = doc.sliceString(node.from, node.to);
              const m = /^!\[([^\]]*)\]\(([^)]*)\)/.exec(text);
              if (m) {
                altText = m[1];
                if (!url) url = m[2];
              }
              const { alt, width, align } = parseAlt(altText);
              const fromLine = doc.lineAt(node.from);
              const toLine = doc.lineAt(node.to);
              const wholeLines =
                node.from === fromLine.from && node.to === toLine.to;
              // CM6 forbids block:true from ViewPlugins. Inline replace works
              // here — the wrapper element uses display:block via CSS so a
              // whole-line image still renders as a block.
              decos.push(
                Decoration.replace({
                  widget: new ImageWidget(url, alt, width, align, wholeLines),
                }).range(node.from, node.to),
              );
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
}
