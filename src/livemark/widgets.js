// All WidgetType implementations for the live markdown engine.
//
// Widgets are memoized through eq() so CM6 reuses DOM across rebuilds; DOM is
// only ever materialized for widgets inside the viewport, which keeps the
// full-document block layer cheap.

import { WidgetType } from "@codemirror/view";
import { syntaxTree } from "@codemirror/language";
import katex from "katex";
import { getAssetBlobUrl } from "../asset-cache.js";

/** Unwrap a CommonMark <destination> while preserving its literal filename. */
export function normalizeMarkdownDestination(raw) {
  const value = (raw || "").trim();
  if (value.startsWith("<") && value.endsWith(">")) {
    return value
      .slice(1, -1)
      .replace(/\\([\\<>])/g, "$1");
  }
  return value;
}

// ─── Clipboard (self-contained; widgets can't reach main.js helpers) ───
function copyText(text) {
  if (navigator.clipboard?.writeText) {
    return navigator.clipboard.writeText(text).catch(() => fallbackCopy(text));
  }
  return Promise.resolve(fallbackCopy(text));
}

function fallbackCopy(text) {
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.style.position = "fixed";
  ta.style.opacity = "0";
  document.body.appendChild(ta);
  ta.select();
  try {
    document.execCommand("copy");
  } finally {
    ta.remove();
  }
}

// ─── Task checkbox ───
export class CheckboxWidget extends WidgetType {
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
      // Look up the live position so doc shifts since render don't break it.
      const pos = view.posAtDOM(cb);
      if (pos == null) return;
      view.dispatch({
        changes: { from: pos + 1, to: pos + 2, insert: cb.checked ? "x" : " " },
        userEvent: "input",
      });
      e.stopPropagation();
    });
    return cb;
  }
}

// ─── List bullet ───
export class BulletWidget extends WidgetType {
  constructor(depth) {
    super();
    this.depth = depth;
  }
  eq(other) {
    return other.depth === this.depth;
  }
  toDOM() {
    const el = document.createElement("span");
    el.className = "cm-bullet";
    el.textContent = this.depth % 3 === 1 ? "◦" : this.depth % 3 === 2 ? "▪" : "•";
    return el;
  }
}

// ─── Horizontal rule ───
export class HRWidget extends WidgetType {
  eq() {
    return true;
  }
  get estimatedHeight() {
    return 25;
  }
  toDOM() {
    const el = document.createElement("div");
    el.className = "cm-hr-widget";
    return el;
  }
}

// ─── Images ───
// Parse `![alt|100%|center](src)` — pipe-separated size/align hints
// (matches the preview renderer's syntax).
export function parseAlt(raw) {
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
    align === "left" ? "0 auto 0 0" : align === "right" ? "0 0 0 auto" : "0 auto";
  return `width:${width};margin:${margin};display:block`;
}

export class ImageWidget extends WidgetType {
  constructor(src, alt, width, align, asBlock) {
    super();
    this.src = src;
    this.alt = alt;
    this.width = width;
    this.align = align;
    this.asBlock = asBlock;
  }
  eq(other) {
    return (
      other.src === this.src &&
      other.alt === this.alt &&
      other.width === this.width &&
      other.align === this.align &&
      other.asBlock === this.asBlock
    );
  }
  get estimatedHeight() {
    return this.asBlock ? 220 : -1;
  }
  toDOM() {
    const wrapper = document.createElement(this.asBlock ? "div" : "span");
    wrapper.className = "cm-image-widget placeholder";
    wrapper.style.cssText = alignStyle(this.width, this.align);
    wrapper.textContent = this.alt || this.src;

    const attach = (src) => {
      wrapper.classList.remove("placeholder");
      wrapper.textContent = "";
      const img = document.createElement("img");
      img.src = src;
      img.alt = this.alt || this.src;
      img.loading = "lazy";
      wrapper.appendChild(img);
    };

    if (this.src.startsWith("asset:")) {
      getAssetBlobUrl(this.src.slice(6))
        .then(attach)
        .catch(() => {
          wrapper.textContent = "Failed to load image";
        });
    } else {
      attach(this.src);
    }
    return wrapper;
  }
}

// ─── KaTeX math ───
// Memoized on source text. Rendering is deterministic, so entries are shared
// across notes safely; the cache is size-bounded instead of note-scoped.
const mathCache = new Map();
const MATH_CACHE_MAX = 300;

