import { renderMarkdown } from "./markdown-preview.js";

self.addEventListener("message", (event) => {
  const { id, content } = event.data || {};
  try {
    const html = renderMarkdown(content || "");
    self.postMessage({ id, ok: true, html });
  } catch (err) {
    self.postMessage({
      id,
      ok: false,
      error: err && err.message ? err.message : String(err),
    });
  }
});
