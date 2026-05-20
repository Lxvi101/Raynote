import { marked } from "marked";
import katex from "katex";

const HTML_ESCAPE = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

export function escapeHtml(str) {
  return String(str ?? "").replace(/[&<>"']/g, (ch) => HTML_ESCAPE[ch]);
}

// ─── LaTeX extension for marked ───
const latexBlock = {
  name: "latexBlock",
  level: "block",
  start(src) {
    return src.match(/\$\$/)?.index;
  },
  tokenizer(src) {
    const match = src.match(/^\$\$([\s\S]+?)\$\$/);
    if (match) {
      return { type: "latexBlock", raw: match[0], text: match[1].trim() };
    }
  },
  renderer(token) {
    try {
      const html = katex.renderToString(token.text, {
        displayMode: true,
        throwOnError: false,
        trust: true,
      });
      return `<div class="latex-widget">${html}</div>`;
    } catch {
      return `<div class="latex-widget latex-error">${escapeHtml(token.text)}</div>`;
    }
  },
};

const latexInline = {
  name: "latexInline",
  level: "inline",
  start(src) {
    return src.match(/\$/)?.index;
  },
  tokenizer(src) {
    const match = src.match(/^\$([^\$\n]+?)\$/);
    if (match) {
      return { type: "latexInline", raw: match[0], text: match[1].trim() };
    }
  },
  renderer(token) {
    try {
      return katex.renderToString(token.text, {
        displayMode: false,
        throwOnError: false,
        trust: true,
      });
    } catch {
      return `<code class="latex-error">${escapeHtml(token.text)}</code>`;
    }
  },
};

// ─── Custom image renderer (lazy asset loading + width + align) ───
// Format: ![alt|50%|right](src) - pipe-separated, defaults to 100% center
function parseImageAlt(raw) {
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

function imageAlignStyle(width, align) {
  const margin =
    align === "left"
      ? "0 auto 0 0"
      : align === "right"
        ? "0 0 0 auto"
        : "0 auto";
  return `width:${width};margin:${margin};display:block`;
}

const imageRenderer = {
  image(token) {
    const src = token.href || "";
    const { alt, width, align } = parseImageAlt(token.text || "");
    const style = imageAlignStyle(width, align);
    if (src.startsWith("asset:")) {
      const assetName = src.slice(6);
      return `<div class="lazy-image" data-asset="${escapeHtml(assetName)}" style="${style}">
        <div class="lazy-image-placeholder">
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none"><rect x="3" y="3" width="18" height="18" rx="3" stroke="currentColor" stroke-width="1.5"/><circle cx="9" cy="9" r="2" stroke="currentColor" stroke-width="1.5"/><path d="M3 16l5-5 4 4 3-3 6 6" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
          <span>${escapeHtml(alt) || escapeHtml(assetName)}</span>
        </div>
      </div>`;
    }
    const title = token.title ? ` title="${escapeHtml(token.title)}"` : "";
    return `<img src="${escapeHtml(src)}" alt="${escapeHtml(alt)}" style="${style}"${title} loading="lazy">`;
  },
};

// ─── Custom link renderer (asset file links + external links) ───
const assetLinkRenderer = {
  link(token) {
    const href = token.href || "";
    if (href.startsWith("asset:")) {
      const assetName = href.slice(6);
      const ext = assetName.split(".").pop().toLowerCase();
      let icon;
      if (ext === "pdf") {
        icon = `<svg width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="M4 1h6l4 4v9a2 2 0 01-2 2H4a2 2 0 01-2-2V3a2 2 0 012-2z" stroke="currentColor" stroke-width="1.3"/><path d="M10 1v4h4" stroke="currentColor" stroke-width="1.3"/></svg>`;
      } else if (/^(mp4|mov|webm|avi|mkv)$/.test(ext)) {
        icon = `<svg width="14" height="14" viewBox="0 0 16 16" fill="none"><rect x="1" y="3" width="14" height="10" rx="2" stroke="currentColor" stroke-width="1.3"/><path d="M6.5 6.5l3.5 2-3.5 2v-4z" fill="currentColor"/></svg>`;
      } else {
        icon = `<svg width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="M4 1h6l4 4v9a2 2 0 01-2 2H4a2 2 0 01-2-2V3a2 2 0 012-2z" stroke="currentColor" stroke-width="1.3"/><path d="M10 1v4h4" stroke="currentColor" stroke-width="1.3"/></svg>`;
      }
      const text = escapeHtml(token.text || assetName);
      return `<a class="asset-link" data-asset="${escapeHtml(assetName)}" href="#">${icon} ${text}</a>`;
    }
    // Render all other links with a data attribute so we can open them externally.
    const url = escapeHtml(href);
    const title = token.title ? ` title="${escapeHtml(token.title)}"` : "";
    const label = token.tokens
      ? this.parser.parseInline(token.tokens)
      : escapeHtml(token.text || href);
    return `<a class="external-link" href="#" data-url="${url}"${title}>${label}</a>`;
  },
};

// ─── Custom code block renderer (lazy highlighting) ───
const codeRenderer = {
  code(token) {
    const lang = token.lang || "";
    const displayLang = lang || "plain";
    const escaped = escapeHtml(token.text);
    // Render unhighlighted first; highlight lazily via IntersectionObserver.
    return `<div class="code-window" data-lang="${escapeHtml(lang)}" data-highlight="pending">
      <div class="code-window-titlebar">
        <div class="code-window-dots">
          <span class="dot dot-red"></span>
          <span class="dot dot-yellow" role="button" tabindex="0" title="Collapse"></span>
          <span class="dot dot-green"></span>
        </div>
        <span class="code-window-lang">${escapeHtml(displayLang)}</span>
        <button class="code-copy-btn" data-code="${escaped}" title="Copy code">
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
            <rect x="5" y="5" width="9" height="9" rx="1.5" stroke="currentColor" stroke-width="1.3"/>
            <path d="M11 5V3.5A1.5 1.5 0 009.5 2h-6A1.5 1.5 0 002 3.5v6A1.5 1.5 0 003.5 11H5" stroke="currentColor" stroke-width="1.3"/>
          </svg>
        </button>
      </div>
      <div class="code-window-body">
        <pre><code class="hljs">${escapeHtml(token.text)}</code></pre>
      </div>
    </div>`;
  },
  codespan(token) {
    return `<code class="inline-code" title="Click to copy">${escapeHtml(token.text)}</code>`;
  },
};

marked.use({ extensions: [latexBlock, latexInline] });
marked.use({
  renderer: { ...codeRenderer, ...imageRenderer, ...assetLinkRenderer },
});
marked.setOptions({
  breaks: true,
  gfm: true,
});

export function renderMarkdown(content) {
  return marked.parse(content);
}
