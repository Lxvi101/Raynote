import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { listen } from "@tauri-apps/api/event";
import { open as shellOpen } from "@tauri-apps/plugin-shell";
import { marked } from "marked";
import hljs from "highlight.js";
import "highlight.js/styles/github-dark-dimmed.min.css";
import katex from "katex";
import "katex/dist/katex.min.css";
import { editor, TextareaBackend } from "./editor-adapter.js";
import { loadAssetImage } from "./asset-cache.js";
import "./style.css";

// ─── Auto-title generation ───
const AUTO_TITLE_PLACEHOLDER = "{{auto_generate}}";
const STORAGE_AI_API_KEY = "raynote-ai-api-key";
const STORAGE_AI_MODEL = "raynote-ai-model";
const STORAGE_AI_BASE_URL = "raynote-ai-base-url";
const STORAGE_NEW_NOTE_TITLE_MODE = "raynote-new-note-title-mode";

const DEFAULT_AI_MODEL = "openai/gpt-oss-20b";
const DEFAULT_AI_BASE_URL = "https://openrouter.ai/api/v1";

/** New-note title behavior: "auto" | "manual" | "empty". */
const TITLE_MODE_AUTO = "auto";
const TITLE_MODE_MANUAL = "manual";
const TITLE_MODE_EMPTY = "empty";
const DEFAULT_NEW_NOTE_TITLE_MODE = TITLE_MODE_AUTO;

function getAISettings() {
  return {
    apiKey: localStorage.getItem(STORAGE_AI_API_KEY) || "",
    model: localStorage.getItem(STORAGE_AI_MODEL) || DEFAULT_AI_MODEL,
    baseUrl: localStorage.getItem(STORAGE_AI_BASE_URL) || DEFAULT_AI_BASE_URL,
  };
}

function getNewNoteTitleMode() {
  const v = localStorage.getItem(STORAGE_NEW_NOTE_TITLE_MODE);
  if (v === TITLE_MODE_AUTO || v === TITLE_MODE_MANUAL || v === TITLE_MODE_EMPTY) {
    return v;
  }
  return DEFAULT_NEW_NOTE_TITLE_MODE;
}

// ─── Edge glow ───
// The slow-sweeping red rim + inner glow on #app. CSS does the heavy
// lifting; this just persists user preferences and pushes them into
// CSS custom properties / root-level classes.
const STORAGE_GLOW_ENABLED = "raynote-glow-enabled";
const STORAGE_GLOW_STATIC = "raynote-glow-static";
const STORAGE_GLOW_WIDTH = "raynote-glow-width";
const STORAGE_GLOW_SIZE = "raynote-glow-size";
const STORAGE_GLOW_INTENSITY = "raynote-glow-intensity";

// Defaults are tuned for a calm, ambient look out of the box: a static
// glow pinned at the top, with a thin rim and a small inner bleed.
const DEFAULT_GLOW_STATIC = true;   // frozen at the top by default
const DEFAULT_GLOW_WIDTH = 15;      // 0–100; 15 → ~0.9px rim (thin)
const DEFAULT_GLOW_SIZE = 10;       // 0–100; 10 → tight edge-only inner glow
const DEFAULT_GLOW_INTENSITY = 100; // 0–100; 100 = full alpha as authored in CSS

function getGlowSettings() {
  const enabledRaw = localStorage.getItem(STORAGE_GLOW_ENABLED);
  const staticRaw = localStorage.getItem(STORAGE_GLOW_STATIC);
  const widthRaw = Number(localStorage.getItem(STORAGE_GLOW_WIDTH));
  const sizeRaw = Number(localStorage.getItem(STORAGE_GLOW_SIZE));
  const intensityRaw = Number(localStorage.getItem(STORAGE_GLOW_INTENSITY));
  return {
    enabled: enabledRaw === null ? true : enabledRaw === "1",
    static: staticRaw === null ? DEFAULT_GLOW_STATIC : staticRaw === "1",
    width: Number.isFinite(widthRaw) ? widthRaw : DEFAULT_GLOW_WIDTH,
    size: Number.isFinite(sizeRaw) ? sizeRaw : DEFAULT_GLOW_SIZE,
    intensity: Number.isFinite(intensityRaw) ? intensityRaw : DEFAULT_GLOW_INTENSITY,
  };
}

/** Push edge-glow prefs into the document. Safe to call repeatedly — used
 *  on startup and on every control change so updates feel instant. */
function applyGlowSettings(settings = getGlowSettings()) {
  const root = document.documentElement;
  root.classList.toggle("glow-disabled", !settings.enabled);
  root.classList.toggle("glow-static", settings.static);

  // Width 0–100 → 0–6 px rim thickness. 25 → 1.5px (the original).
  const width = Math.max(0, Math.min(100, settings.width));
  const widthPx = (width / 100) * 6;
  root.style.setProperty("--glow-rim-width", `${widthPx}px`);

  // Size 0–100 → mask stops. At size = 50 the stops match the pre-settings
  // visual (inner 30%, outer 70%). Bigger size pulls both stops toward the
  // center, so the glow extends further inward; smaller size compresses
  // them against the perimeter for a thin edge-only ring.
  const size = Math.max(0, Math.min(100, settings.size));
  const innerStop = 60 - 0.6 * size;              // 60% → 0%
  const outerStop = Math.min(95, innerStop + 40); // 40-percentage-point ramp width
  root.style.setProperty("--glow-stop-inner", `${innerStop}%`);
  root.style.setProperty("--glow-stop-outer", `${outerStop}%`);

  // Intensity 0–100 → opacity multiplier 0–1 on both layers.
  const intensity = Math.max(0, Math.min(100, settings.intensity)) / 100;
  root.style.setProperty("--glow-intensity", String(intensity));
}

// ─── Global (system-wide) shortcuts ───
// Two roles, each customizable:
//   - "capture": brings the window to front and emits "quick-capture"
//   - "toggle":  shows/hides the main window depending on visibility/focus
// Stored as Tauri accelerator strings (e.g. "Ctrl+Cmd+Alt+Shift+KeyN") in
// localStorage and re-applied on every app start.
const GS_ROLE_CAPTURE = "capture";
const GS_ROLE_TOGGLE = "toggle";
const STORAGE_GS_CAPTURE = "raynote-global-shortcut-capture";
const STORAGE_GS_TOGGLE = "raynote-global-shortcut-toggle";
const DEFAULT_GS_CAPTURE = "Ctrl+Cmd+Alt+Shift+KeyN";
const DEFAULT_GS_TOGGLE = "Ctrl+Cmd+Alt+Shift+KeyM";

function getGlobalShortcutAccelerator(role) {
  const key = role === GS_ROLE_CAPTURE ? STORAGE_GS_CAPTURE : STORAGE_GS_TOGGLE;
  const fallback =
    role === GS_ROLE_CAPTURE ? DEFAULT_GS_CAPTURE : DEFAULT_GS_TOGGLE;
  return localStorage.getItem(key) || fallback;
}

function setGlobalShortcutAccelerator(role, accelerator) {
  const key = role === GS_ROLE_CAPTURE ? STORAGE_GS_CAPTURE : STORAGE_GS_TOGGLE;
  const fallback =
    role === GS_ROLE_CAPTURE ? DEFAULT_GS_CAPTURE : DEFAULT_GS_TOGGLE;
  if (accelerator === fallback) {
    localStorage.removeItem(key);
  } else {
    localStorage.setItem(key, accelerator);
  }
}

/** Convert a KeyboardEvent into an accelerator string the Rust side understands. */
function eventToAccelerator(e) {
  const parts = [];
  if (e.ctrlKey) parts.push("Ctrl");
  if (e.metaKey) parts.push("Cmd");
  if (e.altKey) parts.push("Alt");
  if (e.shiftKey) parts.push("Shift");
  // KeyboardEvent.code gives stable codes ("KeyN", "Digit1", "F1", "Space", …)
  // which is exactly what the global-shortcut plugin's parser accepts.
  parts.push(e.code);
  return parts.join("+");
}

/** Translate an accelerator string into pretty key labels for display. */
function acceleratorToParts(accel) {
  return accel.split("+").map((p) => {
    if (p === "Ctrl" || p === "Control") return "⌃";
    if (p === "Cmd" || p === "Command" || p === "Meta" || p === "Super") return "⌘";
    if (p === "Alt" || p === "Option") return "⌥";
    if (p === "Shift") return "⇧";
    if (p.startsWith("Key")) return p.slice(3); // "KeyN" → "N"
    if (p.startsWith("Digit")) return p.slice(5); // "Digit1" → "1"
    if (p === "Space") return "Space";
    if (p === "Enter") return "↵";
    if (p === "Backspace") return "⌫";
    if (p === "Escape") return "Esc";
    if (p === "Tab") return "⇥";
    return p;
  });
}

/** True if the event represents a usable shortcut combination. */
function isAcceleratorComplete(e) {
  // Bare modifier presses produce no useful accelerator on their own.
  if (["Meta", "Control", "Alt", "Shift"].includes(e.key)) return false;
  // Refuse a key with no modifiers — global shortcuts must be modified.
  return e.ctrlKey || e.metaKey || e.altKey || e.shiftKey;
}

/** Apply the user's saved global shortcuts (or defaults) by calling the Rust command. */
async function applyGlobalShortcuts() {
  for (const role of [GS_ROLE_CAPTURE, GS_ROLE_TOGGLE]) {
    const accelerator = getGlobalShortcutAccelerator(role);
    try {
      await invoke("set_global_shortcut", { role, accelerator });
    } catch (err) {
      // Don't block startup — log so dev sees it; user can pick a new combo.
      console.warn(`Global shortcut "${role}" (${accelerator}) failed:`, err);
    }
  }
}

function hasAutoTitlePlaceholder(content) {
  const firstLine = (content || "").split("\n")[0];
  return firstLine.includes(AUTO_TITLE_PLACEHOLDER);
}

/** Note IDs currently being title-generated — prevents duplicate in-flight requests. */
const titleGenerationsInFlight = new Set();

/**
 * Generate a title for a note using the configured AI provider.
 * Runs in the background — replaces the {{auto_generate}} placeholder
 * in the saved file and updates the sidebar / titlebar.
 */
async function autoGenerateTitle(noteId, content) {
  if (titleGenerationsInFlight.has(noteId)) return;

  const ai = getAISettings();
  if (!ai.apiKey) return;

  const bodyContent = content.split("\n").slice(1).join("\n").trim();
  if (!bodyContent) return;

  titleGenerationsInFlight.add(noteId);
  try {
    const res = await fetch(`${ai.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${ai.apiKey}`,
        "HTTP-Referer": "https://raynote.app",
        "X-Title": "Raynote",
      },
      body: JSON.stringify({
        model: ai.model,
        messages: [
          {
            role: "system",
            content:
              "Generate a short, descriptive title (3-8 words) for the following note. " +
              "Respond with ONLY the title text — no quotes, no markdown, no punctuation at the end.",
          },
          { role: "user", content: bodyContent.slice(0, 2000) },
        ],
        max_tokens: 512,
      }),
    });

    if (!res.ok) return;

    const data = await res.json();
    const title = (data.choices?.[0]?.message?.content || "").trim();
    if (!title) return;

    // Replace placeholder in the file content
    const updatedContent = content.replace(
      new RegExp(`#\\s*${AUTO_TITLE_PLACEHOLDER.replace(/[{}]/g, "\\$&")}`),
      `# ${title}`,
    );

    // Persist to disk
    await invoke("save_note", { id: noteId, content: updatedContent });

    // If user is currently viewing this note, update the editor too
    if (state.currentId === noteId) {
      const pos = editor.getSelection().start;
      editor.setText(updatedContent);
      editor.setSelection(pos, pos);
      invalidatePreviewCache(noteId);
    }

    // Update sidebar metadata
    const idx = state.notes.findIndex((n) => n.id === noteId);
    if (idx >= 0) {
      state.notes[idx].title = title;
      renderNoteList(state.searchQuery);
      updateTitle();
    }
  } catch (_) {
    // Silently fail — user can always rename manually
  } finally {
    titleGenerationsInFlight.delete(noteId);
  }
}

const urlParams = new URLSearchParams(window.location.search);
const isSticky = urlParams.get("sticky") === "1";
const stickyNoteId = urlParams.get("id");
if (isSticky) {
  document.documentElement.classList.add("sticky-mode");
}

// Apply persisted edge-glow prefs as early as possible so the rim renders
// in its configured state on first paint instead of flashing the default.
applyGlowSettings();

/** Fade out and remove the inline splash from index.html. Idempotent. */
function hideSplash() {
  const splash = document.getElementById("splash");
  if (!splash || splash.classList.contains("hidden")) return;
  splash.classList.add("hidden");
  setTimeout(() => splash.remove(), 300);
}

/** Main window hides; sticky windows are destroyed so they do not respawn on global shortcuts. */
function closeCurrentWindow() {
  if (isSticky) {
    getCurrentWindow().close();
  } else {
    getCurrentWindow().hide();
  }
}