function renderKatex(source, displayMode) {
  const key = (displayMode ? "B:" : "I:") + source;
  if (mathCache.has(key)) return mathCache.get(key);
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
  if (mathCache.size >= MATH_CACHE_MAX) mathCache.clear();
  mathCache.set(key, html);
  return html;
}

export class MathWidget extends WidgetType {
  constructor(source, displayMode) {
    super();
    this.source = source;
    this.displayMode = displayMode;
  }
  eq(other) {
    return other.source === this.source && other.displayMode === this.displayMode;
  }
  get estimatedHeight() {
    return this.displayMode ? 80 : -1;
  }
  toDOM() {
    const el = document.createElement(this.displayMode ? "div" : "span");
    el.className = this.displayMode ? "cm-katex-block" : "cm-katex-inline";
    const html = renderKatex(this.source, this.displayMode);
    if (html === null) {
      el.classList.add("error");
      el.textContent = this.source;
    } else {
      el.innerHTML = html; // KaTeX output is trusted library HTML
    }
    return el;
  }
}

// ─── Fenced code chrome ───
// Replaces the opening ``` line with a header (language badge + copy button)
// and the closing ``` line with a bottom cap. The code text itself stays in
// the document, so CM's per-language highlighting keeps working.
export class CodeHeaderWidget extends WidgetType {
  constructor(lang) {
    super();
    this.lang = lang;
  }
  eq(other) {
    return other.lang === this.lang;
  }
  toDOM(view) {
    // In-flow empty inline anchor: keeps the line box at normal strut height
    // (identical to the raw ``` text this widget replaces) while the visible
    // header is absolutely positioned and contributes nothing to layout.
    const anchor = document.createElement("span");
    anchor.className = "cm-code-header-anchor";
    const el = document.createElement("span");
    el.className = "cm-code-header";
    anchor.appendChild(el);

    const label = document.createElement("span");
    label.className = "cm-code-lang";
    label.textContent = this.lang || "code";
    el.appendChild(label);

    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "cm-code-copy";
    btn.title = "Copy code";
    btn.innerHTML = `<svg width="13" height="13" viewBox="0 0 16 16" fill="none"><rect x="5" y="5" width="9" height="9" rx="1.5" stroke="currentColor" stroke-width="1.3"/><path d="M11 5V3.5A1.5 1.5 0 009.5 2h-6A1.5 1.5 0 002 3.5v6A1.5 1.5 0 003.5 11H5" stroke="currentColor" stroke-width="1.3"/></svg>`;
    btn.addEventListener("mousedown", (e) => e.preventDefault());
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const code = this.codeTextAt(view, view.posAtDOM(el));
      if (code == null) return;
      copyText(code);
      btn.classList.add("copied");
      setTimeout(() => btn.classList.remove("copied"), 1200);
    });
    el.appendChild(btn);
    return anchor;
  }
  // Resolve the enclosing FencedCode at click time so document shifts since
  // render can't make us copy stale text.
  codeTextAt(view, pos) {
    if (pos == null) return null;
    let node = syntaxTree(view.state).resolveInner(pos, 1);
    while (node && node.name !== "FencedCode") node = node.parent;
    if (!node) return null;
    const doc = view.state.doc;
    const first = doc.lineAt(node.from);
    const last = doc.lineAt(node.to);
    if (last.number <= first.number + 1) return "";
    return doc.sliceString(doc.line(first.number + 1).from, doc.line(last.number - 1).to);
  }
}

export class CodeCapWidget extends WidgetType {
  eq() {
    return true;
  }
  toDOM() {
    const el = document.createElement("span");
    el.className = "cm-code-cap";
    return el;
  }
}

// ─── Tables ───
// Renders a GFM table as real HTML while the selection is outside it.
// Clicking a row moves the cursor onto that row's source line, which reveals
// the raw markdown for editing.

