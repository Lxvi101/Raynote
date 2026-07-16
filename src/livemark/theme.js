// Visual system for the live markdown editor. Prose is proportional
// (matching #preview's typography), code is monospace. Colors reference the
// app's CSS variables so theme changes flow through automatically.

import { EditorView } from "@codemirror/view";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { tags as t } from "@lezer/highlight";

export const raynoteTheme = EditorView.theme(
  {
    "&": {
      height: "100%",
      backgroundColor: "transparent",
      color: "rgba(255, 255, 255, 0.82)",
      fontSize: "14px",
      fontFamily: "var(--font)",
    },
    ".cm-content": {
      padding: "28px 40px 48px",
      caretColor: "var(--accent)",
      lineHeight: "1.7",
    },
    ".cm-scroller": {
      overflow: "auto",
      scrollbarWidth: "none",
      fontFamily: "inherit",
    },
    ".cm-scroller::-webkit-scrollbar": { display: "none" },
    "&.cm-focused": { outline: "none" },
    ".cm-gutters": { display: "none" },
    ".cm-cursor, .cm-dropCursor": {
      borderLeftColor: "var(--accent)",
      borderLeftWidth: "2px",
    },
    "&.cm-focused .cm-selectionBackground, ::selection, .cm-selectionBackground":
      {
        background: "rgba(124, 111, 247, 0.25) !important",
      },
    ".cm-line": { padding: "0" },
    ".cm-placeholder": { color: "var(--text-dim)" },

    // ─── Revealed syntax markers ───
    ".cm-formatting": {
      color: "var(--text-dim)",
      opacity: "0.65",
    },

    // ─── Headings ───
    ".cm-heading": {
      letterSpacing: "-0.01em",
      color: "var(--text)",
      fontWeight: "600",
    },
    ".cm-h1": {
      fontSize: "26px",
      lineHeight: "1.3",
      letterSpacing: "-0.02em",
      padding: "14px 0 6px",
    },
    ".cm-h2": { fontSize: "20px", padding: "12px 0 4px" },
    ".cm-h3": { fontSize: "16px", padding: "8px 0 2px" },
    ".cm-h4": { fontSize: "14.5px", padding: "6px 0 2px" },
    ".cm-h5": { fontSize: "13.5px", padding: "4px 0 2px" },
    ".cm-h6": {
      fontSize: "13px",
      padding: "4px 0 2px",
      color: "var(--text-secondary)",
    },

    // ─── Inline prose ───
    ".cm-strong": { fontWeight: "600", color: "var(--text)" },
    ".cm-em": { fontStyle: "italic" },
    ".cm-strike": { textDecoration: "line-through", color: "var(--text-dim)" },
    ".cm-link": {
      color: "var(--accent)",
      textDecoration: "none",
      cursor: "pointer",
    },
    ".cm-link:hover": { textDecoration: "underline" },
    ".cm-inline-code": {
      fontFamily: "var(--font-mono)",
      fontSize: "12.5px",
      background: "var(--surface-active)",
      padding: "2px 6px",
      borderRadius: "4px",
      color: "var(--accent-red-bright)",
    },

    // ─── Lists ───
    ".cm-bullet": {
      color: "var(--text-dim)",
      fontWeight: "700",
    },
    ".cm-list-mark": { color: "var(--text-dim)" },
    ".cm-task-checkbox": {
      width: "15px",
      height: "15px",
      verticalAlign: "middle",
      accentColor: "var(--accent)",
      cursor: "pointer",
      margin: "0 6px 0 0",
      position: "relative",
      top: "-1px",
    },
    ".cm-task-done": {
      textDecoration: "line-through",
      color: "var(--text-dim)",
    },

    // ─── Blockquotes ───
    ".cm-blockquote-line": {
      borderLeft: "3px solid var(--accent)",
      paddingLeft: "12px",
      color: "var(--text-secondary)",
      background: "var(--surface)",
    },

    // ─── Code blocks ───
    ".cm-codeblock-line": {
      fontFamily: "var(--font-mono)",
      fontSize: "13px",
      lineHeight: "1.6",
      background: "#1c1e26",
      borderLeft: "1px solid rgba(255, 255, 255, 0.08)",
      borderRight: "1px solid rgba(255, 255, 255, 0.08)",
      padding: "0 14px",
    },
    // Vertical padding lives on the LINE classes, not the header widget —
    // the classes apply whether the fence is rendered (header/cap widget) or
    // revealed (raw ```), so entering/leaving the block never shifts layout.
    ".cm-codeblock-first": {
      position: "relative", // anchors the absolutely-positioned header
      borderTop: "1px solid rgba(255, 255, 255, 0.08)",
      borderRadius: "10px 10px 0 0",
      background: "rgba(255, 255, 255, 0.03)",
      marginTop: "6px",
      paddingTop: "5px",
      paddingBottom: "5px",
    },
    ".cm-codeblock-last": {
      borderBottom: "1px solid rgba(255, 255, 255, 0.08)",
      borderRadius: "0 0 10px 10px",
      marginBottom: "6px",
      paddingBottom: "4px",
    },
    // Absolutely positioned so the widget contributes NOTHING to the line
    // box — the fence line's height comes from the same text strut whether
    // it shows the raw ``` or this header, so toggling can't shift layout.
    ".cm-code-header": {
      position: "absolute",
      top: "0",
      bottom: "0",
      left: "14px",
      right: "14px",
      display: "flex",
      alignItems: "center",
      justifyContent: "space-between",
    },
    ".cm-code-lang": {
      fontSize: "11px",
      fontFamily: "var(--font-mono)",
      textTransform: "lowercase",
      letterSpacing: "0.04em",
      color: "rgba(255, 255, 255, 0.32)",
    },
    ".cm-code-copy": {
      display: "inline-flex",
      alignItems: "center",
      justifyContent: "center",
      width: "20px",
      height: "20px",
      padding: "0",
      background: "transparent",
      border: "none",
      borderRadius: "5px",
      color: "rgba(255, 255, 255, 0.35)",
      cursor: "pointer",
    },
    ".cm-code-copy:hover": {
      background: "rgba(255, 255, 255, 0.08)",
      color: "var(--text)",
    },
    ".cm-code-copy.copied": { color: "#28c840" },
    ".cm-code-cap": {
      display: "inline-block",
      height: "4px",
    },

    // ─── Horizontal rule ───
    ".cm-hr-widget": {
      height: "1px",
      background: "var(--border)",
      margin: "14px 0",
    },

    // ─── Images ───
    ".cm-image-widget": {
      display: "block",
      margin: "10px 0",
      borderRadius: "var(--radius)",
      overflow: "hidden",
    },
    "span.cm-image-widget": { display: "inline-block", margin: "4px 0" },
    ".cm-image-widget img": {
      display: "block",
      maxWidth: "100%",
      height: "auto",
      borderRadius: "var(--radius)",
    },
    ".cm-image-widget.placeholder": {
      padding: "24px 16px",
      background: "var(--surface)",
      border: "1px solid var(--border)",
      color: "var(--text-dim)",
      fontSize: "13px",
      textAlign: "center",
    },

    // ─── Math ───
    ".cm-katex-block": {
      display: "block",
      margin: "14px 0",
      padding: "20px 24px",
      background: "#ffffff",
      borderRadius: "10px",
      textAlign: "center",
      color: "#1a1a2e",
      overflowX: "auto",
    },
    ".cm-katex-block.error": {
      background: "transparent",
      color: "var(--danger)",
      fontFamily: "var(--font-mono)",
      fontSize: "13px",
      padding: "8px",
    },
    ".cm-katex-inline": { display: "inline" },
    ".cm-katex-inline.error": {
      color: "var(--danger)",
      fontFamily: "var(--font-mono)",
    },

    // ─── Tables ───
    ".cm-table-widget": {
      margin: "10px 0",
      overflowX: "auto",
    },
    ".cm-table-widget table": {
      borderCollapse: "collapse",
      fontSize: "13px",
      width: "100%",
    },
    ".cm-table-widget th, .cm-table-widget td": {
      border: "1px solid var(--border)",
      padding: "6px 12px",
      textAlign: "left",
      color: "rgba(255, 255, 255, 0.82)",
    },
    ".cm-table-widget th": {
      background: "rgba(255, 255, 255, 0.04)",
      fontWeight: "600",
      color: "var(--text)",
    },
    ".cm-table-widget tbody tr:hover": {
      background: "rgba(255, 255, 255, 0.03)",
    },
    ".cm-table-widget code": {
      fontFamily: "var(--font-mono)",
      fontSize: "12px",
      background: "var(--surface-active)",
      padding: "1px 5px",
      borderRadius: "4px",
      color: "var(--accent-red-bright)",
    },
    ".cm-table-link": { color: "var(--accent)" },
  },
  { dark: true },
);

// Syntax colors for code inside fenced blocks (One-Dark-ish, matching the
// app's dark glass look). Markdown structure itself is styled through
// decorations, so no heading/emphasis tags here.
const codeHighlight = HighlightStyle.define([
  { tag: [t.keyword, t.moduleKeyword, t.controlKeyword], color: "#c678dd" },
  { tag: [t.string, t.special(t.string), t.regexp], color: "#98c379" },
  { tag: [t.number, t.bool, t.atom, t.null], color: "#d19a66" },
  { tag: [t.comment, t.blockComment, t.lineComment], color: "#5c6370", fontStyle: "italic" },
  { tag: [t.function(t.variableName), t.function(t.propertyName)], color: "#61afef" },
  { tag: [t.typeName, t.className, t.namespace], color: "#e5c07b" },
  { tag: [t.operator, t.compareOperator, t.logicOperator], color: "#56b6c2" },
  { tag: [t.propertyName, t.attributeName], color: "#e06c75" },
  { tag: [t.definition(t.variableName), t.macroName], color: "#e06c75" },
  { tag: [t.meta, t.punctuation], color: "rgba(255, 255, 255, 0.45)" },
]);

export const raynoteHighlight = syntaxHighlighting(codeHighlight);