/** Subtle dark glass tints (gradient stops on #app); kept low-chroma for readability. */
const STICKY_TINT_PRESETS = [
  {
    id: "mist",
    label: "Mist",
    c1: "rgba(20, 22, 28, 0.92)",
    c2: "rgba(15, 17, 22, 0.90)",
  },
  {
    id: "lavender",
    label: "Lavender",
    c1: "rgba(24, 21, 30, 0.92)",
    c2: "rgba(17, 16, 24, 0.90)",
  },
  {
    id: "rose",
    label: "Rose",
    c1: "rgba(28, 20, 23, 0.92)",
    c2: "rgba(21, 17, 19, 0.90)",
  },
  {
    id: "clay",
    label: "Clay",
    c1: "rgba(28, 22, 19, 0.92)",
    c2: "rgba(22, 18, 16, 0.90)",
  },
  {
    id: "mint",
    label: "Mint",
    c1: "rgba(18, 24, 22, 0.92)",
    c2: "rgba(15, 20, 19, 0.90)",
  },
  {
    id: "olive",
    label: "Olive",
    c1: "rgba(24, 25, 19, 0.92)",
    c2: "rgba(19, 20, 16, 0.90)",
  },
  {
    id: "sky",
    label: "Sky",
    c1: "rgba(18, 22, 30, 0.92)",
    c2: "rgba(15, 18, 24, 0.90)",
  },
];

const STICKY_TINT_LEGACY = { peach: "clay", butter: "olive" };

function stickyTintIdFromStorage(raw) {
  if (!raw) return null;
  const id = STICKY_TINT_LEGACY[raw] || raw;
  return STICKY_TINT_PRESETS.some((p) => p.id === id) ? id : null;
}

