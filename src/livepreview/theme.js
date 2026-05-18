import { EditorView } from "@codemirror/view";

// CM6 theme matching Raynote's existing dark/glow look. Colors deliberately
// reference CSS variables so a future light theme would Just Work.
export const raynoteTheme = EditorView.theme(
  {
    "&": {
      height: "100%",
      backgroundColor: "transparent",
      color: "var(--text)",
      fontSize: "13.5px",
      fontFamily: "var(--font-mono)",
    },
    ".cm-content": {
      padding: "28px 40px",
      caretColor: "var(--accent)",
      lineHeight: "1.75",
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
    ".cm-line": {
      padding: "0",
    },
    // ─── Live preview decoration classes ───
    ".cm-heading": {
      letterSpacing: "-0.01em",
      color: "var(--text)",
    },
    ".cm-h1": { fontSize: "26px", fontWeight: "600", lineHeight: "1.3" },
    ".cm-h2": { fontSize: "20px", fontWeight: "600" },
    ".cm-h3": { fontSize: "16px", fontWeight: "600" },
    ".cm-h4": { fontSize: "14.5px", fontWeight: "600" },
    ".cm-h5": { fontSize: "13.5px", fontWeight: "600" },
    ".cm-h6": { fontSize: "13px", fontWeight: "600", color: "var(--text-secondary)" },
    ".cm-strong": { fontWeight: "600", color: "var(--text)" },
    ".cm-em": { fontStyle: "italic" },
    ".cm-strike": { textDecoration: "line-through", color: "var(--text-dim)" },
    ".cm-inline-code": {
      fontFamily: "var(--font-mono)",
      fontSize: "12.5px",
      background: "var(--surface-active)",
      padding: "2px 6px",
      borderRadius: "4px",
      color: "#c4b5fd",
    },
    ".cm-fenced-code-line": {
      fontFamily: "var(--font-mono)",
      background: "rgba(0, 0, 0, 0.25)",
      fontSize: "13px",
    },
    ".cm-blockquote-line": {
      borderLeft: "3px solid var(--accent)",
      paddingLeft: "12px",
      color: "var(--text-secondary)",
    },
    ".cm-link": {
      color: "var(--accent)",
      textDecoration: "none",
    },
    ".cm-task-checkbox": {
      width: "16px",
      height: "16px",
      verticalAlign: "middle",
      accentColor: "var(--accent)",
      cursor: "pointer",
      margin: "0 8px 0 0",
      position: "relative",
      top: "-1px",
    },
    ".cm-hr-widget": {
      display: "block",
      height: "1px",
      background: "var(--border)",
      margin: "12px 0",
    },
    ".cm-image-widget": {
      display: "block",
      margin: "16px 0",
      borderRadius: "var(--radius)",
      overflow: "hidden",
    },
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
    ".cm-katex-block": {
      display: "block",
      margin: "16px 0",
      padding: "20px 24px",
      background: "#ffffff",
      borderRadius: "10px",
      textAlign: "center",
      color: "#1a1a2e",
    },
    ".cm-katex-block.error": {
      background: "transparent",
      color: "var(--danger)",
      fontFamily: "var(--font-mono)",
      fontSize: "13px",
      padding: "8px",
    },
    ".cm-katex-inline": {
      display: "inline",
    },
    ".cm-katex-inline.error": {
      color: "var(--danger)",
      fontFamily: "var(--font-mono)",
    },
  },
  { dark: true },
);