// Minimal inline formatting for table cells. Built with DOM nodes (never
// innerHTML on user text) so output is inert by construction.
const CELL_TOKEN_RE =
  /(`[^`]+`)|(\*\*[^*]+\*\*|__[^_]+__)|(\*[^*\s][^*]*\*|_[^_\s][^_]*_)|(~~[^~]+~~)|(!?\[[^\]]*\]\(([^)\s]*)[^)]*\))/g;

function renderCellInto(el, text) {
  let last = 0;
  let m;
  CELL_TOKEN_RE.lastIndex = 0;
  while ((m = CELL_TOKEN_RE.exec(text)) !== null) {
    if (m.index > last) el.appendChild(document.createTextNode(text.slice(last, m.index)));
    const tok = m[0];
    let child;
    if (m[1]) {
      child = document.createElement("code");
      child.textContent = tok.slice(1, -1);
    } else if (m[2]) {
      child = document.createElement("strong");
      child.textContent = tok.slice(2, -2);
    } else if (m[3]) {
      child = document.createElement("em");
      child.textContent = tok.slice(1, -1);
    } else if (m[4]) {
      child = document.createElement("del");
      child.textContent = tok.slice(2, -2);
    } else {
      // Link / image — show the label, keep the URL as a tooltip.
      const label = /\[([^\]]*)\]/.exec(tok)?.[1] ?? tok;
      child = document.createElement("span");
      child.className = "cm-table-link";
      child.textContent = label || m[6] || "";
      if (m[6]) child.title = m[6];
    }
    el.appendChild(child);
    last = m.index + tok.length;
  }
  if (last < text.length) el.appendChild(document.createTextNode(text.slice(last)));
}

function splitRow(line) {
  // Strip leading/trailing pipes, split on unescaped pipes. Written as a
  // manual scan — a lookbehind regex would throw on Safari/WKWebView < 16.4,
  // which the safari16 build target still supports.
  const trimmed = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  const cells = [];
  let cur = "";
  for (let i = 0; i < trimmed.length; i++) {
    const ch = trimmed[i];
    if (ch === "\\" && trimmed[i + 1] === "|") {
      cur += "|";
      i++;
    } else if (ch === "|") {
      cells.push(cur.trim());
      cur = "";
    } else {
      cur += ch;
    }
  }
  cells.push(cur.trim());
  return cells;
}

function parseAligns(delimLine) {
  return splitRow(delimLine).map((c) => {
    const left = c.startsWith(":");
    const right = c.endsWith(":");
    if (left && right) return "center";
    if (right) return "right";
    if (left) return "left";
    return null;
  });
}

export class TableWidget extends WidgetType {
  constructor(source) {
    super();
    this.source = source;
  }
  eq(other) {
    return other.source === this.source;
  }
  get estimatedHeight() {
    return (this.source.split("\n").length + 1) * 30;
  }
  toDOM(view) {
    const wrap = document.createElement("div");
    wrap.className = "cm-table-widget";
    const lines = this.source.split("\n").filter((l) => l.trim() !== "");
    if (lines.length < 2) {
      wrap.textContent = this.source;
      return wrap;
    }
    const aligns = parseAligns(lines[1]);
    const table = document.createElement("table");

    const makeRow = (line, cellTag, sourceLineIdx) => {
      const tr = document.createElement("tr");
      tr.dataset.line = String(sourceLineIdx);
      for (const [i, cell] of splitRow(line).entries()) {
        const td = document.createElement(cellTag);
        if (aligns[i]) td.style.textAlign = aligns[i];
        renderCellInto(td, cell);
        tr.appendChild(td);
      }
      return tr;
    };

    const thead = document.createElement("thead");
    thead.appendChild(makeRow(lines[0], "th", 0));
    table.appendChild(thead);

    const tbody = document.createElement("tbody");
    for (let i = 2; i < lines.length; i++) {
      tbody.appendChild(makeRow(lines[i], "td", i));
    }
    table.appendChild(tbody);
    wrap.appendChild(table);

    // Click a row → cursor onto that row's source line (reveals raw table).
    wrap.addEventListener("mousedown", (e) => e.preventDefault());
    wrap.addEventListener("click", (e) => {
      const base = view.posAtDOM(wrap);
      if (base == null) return;
      const row = e.target.closest("tr");
      const lineOffset = row ? Number(row.dataset.line) || 0 : 0;
      const doc = view.state.doc;
      const baseLine = doc.lineAt(base);
      const target = doc.line(
        Math.min(baseLine.number + lineOffset, doc.lines),
      );
      view.dispatch({ selection: { anchor: target.to } });
      view.focus();
    });
    return wrap;
  }
}