// ─── Utilities (hoisted for use in extensions) ───
function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
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
// Format: ![alt|50%|right](src) — pipe-separated, defaults to 100% center
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
    // Render all other links with a data attribute so we can open them externally
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
    const escaped = escapeHtml(token.text).replace(/"/g, "&quot;");
    // Render unhighlighted first; highlight lazily via IntersectionObserver
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

// ─── Configure marked ───
marked.use({ extensions: [latexBlock, latexInline] });
marked.use({
  renderer: { ...codeRenderer, ...imageRenderer, ...assetLinkRenderer },
});
marked.setOptions({
  breaks: true,
  gfm: true,
});

// ─── Shortcuts system ───
const defaultShortcuts = {
  newNote: { label: "New Note", key: "n", meta: true },
  newSticky: {
    label: "Open Sticky (this note)",
    key: "n",
    meta: true,
    shift: true,
  },
  deleteNote: {
    label: "Delete Note",
    key: "Backspace",
    meta: true,
    shift: true,
  },
  toggleEdit: { label: "Toggle Edit/Preview", key: "e", meta: true },
  toggleLive: { label: "Toggle Live Preview", key: "l", meta: true, shift: true },
  toggleSidebar: { label: "Toggle Sidebar", key: "s", meta: true, shift: true },
  save: { label: "Save Note", key: "s", meta: true },
  closeWindow: { label: "Close Window", key: "w", meta: true },
  openPalette: { label: "Search Notes", key: "k", meta: true },
  commandPalette: {
    label: "Command Palette",
    key: "p",
    meta: true,
    shift: true,
  },
  pinWindow: { label: "Pin Window on Top", key: "t", meta: true, shift: true },
  copyNote: {
    label: "Copy Note as Markdown",
    key: "c",
    meta: true,
    shift: true,
  },
  undoDelete: { label: "Undo Delete Note", key: "z", meta: true, shift: true },
  redoDelete: {
    label: "Redo Delete Note",
    key: "z",
    meta: true,
    shift: true,
    alt: true,
  },
  viewTrash: { label: "View Trash", key: "Backspace", meta: true, alt: true },
  pinNote: { label: "Pin/Unpin Note", key: "p", meta: true, alt: true },
  settings: { label: "Settings", key: ",", meta: true },
};

function loadShortcuts() {
  try {
    const saved = JSON.parse(
      localStorage.getItem("raynote-shortcuts") || "{}",
    );
    return { ...structuredClone(defaultShortcuts), ...saved };
  } catch {
    return structuredClone(defaultShortcuts);
  }
}

function saveShortcuts(shortcuts) {
  const toSave = {};
  for (const [id, sc] of Object.entries(shortcuts)) {
    const def = defaultShortcuts[id];
    if (
      def &&
      (sc.key !== def.key ||
        !!sc.meta !== !!def.meta ||
        !!sc.shift !== !!def.shift ||
        !!sc.alt !== !!def.alt)
    ) {
      toSave[id] = {
        label: sc.label,
        key: sc.key,
        meta: !!sc.meta,
        shift: !!sc.shift,
        alt: !!sc.alt,
      };
    }
  }
  localStorage.setItem("raynote-shortcuts", JSON.stringify(toSave));
}

function formatShortcut(sc) {
  const parts = [];
  if (sc.meta) parts.push("Cmd");
  if (sc.alt) parts.push("Alt");
  if (sc.shift) parts.push("Shift");
  const keyName =
    sc.key === " "
      ? "Space"
      : sc.key === ","
        ? ","
        : sc.key.length === 1
          ? sc.key.toUpperCase()
          : sc.key;
  parts.push(keyName);
  return parts.join("+");
}

function matchesShortcut(e, sc) {
  const meta = e.metaKey || e.ctrlKey;
  if (!!sc.meta !== meta) return false;
  if (!!sc.shift !== e.shiftKey) return false;
  if (!!sc.alt !== e.altKey) return false;
  return e.key.toLowerCase() === sc.key.toLowerCase() || e.key === sc.key;
}

// ─── Pagination constants ───
const PAGE_SIZE = 50;

// ─── Pinned notes ───
function loadPinnedNotes() {
  try {
    return new Set(
      JSON.parse(localStorage.getItem("raynote-pinned-notes") || "[]"),
    );
  } catch {
    return new Set();
  }
}

function savePinnedNotes(pinnedSet) {
  localStorage.setItem("raynote-pinned-notes", JSON.stringify([...pinnedSet]));
}

function toggleNotePin(id) {
  if (state.pinnedNotes.has(id)) {
    state.pinnedNotes.delete(id);
  } else {
    state.pinnedNotes.add(id);
  }
  savePinnedNotes(state.pinnedNotes);
  renderNoteList(state.searchQuery);
}

function isNotePinned(id) {
  return state.pinnedNotes.has(id);
}

// ─── State ───
const state = {
  notes: [],
  totalNotes: 0,
  notesOffset: 0,
  loadingMore: false,
  searchQuery: "",
  pinnedNotes: loadPinnedNotes(),
  currentId: null,
  mode: "preview", // 'preview' | 'edit' | 'live'
  sidebarOpen: true,
  pinned: false,
  dirty: false,
  paletteMode: null, // null | 'notes' | 'commands'
  selectedPaletteIndex: 0,
  settingsOpen: false,
  recordingShortcut: null, // shortcut id being recorded
  recordingGlobalShortcut: null, // global shortcut role being recorded ("capture" | "toggle")
  shortcuts: loadShortcuts(),
};

// ─── Preview HTML cache ───
const previewCache = new Map(); // Map<noteId, { html: string, content: string }>
const PREVIEW_CACHE_MAX = 60;
let renderGeneration = 0; // monotonically increasing; guards against race conditions

function cachePreviewHtml(noteId, content, html) {
  // Evict oldest entry if at capacity (simple LRU via insertion order)
  if (previewCache.size >= PREVIEW_CACHE_MAX && !previewCache.has(noteId)) {
    const firstKey = previewCache.keys().next().value;
    previewCache.delete(firstKey);
  }
  previewCache.set(noteId, { html, content });
}

function getCachedPreviewHtml(noteId, content) {
  const entry = previewCache.get(noteId);
  if (entry && entry.content === content) {
    // Move to end (most recently used) for LRU
    previewCache.delete(noteId);
    previewCache.set(noteId, entry);
    return entry.html;
  }
  return null;
}

function invalidatePreviewCache(noteId) {
  previewCache.delete(noteId);
}

// ─── Note content cache ───
// Switching to a note used to re-read it from disk every time via the
// read_note IPC call. Notes live in iCloud Drive, so that round-trip can
// stall on an on-demand download — which is what made note switching lag
// even though the *rendered* HTML was cached. Keep the raw content around
// too, keyed by id, refreshed on save and dropped on delete.
const contentCache = new Map(); // Map<noteId, string>
const CONTENT_CACHE_MAX = 80;

function cacheContent(noteId, content) {
  if (contentCache.size >= CONTENT_CACHE_MAX && !contentCache.has(noteId)) {
    contentCache.delete(contentCache.keys().next().value);
  }
  contentCache.delete(noteId); // re-insert moves it to MRU position
  contentCache.set(noteId, content);
}

/** Returns the cached content string, or null if this note isn't cached. */
function getCachedContent(noteId) {
  if (!contentCache.has(noteId)) return null;
  const content = contentCache.get(noteId);
  contentCache.delete(noteId);
  contentCache.set(noteId, content); // bump to MRU
  return content;
}

function invalidateContentCache(noteId) {
  contentCache.delete(noteId);
}

// ─── DOM refs ───
const $ = (s) => document.querySelector(s);
const editorEl = $("#editor");
const preview = $("#preview");
const noteList = $("#note-list");
const search = $("#search");
const palette = $("#command-palette");
const paletteInput = $("#palette-input");
const paletteResults = $("#palette-results");
const sidebar = $("#sidebar");
const titlebarTitle = $("#titlebar-title");

// ─── Editor adapter setup ───
// `editor` (imported) is the abstraction; backends are registered for each
// supported mode. The textarea backend is the only one available at boot —
// the live-preview (CM6) backend is lazy-imported on first switch into
// live mode.
editor.register("textarea", new TextareaBackend(editorEl));
editor.setActive("textarea");

// Remember the last editor surface the user picked so re-launching the app
// doesn't force everyone back to raw textarea every time.
const STORAGE_PREFERRED_EDITOR = "raynote-preferred-editor";
function getPreferredEditor() {
  const v = localStorage.getItem(STORAGE_PREFERRED_EDITOR);
  return v === "live" ? "live" : "textarea";
}
function setPreferredEditor(name) {
  if (name === "textarea" || name === "live") {
    localStorage.setItem(STORAGE_PREFERRED_EDITOR, name);
  }
}

// ─── Event delegation (single listener instead of per-element) ───

// Note list: one click handler for all note items and pin buttons
noteList.addEventListener("click", (e) => {
  const pinBtn = e.target.closest(".note-pin-btn");
  if (pinBtn) {
    e.stopPropagation();
    toggleNotePin(pinBtn.dataset.pinId);
    return;
  }
  const noteItem = e.target.closest(".note-item");
  if (noteItem) {
    selectNote(noteItem.dataset.id);
  }
});

// Preview pane: one click handler for all interactive preview elements
preview.addEventListener("click", (e) => {
  // Code copy button
  const copyBtn = e.target.closest(".code-copy-btn");
  if (copyBtn) {
    e.stopPropagation();
    const code = copyBtn
      .getAttribute("data-code")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'");
    copyToClipboard(code);
    copyBtn.classList.add("copied");
    copyBtn.innerHTML = `<svg width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="M3 8.5l3.5 3.5 7-7" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
    setTimeout(() => {
      copyBtn.classList.remove("copied");
      copyBtn.innerHTML = `<svg width="14" height="14" viewBox="0 0 16 16" fill="none"><rect x="5" y="5" width="9" height="9" rx="1.5" stroke="currentColor" stroke-width="1.3"/><path d="M11 5V3.5A1.5 1.5 0 009.5 2h-6A1.5 1.5 0 002 3.5v6A1.5 1.5 0 003.5 11H5" stroke="currentColor" stroke-width="1.3"/></svg>`;
    }, 1500);
    return;
  }

  // Collapsible code blocks via yellow dot
  const yellowDot = e.target.closest(".dot-yellow[role='button']");
  if (yellowDot) {
    e.stopPropagation();
    const codeWindow = yellowDot.closest(".code-window");
    if (codeWindow) codeWindow.classList.toggle("collapsed");
    return;
  }

  // Asset link
  const assetLink = e.target.closest(".asset-link[data-asset]");
  if (assetLink) {
    e.preventDefault();
    invoke("reveal_asset", { name: assetLink.dataset.asset }).catch(() => {
      showCopyToast("Failed to open file");
    });
    return;
  }

  // External link
  const extLink = e.target.closest(".external-link[data-url]");
  if (extLink) {
    e.preventDefault();
    shellOpen(extLink.dataset.url).catch(() => {
      showCopyToast("Failed to open link");
    });
    return;
  }

  // Inline code: click to copy
  const inlineCode = e.target.closest(".inline-code");
  if (inlineCode) {
    e.stopPropagation();
    copyToClipboard(inlineCode.textContent);
    inlineCode.classList.remove("copied");
    void inlineCode.offsetWidth;
    inlineCode.classList.add("copied");
    setTimeout(() => inlineCode.classList.remove("copied"), 600);
    showCopyToast("Copied!");
    return;
  }
});

// Preview pane: delegated change handler for todo checkboxes
preview.addEventListener("change", (e) => {
  const cb = e.target.closest('input[type="checkbox"]');
  if (cb && cb.dataset.todoIndex !== undefined) {
    toggleTodoInMarkdown(parseInt(cb.dataset.todoIndex, 10), cb.checked);
  }
});

// Preview pane: delegated keydown handler for todo items
preview.addEventListener("keydown", (e) => {
  const todoItem = e.target.closest(".todo-item");
  if (todoItem && (e.key === " " || e.key === "Enter")) {
    e.preventDefault();
    const cb = todoItem.querySelector('input[type="checkbox"]');
    if (cb) {
      cb.checked = !cb.checked;
      cb.dispatchEvent(new Event("change", { bubbles: true }));
    }
  }
});

// ─── Mode indicator ───
const modeIndicator = document.createElement("div");
modeIndicator.className = "mode-indicator";
modeIndicator.textContent = "preview";
document.getElementById("app").appendChild(modeIndicator);

// ─── Settings panel ───
function createSettingsPanel() {
  const panel = document.createElement("div");
  panel.id = "settings-panel";
  panel.className = "hidden";
  panel.innerHTML = `
    <div class="settings-backdrop"></div>
    <div class="settings-modal" role="dialog" aria-label="Settings">
      <aside class="settings-sidebar">
        <div class="settings-identity">
          <div class="settings-identity-badge"></div>
          <div class="settings-identity-text">
            <span class="settings-identity-name">Raynote</span>
            <span class="settings-identity-sub">Settings</span>
          </div>
        </div>
        <nav class="settings-nav">
          <button class="settings-nav-item active" data-cat="general">
            <span class="settings-nav-icon"><svg width="15" height="15" viewBox="0 0 16 16" fill="none"><circle cx="8" cy="8" r="2.5" stroke="currentColor" stroke-width="1.3"/><path d="M8 1v2M8 13v2M1 8h2M13 8h2M3.05 3.05l1.41 1.41M11.54 11.54l1.41 1.41M3.05 12.95l1.41-1.41M11.54 4.46l1.41-1.41" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg></span>
            <span>General</span>
          </button>
          <button class="settings-nav-item" data-cat="appearance">
            <span class="settings-nav-icon"><svg width="15" height="15" viewBox="0 0 16 16" fill="none"><circle cx="8" cy="8" r="6.4" stroke="currentColor" stroke-width="1.3"/><path d="M8 1.6V14.4A6.4 6.4 0 0 0 8 1.6Z" fill="currentColor"/></svg></span>
            <span>Appearance</span>
          </button>
          <button class="settings-nav-item" data-cat="shortcuts">
            <span class="settings-nav-icon"><svg width="15" height="15" viewBox="0 0 16 16" fill="none"><rect x="1.6" y="4" width="12.8" height="8" rx="1.8" stroke="currentColor" stroke-width="1.3"/><path d="M4 6.4h.01M6.4 6.4h.01M8.8 6.4h.01M11.2 6.4h.01M5 9.4h6" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg></span>
            <span>Shortcuts</span>
          </button>
          <button class="settings-nav-item" data-cat="ai">
            <span class="settings-nav-icon"><svg width="15" height="15" viewBox="0 0 16 16" fill="none"><path d="M8 1.5l1.3 3.4 3.4 1.3-3.4 1.3L8 11l-1.3-3.5L3.2 6.2l3.5-1.3L8 1.5Z" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/><path d="M12.5 10.5l.6 1.5 1.5.6-1.5.6-.6 1.5-.6-1.5-1.5-.6 1.5-.6.6-1.5Z" fill="currentColor"/></svg></span>
            <span>AI</span>
          </button>
          <button class="settings-nav-item" data-cat="about">
            <span class="settings-nav-icon"><svg width="15" height="15" viewBox="0 0 16 16" fill="none"><circle cx="8" cy="8" r="6.4" stroke="currentColor" stroke-width="1.3"/><path d="M8 7.2v4M8 4.9h.01" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg></span>
            <span>About</span>
          </button>
        </nav>
      </aside>
      <section class="settings-content">
        <button class="settings-close-btn" title="Close (Esc)">
          <svg width="13" height="13" viewBox="0 0 14 14"><path d="M1 1l12 12M13 1L1 13" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>
        </button>
        <div class="settings-scroll">
          <div class="settings-cat" data-cat="general">
            <h2 class="settings-cat-title">General</h2>
            <div class="settings-group">
              <div class="settings-group-title">New Notes</div>
              <div class="settings-card">
                <div class="settings-item settings-item-stacked">
                  <div class="setting-info">
                    <span class="setting-label">Title</span>
                    <span class="setting-desc">What appears in the title field when you create a new note</span>
                  </div>
                  <select id="setting-new-note-title-mode" class="setting-input setting-select">
                    <option value="auto">Auto-generate from content</option>
                    <option value="manual">Write title manually</option>
                    <option value="empty">Skip — empty note</option>
                  </select>
                </div>
              </div>
              <div class="settings-group-caption"><strong>Auto-generate</strong> lets the AI write a title from your content (configure the provider in the AI tab). <strong>Write manually</strong> starts the cursor right after <code>#&nbsp;</code>. <strong>Skip</strong> creates an empty note with the cursor at the top.</div>
            </div>
          </div>

          <div class="settings-cat hidden" data-cat="appearance">
            <h2 class="settings-cat-title">Appearance</h2>
            <div class="settings-group">
              <div class="settings-group-title">Dock</div>
              <div class="settings-card">
                <div class="settings-item">
                  <div class="setting-info">
                    <span class="setting-label">Hide from Dock</span>
                    <span class="setting-desc">App stays in the menu bar tray only</span>
                  </div>
                  <label class="toggle-switch">
                    <input type="checkbox" id="toggle-dock-hide" />
                    <span class="toggle-track"><span class="toggle-thumb"></span></span>
                  </label>
                </div>
              </div>
            </div>
            <div class="settings-group">
              <div class="settings-group-title">Edge Glow</div>
              <div class="settings-card">
                <div class="settings-item">
                  <div class="setting-info">
                    <span class="setting-label">Enable</span>
                    <span class="setting-desc">Show the rim and the inner glow</span>
                  </div>
                  <label class="toggle-switch">
                    <input type="checkbox" id="toggle-glow-enabled" />
                    <span class="toggle-track"><span class="toggle-thumb"></span></span>
                  </label>
                </div>
                <div class="settings-item">
                  <div class="setting-info">
                    <span class="setting-label">Static</span>
                    <span class="setting-desc">Stop the sweep — keep a fixed glow centered at the top</span>
                  </div>
                  <label class="toggle-switch">
                    <input type="checkbox" id="toggle-glow-static" />
                    <span class="toggle-track"><span class="toggle-thumb"></span></span>
                  </label>
                </div>
                <div class="settings-item settings-item-stacked">
                  <div class="setting-info">
                    <span class="setting-label">Width</span>
                    <span class="setting-desc">Thickness of the crisp rim line on the edge</span>
                  </div>
                  <input type="range" id="setting-glow-width" class="setting-range" min="0" max="100" step="1" />
                </div>
                <div class="settings-item settings-item-stacked">
                  <div class="setting-info">
                    <span class="setting-label">Size</span>
                    <span class="setting-desc">How far the inner glow reaches toward the center</span>
                  </div>
                  <input type="range" id="setting-glow-size" class="setting-range" min="0" max="100" step="1" />
                </div>
                <div class="settings-item settings-item-stacked">
                  <div class="setting-info">
                    <span class="setting-label">Intensity</span>
                    <span class="setting-desc">How strong the glow looks overall</span>
                  </div>
                  <input type="range" id="setting-glow-intensity" class="setting-range" min="0" max="100" step="1" />
                </div>
              </div>
              <div class="settings-group-caption">A soft red rim that slowly sweeps around the window. Freeze it at the top, resize it, dim it, or turn it off entirely.</div>
            </div>
          </div>

          <div class="settings-cat hidden" data-cat="shortcuts">
            <h2 class="settings-cat-title">Shortcuts</h2>
            <div class="settings-group">
              <div class="settings-group-title">Global Shortcuts</div>
              <div class="settings-card">
                <div id="global-shortcuts-list"></div>
              </div>
              <div class="settings-group-caption">System-wide hotkeys that work even when Raynote isn't focused. Click to record, press Escape to cancel.</div>
              <div class="settings-inline-error" id="global-shortcut-error" style="display: none;">
                <span class="setting-label" style="color: var(--danger);">Shortcut conflict</span>
                <span class="setting-desc" id="global-shortcut-error-msg"></span>
              </div>
            </div>
            <div class="settings-group">
              <div class="settings-group-title">Keyboard Shortcuts</div>
              <div class="settings-card">
                <div id="shortcuts-list"></div>
              </div>
              <div class="settings-group-caption">Click any shortcut to rebind. Press Escape to cancel.</div>
            </div>
          </div>

          <div class="settings-cat hidden" data-cat="ai">
            <h2 class="settings-cat-title">AI</h2>
            <div class="settings-group">
              <div class="settings-group-title">Auto-Title</div>
              <div class="settings-card">
                <div class="settings-item settings-item-stacked">
                  <div class="setting-info">
                    <span class="setting-label">API Key</span>
                    <span class="setting-desc">Your OpenRouter API key (or any OpenAI-compatible provider)</span>
                  </div>
                  <div class="setting-input-wrap">
                    <input type="password" id="setting-ai-api-key" class="setting-input" placeholder="sk-or-v1-..." spellcheck="false" autocomplete="off" />
                    <button class="setting-input-toggle" id="toggle-api-key-vis" title="Show / hide key" aria-label="Toggle key visibility">
                      <svg width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="M8 3C4.4 3 1.4 5.4.5 8c.9 2.6 3.9 5 7.5 5s6.6-2.4 7.5-5c-.9-2.6-3.9-5-7.5-5Zm0 8.3A3.3 3.3 0 1 1 8 4.7a3.3 3.3 0 0 1 0 6.6Zm0-5.3a2 2 0 1 0 0 4 2 2 0 0 0 0-4Z" fill="currentColor"/></svg>
                    </button>
                  </div>
                </div>
                <div class="settings-item settings-item-stacked">
                  <div class="setting-info">
                    <span class="setting-label">Model</span>
                    <span class="setting-desc">The model used to generate titles</span>
                  </div>
                  <input type="text" id="setting-ai-model" class="setting-input" placeholder="${DEFAULT_AI_MODEL}" spellcheck="false" autocomplete="off" />
                </div>
                <div class="settings-item settings-item-stacked">
                  <div class="setting-info">
                    <span class="setting-label">Base URL</span>
                    <span class="setting-desc">API endpoint (OpenAI-compatible <code>/chat/completions</code>)</span>
                  </div>
                  <input type="text" id="setting-ai-base-url" class="setting-input" placeholder="${DEFAULT_AI_BASE_URL}" spellcheck="false" autocomplete="off" />
                </div>
              </div>
              <div class="settings-group-caption">When <em>New Notes → Title</em> is set to <strong>Auto-generate</strong>, new notes get a <code>{{auto_generate}}</code> heading so you can start typing immediately, and the title is generated from your content when you switch away. These credentials are unused for the other title modes.</div>
            </div>
          </div>

          <div class="settings-cat hidden" data-cat="about">
            <h2 class="settings-cat-title">About</h2>
            <div class="settings-about">
              <div class="settings-about-badge"></div>
              <div class="settings-about-name">Raynote</div>
              <div class="settings-about-tag">A minimal markdown note-taking app</div>
            </div>
            <div class="settings-group">
              <div class="settings-group-title">Storage</div>
              <div class="settings-card">
                <div class="settings-item">
                  <div class="setting-info">
                    <span class="setting-label">Notes Location</span>
                    <span class="setting-desc">Notes sync automatically across your devices</span>
                  </div>
                  <span class="setting-badge">iCloud Drive</span>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>
    </div>
  `;
  document.getElementById("app").appendChild(panel);

  panel
    .querySelector(".settings-backdrop")
    .addEventListener("click", closeSettings);
  panel
    .querySelector(".settings-close-btn")
    .addEventListener("click", closeSettings);

  // Sidebar category switching
  const settingsScroll = panel.querySelector(".settings-scroll");
  panel.querySelectorAll(".settings-nav-item").forEach((item) => {
    item.addEventListener("click", () => {
      panel
        .querySelectorAll(".settings-nav-item")
        .forEach((t) => t.classList.remove("active"));
      item.classList.add("active");
      panel
        .querySelectorAll(".settings-cat")
        .forEach((p) => p.classList.add("hidden"));
      panel
        .querySelector(`.settings-cat[data-cat="${item.dataset.cat}"]`)
        .classList.remove("hidden");
      if (settingsScroll) settingsScroll.scrollTop = 0;
    });
  });

  // Dock hide toggle
  panel.querySelector("#toggle-dock-hide").addEventListener("change", (e) => {
    const hide = e.target.checked;
    localStorage.setItem("raynote-hide-dock", hide ? "1" : "0");
    invoke("set_dock_visible", { visible: !hide });
  });

  // Edge-glow controls — persist + apply live so the rim updates as the
  // user drags the sliders or flips the toggles.
  const glowEnabled = panel.querySelector("#toggle-glow-enabled");
  const glowStatic = panel.querySelector("#toggle-glow-static");
  const glowWidth = panel.querySelector("#setting-glow-width");
  const glowSize = panel.querySelector("#setting-glow-size");
  const glowIntensity = panel.querySelector("#setting-glow-intensity");

  glowEnabled.addEventListener("change", () => {
    localStorage.setItem(STORAGE_GLOW_ENABLED, glowEnabled.checked ? "1" : "0");
    applyGlowSettings();
  });
  glowStatic.addEventListener("change", () => {
    localStorage.setItem(STORAGE_GLOW_STATIC, glowStatic.checked ? "1" : "0");
    applyGlowSettings();
  });
  glowWidth.addEventListener("input", () => {
    localStorage.setItem(STORAGE_GLOW_WIDTH, glowWidth.value);
    applyGlowSettings();
  });
  glowSize.addEventListener("input", () => {
    localStorage.setItem(STORAGE_GLOW_SIZE, glowSize.value);
    applyGlowSettings();
  });
  glowIntensity.addEventListener("input", () => {
    localStorage.setItem(STORAGE_GLOW_INTENSITY, glowIntensity.value);
    applyGlowSettings();
  });

  // New-note title mode
  panel
    .querySelector("#setting-new-note-title-mode")
    .addEventListener("change", (e) => {
      localStorage.setItem(STORAGE_NEW_NOTE_TITLE_MODE, e.target.value);
    });

  // AI settings — persist on change
  const aiKeyInput = panel.querySelector("#setting-ai-api-key");
  const aiModelInput = panel.querySelector("#setting-ai-model");
  const aiBaseUrlInput = panel.querySelector("#setting-ai-base-url");

  aiKeyInput.addEventListener("input", () => {
    localStorage.setItem(STORAGE_AI_API_KEY, aiKeyInput.value.trim());
  });
  aiModelInput.addEventListener("input", () => {
    localStorage.setItem(STORAGE_AI_MODEL, aiModelInput.value.trim());
  });
  aiBaseUrlInput.addEventListener("input", () => {
    localStorage.setItem(STORAGE_AI_BASE_URL, aiBaseUrlInput.value.trim());
  });

  // Toggle API key visibility
  panel.querySelector("#toggle-api-key-vis").addEventListener("click", () => {
    const isPassword = aiKeyInput.type === "password";
    aiKeyInput.type = isPassword ? "text" : "password";
  });

  return panel;
}

const settingsPanel = createSettingsPanel();

function openSettings() {
  if (isSticky) return;
  state.settingsOpen = true;
  state.recordingShortcut = null;
  settingsPanel.classList.remove("hidden");
  // Restore dock toggle state
  const dockHidden = localStorage.getItem("raynote-hide-dock") === "1";
  document.getElementById("toggle-dock-hide").checked = dockHidden;
  // Restore edge-glow controls
  const glow = getGlowSettings();
  document.getElementById("toggle-glow-enabled").checked = glow.enabled;
  document.getElementById("toggle-glow-static").checked = glow.static;
  document.getElementById("setting-glow-width").value = String(glow.width);
  document.getElementById("setting-glow-size").value = String(glow.size);
  document.getElementById("setting-glow-intensity").value = String(glow.intensity);
  // Restore new-note title mode
  document.getElementById("setting-new-note-title-mode").value =
    getNewNoteTitleMode();
  // Restore AI settings
  const ai = getAISettings();
  document.getElementById("setting-ai-api-key").value = ai.apiKey;
  document.getElementById("setting-ai-model").value =
    ai.model === DEFAULT_AI_MODEL ? "" : ai.model;
  document.getElementById("setting-ai-base-url").value =
    ai.baseUrl === DEFAULT_AI_BASE_URL ? "" : ai.baseUrl;
  renderShortcutsList();
  renderGlobalShortcutsList();
}

function closeSettings() {
  state.settingsOpen = false;
  state.recordingShortcut = null;
  state.recordingGlobalShortcut = null;
  hideGlobalShortcutError();
  settingsPanel.classList.add("hidden");
}

const GLOBAL_SHORTCUT_LABELS = {
  [GS_ROLE_CAPTURE]: {
    label: "Quick Capture",
    desc: "Show Raynote and start a fresh note from anywhere",
  },
  [GS_ROLE_TOGGLE]: {
    label: "Toggle Window",
    desc: "Show or hide the main Raynote window",
  },
};

function showGlobalShortcutError(msg) {
  const row = document.getElementById("global-shortcut-error");
  const out = document.getElementById("global-shortcut-error-msg");
  if (!row || !out) return;
  out.textContent = msg;
  row.style.display = "";
}

function hideGlobalShortcutError() {
  const row = document.getElementById("global-shortcut-error");
  if (row) row.style.display = "none";
}

function renderGlobalShortcutsList() {
  const list = document.getElementById("global-shortcuts-list");
  if (!list) return;
  list.innerHTML = [GS_ROLE_CAPTURE, GS_ROLE_TOGGLE]
    .map((role) => {
      const meta = GLOBAL_SHORTCUT_LABELS[role];
      const accel = getGlobalShortcutAccelerator(role);
      const isRecording = state.recordingGlobalShortcut === role;
      const defaultAccel =
        role === GS_ROLE_CAPTURE ? DEFAULT_GS_CAPTURE : DEFAULT_GS_TOGGLE;
      const isModified = accel !== defaultAccel;
      return `
        <div class="shortcut-row ${isRecording ? "recording" : ""}" data-role="${role}">
          <div class="setting-info">
            <span class="shortcut-label">${escapeHtml(meta.label)}</span>
            <span class="setting-desc">${escapeHtml(meta.desc)}</span>
          </div>
          <div class="shortcut-keys-area">
            ${
              isModified
                ? `<button class="shortcut-reset-btn" data-role="${role}" data-action="reset" title="Reset to default">
              <svg width="12" height="12" viewBox="0 0 16 16" fill="none"><path d="M2 2v5h5M14 14v-5H9" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/><path d="M13.5 6A6 6 0 003.3 3.3L2 7m12 3l-1.3 3.7A6 6 0 012.5 10" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>
            </button>`
                : ""
            }
            <button class="shortcut-key-btn ${isRecording ? "recording" : ""}" data-role="${role}" data-action="record">
              ${
                isRecording
                  ? '<span class="recording-pulse"></span>Press keys...'
                  : acceleratorToParts(accel)
                      .map((k) => `<kbd>${escapeHtml(k)}</kbd>`)
                      .join('<span class="shortcut-plus">+</span>')
              }
            </button>
          </div>
        </div>`;
    })
    .join("");

  list.querySelectorAll('[data-action="record"]').forEach((btn) => {
    btn.addEventListener("click", () => {
      hideGlobalShortcutError();
      state.recordingGlobalShortcut = btn.dataset.role;
      // Cancel any in-progress app-shortcut recording so the two don't fight.
      state.recordingShortcut = null;
      renderShortcutsList();
      renderGlobalShortcutsList();
    });
  });

  list.querySelectorAll('[data-action="reset"]').forEach((btn) => {
    btn.addEventListener("click", async (e) => {
      e.stopPropagation();
      const role = btn.dataset.role;
      const def =
        role === GS_ROLE_CAPTURE ? DEFAULT_GS_CAPTURE : DEFAULT_GS_TOGGLE;
      try {
        await invoke("set_global_shortcut", { role, accelerator: def });
        setGlobalShortcutAccelerator(role, def);
        hideGlobalShortcutError();
      } catch (err) {
        showGlobalShortcutError(String(err));
      }
      renderGlobalShortcutsList();
    });
  });
}

// Sync wrapper so the keydown handler can short-circuit cleanly.
// Registration is async, but interception is decided synchronously.
function handleGlobalShortcutRecording(e) {
  if (!state.recordingGlobalShortcut) return false;
  e.preventDefault();
  e.stopPropagation();

  if (e.key === "Escape") {
    state.recordingGlobalShortcut = null;
    renderGlobalShortcutsList();
    return true;
  }

  if (!isAcceleratorComplete(e)) return true;

  const role = state.recordingGlobalShortcut;
  const accelerator = eventToAccelerator(e);
  state.recordingGlobalShortcut = null;
  renderGlobalShortcutsList();

  // Fire-and-forget the actual registration; UI already reflects the attempt.
  (async () => {
    try {
      await invoke("set_global_shortcut", { role, accelerator });
      setGlobalShortcutAccelerator(role, accelerator);
      hideGlobalShortcutError();
    } catch (err) {
      // Typically: another running app or macOS owns this combo.
      // Old binding stays in place because Rust bails before unregistering.
      showGlobalShortcutError(
        `Couldn't bind ${acceleratorToParts(accelerator).join("+")} — ${err}. Try a different combination.`,
      );
    }
    renderGlobalShortcutsList();
  })();

  return true;
}

function renderShortcutsList() {
  const list = document.getElementById("shortcuts-list");
  list.innerHTML = Object.entries(state.shortcuts)
    .map(([id, sc]) => {
      const isRecording = state.recordingShortcut === id;
      const isModified = (() => {
        const def = defaultShortcuts[id];
        return (
          def &&
          (sc.key !== def.key ||
            !!sc.meta !== !!def.meta ||
            !!sc.shift !== !!def.shift ||
            !!sc.alt !== !!def.alt)
        );
      })();
      return `
        <div class="shortcut-row ${isRecording ? "recording" : ""}" data-id="${id}">
          <span class="shortcut-label">${escapeHtml(sc.label)}</span>
          <div class="shortcut-keys-area">
            ${
              isModified
                ? `<button class="shortcut-reset-btn" data-id="${id}" title="Reset to default">
              <svg width="12" height="12" viewBox="0 0 16 16" fill="none"><path d="M2 2v5h5M14 14v-5H9" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/><path d="M13.5 6A6 6 0 003.3 3.3L2 7m12 3l-1.3 3.7A6 6 0 012.5 10" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>
            </button>`
                : ""
            }
            <button class="shortcut-key-btn ${isRecording ? "recording" : ""}" data-id="${id}">
              ${
                isRecording
                  ? '<span class="recording-pulse"></span>Press keys...'
                  : formatShortcut(sc)
                      .split("+")
                      .map((k) => `<kbd>${escapeHtml(k)}</kbd>`)
                      .join('<span class="shortcut-plus">+</span>')
              }
            </button>
          </div>
        </div>`;
    })
    .join("");

  list.querySelectorAll(".shortcut-key-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      state.recordingShortcut = btn.dataset.id;
      renderShortcutsList();
    });
  });

  list.querySelectorAll(".shortcut-reset-btn").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const id = btn.dataset.id;
      state.shortcuts[id] = { ...structuredClone(defaultShortcuts[id]) };
      saveShortcuts(state.shortcuts);
      renderShortcutsList();
    });
  });
}

function handleShortcutRecording(e) {
  if (!state.recordingShortcut) return false;
  e.preventDefault();
  e.stopPropagation();

  if (e.key === "Escape") {
    state.recordingShortcut = null;
    renderShortcutsList();
    return true;
  }

  // Ignore bare modifier keys
  if (["Meta", "Control", "Alt", "Shift"].includes(e.key)) return true;

  const id = state.recordingShortcut;
  state.shortcuts[id] = {
    ...state.shortcuts[id],
    key: e.key,
    meta: e.metaKey || e.ctrlKey,
    shift: e.shiftKey,
    alt: e.altKey,
  };
  saveShortcuts(state.shortcuts);
  state.recordingShortcut = null;
  renderShortcutsList();
  return true;
}

// ─── Init ───
async function init() {
  if (!isSticky) {
    if (localStorage.getItem("raynote-hide-dock") === "1") {
      invoke("set_dock_visible", { visible: false });
    }
    // Re-apply any user-customized global shortcuts. Defaults are already
    // registered by the Rust setup; this only does work if the user picked
    // something else. Fire-and-forget so we don't block the splash.
    applyGlobalShortcuts();
  }

  if (isSticky && stickyNoteId) {
    const raw = localStorage.getItem(`raynote-sticky-tint-${stickyNoteId}`);
    applyStickyTintById(stickyTintIdFromStorage(raw) || "mist");
  }

  await loadNotesInitial();

  // Sidebar is now painted (and the background scan has finished) — drop the
  // splash before we start fetching/rendering the first note. Markdown render
  // uses the existing .preview-loading spinner.
  hideSplash();

  if (isSticky) {
    state.sidebarOpen = false;
    sidebar.classList.remove("open");
    if (!stickyNoteId) {
      showEmptyState();
      setupEventListeners();
      setupTauriListeners();
      return;
    }
    // Check if note exists by trying to read it (may not be in paginated list)
    const stickyContent = await invoke("read_note", { id: stickyNoteId });
    if (!stickyContent) {
      preview.innerHTML =
        '<div class="empty-state">This sticky could not be found.</div>';
      preview.classList.add("visible");
      editorEl.classList.remove("visible");
      setupEventListeners();
      setupTauriListeners();
      return;
    }
    await selectNote(stickyNoteId);
    setupStickyTintPicker();
    const target = getPreferredEditor() === "live" ? "live" : "edit";
    await setMode(target);
    editor.focus();
  } else if (state.notes.length > 0) {
    await selectNote(state.notes[0].id);
  } else {
    showEmptyState();
  }

  setupEventListeners();
  setupTauriListeners();
}

// First load on the main window. The note-metadata scan now runs in the
// background (see the Rust setup hook), so an empty result here can mean
// "scan not finished yet" rather than "no notes". Keep waiting — and let the
// caller keep the splash up — until the scan actually completes, instead of
// flashing an empty state.
async function loadNotesInitial() {
  await loadNotes();
  if (state.notes.length > 0 || isSticky) return;
  if (!(await invoke("notes_loading"))) {
    // Scan finished between the two calls above — pick up its results.
    await loadNotes();
    return;
  }
  await new Promise((resolve) => {
    let settled = false;
    let unlisten = null;
    let poll = null;
    const settle = async () => {
      if (settled) return;
      settled = true;
      if (poll) clearInterval(poll);
      if (unlisten) unlisten();
      await loadNotes();
      resolve();
    };
    // Normal path: the backend emits this once the scan completes.
    listen("notes-loaded", settle).then((fn) => {
      unlisten = fn;
      if (settled) fn();
    });
    // Safety net: if the event fired before this listener attached (very
    // fast scan), the flag will still flip — poll it as a fallback.
    poll = setInterval(async () => {
      if (!(await invoke("notes_loading"))) settle();
    }, 200);
  });
}

// ─── Notes CRUD ───
async function loadNotes() {
  state.searchQuery = "";
  search.value = "";
  const result = await invoke("list_notes_paginated", {
    offset: 0,
    limit: PAGE_SIZE,
  });

  // Ensure pinned notes are always loaded even if not in the first page
  const loadedIds = new Set(result.notes.map((n) => n.id));
  const missingPinned = [...state.pinnedNotes].filter(
    (id) => !loadedIds.has(id),
  );
  let pinnedExtras = [];
  if (missingPinned.length > 0) {
    // Fetch all notes to find the missing pinned ones (they could be old)
    const all = await invoke("list_notes");
    pinnedExtras = all.filter((n) => missingPinned.includes(n.id));
  }

  state.notes = [...pinnedExtras, ...result.notes];
  state.totalNotes = result.total;
  state.notesOffset = result.notes.length;
  renderNoteList();
}

async function loadMoreNotes() {
  if (
    state.loadingMore ||
    state.searchQuery ||
    state.notesOffset >= state.totalNotes
  )
    return;
  state.loadingMore = true;
  try {
    const result = await invoke("list_notes_paginated", {
      offset: state.notesOffset,
      limit: PAGE_SIZE,
    });
    if (result.notes.length > 0) {
      state.notes = [...state.notes, ...result.notes];
      state.totalNotes = result.total;
      state.notesOffset += result.notes.length;
      renderNoteList();
    }
  } finally {
    state.loadingMore = false;
  }
}

async function selectNote(id) {
  if (state.dirty && state.currentId) {
    await saveCurrentNote();
  }

  // If the note we're leaving still has the auto-title placeholder, generate a title in the background
  if (state.currentId) {
    const prevContent = editor.getText();
    const prevNoteId = state.currentId;
    if (hasAutoTitlePlaceholder(prevContent)) {
      autoGenerateTitle(prevNoteId, prevContent); // fire-and-forget
    }
  }

  const prevId = state.currentId;
  state.currentId = id;
  let content = getCachedContent(id);
  if (content === null) {
    content = await invoke("read_note", { id });
    cacheContent(id, content);
  }
  editor.setText(content);

  // Update sidebar immediately (before any heavy render work)
  updateNoteListActiveState(prevId, id);
  updateTitle();

  // Empty note: show empty state instantly
  if (!content || content.trim() === "") {
    preview.innerHTML = '<div class="empty-state">Start writing...</div>';
    setModeRaw("preview");
    return;
  }

  // Cache hit: instant render, no blocking
  const cachedHtml = getCachedPreviewHtml(id, content);
  if (cachedHtml) {
    if (codeObserver) { codeObserver.disconnect(); codeObserver = null; }
    preview.innerHTML = cachedHtml;
    lazyHighlightCodeBlocks();
    lazyLoadAssetImages();
    setupTodoAttributes();
    setModeRaw("preview");
    return;
  }

  // Cache miss: show spinner, yield to let the sidebar paint, then parse
  preview.innerHTML = '<div class="preview-loading"></div>';
  setModeRaw("preview");

  const gen = ++renderGeneration;

  // Double-yield: rAF ensures the browser has scheduled a paint,
  // then setTimeout(0) runs after that paint completes
  await new Promise((resolve) => {
    requestAnimationFrame(() => setTimeout(resolve, 0));
  });

  // Guard: if user navigated away during the yield, abandon this render
  if (renderGeneration !== gen) return;

  if (codeObserver) { codeObserver.disconnect(); codeObserver = null; }
  const html = marked.parse(content);
  preview.innerHTML = html;
  cachePreviewHtml(id, content, html);
  lazyHighlightCodeBlocks();
  lazyLoadAssetImages();
  setupTodoAttributes();
}

/** Swap the .active class in the sidebar without rebuilding the DOM. */
function updateNoteListActiveState(prevId, newId) {
  if (prevId) {
    const prev = noteList.querySelector(`.note-item[data-id="${prevId}"]`);
    if (prev) prev.classList.remove("active");
  }
  if (newId) {
    const next = noteList.querySelector(`.note-item[data-id="${newId}"]`);
    if (next) next.classList.add("active");
  }
}

async function saveCurrentNote() {
  if (!state.currentId) return;
  invalidatePreviewCache(state.currentId);
  const content = editor.getText();
  cacheContent(state.currentId, content); // keep cache in sync with disk
  await invoke("save_note", { id: state.currentId, content });
  state.dirty = false;
  const rawTitle =
    (content.split("\n")[0] || state.currentId).replace(/^#+\s*/, "").trim() ||
    state.currentId;
  const title = rawTitle === AUTO_TITLE_PLACEHOLDER ? "New Note" : rawTitle;
  const previewText = content.split("\n").slice(1, 3).join(" ").slice(0, 100);
  const now = Math.floor(Date.now() / 1000);
  const idx = state.notes.findIndex((n) => n.id === state.currentId);
  const updatedMeta = {
    id: state.currentId,
    title,
    modified: now,
    preview: previewText,
  };
  if (idx >= 0) {
    state.notes.splice(idx, 1);
  }
  // Insert at top (most recently modified)
  state.notes.unshift(updatedMeta);
  renderNoteList(state.searchQuery);
}

async function createNote() {
  const ts = Date.now();
  const id = `note-${ts}`;
  const mode = getNewNoteTitleMode();

  // Three modes:
  //   - auto:   "# {{auto_generate}}\n\n", cursor at end → type body, title auto-generated on switch
  //   - manual: "# ",                       cursor after "# " → type the title, then Enter for body
  //   - empty:  "",                         cursor at 0 → blank slate, user decides
  let content;
  let cursorPos;
  if (mode === TITLE_MODE_MANUAL) {
    content = "# ";
    cursorPos = content.length;
  } else if (mode === TITLE_MODE_EMPTY) {
    content = "";
    cursorPos = 0;
  } else {
    content = `# ${AUTO_TITLE_PLACEHOLDER}\n\n`;
    cursorPos = content.length;
  }

  await invoke("save_note", { id, content });
  await loadNotes();
  await selectNote(id);
  const target = getPreferredEditor() === "live" ? "live" : "edit";
  await setMode(target);
  editor.setSelection(cursorPos, cursorPos);
  editor.focus();
}

async function openNewSticky() {
  if (!state.currentId) {
    showCopyToast("Open a note first");
    return;
  }
  try {
    await invoke("create_sticky_window", { id: state.currentId });
  } catch {
    showCopyToast("Could not open sticky");
  }
}

function applyStickyTintById(presetId) {
  const preset =
    STICKY_TINT_PRESETS.find((p) => p.id === presetId) ||
    STICKY_TINT_PRESETS[0];
  const app = document.getElementById("app");
  app.style.setProperty("--sticky-glass-1", preset.c1);
  app.style.setProperty("--sticky-glass-2", preset.c2);
}

function setupStickyTintPicker() {
  const el = document.getElementById("sticky-tint-picker");
  if (!el || !stickyNoteId) return;
  const raw = localStorage.getItem(`raynote-sticky-tint-${stickyNoteId}`);
  const current = stickyTintIdFromStorage(raw) || "mist";
  applyStickyTintById(current);

  const currentPreset =
    STICKY_TINT_PRESETS.find((p) => p.id === current) || STICKY_TINT_PRESETS[0];
  el.innerHTML = `
    <div class="sticky-tint-dd">
      <button type="button" class="sticky-tint-dd-trigger" aria-expanded="false" aria-haspopup="listbox" aria-label="Glass tint">
        <span class="sticky-tint-dd-value">${escapeHtml(currentPreset.label)}</span>
        <svg class="sticky-tint-dd-chevron" width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
          <path d="M3 4.5L6 7.5L9 4.5" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/>
        </svg>
      </button>
      <ul class="sticky-tint-dd-menu" role="listbox" hidden>
        ${STICKY_TINT_PRESETS.map(
          (p) => `
          <li role="presentation">
            <button type="button" role="option" class="sticky-tint-dd-option${p.id === current ? " is-selected" : ""}"
              data-tint="${escapeHtml(p.id)}" aria-selected="${p.id === current}">
              ${escapeHtml(p.label)}
            </button>
          </li>`,
        ).join("")}
      </ul>
    </div>
  `;

  const dd = el.querySelector(".sticky-tint-dd");
  const trigger = el.querySelector(".sticky-tint-dd-trigger");
  const menu = el.querySelector(".sticky-tint-dd-menu");
  const valueEl = el.querySelector(".sticky-tint-dd-value");
  let docMousedown;
  let docKeydown;
  let onResize;

  function positionMenu() {
    const rect = trigger.getBoundingClientRect();
    const w = Math.max(rect.width, 148);
    menu.style.position = "fixed";
    menu.style.top = `${Math.round(rect.bottom + 4)}px`;
    menu.style.left = `${Math.round(rect.left)}px`;
    menu.style.width = `${Math.round(w)}px`;
    menu.style.zIndex = "6000";
  }

  function closeMenu() {
    dd.classList.remove("is-open");
    menu.hidden = true;
    trigger.setAttribute("aria-expanded", "false");
    if (docMousedown) {
      document.removeEventListener("mousedown", docMousedown);
      docMousedown = null;
    }
    if (docKeydown) {
      document.removeEventListener("keydown", docKeydown);
      docKeydown = null;
    }
    if (onResize) {
      window.removeEventListener("resize", onResize);
      onResize = null;
    }
  }

  function openMenu() {
    dd.classList.add("is-open");
    menu.hidden = false;
    trigger.setAttribute("aria-expanded", "true");
    positionMenu();
    onResize = () => positionMenu();
    window.addEventListener("resize", onResize);
    docMousedown = (e) => {
      if (!dd.contains(e.target)) closeMenu();
    };
    docKeydown = (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        closeMenu();
        trigger.focus();
      }
    };
    setTimeout(() => {
      document.addEventListener("mousedown", docMousedown);
      document.addEventListener("keydown", docKeydown);
    }, 0);
  }

  function selectTint(id) {
    localStorage.setItem(`raynote-sticky-tint-${stickyNoteId}`, id);
    applyStickyTintById(id);
    const preset = STICKY_TINT_PRESETS.find((p) => p.id === id);
    if (preset) valueEl.textContent = preset.label;
    menu.querySelectorAll(".sticky-tint-dd-option").forEach((btn) => {
      const on = btn.dataset.tint === id;
      btn.classList.toggle("is-selected", on);
      btn.setAttribute("aria-selected", on ? "true" : "false");
    });
    closeMenu();
  }

  trigger.addEventListener("click", (e) => {
    e.stopPropagation();
    if (dd.classList.contains("is-open")) closeMenu();
    else openMenu();
  });

  menu.querySelectorAll(".sticky-tint-dd-option").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      selectTint(btn.dataset.tint);
    });
  });
}

const undoDeleteStack = []; // { id, wasPinned } — most recent deletion at end
const redoDeleteStack = []; // { id, wasPinned } — most recent redo-able at end

async function deleteCurrentNote() {
  if (!state.currentId) return;
  const wasPinned = isNotePinned(state.currentId);
  const id = state.currentId;
  invalidatePreviewCache(id);
  invalidateContentCache(id);

  await invoke("delete_note", { id });

  undoDeleteStack.push({ id, wasPinned });
  redoDeleteStack.length = 0; // new action clears redo

  // Remove pin state
  if (wasPinned) {
    state.pinnedNotes.delete(id);
    savePinnedNotes(state.pinnedNotes);
  }
  // Remove from local list
  state.notes = state.notes.filter((n) => n.id !== id);
  state.totalNotes = Math.max(0, state.totalNotes - 1);
  state.currentId = null;
  state.dirty = false;
  renderNoteList(state.searchQuery);

  showCopyToast("Moved to Trash");

  if (state.notes.length > 0) {
    await selectNote(state.notes[0].id);
  } else {
    editor.setText("");
    preview.innerHTML = "";
    showEmptyState();
  }
}

async function undoDeleteNote() {
  if (undoDeleteStack.length === 0) return;
  const { id, wasPinned } = undoDeleteStack.pop();
  const ok = await invoke("restore_note", { id });
  if (!ok) {
    showCopyToast("Could not restore note");
    return;
  }
  redoDeleteStack.push({ id, wasPinned });
  // Restore pin state if it was pinned before deletion
  if (wasPinned) {
    state.pinnedNotes.add(id);
    savePinnedNotes(state.pinnedNotes);
  }
  await loadNotes();
  await selectNote(id);
  showCopyToast("Note restored");
}

async function redoDeleteNote() {
  if (redoDeleteStack.length === 0) return;
  const { id, wasPinned } = redoDeleteStack.pop();

  invalidatePreviewCache(id);
  invalidateContentCache(id);
  await invoke("delete_note", { id });
  undoDeleteStack.push({ id, wasPinned });

  // Remove pin state
  if (wasPinned) {
    state.pinnedNotes.delete(id);
    savePinnedNotes(state.pinnedNotes);
  }
  // Remove from local list
  state.notes = state.notes.filter((n) => n.id !== id);
  state.totalNotes = Math.max(0, state.totalNotes - 1);
  if (state.currentId === id) {
    state.currentId = null;
    state.dirty = false;
  }
  renderNoteList(state.searchQuery);

  showCopyToast("Moved to Trash");

  if (!state.currentId && state.notes.length > 0) {
    await selectNote(state.notes[0].id);
  } else if (state.notes.length === 0) {
    editor.setText("");
    preview.innerHTML = "";
    showEmptyState();
  }
}

async function restoreFromTrash(id) {
  const ok = await invoke("restore_note", { id });
  if (!ok) {
    showCopyToast("Could not restore note");
    return;
  }
  await loadNotes();
  await selectNote(id);
  showCopyToast("Note restored");
}

async function emptyTrash() {
  const trashNotes = await invoke("list_trash");
  if (trashNotes.length === 0) {
    showCopyToast("Trash is empty");
    return;
  }
  await invoke("empty_trash");
  // Clear undo/redo stacks since those notes are gone forever
  undoDeleteStack.length = 0;
  redoDeleteStack.length = 0;
  showCopyToast("Trash emptied");
}

// ─── Copy helpers ───
async function copyToClipboard(text) {
  await navigator.clipboard.writeText(text);
}

function showCopyToast(msg = "Copied!") {
  let toast = document.querySelector(".copy-toast");
  if (!toast) {
    toast = document.createElement("div");
    toast.className = "copy-toast";
    document.getElementById("app").appendChild(toast);
  }
  toast.textContent = msg;
  toast.classList.remove("visible");
  // force reflow
  void toast.offsetWidth;
  toast.classList.add("visible");
  setTimeout(() => toast.classList.remove("visible"), 1600);
}

function copyNoteMarkdown() {
  const text = editor.getText();
  if (!text) return;
  copyToClipboard(text);
  showCopyToast("Markdown copied!");
}

// ─── Render ───
let codeObserver = null;

function renderPreview(content, noteId = null) {
  if (!content || content.trim() === "") {
    preview.innerHTML = '<div class="empty-state">Start writing...</div>';
    return;
  }
  // Clean up previous observer
  if (codeObserver) {
    codeObserver.disconnect();
    codeObserver = null;
  }

  // Check cache when a noteId is provided
  if (noteId) {
    const cachedHtml = getCachedPreviewHtml(noteId, content);
    if (cachedHtml) {
      preview.innerHTML = cachedHtml;
      lazyHighlightCodeBlocks();
      lazyLoadAssetImages();
      setupTodoAttributes();
      return;
    }
  }

  const html = marked.parse(content);
  preview.innerHTML = html;
  if (noteId) {
    cachePreviewHtml(noteId, content, html);
  }
  // Only observers need setup here – click/change/keydown handlers use event
  // delegation on the preview element (registered once at startup).
  lazyHighlightCodeBlocks();
  lazyLoadAssetImages();
  setupTodoAttributes();
}

function lazyHighlightCodeBlocks() {
  const pending = preview.querySelectorAll(
    '.code-window[data-highlight="pending"]',
  );
  if (pending.length === 0) return;

  codeObserver = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        const block = entry.target;
        codeObserver.unobserve(block);
        const lang = block.dataset.lang;
        const codeEl = block.querySelector("code");
        const raw = codeEl.textContent;
        if (lang && hljs.getLanguage(lang)) {
          codeEl.innerHTML = hljs.highlight(raw, { language: lang }).value;
        } else {
          codeEl.innerHTML = hljs.highlightAuto(raw).value;
        }
        block.dataset.highlight = "done";
      }
    },
    { root: preview, rootMargin: "200px" },
  );

  pending.forEach((block) => codeObserver.observe(block));
}

// setupCodeCopyButtons – removed: handled by delegated click on preview

// ─── Lazy asset image loading ───
let imageObserver = null;

function lazyLoadAssetImages() {
  const pending = preview.querySelectorAll(".lazy-image[data-asset]");
  if (pending.length === 0) return;

  if (imageObserver) {
    imageObserver.disconnect();
    imageObserver = null;
  }

  imageObserver = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        const el = entry.target;
        imageObserver.unobserve(el);
        const assetName = el.dataset.asset;
        loadAssetImage(el, assetName);
      }
    },
    { root: preview, rootMargin: "200px" },
  );

  pending.forEach((el) => imageObserver.observe(el));
}

// setupAssetLinkClicks – removed: handled by delegated click on preview
// setupExternalLinkClicks – removed: handled by delegated click on preview

// ─── Todo checkboxes ───
// Only sets data attributes/classes – actual event handling uses delegation on preview.
function setupTodoAttributes() {
  const checkboxes = preview.querySelectorAll('input[type="checkbox"]');
  if (checkboxes.length === 0) return;

  checkboxes.forEach((cb, index) => {
    cb.removeAttribute("disabled");
    cb.dataset.todoIndex = index;
    const li = cb.closest("li");
    if (li) {
      li.classList.add("todo-item");
      li.dataset.todoIndex = index;
      li.setAttribute("tabindex", "0");
    }
  });
}

function toggleTodoInMarkdown(index, checked) {
  const content = editor.getText();
  const todoPattern = /^(\s*[-*+]\s*)\[([ xX])\]/gm;
  let match;
  let count = 0;

  while ((match = todoPattern.exec(content)) !== null) {
    if (count === index) {
      const newMark = checked ? "x" : " ";
      const before = content.slice(0, match.index + match[1].length + 1);
      const after = content.slice(match.index + match[1].length + 2);
      const sel = editor.getSelection();
      editor.setText(before + newMark + after);
      editor.setSelection(sel.start, sel.end);
      state.dirty = true;
      // Save without re-rendering – the checkbox already reflects the new state
      // in the DOM (the user just toggled it). Only persist the markdown.
      saveTodoChange();
      return;
    }
    count++;
  }
}

/** Debounced save specifically for todo toggles – avoids full UI cascade. */
let _todoSaveTimer = null;
function saveTodoChange() {
  clearTimeout(_todoSaveTimer);
  _todoSaveTimer = setTimeout(async () => {
    if (!state.currentId) return;
    invalidatePreviewCache(state.currentId);
    const content = editor.getText();
    await invoke("save_note", { id: state.currentId, content });
    state.dirty = false;
    const title =
      (content.split("\n")[0] || state.currentId)
        .replace(/^#+\s*/, "")
        .trim() || state.currentId;
    const previewText = content.split("\n").slice(1, 3).join(" ").slice(0, 100);
    const now = Math.floor(Date.now() / 1000);
    const idx = state.notes.findIndex((n) => n.id === state.currentId);
    if (idx >= 0) {
      state.notes[idx] = {
        ...state.notes[idx],
        title,
        modified: now,
        preview: previewText,
      };
    }
  }, 300);
}

// ─── Drag & drop file handling (uses Tauri native events) ───
const IMAGE_EXTS = /\.(png|jpe?g|gif|webp|svg|bmp|ico)$/i;

function setupDropHandler() {
  const editorArea = document.getElementById("editor-area");

  getCurrentWindow().onDragDropEvent((event) => {
    const { type } = event.payload;

    if (type === "enter" || type === "over") {
      editorArea.classList.add("drop-active");
    } else if (type === "leave") {
      editorArea.classList.remove("drop-active");
    } else if (type === "drop") {
      editorArea.classList.remove("drop-active");
      const paths = event.payload.paths || [];
      if (paths.length > 0) handleDroppedPaths(paths);
    }
  });
}

async function handleDroppedPaths(paths) {
  if (!state.currentId) return;

  // Drop into whatever editor is active. If we're in preview, jump to raw
  // edit mode so the user sees the inserted markdown.
  if (state.mode === "preview") {
    setMode("edit");
    editor.focus();
  }

  for (const filePath of paths) {
    try {
      const [assetName, originalName] = await invoke("copy_to_assets", {
        sourcePath: filePath,
      });

      let markdown;
      if (IMAGE_EXTS.test(originalName)) {
        markdown = `![${originalName}|100%|center](asset:${assetName})`;
      } else {
        markdown = `[${originalName}](asset:${assetName})`;
      }

      insertAtCursor(markdown + "\n");
      showCopyToast("File attached");
    } catch {
      showCopyToast("Failed to attach file");
    }
  }
}

function insertAtCursor(text) {
  const { start, end } = editor.getSelection();
  const v = editor.getText();
  const before = v.substring(0, start);
  const after = v.substring(end);
  const needsNewline = before.length > 0 && !before.endsWith("\n");
  const insert = (needsNewline ? "\n" : "") + text;
  editor.setText(before + insert + after);
  const pos = start + insert.length;
  editor.setSelection(pos, pos);
  state.dirty = true;
  saveCurrentNote();
}

const PIN_ICON_SVG = `<svg width="12" height="12" viewBox="0 0 16 16" fill="none"><path d="M9.5 2L14 6.5L10.5 10L11.5 14.5L8 11L4.5 14.5L5.5 10L2 6.5L6.5 2L8 4.5L9.5 2Z" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

function renderNoteItem(n) {
  const isPinned = isNotePinned(n.id);
  const isAutoTitle = n.title === "New Note" || n.title === AUTO_TITLE_PLACEHOLDER;
  const titleClass = `note-item-title${isAutoTitle ? " auto-title" : ""}`;
  const displayTitle = n.title === AUTO_TITLE_PLACEHOLDER ? "New Note" : n.title;
  return `
    <li class="note-item ${n.id === state.currentId ? "active" : ""}${isPinned ? " pinned" : ""}" data-id="${n.id}">
      <div class="note-item-header">
        <div class="${titleClass}">${escapeHtml(displayTitle)}</div>
        <button class="note-pin-btn${isPinned ? " is-pinned" : ""}" data-pin-id="${n.id}" title="${isPinned ? "Unpin" : "Pin"} note" aria-label="${isPinned ? "Unpin" : "Pin"} note">
          ${PIN_ICON_SVG}
        </button>
      </div>
      <div class="note-item-preview">${escapeHtml(n.preview)}</div>
      <div class="note-item-date">${formatDate(n.modified)}</div>
    </li>`;
}

function renderNoteList(filter = "") {
  // When searching, state.notes already contains search results from the backend.
  // When not searching, state.notes contains the paginated list.
  const displayNotes = filter
    ? state.notes.filter(
        (n) =>
          n.title.toLowerCase().includes(filter.toLowerCase()) ||
          n.preview.toLowerCase().includes(filter.toLowerCase()),
      )
    : state.notes;

  // Split into pinned and unpinned
  const pinned = displayNotes.filter((n) => isNotePinned(n.id));
  const unpinned = displayNotes.filter((n) => !isNotePinned(n.id));

  const hasMore = !state.searchQuery && state.notesOffset < state.totalNotes;

  let html = "";
  if (pinned.length > 0) {
    html += `<li class="note-section-label" aria-hidden="true">Pinned</li>`;
    html += pinned.map(renderNoteItem).join("");
    if (unpinned.length > 0) {
      html += `<li class="note-section-divider" aria-hidden="true"></li>`;
    }
  }
  html += unpinned.map(renderNoteItem).join("");
  if (hasMore) {
    html += `<li class="note-list-sentinel" aria-hidden="true" style="height:1px;"></li>`;
  }

  noteList.innerHTML = html;

  // Observe sentinel for infinite scroll
  setupScrollObserver();
}

// ─── Infinite scroll observer ───
let scrollObserver = null;

function setupScrollObserver() {
  if (scrollObserver) {
    scrollObserver.disconnect();
    scrollObserver = null;
  }
  const sentinel = noteList.querySelector(".note-list-sentinel");
  if (!sentinel) return;

  scrollObserver = new IntersectionObserver(
    (entries) => {
      if (entries[0].isIntersecting) {
        loadMoreNotes();
      }
    },
    { root: noteList, rootMargin: "200px" },
  );
  scrollObserver.observe(sentinel);
}

// ─── Debounced backend search ───
let searchTimeout = null;

async function handleSearch(query) {
  state.searchQuery = query;
  if (!query) {
    // Restore paginated list
    const result = await invoke("list_notes_paginated", {
      offset: 0,
      limit: PAGE_SIZE,
    });
    state.notes = result.notes;
    state.totalNotes = result.total;
    state.notesOffset = result.notes.length;
    renderNoteList();
    return;
  }
  // Search on backend — returns up to 100 results
  const results = await invoke("search_notes", { query, limit: 100 });
  state.notes = results;
  state.totalNotes = results.length;
  state.notesOffset = results.length;
  renderNoteList();
}

function showEmptyState() {
  preview.innerHTML = `
    <div class="empty-state">
      <span>No notes yet</span>
      <span>Press <kbd>Cmd+N</kbd> to create one</span>
    </div>
  `;
  applyModeChrome("preview");
}

function updateTitle() {
  const note = state.notes.find((n) => n.id === state.currentId);
  if (!note) {
    titlebarTitle.textContent = "Raynote";
    return;
  }
  const display =
    note.title === AUTO_TITLE_PLACEHOLDER ? "New Note" : note.title;
  titlebarTitle.textContent = display;
}

// ─── Mode switching ───
// Three modes:
//   - "edit"    : raw markdown textarea visible
//   - "preview" : rendered HTML (marked) visible
//   - "live"    : live-preview CodeMirror editor visible (lazy-loaded)
//
// "edit" and "live" both put an editor in front; the adapter's active
// backend tracks which one owns the doc text. Switching between them
// transfers the text over.

const MODE_LABELS = {
  edit: "editing",
  preview: "preview",
  live: "live",
};

let liveEditorEl = null; // populated on first switch into live mode
let liveEditorLoadPromise = null;

async function ensureLiveEditor() {
  if (liveEditorEl) return liveEditorEl;
  if (liveEditorLoadPromise) return liveEditorLoadPromise;
  liveEditorLoadPromise = (async () => {
    const mod = await import("./livepreview/index.js");
    liveEditorEl = mod.setupLiveEditor({
      container: document.getElementById("editor-area"),
      adapter: editor,
      onSaveTrigger: scheduleSave,
      getActiveNoteId: () => state.currentId,
    });
    return liveEditorEl;
  })();
  return liveEditorLoadPromise;
}

function applyModeChrome(mode) {
  state.mode = mode;
  // Visibility — only one of the three surfaces is visible at a time.
  editorEl.classList.toggle("visible", mode === "edit");
  preview.classList.toggle("visible", mode === "preview");
  if (liveEditorEl) liveEditorEl.classList.toggle("visible", mode === "live");
  // Mode indicator
  modeIndicator.textContent = MODE_LABELS[mode];
  modeIndicator.classList.toggle("editing", mode === "edit" || mode === "live");
}

/** Switch mode DOM state without triggering renderPreview. Used by selectNote
 *  which manages rendering separately to avoid double-renders. */
function setModeRaw(mode) {
  applyModeChrome(mode);
}

// Monotonic gen so a late ensureLiveEditor() resolution can detect that the
// user already moved to a different mode and bail out instead of forcing the
// live view back on screen.
let _modeRequestGen = 0;

function setMode(mode) {
  const gen = ++_modeRequestGen;

  if (mode === "live") {
    setPreferredEditor("live");
    return ensureLiveEditor()
      .then(() => {
        if (gen !== _modeRequestGen) return;
        editor.switchTo("live");
        applyModeChrome("live");
        editor.focus();
      })
      .catch((err) => {
        if (gen !== _modeRequestGen) return;
        console.error("Failed to load live editor:", err);
        const detail = err && err.message ? err.message : String(err);
        // Persist the full stack so the user can retrieve it from devtools
        // localStorage even if the toast clipped the message.
        try {
          localStorage.setItem(
            "raynote-live-error",
            (err && err.stack) || detail,
          );
        } catch {}
        showCopyToast("Live preview failed: " + detail.slice(0, 80));
        editor.switchTo("textarea");
        applyModeChrome("edit");
        editor.focus();
      });
  }

  if (mode === "edit") {
    setPreferredEditor("textarea");
    editor.switchTo("textarea");
    applyModeChrome("edit");
    return Promise.resolve();
  }

  // preview — keep current backend as source of truth, just show the pane.
  applyModeChrome("preview");
  renderPreview(editor.getText(), state.currentId);
  return Promise.resolve();
}

// ─── Command Palette ───
function getCommands() {
  const pinLabelSticky =
    state.currentId && isNotePinned(state.currentId)
      ? "Unpin Note"
      : "Pin Note";

  if (isSticky) {
    return [
      {
        label: "Open Sticky (this note)",
        hint: formatShortcut(state.shortcuts.newSticky),
        action: openNewSticky,
      },
      {
        label: pinLabelSticky,
        hint: formatShortcut(state.shortcuts.pinNote),
        action: () => {
          if (state.currentId) toggleNotePin(state.currentId);
        },
      },
      {
        label: "Delete Note",
        hint: formatShortcut(state.shortcuts.deleteNote),
        action: deleteCurrentNote,
      },
      {
        label: "Undo Delete Note",
        hint: formatShortcut(state.shortcuts.undoDelete),
        action: undoDeleteNote,
      },
      {
        label: "Redo Delete Note",
        hint: formatShortcut(state.shortcuts.redoDelete),
        action: redoDeleteNote,
      },
      {
        label: "View Trash",
        hint: formatShortcut(state.shortcuts.viewTrash),
        action: () => openPalette("trash"),
      },
      { label: "Empty Trash", action: emptyTrash },
      {
        label: "Toggle Edit/Preview",
        hint: formatShortcut(state.shortcuts.toggleEdit),
        action: () => {
          if (state.mode === "edit" || state.mode === "live") {
            setMode("preview");
          } else {
            setMode(getPreferredEditor() === "live" ? "live" : "edit");
          }
        },
      },
      {
        label: "Toggle Live Preview",
        hint: formatShortcut(state.shortcuts.toggleLive),
        action: () => setMode(state.mode === "live" ? "preview" : "live"),
      },
      {
        label: "Pin Window on Top",
        hint: formatShortcut(state.shortcuts.pinWindow),
        action: () => togglePin(),
      },
      {
        label: "Copy Note as Markdown",
        hint: formatShortcut(state.shortcuts.copyNote),
        action: copyNoteMarkdown,
      },
      {
        label: "Close Window",
        hint: formatShortcut(state.shortcuts.closeWindow),
        action: () => closeCurrentWindow(),
      },
    ];
  }

  const pinLabel =
    state.currentId && isNotePinned(state.currentId)
      ? "Unpin Note"
      : "Pin Note";

  return [
    {
      label: "New Note",
      hint: formatShortcut(state.shortcuts.newNote),
      action: createNote,
    },
    {
      label: "Open Sticky (this note)",
      hint: formatShortcut(state.shortcuts.newSticky),
      action: openNewSticky,
    },
    {
      label: pinLabel,
      hint: formatShortcut(state.shortcuts.pinNote),
      action: () => {
        if (state.currentId) toggleNotePin(state.currentId);
      },
    },
    {
      label: "Delete Note",
      hint: formatShortcut(state.shortcuts.deleteNote),
      action: deleteCurrentNote,
    },
    {
      label: "Undo Delete Note",
      hint: formatShortcut(state.shortcuts.undoDelete),
      action: undoDeleteNote,
    },
    {
      label: "Redo Delete Note",
      hint: formatShortcut(state.shortcuts.redoDelete),
      action: redoDeleteNote,
    },
    {
      label: "View Trash",
      hint: formatShortcut(state.shortcuts.viewTrash),
      action: () => openPalette("trash"),
    },
    { label: "Empty Trash", action: emptyTrash },
    {
      label: "Toggle Edit/Preview",
      hint: formatShortcut(state.shortcuts.toggleEdit),
      action: () => setMode(state.mode === "edit" ? "preview" : "edit"),
    },
    {
      label: "Toggle Sidebar",
      hint: formatShortcut(state.shortcuts.toggleSidebar),
      action: () => toggleSidebar(),
    },
    {
      label: "Pin Window on Top",
      hint: formatShortcut(state.shortcuts.pinWindow),
      action: () => togglePin(),
    },
    {
      label: "Copy Note as Markdown",
      hint: formatShortcut(state.shortcuts.copyNote),
      action: copyNoteMarkdown,
    },
    {
      label: "Settings",
      hint: formatShortcut(state.shortcuts.settings),
      action: openSettings,
    },
    {
      label: "Close Window",
      hint: formatShortcut(state.shortcuts.closeWindow),
      action: () => closeCurrentWindow(),
    },
  ];
}

function openPalette(mode = "notes") {
  state.paletteMode = mode;
  state.selectedPaletteIndex = 0;
  palette.classList.remove("hidden");
  paletteInput.value = "";
  paletteInput.placeholder =
    mode === "trash" ? "Search trash..." : "Type a command or search notes...";
  paletteInput.focus();
  renderPalette();
}

function closePalette() {
  state.paletteMode = null;
  palette.classList.add("hidden");
  paletteInput.value = "";
}

let paletteSearchTimeout = null;

function renderPalette() {
  const query = paletteInput.value.toLowerCase();

  if (state.paletteMode === "trash") {
    paletteInput.placeholder = "Search trash...";
    clearTimeout(paletteSearchTimeout);
    paletteSearchTimeout = setTimeout(async () => {
      const trashNotes = await invoke("list_trash");
      const filtered = query
        ? trashNotes.filter(
            (n) =>
              n.title.toLowerCase().includes(query) ||
              n.preview.toLowerCase().includes(query),
          )
        : trashNotes;
      if (filtered.length === 0) {
        renderPaletteItems([
          { label: "Trash is empty", hint: "", action: () => closePalette() },
        ]);
        return;
      }
      const items = filtered.map((n) => ({
        label: n.title,
        hint: formatDate(n.modified),
        action: () => restoreFromTrash(n.id),
      }));
      // Add "Empty Trash" action at the bottom
      items.push({
        label: "Empty Trash",
        hint: `${filtered.length} notes`,
        action: async () => {
          await emptyTrash();
          openPalette("trash");
        },
      });
      renderPaletteItems(items);
    }, 100);
    return;
  }

  if (state.paletteMode === "commands" || query.startsWith(">")) {
    const q = query.replace(/^>\s*/, "");
    const items = getCommands()
      .filter((c) => c.label.toLowerCase().includes(q))
      .map((c) => ({
        label: c.label,
        hint: c.hint,
        action: c.action,
      }));
    renderPaletteItems(items);
  } else {
    // Notes search — debounce backend call, pinned first
    clearTimeout(paletteSearchTimeout);
    if (!query) {
      // Show pinned first, then recent notes
      const pinnedItems = state.notes
        .filter((n) => isNotePinned(n.id))
        .map((n) => ({
          label: n.title,
          hint: "pinned",
          action: () => selectNote(n.id),
          pinned: true,
        }));
      const unpinnedItems = state.notes
        .filter((n) => !isNotePinned(n.id))
        .slice(0, 50 - pinnedItems.length)
        .map((n) => ({
          label: n.title,
          hint: formatDate(n.modified),
          action: () => selectNote(n.id),
        }));
      renderPaletteItems([...pinnedItems, ...unpinnedItems]);
    } else {
      paletteSearchTimeout = setTimeout(async () => {
        const results = await invoke("search_notes", { query, limit: 50 });
        // Sort pinned to top of search results
        const pinnedResults = results.filter((n) => isNotePinned(n.id));
        const unpinnedResults = results.filter((n) => !isNotePinned(n.id));
        const sorted = [...pinnedResults, ...unpinnedResults];
        const items = sorted.map((n) => ({
          label: n.title,
          hint: isNotePinned(n.id) ? "pinned" : formatDate(n.modified),
          action: () => selectNote(n.id),
          pinned: isNotePinned(n.id),
        }));
        renderPaletteItems(items);
      }, 150);
    }
  }
}

function renderPaletteItems(items) {
  if (state.selectedPaletteIndex >= items.length) {
    state.selectedPaletteIndex = Math.max(0, items.length - 1);
  }

  paletteResults.innerHTML = items
    .map(
      (item, i) => `
    <li class="palette-item ${i === state.selectedPaletteIndex ? "selected" : ""}${item.pinned ? " palette-item-pinned" : ""}" data-index="${i}">
      <span class="palette-item-label">${item.pinned ? `<span class="palette-pin-icon">${PIN_ICON_SVG}</span>` : ""}${escapeHtml(item.label)}</span>
      <span class="palette-item-hint">${escapeHtml(item.hint)}</span>
    </li>
  `,
    )
    .join("");

  // Store actions for execution
  paletteResults._items = items;

  paletteResults.querySelectorAll(".palette-item").forEach((el) => {
    el.addEventListener("click", () => {
      const idx = parseInt(el.dataset.index);
      executePaletteItem(idx);
    });
  });
}

function executePaletteItem(index) {
  const items = paletteResults._items;
  if (items && items[index]) {
    closePalette();
    items[index].action();
  }
}

// ─── Sidebar ───
function toggleSidebar() {
  if (isSticky) return;
  state.sidebarOpen = !state.sidebarOpen;
  sidebar.classList.toggle("open", state.sidebarOpen);
}

// ─── Pin ───
async function togglePin() {
  state.pinned = !state.pinned;
  await getCurrentWindow().setAlwaysOnTop(state.pinned);
  document.getElementById("btn-pin").classList.toggle("active", state.pinned);
}

// ─── Event listeners ───
let _saveTimeout = null;
function scheduleSave() {
  state.dirty = true;
  clearTimeout(_saveTimeout);
  _saveTimeout = setTimeout(() => saveCurrentNote(), 800);
}

function setupEventListeners() {
  // Editor input — adapter forwards from whichever backend is active
  editor.onInput(scheduleSave);

  // Search (debounced, backend-powered)
  search.addEventListener("input", () => {
    clearTimeout(searchTimeout);
    const query = search.value.trim();
    searchTimeout = setTimeout(() => handleSearch(query), 200);
  });

  // Palette input
  paletteInput.addEventListener("input", renderPalette);
  paletteInput.addEventListener("keydown", (e) => {
    const items = paletteResults._items || [];
    if (e.key === "ArrowDown") {
      e.preventDefault();
      state.selectedPaletteIndex = Math.min(
        state.selectedPaletteIndex + 1,
        items.length - 1,
      );
      renderPalette();
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      state.selectedPaletteIndex = Math.max(state.selectedPaletteIndex - 1, 0);
      renderPalette();
    } else if (e.key === "Enter") {
      e.preventDefault();
      executePaletteItem(state.selectedPaletteIndex);
    } else if (e.key === "Escape") {
      closePalette();
    }
  });

  // Palette backdrop click
  document
    .querySelector(".palette-backdrop")
    ?.addEventListener("click", closePalette);

  // Titlebar buttons
  document
    .getElementById("btn-sidebar")
    .addEventListener("click", toggleSidebar);
  document
    .getElementById("btn-settings")
    .addEventListener("click", openSettings);
  document.getElementById("btn-pin").addEventListener("click", togglePin);
  document.getElementById("btn-new").addEventListener("click", createNote);
  document
    .getElementById("btn-close")
    .addEventListener("click", () => closeCurrentWindow());
  document
    .getElementById("btn-minimize")
    .addEventListener("click", () => getCurrentWindow().minimize());

  // Sticky: CSS -webkit-app-region / data-tauri-drag-region fail to hit the gap between tint and
  // window controls on transparent WKWebView; use the window API instead.
  if (isSticky) {
    const tb = document.getElementById("titlebar");
    tb.removeAttribute("data-tauri-drag-region");
    document
      .querySelector(".titlebar-drag-spacer")
      ?.removeAttribute("data-tauri-drag-region");
    tb.addEventListener("mousedown", (e) => {
      if (e.button !== 0) return;
      if (
        e.target.closest(".titlebar-btn") ||
        e.target.closest(".sticky-tint-dd")
      )
        return;
      void getCurrentWindow().startDragging();
    });
  }

  // Drag & drop
  setupDropHandler();

  // ─── Block web-app behaviors to feel native ───
  // Prevent right-click context menu (except in text inputs, preview, and the live editor)
  document.addEventListener("contextmenu", (e) => {
    if (!e.target.closest("textarea, input, #preview, .cm-editor")) {
      e.preventDefault();
    }
  });

  // Block refresh, devtools, and other browser-revealing shortcuts
  document.addEventListener(
    "keydown",
    (e) => {
      const meta = e.metaKey || e.ctrlKey;
      // F5 / Cmd+R / Ctrl+R — refresh
      if (e.key === "F5" || (meta && e.key === "r")) {
        e.preventDefault();
        return;
      }
      // Cmd+Shift+R / Ctrl+Shift+R — hard refresh
      if (meta && e.shiftKey && e.key === "R") {
        e.preventDefault();
        return;
      }
      // Cmd+Option+I / Ctrl+Shift+I — devtools
      if (
        (e.metaKey && e.altKey && e.key === "i") ||
        (e.ctrlKey && e.shiftKey && e.key === "I")
      ) {
        e.preventDefault();
        return;
      }
      // Cmd+Option+J — devtools console
      if (e.metaKey && e.altKey && e.key === "j") {
        e.preventDefault();
        return;
      }
      // Cmd+Option+U / Ctrl+U — view source
      if (
        (e.metaKey && e.altKey && e.key === "u") ||
        (e.ctrlKey && e.key === "u")
      ) {
        e.preventDefault();
        return;
      }
    },
    true,
  ); // capture phase to intercept before anything else

  // Global keyboard shortcuts
  document.addEventListener("keydown", (e) => {
    // Shortcut recording intercepts everything
    if (handleGlobalShortcutRecording(e)) return;
    if (handleShortcutRecording(e)) return;

    // CM6 (live mode) handles its own keymap (undo, redo, indent, etc.) and
    // calls preventDefault on those events. Don't double-fire app shortcuts
    // that share keys with CM6 commands (Cmd+Z, Cmd+Shift+Z).
    if (e.defaultPrevented) return;

    const sc = state.shortcuts;

    if (matchesShortcut(e, sc.openPalette)) {
      e.preventDefault();
      state.paletteMode ? closePalette() : openPalette("notes");
      return;
    }

    if (matchesShortcut(e, sc.commandPalette)) {
      e.preventDefault();
      state.paletteMode ? closePalette() : openPalette("commands");
      return;
    }

    if (matchesShortcut(e, sc.settings)) {
      e.preventDefault();
      if (!isSticky) {
        state.settingsOpen ? closeSettings() : openSettings();
      }
      return;
    }

    if (matchesShortcut(e, sc.newSticky)) {
      e.preventDefault();
      openNewSticky();
      return;
    }

    if (matchesShortcut(e, sc.newNote)) {
      e.preventDefault();
      if (isSticky) {
        openNewSticky();
      } else {
        createNote();
      }
      return;
    }

    if (matchesShortcut(e, sc.toggleEdit)) {
      e.preventDefault();
      if (state.currentId) {
        if (state.mode === "edit" || state.mode === "live") {
          setMode("preview");
        } else {
          const target = getPreferredEditor() === "live" ? "live" : "edit";
          setMode(target);
          editor.focus();
        }
      }
      return;
    }

    if (matchesShortcut(e, sc.toggleLive)) {
      e.preventDefault();
      if (state.currentId) {
        setMode(state.mode === "live" ? "preview" : "live");
      }
      return;
    }

    if (matchesShortcut(e, sc.toggleSidebar)) {
      e.preventDefault();
      if (!isSticky) toggleSidebar();
      return;
    }

    if (matchesShortcut(e, sc.save)) {
      e.preventDefault();
      saveCurrentNote();
      return;
    }

    if (matchesShortcut(e, sc.deleteNote)) {
      e.preventDefault();
      deleteCurrentNote();
      return;
    }

    if (matchesShortcut(e, sc.redoDelete)) {
      e.preventDefault();
      redoDeleteNote();
      return;
    }

    if (matchesShortcut(e, sc.undoDelete)) {
      e.preventDefault();
      undoDeleteNote();
      return;
    }

    if (matchesShortcut(e, sc.viewTrash)) {
      e.preventDefault();
      openPalette("trash");
      return;
    }

    if (matchesShortcut(e, sc.copyNote)) {
      e.preventDefault();
      copyNoteMarkdown();
      return;
    }

    if (matchesShortcut(e, sc.pinNote)) {
      e.preventDefault();
      if (state.currentId) {
        toggleNotePin(state.currentId);
        showCopyToast(
          isNotePinned(state.currentId) ? "Note pinned" : "Note unpinned",
        );
      }
      return;
    }

    if (matchesShortcut(e, sc.pinWindow)) {
      e.preventDefault();
      togglePin();
      return;
    }

    if (matchesShortcut(e, sc.closeWindow)) {
      e.preventDefault();
      closeCurrentWindow();
      return;
    }

    // Escape: exit settings, palette, or any active editor mode
    if (e.key === "Escape") {
      if (state.settingsOpen) {
        closeSettings();
      } else if (state.paletteMode) {
        closePalette();
      } else if (state.mode === "edit" || state.mode === "live") {
        setMode("preview");
      }
      return;
    }

    const meta = e.metaKey || e.ctrlKey;

    // Enter edit mode when typing (if in preview and no modifier).
    // Honors the persisted editor preference so a user who chose live mode
    // doesn't get yanked back to raw textarea after relaunching.
    if (
      state.mode === "preview" &&
      state.currentId &&
      !state.paletteMode &&
      !state.settingsOpen &&
      !meta &&
      !e.altKey &&
      e.key.length === 1
    ) {
      const target = getPreferredEditor() === "live" ? "live" : "edit";
      setMode(target);
      editor.focus();
    }

    // Navigate notes with arrow keys when not editing
    if (state.mode === "preview" && !state.paletteMode && !state.settingsOpen) {
      if (e.key === "ArrowDown" || e.key === "j") {
        e.preventDefault();
        navigateNotes(1);
      } else if (e.key === "ArrowUp" || e.key === "k") {
        e.preventDefault();
        navigateNotes(-1);
      }
    }

    // Todo keyboard navigation in preview mode
    if (state.mode === "preview" && !state.paletteMode && !state.settingsOpen) {
      const todos = preview.querySelectorAll(".todo-item");
      if (todos.length > 0) {
        const focused = document.activeElement?.closest(".todo-item");
        if (e.key === "Tab" && !e.metaKey && !e.ctrlKey && !e.altKey) {
          e.preventDefault();
          const items = Array.from(todos);
          if (!focused) {
            items[e.shiftKey ? items.length - 1 : 0].focus();
          } else {
            const idx = items.indexOf(focused);
            const next = e.shiftKey ? idx - 1 : idx + 1;
            if (next >= 0 && next < items.length) {
              items[next].focus();
            }
          }
          return;
        }
      }
    }

    // Focus search
    if (
      e.key === "/" &&
      state.mode === "preview" &&
      !state.paletteMode &&
      !state.settingsOpen &&
      !isSticky
    ) {
      e.preventDefault();
      if (!state.sidebarOpen) toggleSidebar();
      search.focus();
    }
  });

  // Tab handling and line duplicate in the raw textarea. CM6 ships its own
  // keymap (indentWithTab, copyLineUp/Down, moveLineUp/Down) so these handlers
  // are intentionally textarea-scoped.
  editorEl.addEventListener("keydown", (e) => {
    if (e.key === "Tab") {
      e.preventDefault();
      const start = editorEl.selectionStart;
      const end = editorEl.selectionEnd;
      editorEl.value =
        editorEl.value.substring(0, start) + "  " + editorEl.value.substring(end);
      editorEl.selectionStart = editorEl.selectionEnd = start + 2;
      state.dirty = true;
    }

    // Option+Arrow: duplicate line up/down
    if (
      e.altKey &&
      (e.key === "ArrowDown" || e.key === "ArrowUp") &&
      e.shiftKey
    ) {
      e.preventDefault();
      const val = editorEl.value;
      const cursor = editorEl.selectionStart;
      const selEnd = editorEl.selectionEnd;
      const lineStart = val.lastIndexOf("\n", cursor - 1) + 1;
      const lineEnd = val.indexOf("\n", selEnd);
      const end = lineEnd === -1 ? val.length : lineEnd;
      const line = val.slice(lineStart, end);

      if (e.key === "ArrowDown") {
        editorEl.value = val.slice(0, end) + "\n" + line + val.slice(end);
        editorEl.selectionStart = cursor + line.length + 1;
        editorEl.selectionEnd = selEnd + line.length + 1;
      } else {
        editorEl.value =
          val.slice(0, lineStart) + line + "\n" + val.slice(lineStart);
        editorEl.selectionStart = cursor;
        editorEl.selectionEnd = selEnd;
      }
      state.dirty = true;
    }

    // Option+Arrow (no shift/cmd/ctrl): move line(s) up/down — VSCode-style
    if (
      e.altKey &&
      !e.shiftKey &&
      !e.metaKey &&
      !e.ctrlKey &&
      (e.key === "ArrowDown" || e.key === "ArrowUp")
    ) {
      e.preventDefault();
      const val = editorEl.value;
      const cursor = editorEl.selectionStart;
      const selEnd = editorEl.selectionEnd;
      const blockStart = val.lastIndexOf("\n", cursor - 1) + 1;
      const lineEndIdx = val.indexOf("\n", selEnd);
      const blockEnd = lineEndIdx === -1 ? val.length : lineEndIdx;

      if (e.key === "ArrowUp") {
        if (blockStart === 0) return;
        const prevLineStart = val.lastIndexOf("\n", blockStart - 2) + 1;
        const block = val.slice(blockStart, blockEnd);
        const prevLine = val.slice(prevLineStart, blockStart - 1);
        editorEl.value =
          val.slice(0, prevLineStart) +
          block +
          "\n" +
          prevLine +
          val.slice(blockEnd);
        const offset = -(prevLine.length + 1);
        editorEl.selectionStart = cursor + offset;
        editorEl.selectionEnd = selEnd + offset;
      } else {
        if (blockEnd >= val.length) return;
        const nextLineEndIdx = val.indexOf("\n", blockEnd + 1);
        const nextLineEnd =
          nextLineEndIdx === -1 ? val.length : nextLineEndIdx;
        const block = val.slice(blockStart, blockEnd);
        const nextLine = val.slice(blockEnd + 1, nextLineEnd);
        editorEl.value =
          val.slice(0, blockStart) +
          nextLine +
          "\n" +
          block +
          val.slice(nextLineEnd);
        const offset = nextLine.length + 1;
        editorEl.selectionStart = cursor + offset;
        editorEl.selectionEnd = selEnd + offset;
      }
      state.dirty = true;
      editorEl.dispatchEvent(new Event("input", { bubbles: true }));
    }
  });
}

function navigateNotes(direction) {
  if (state.notes.length === 0) return;
  // Build the visual order: pinned first, then unpinned (matches renderNoteList)
  const displayNotes = state.searchQuery
    ? state.notes.filter(
        (n) =>
          n.title.toLowerCase().includes(state.searchQuery.toLowerCase()) ||
          n.preview.toLowerCase().includes(state.searchQuery.toLowerCase()),
      )
    : state.notes;
  const pinned = displayNotes.filter((n) => isNotePinned(n.id));
  const unpinned = displayNotes.filter((n) => !isNotePinned(n.id));
  const visualOrder = [...pinned, ...unpinned];

  if (visualOrder.length === 0) return;
  const currentIndex = visualOrder.findIndex((n) => n.id === state.currentId);
  const newIndex = Math.max(
    0,
    Math.min(visualOrder.length - 1, currentIndex + direction),
  );
  if (newIndex !== currentIndex) {
    selectNote(visualOrder[newIndex].id);
  }
}

// ─── Tauri event listeners ───
function setupTauriListeners() {
  listen("quick-capture", () => {
    if (isSticky) return;
    createNote();
  });
}

// ─── Utilities ───
function formatDate(timestamp) {
  if (!timestamp) return "";
  const date = new Date(timestamp * 1000);
  const now = new Date();
  const diff = now - date;

  if (diff < 60000) return "just now";
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
  if (diff < 604800000) return `${Math.floor(diff / 86400000)}d ago`;

  return date.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
  });
}

// ─── Boot ───
init().catch((err) => {
  console.error("init() failed:", err);
  hideSplash();
});
