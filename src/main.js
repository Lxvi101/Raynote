import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { listen } from "@tauri-apps/api/event";
import { open as shellOpen } from "@tauri-apps/plugin-shell";
import hljs from "highlight.js";
import "highlight.js/styles/github-dark-dimmed.min.css";
import "katex/dist/katex.min.css";
import { editor, TextareaBackend } from "./editor-adapter.js";
import { forgetAssetBlobUrl, loadAssetImage } from "./asset-cache.js";
import { ByteLruCache } from "./byte-lru-cache.js";
import "./style.css";

// ─── Spaces ───
// A space is one of up to MAX_SPACES workspaces, each backed by its own
// folder on disk under Raynote/Spaces/<id>/. The user picks an emoji + name
// per space. The active space is persisted in localStorage; sticky windows
// override the active space via the `space` URL parameter.
//
// The default space (id "default") is created on first launch and holds any
// notes that existed before the spaces feature was introduced. It can be
// renamed and re-emoji'd, but never deleted — see delete_space in lib.rs.
const STORAGE_SPACES = "raynote-spaces";
const STORAGE_CURRENT_SPACE = "raynote-current-space";
const STORAGE_SPACE_SWITCH_ANIM = "raynote-space-switch-animation";
const SPACE_SWITCH_ANIM_MS = 120;
const DEFAULT_SPACE_ID = "default";
const MAX_SPACES = 4;
const DEFAULT_SPACE_NAME = "Notes";
const DEFAULT_SPACE_EMOJI = "📝";
const NEW_SPACE_NAME_SUGGESTIONS = ["Personal", "Work", "Ideas", "Projects"];
const NEW_SPACE_EMOJI_SUGGESTIONS = ["💼", "💡", "🎨", "🧪"];

function sanitizeSpace(s) {
  if (!s || typeof s !== "object") return null;
  if (typeof s.id !== "string" || !s.id) return null;
  const name = typeof s.name === "string" && s.name.trim() ? s.name : DEFAULT_SPACE_NAME;
  const emoji = typeof s.emoji === "string" && s.emoji ? s.emoji : DEFAULT_SPACE_EMOJI;
  return { id: s.id, name, emoji };
}

function getSpaces() {
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_SPACES) || "null");
    if (Array.isArray(raw) && raw.length > 0) {
      const list = raw.map(sanitizeSpace).filter(Boolean);
      if (list.length > 0) {
        // Always ensure the default space exists at index 0 — protects against
        // settings-panel edits accidentally removing it.
        if (!list.some((s) => s.id === DEFAULT_SPACE_ID)) {
          list.unshift({
            id: DEFAULT_SPACE_ID,
            name: DEFAULT_SPACE_NAME,
            emoji: DEFAULT_SPACE_EMOJI,
          });
        }
        return list.slice(0, MAX_SPACES);
      }
    }
  } catch {
    /* fall through to default */
  }
  return [{ id: DEFAULT_SPACE_ID, name: DEFAULT_SPACE_NAME, emoji: DEFAULT_SPACE_EMOJI }];
}

function saveSpaces(spaces) {
  const cleaned = spaces.map(sanitizeSpace).filter(Boolean).slice(0, MAX_SPACES);
  if (!cleaned.some((s) => s.id === DEFAULT_SPACE_ID)) {
    cleaned.unshift({
      id: DEFAULT_SPACE_ID,
      name: DEFAULT_SPACE_NAME,
      emoji: DEFAULT_SPACE_EMOJI,
    });
  }
  localStorage.setItem(STORAGE_SPACES, JSON.stringify(cleaned));
}

function getStoredCurrentSpaceId() {
  const id = localStorage.getItem(STORAGE_CURRENT_SPACE);
  const spaces = getSpaces();
  if (id && spaces.some((s) => s.id === id)) return id;
  return spaces[0].id;
}

function setStoredCurrentSpaceId(id) {
  localStorage.setItem(STORAGE_CURRENT_SPACE, id);
}

function isSpaceSwitchAnimationEnabled() {
  return localStorage.getItem(STORAGE_SPACE_SWITCH_ANIM) !== "0";
}

function applySpaceSwitchAnimationPref() {
  const on =
    isSpaceSwitchAnimationEnabled() &&
    !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  document.documentElement.classList.toggle("space-switch-animate", on);
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function playSpaceSwitchAnimOut() {
  if (!document.documentElement.classList.contains("space-switch-animate")) {
    return wait(0);
  }
  document.documentElement.classList.add("space-switch-out");
  document.documentElement.classList.remove("space-switch-in");
  return wait(SPACE_SWITCH_ANIM_MS);
}

function playSpaceSwitchAnimIn() {
  if (!document.documentElement.classList.contains("space-switch-animate")) {
    return;
  }
  document.documentElement.classList.remove("space-switch-out");
}

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
async function autoGenerateTitle(noteId, content, noteSpaceId) {
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

    // Persist to disk. Use the space the note belongs to — not the active
    // one — so a slow title request that returns after the user switched
    // spaces still saves to the right folder.
    await invoke("save_note", {
      space: noteSpaceId,
      id: noteId,
      content: updatedContent,
    });
    deleteDiskCachedPreviewHtml(noteId, noteSpaceId);

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
// Sticky windows are pinned to the space they were opened from. The main
// window reads the active space from localStorage and writes it back when
// the user switches.
const stickySpaceId = urlParams.get("space") || DEFAULT_SPACE_ID;
const initialSpaceId = isSticky ? stickySpaceId : getStoredCurrentSpaceId();
if (isSticky) {
  document.documentElement.classList.add("sticky-mode");
}

// Apply persisted edge-glow prefs as early as possible so the rim renders
// in its configured state on first paint instead of flashing the default.
applyGlowSettings();
applySpaceSwitchAnimationPref();

/** Fade out and remove the inline splash from index.html. Idempotent. */
function hideSplash() {
  const splash = document.getElementById("splash");
  if (!splash || splash.classList.contains("hidden")) return;
  splash.classList.add("hidden");
  setTimeout(() => splash.remove(), 300);
}

function showNotesLoadingState(message = "Loading iCloud notes...") {
  titlebarTitle.textContent = "Loading notes...";
  noteList.innerHTML = `
    <li class="note-list-loading" aria-live="polite">
      <span class="note-list-loading-spinner"></span>
      <span>${escapeHtml(message)}</span>
    </li>
  `;
  preview.innerHTML = `
    <div class="preview-loading preview-loading-with-text" aria-live="polite">
      <span>${escapeHtml(message)}</span>
    </div>
  `;
  editorEl.classList.remove("visible");
  preview.classList.add("visible");
}

/** Build (or return) the small red progress pill above the note list.
 *
 * The pill is what carries the "Loading 12 of 51 notes from iCloud…"
 * message during the initial scan after a Mac restart, when iCloud has
 * evicted file contents and downloads have to happen serially. We keep
 * it alive across the whole scan so the user always sees the count
 * moving — that's the "tell them what's going on" piece of the fix. */
function ensureNotesLoadingBanner() {
  let banner = document.getElementById("notes-loading-banner");
  if (banner) return banner;
  banner = document.createElement("div");
  banner.id = "notes-loading-banner";
  banner.className = "notes-loading-banner";
  banner.setAttribute("aria-live", "polite");
  banner.innerHTML = `
    <span class="notes-loading-banner-spinner" aria-hidden="true"></span>
    <span class="notes-loading-banner-text">Syncing with iCloud…</span>
  `;
  const sb = document.getElementById("sidebar");
  const nl = document.getElementById("note-list");
  if (sb && nl) {
    sb.insertBefore(banner, nl);
  }
  return banner;
}

// Avoid flashing the banner on warm restarts where the mtime fast-path
// finishes the scan in well under a second. We only mount the banner once
// the scan has been running for this long.
const BANNER_SHOW_AFTER_MS = 250;
let scanStartTime = null;

function updateNotesLoadingBanner(progress) {
  if (scanStartTime === null) {
    scanStartTime = performance.now();
  }
  if (performance.now() - scanStartTime < BANNER_SHOW_AFTER_MS) {
    return;
  }
  const banner = ensureNotesLoadingBanner();
  banner.classList.remove("hidden");
  const text = banner.querySelector(".notes-loading-banner-text");
  if (!text) return;
  const done = progress && typeof progress.done === "number" ? progress.done : null;
  const total = progress && typeof progress.total === "number" ? progress.total : null;
  if (done !== null && total !== null && total > 0) {
    text.textContent = `Loading ${done} of ${total} notes from iCloud…`;
  } else {
    text.textContent = "Syncing with iCloud…";
  }
}

function hideNotesLoadingBanner() {
  scanStartTime = null;
  const banner = document.getElementById("notes-loading-banner");
  if (!banner) return;
  banner.classList.add("hidden");
  // Match the CSS transition (220ms) before removing from the DOM so the
  // fade-out plays. Idempotent on repeated calls.
  setTimeout(() => banner.remove(), 240);
}

// Coalesce a burst of note-meta-loaded events into one rerender per frame.
let pendingNoteListRender = false;
function scheduleNoteListRender() {
  if (pendingNoteListRender) return;
  pendingNoteListRender = true;
  requestAnimationFrame(() => {
    pendingNoteListRender = false;
    renderNoteList();
  });
}

/** Splice a single NoteMeta delivered by the streaming scan into state.notes.
 *
 * The backend's scan emits one of these per file in directory order. We
 * insert by `modified` descending so the sidebar reads correctly while it
 * fills. state.totalNotes / state.notesOffset stay alone here — the final
 * `notes-loaded` event triggers refreshNotesFromBackend, which re-syncs
 * pagination from the now-authoritative backend cache. */
function upsertNoteFromScan(meta) {
  if (!meta || typeof meta.id !== "string") return;
  if (state.searchQuery) return;
  const idx = state.notes.findIndex((n) => n.id === meta.id);
  if (idx >= 0) {
    const prev = state.notes[idx];
    state.notes[idx] = meta;
    if (prev.modified !== meta.modified) {
      state.notes.sort((a, b) => b.modified - a.modified);
    }
  } else {
    let insertAt = state.notes.length;
    for (let i = 0; i < state.notes.length; i++) {
      if (state.notes[i].modified < meta.modified) {
        insertAt = i;
        break;
      }
    }
    state.notes.splice(insertAt, 0, meta);
  }
  scheduleNoteListRender();
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

const MAX_TITLE_LEN = 80;

function truncateTitle(title) {
  if (!title || title.length <= MAX_TITLE_LEN) return title;
  return `${title.slice(0, MAX_TITLE_LEN)}…`;
}

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
  toggleEdit: { label: "Toggle Source Mode", key: "e", meta: true },
  toggleLive: { label: "Toggle Reading Mode", key: "l", meta: true, shift: true },
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
// Pins are per-space; the legacy "raynote-pinned-notes" key (single-list,
// from before the spaces feature) is migrated into the default space's key
// on first read so existing pins are preserved.
function pinnedNotesStorageKey(spaceId) {
  return `raynote-pinned-notes-${spaceId}`;
}

function loadPinnedNotes(spaceId) {
  const key = pinnedNotesStorageKey(spaceId);
  try {
    const raw = localStorage.getItem(key);
    if (raw !== null) return new Set(JSON.parse(raw));
  } catch {
    /* fall through to legacy migration */
  }
  if (spaceId === DEFAULT_SPACE_ID) {
    try {
      const legacy = localStorage.getItem("raynote-pinned-notes");
      if (legacy) {
        const ids = JSON.parse(legacy);
        localStorage.setItem(key, JSON.stringify(ids));
        localStorage.removeItem("raynote-pinned-notes");
        return new Set(ids);
      }
    } catch {
      /* nothing */
    }
  }
  return new Set();
}

function savePinnedNotes(pinnedSet, spaceId) {
  localStorage.setItem(
    pinnedNotesStorageKey(spaceId),
    JSON.stringify([...pinnedSet]),
  );
}

function toggleNotePin(id) {
  if (state.pinnedNotes.has(id)) {
    state.pinnedNotes.delete(id);
  } else {
    state.pinnedNotes.add(id);
  }
  savePinnedNotes(state.pinnedNotes, state.currentSpaceId);
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
  currentSpaceId: initialSpaceId,
  pinnedNotes: loadPinnedNotes(initialSpaceId),
  currentId: null,
  // 'live' | 'edit' | 'preview'. Starts on the preferred editing surface so
  // the first note opens there; selectNote keeps whatever mode the user is in.
  // Reads localStorage directly: getPreferredEditor()'s STORAGE_ const isn't
  // initialized yet at this point in module evaluation (TDZ).
  mode:
    localStorage.getItem("raynote-preferred-editor") === "textarea"
      ? "edit"
      : "live",
  // The note canvas is the default focus. The notes panel is revealed on
  // demand from the first titlebar action or the existing shortcut.
  sidebarOpen: false,
  pinned: false,
  dirty: false,
  // False while a note's content is being fetched — blocks scheduleSave and
  // saveCurrentNote so text still belonging to the PREVIOUS note can never be
  // written under the new note's id.
  contentReady: false,
  paletteMode: null, // null | 'notes' | 'commands'
  selectedPaletteIndex: 0,
  settingsOpen: false,
  recordingShortcut: null, // shortcut id being recorded
  recordingGlobalShortcut: null, // global shortcut role being recorded ("capture" | "toggle")
  shortcuts: loadShortcuts(),
};

// ─── Preview HTML cache ───
const PREVIEW_CACHE_MAX = 60;
const PREVIEW_CACHE_MAX_BYTES = 32 * 1024 * 1024;
const previewCache = new ByteLruCache({
  maxEntries: PREVIEW_CACHE_MAX,
  maxBytes: PREVIEW_CACHE_MAX_BYTES,
  // JS strings can occupy two bytes per code unit. Count both strings even
  // though engines may share the content reference with contentCache.
  sizeOf: ({ html, content }) => (html.length + content.length) * 2,
});
let renderGeneration = 0; // monotonically increasing; guards against race conditions

function cachePreviewHtml(noteId, content, html) {
  previewCache.set(noteId, { html, content });
}

function getCachedPreviewHtml(noteId, content) {
  const entry = previewCache.get(noteId);
  if (entry && entry.content === content) {
    return entry.html;
  }
  return null;
}

function invalidatePreviewCache(noteId) {
  previewCache.delete(noteId);
  warmPreviewDone.delete(noteId);
}

async function hashContent(content) {
  if (globalThis.crypto?.subtle) {
    const bytes = new TextEncoder().encode(content);
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    return [...new Uint8Array(digest)]
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  }

  // Non-cryptographic fallback for unusual WebView contexts without SubtleCrypto.
  let h = 2166136261;
  for (let i = 0; i < content.length; i++) {
    h ^= content.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

async function getDiskCachedPreviewHtml(noteId, contentHash) {
  try {
    return await invoke("read_preview_cache", {
      space: state.currentSpaceId,
      id: noteId,
      contentHash,
    });
  } catch (err) {
    console.warn("Failed to read preview cache:", err);
    return null;
  }
}

function writeDiskCachedPreviewHtml(noteId, contentHash, html) {
  invoke("write_preview_cache", {
    space: state.currentSpaceId,
    id: noteId,
    contentHash,
    html,
  }).catch((err) => {
    console.warn("Failed to write preview cache:", err);
  });
}

function deleteDiskCachedPreviewHtml(noteId, spaceOverride) {
  // Callers that have a stale spaceOverride (e.g. a slow auto-title request
  // returning after the user switched spaces) must pass it explicitly so we
  // wipe the right space's cache rather than the currently-active one's.
  invoke("delete_preview_cache", {
    space: spaceOverride || state.currentSpaceId,
    id: noteId,
  }).catch(() => {});
}

// ─── Note content cache ───
// Switching to a note used to re-read it from disk every time via the
// read_note IPC call. Notes live in iCloud Drive, so that round-trip can
// stall on an on-demand download — which is what made note switching lag
// even though the *rendered* HTML was cached. Keep the raw content around
// too, keyed by id, refreshed on save and dropped on delete.
const CONTENT_CACHE_MAX = 80;
const CONTENT_CACHE_MAX_BYTES = 24 * 1024 * 1024;
const contentCache = new ByteLruCache({
  maxEntries: CONTENT_CACHE_MAX,
  maxBytes: CONTENT_CACHE_MAX_BYTES,
  sizeOf: (content) => content.length * 2,
});

function cacheContent(noteId, content) {
  return contentCache.set(noteId, content);
}

/** Returns the cached content string, or null if this note isn't cached. */
function getCachedContent(noteId) {
  const content = contentCache.get(noteId);
  return content === undefined ? null : content;
}

function hasCachedContent(noteId) {
  return contentCache.has(noteId);
}

function invalidateContentCache(noteId) {
  contentCache.delete(noteId);
}

// Share native reads between a foreground selection and an idle prefetch.
// Without this, clicking a note just as the warmer reaches it can start two
// concurrent iCloud downloads for the same file.
const noteReadsInFlight = new Map(); // Map<space:id, Promise<NoteReadResult>>

function readNoteContent(space, id) {
  const key = `${space}:${id}`;
  const existing = noteReadsInFlight.get(key);
  if (existing) return existing;

  const pending = invoke("read_note", { space, id })
    .then((result) => {
      // Keep a compatibility fallback for a frontend hot reload paired with
      // an older native process that still returns the bare content string.
      if (typeof result === "string") {
        return { content: result, cacheHit: false };
      }
      return {
        content: typeof result?.content === "string" ? result.content : "",
        cacheHit: result?.cacheHit === true,
      };
    })
    .finally(() => {
      if (noteReadsInFlight.get(key) === pending) {
        noteReadsInFlight.delete(key);
      }
    });

  noteReadsInFlight.set(key, pending);
  return pending;
}

// ─── Markdown render worker ───
// `marked.parse()` can be expensive enough to freeze note switching. Keep it
// off the UI thread on cache misses, and terminate stale work when the user
// clicks through notes quickly.
let markdownWorker = null;
let warmMarkdownWorker = null;
let activeMarkdownRender = null;
let markdownJobId = 0;

function cancelledMarkdownRenderError() {
  const err = new Error("Markdown render cancelled");
  err.name = "AbortError";
  return err;
}

function isMarkdownRenderCancelled(err) {
  return err && err.name === "AbortError";
}

function getMarkdownWorker() {
  if (typeof Worker === "undefined") return null;
  if (!markdownWorker) {
    markdownWorker = new Worker(
      new URL("./markdown-worker.js", import.meta.url),
      { type: "module" },
    );
  }
  return markdownWorker;
}

function getWarmMarkdownWorker() {
  if (typeof Worker === "undefined") return null;
  if (!warmMarkdownWorker) {
    warmMarkdownWorker = new Worker(
      new URL("./markdown-worker.js", import.meta.url),
      { type: "module" },
    );
  }
  return warmMarkdownWorker;
}

function cancelPendingMarkdownRender() {
  if (!activeMarkdownRender) return;
  const render = activeMarkdownRender;
  activeMarkdownRender = null;
  if (markdownWorker === render.worker) {
    markdownWorker.terminate();
    markdownWorker = null;
  }
  render.cancel();
}

function renderMarkdownAsync(content) {
  cancelPendingMarkdownRender();

  const worker = getMarkdownWorker();
  if (!worker) {
    return import("./markdown-preview.js").then(({ renderMarkdown }) =>
      renderMarkdown(content),
    );
  }

  const jobId = ++markdownJobId;

  return new Promise((resolve, reject) => {
    const cleanup = () => {
      worker.removeEventListener("message", onMessage);
      worker.removeEventListener("error", onError);
      if (activeMarkdownRender?.jobId === jobId) {
        activeMarkdownRender = null;
      }
    };

    const fail = (err, resetWorker = false) => {
      cleanup();
      if (resetWorker && markdownWorker === worker) {
        markdownWorker.terminate();
        markdownWorker = null;
      }
      reject(err);
    };

    const onMessage = (event) => {
      const data = event.data || {};
      if (data.id !== jobId) return;
      if (data.ok) {
        cleanup();
        resolve(data.html);
      } else {
        fail(new Error(data.error || "Markdown render failed"), true);
      }
    };

    const onError = (event) => {
      fail(new Error(event.message || "Markdown render worker failed"), true);
    };

    activeMarkdownRender = {
      jobId,
      worker,
      cancel: () => {
        cleanup();
        reject(cancelledMarkdownRenderError());
      },
    };

    worker.addEventListener("message", onMessage);
    worker.addEventListener("error", onError);

    try {
      worker.postMessage({ id: jobId, content });
    } catch (err) {
      fail(err, true);
    }
  });
}

function renderMarkdownWarmAsync(content) {
  const worker = getWarmMarkdownWorker();
  if (!worker) {
    return import("./markdown-preview.js").then(({ renderMarkdown }) =>
      renderMarkdown(content),
    );
  }

  const jobId = ++markdownJobId;

  return new Promise((resolve, reject) => {
    const cleanup = () => {
      worker.removeEventListener("message", onMessage);
      worker.removeEventListener("error", onError);
    };

    const fail = (err, resetWorker = false) => {
      cleanup();
      if (resetWorker && warmMarkdownWorker === worker) {
        warmMarkdownWorker.terminate();
        warmMarkdownWorker = null;
      }
      reject(err);
    };

    const onMessage = (event) => {
      const data = event.data || {};
      if (data.id !== jobId) return;
      if (data.ok) {
        cleanup();
        resolve(data.html);
      } else {
        fail(new Error(data.error || "Markdown render failed"), true);
      }
    };

    const onError = (event) => {
      fail(new Error(event.message || "Markdown render worker failed"), true);
    };

    worker.addEventListener("message", onMessage);
    worker.addEventListener("error", onError);

    try {
      worker.postMessage({ id: jobId, content });
    } catch (err) {
      fail(err, true);
    }
  });
}

function afterNextPaint() {
  return new Promise((resolve) => {
    requestAnimationFrame(() => setTimeout(resolve, 0));
  });
}

function idleDelay(timeout = 800) {
  if ("requestIdleCallback" in window) {
    return new Promise((resolve) => {
      window.requestIdleCallback(resolve, { timeout });
    });
  }
  return new Promise((resolve) => setTimeout(resolve, Math.min(timeout, 250)));
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
const titlebarChip = $(".note-title-chip");
const titlebarTitle = $("#titlebar-title");
const titlebarTitleInput = $("#titlebar-title-input");

// ─── Editor adapter setup ───
// `editor` (imported) is the abstraction; backends are registered for each
// supported mode. The textarea backend is the only one available at boot —
// the live markdown (CM6) backend is lazy-imported (and idle-preloaded)
// since it is the default editing surface.
editor.register("textarea", new TextareaBackend(editorEl));
editor.setActive("textarea");

// Remember the last editor surface the user picked so re-launching the app
// keeps their choice. Live markdown is the default.
const STORAGE_PREFERRED_EDITOR = "raynote-preferred-editor";
function getPreferredEditor() {
  const v = localStorage.getItem(STORAGE_PREFERRED_EDITOR);
  return v === "textarea" ? "textarea" : "live";
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
          <button class="settings-nav-item" data-cat="spaces">
            <span class="settings-nav-icon"><svg width="15" height="15" viewBox="0 0 16 16" fill="none"><rect x="1.6" y="1.6" width="5.6" height="5.6" rx="1.3" stroke="currentColor" stroke-width="1.3"/><rect x="8.8" y="1.6" width="5.6" height="5.6" rx="1.3" stroke="currentColor" stroke-width="1.3"/><rect x="1.6" y="8.8" width="5.6" height="5.6" rx="1.3" stroke="currentColor" stroke-width="1.3"/><rect x="8.8" y="8.8" width="5.6" height="5.6" rx="1.3" stroke="currentColor" stroke-width="1.3"/></svg></span>
            <span>Spaces</span>
          </button>
          <button class="settings-nav-item" data-cat="files">
            <span class="settings-nav-icon"><svg width="15" height="15" viewBox="0 0 16 16" fill="none"><path d="M3 1.6h6l4 4v8.8H3V1.6Z" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/><path d="M9 1.8v4h3.8M5.2 9h5.6M5.2 11.5h4" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg></span>
            <span>Files</span>
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

          <div class="settings-cat hidden" data-cat="spaces">
            <h2 class="settings-cat-title">Spaces</h2>
            <div class="settings-group">
              <div class="settings-group-title">Your Spaces</div>
              <div class="settings-card" id="spaces-card">
                <div id="spaces-list"></div>
              </div>
              <div class="settings-group-caption">Each space is its own folder of notes, trash, and pinned items. Switch between them with <code>⌘1</code>–<code>⌘4</code>. Up to ${MAX_SPACES} spaces.</div>
              <button type="button" class="space-add-btn" id="add-space-btn">
                <svg width="13" height="13" viewBox="0 0 14 14" fill="none" aria-hidden="true"><path d="M7 1v12M1 7h12" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>
                <span>Add space</span>
              </button>
            </div>
            <div class="settings-group">
              <div class="settings-group-title">Switcher</div>
              <div class="settings-card">
                <div class="settings-item">
                  <div class="setting-info">
                    <span class="setting-label">Animate switches</span>
                    <span class="setting-desc">Fade the note list and editor when changing spaces</span>
                  </div>
                  <label class="toggle-switch">
                    <input type="checkbox" id="toggle-space-switch-anim" />
                    <span class="toggle-track"><span class="toggle-thumb"></span></span>
                  </label>
                </div>
              </div>
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

          <div class="settings-cat hidden" data-cat="files">
            <h2 class="settings-cat-title">Files</h2>
            <div class="files-summary" id="files-summary">
              <div class="files-summary-stat"><strong>—</strong><span>Files</span></div>
              <div class="files-summary-stat"><strong>—</strong><span>Storage</span></div>
              <div class="files-summary-stat"><strong>—</strong><span>Unused</span></div>
            </div>
            <div class="files-toolbar">
              <span class="files-scan-note" id="files-scan-note">Open this panel to check file references.</span>
              <div class="files-toolbar-actions">
                <button type="button" class="files-button" id="files-refresh-btn">Refresh</button>
                <button type="button" class="files-button files-button-danger" id="files-clean-btn" disabled>Remove unused</button>
              </div>
            </div>
            <div class="settings-card files-card" id="files-list">
              <div class="files-empty">Select Refresh to scan files.</div>
            </div>
            <div class="settings-group-caption">Files are stored once in the shared <code>Raynote/assets</code> folder and linked from notes. Notes in Trash still count as references so restoring them remains safe. Cleanup only happens when you ask.</div>
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
      if (item.dataset.cat === "files") refreshFilesSettings(true);
    });
  });

  panel.querySelector("#files-refresh-btn").addEventListener("click", () =>
    refreshFilesSettings(true),
  );
  panel.querySelector("#files-clean-btn").addEventListener("click", () =>
    removeUnusedFiles(),
  );
  panel.querySelector("#files-list").addEventListener("click", (event) => {
    const button = event.target.closest("button[data-file-action]");
    if (!button) return;
    const name = button.closest(".files-row")?.dataset.asset;
    if (!name) return;
    if (button.dataset.fileAction === "reveal") {
      invoke("reveal_asset", { name }).catch((err) =>
        showCopyToast(`Could not reveal file: ${err}`),
      );
    } else if (button.dataset.fileAction === "delete") {
      deleteManagedFile(name);
    }
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

  // Add space (Spaces tab)
  panel.querySelector("#add-space-btn")?.addEventListener("click", addNewSpace);

  panel.querySelector("#toggle-space-switch-anim")?.addEventListener("change", (e) => {
    localStorage.setItem(
      STORAGE_SPACE_SWITCH_ANIM,
      e.target.checked ? "1" : "0",
    );
    applySpaceSwitchAnimationPref();
  });

  return panel;
}

const settingsPanel = createSettingsPanel();

let managedFiles = [];
let managedFilesScanComplete = false;
let filesRefreshGeneration = 0;

function formatFileSize(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / 1024 ** index;
  return `${value.toFixed(index === 0 || value >= 10 ? 0 : 1)} ${units[index]}`;
}

function renderManagedFiles(files) {
  const list = document.getElementById("files-list");
  const summary = document.getElementById("files-summary");
  const cleanButton = document.getElementById("files-clean-btn");
  if (!list || !summary || !cleanButton) return;
  const unused = managedFilesScanComplete
    ? files.filter((file) => file.referenceCount === 0)
    : [];
  const totalSize = files.reduce((total, file) => total + file.size, 0);
  const unusedSize = unused.reduce((total, file) => total + file.size, 0);
  summary.innerHTML = `
    <div class="files-summary-stat"><strong>${files.length}</strong><span>Files</span></div>
    <div class="files-summary-stat"><strong>${formatFileSize(totalSize)}</strong><span>Storage</span></div>
    <div class="files-summary-stat"><strong>${managedFilesScanComplete ? unused.length : "—"}</strong><span>${managedFilesScanComplete ? `${formatFileSize(unusedSize)} unused` : "Status unknown"}</span></div>
  `;
  cleanButton.disabled = unused.length === 0;
  if (files.length === 0) {
    list.innerHTML = `<div class="files-empty">No attached files yet.</div>`;
    return;
  }
  list.innerHTML = files
    .map(
      (file) => `
        <div class="files-row" data-asset="${escapeHtml(file.name)}">
          <div class="files-row-icon" aria-hidden="true">${IMAGE_EXTS.test(file.originalName) ? "▧" : "≡"}</div>
          <div class="files-row-info">
            <span class="files-row-name" title="${escapeHtml(file.originalName)}">${escapeHtml(file.originalName)}</span>
            <span class="files-row-meta">${formatFileSize(file.size)} · ${file.referenceCount === 0 ? (managedFilesScanComplete ? '<em>Unused</em>' : "Reference status unknown") : `${file.referenceCount} ${file.referenceCount === 1 ? "reference" : "references"}`}</span>
          </div>
          <div class="files-row-actions">
            <button type="button" data-file-action="reveal" title="Show in Finder" aria-label="Show ${escapeHtml(file.originalName)} in Finder">↗</button>
            <button type="button" data-file-action="delete" class="files-row-delete" title="Delete file" aria-label="Delete ${escapeHtml(file.originalName)}">×</button>
          </div>
        </div>`,
    )
    .join("");
}

async function refreshFilesSettings(force = false) {
  const list = document.getElementById("files-list");
  const note = document.getElementById("files-scan-note");
  if (!list || !note) return;
  if (!force && managedFiles.length > 0) {
    renderManagedFiles(managedFiles);
    return;
  }
  const generation = ++filesRefreshGeneration;
  list.innerHTML = `<div class="files-empty files-loading"><span class="files-spinner"></span>Checking note references…</div>`;
  note.textContent = "Scanning only because the Files panel is open…";
  try {
    // Persist the active editor first so newly added/removed asset links are
    // part of the disk snapshot Rust is about to inspect.
    if (state.dirty && state.currentId && !(await saveCurrentNote())) {
      throw new Error("The current note could not be saved");
    }
    const inventory = await invoke("list_assets");
    if (generation !== filesRefreshGeneration) return;
    managedFiles = inventory.files;
    managedFilesScanComplete = inventory.scanComplete;
    renderManagedFiles(managedFiles);
    note.textContent = inventory.scanComplete
      ? `Checked ${new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`
      : `Cleanup unavailable — ${inventory.scanErrorCount} note location${inventory.scanErrorCount === 1 ? "" : "s"} could not be read`;
  } catch (err) {
    if (generation !== filesRefreshGeneration) return;
    managedFilesScanComplete = false;
    list.innerHTML = `<div class="files-empty files-error">Could not scan files: ${escapeHtml(String(err))}</div>`;
    note.textContent = "Scan failed";
  }
}

async function deleteManagedFile(name) {
  const file = managedFiles.find((item) => item.name === name);
  if (!file) return;
  const referenced = file.referenceCount > 0;
  const statusUnknown = !managedFilesScanComplete && !referenced;
  const ok = await showConfirmDialog({
    title: referenced || statusUnknown ? "Delete possibly linked file?" : "Delete unused file?",
    message: referenced
      ? `“${file.originalName}” is linked ${file.referenceCount} ${file.referenceCount === 1 ? "time" : "times"}. Deleting it will leave those links broken.`
      : statusUnknown
        ? `Raynote could not verify every note, so “${file.originalName}” may still be linked. Deleting it may leave a broken link.`
      : `Permanently delete “${file.originalName}”? This cannot be undone.`,
    confirmLabel: "Delete",
    destructive: true,
  });
  if (!ok) return;
  try {
    if (!referenced && managedFilesScanComplete) {
      if (state.dirty && state.currentId && !(await saveCurrentNote())) {
        throw new Error("The current note could not be saved");
      }
      const result = await invoke("delete_orphan_assets", { names: [name] });
      if (!result.deletedNames.includes(name)) {
        await refreshFilesSettings(true);
        showCopyToast("File was kept because it is now linked");
        return;
      }
    } else {
      // Linked/unknown files reach this branch only after the explicit warning
      // above; this is the intentional force-delete path.
      await invoke("delete_assets", { names: [name] });
    }
    forgetAssetBlobUrl(name);
    managedFiles = managedFiles.filter((item) => item.name !== name);
    renderManagedFiles(managedFiles);
    showCopyToast("File deleted");
  } catch (err) {
    showCopyToast(`Could not delete file: ${err}`);
  }
}

async function removeUnusedFiles() {
  if (!managedFilesScanComplete) {
    showCopyToast("Cleanup unavailable until every note can be read");
    return;
  }
  const unused = managedFiles.filter((file) => file.referenceCount === 0);
  if (unused.length === 0) return;
  const bytes = unused.reduce((total, file) => total + file.size, 0);
  const ok = await showConfirmDialog({
    title: "Remove unused files?",
    message: `Permanently delete ${unused.length} unused ${unused.length === 1 ? "file" : "files"} and free ${formatFileSize(bytes)}?`,
    confirmLabel: "Remove",
    destructive: true,
  });
  if (!ok) return;
  try {
    if (state.dirty && state.currentId && !(await saveCurrentNote())) {
      throw new Error("The current note could not be saved");
    }
    const result = await invoke("delete_orphan_assets", {
      names: unused.map((file) => file.name),
    });
    result.deletedNames.forEach(forgetAssetBlobUrl);
    const deletedNames = new Set(result.deletedNames);
    managedFiles = managedFiles.filter((file) => !deletedNames.has(file.name));
    renderManagedFiles(managedFiles);
    const skipped = result.skippedLinked;
    showCopyToast(`${result.deletedNames.length} ${result.deletedNames.length === 1 ? "file" : "files"} removed${skipped ? ` · ${skipped} now linked` : ""}`);
    if (skipped) await refreshFilesSettings(true);
  } catch (err) {
    showCopyToast(`Could not remove files: ${err}`);
    refreshFilesSettings(true);
  }
}

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
  renderSpacesSettingsList();
  document.getElementById("toggle-space-switch-anim").checked =
    isSpaceSwitchAnimationEnabled();
}

// ─── Spaces settings ───
// In-settings management of the spaces list. The sidebar switcher updates
// reactively as soon as the user edits a name, picks a new emoji, adds a
// space, or deletes one (see calls to renderSpaceSwitcher below).
function renderSpacesSettingsList() {
  const list = document.getElementById("spaces-list");
  if (!list) return;
  const spaces = getSpaces();
  list.innerHTML = spaces
    .map(
      (s, i) => `
      <div class="space-row" data-space="${escapeHtml(s.id)}">
        <button type="button"
                class="space-row-emoji"
                data-action="cycle-emoji"
                title="Click to change emoji">${escapeHtml(s.emoji || DEFAULT_SPACE_EMOJI)}</button>
        <input type="text"
               class="space-row-name setting-input"
               data-field="name"
               value="${escapeHtml(s.name)}"
               maxlength="32"
               placeholder="Space name" />
        <kbd class="space-row-shortcut">⌘${i + 1}</kbd>
        ${
          s.id === DEFAULT_SPACE_ID
            ? `<span class="space-row-default" title="The default space can be renamed but not deleted">Default</span>`
            : `<button type="button" class="space-row-delete" data-action="delete" title="Delete space">
                <svg width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="M3 4.5h10M5.5 4.5V3a1 1 0 0 1 1-1h3a1 1 0 0 1 1 1v1.5M4 4.5l.7 8.6A1.3 1.3 0 0 0 6 14.3h4a1.3 1.3 0 0 0 1.3-1.2L12 4.5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>
              </button>`
        }
      </div>
    `,
    )
    .join("");

  list.querySelectorAll(".space-row").forEach((row) => {
    const id = row.dataset.space;
    const nameInput = row.querySelector('[data-field="name"]');
    if (nameInput) {
      // Save on Enter or blur — not on every keystroke (avoids stomping
      // the cursor with a re-render mid-typing).
      const commit = () => {
        const next = nameInput.value.trim() || DEFAULT_SPACE_NAME;
        const cur = getSpaces();
        const idx = cur.findIndex((s) => s.id === id);
        if (idx < 0) return;
        if (cur[idx].name === next) return;
        cur[idx].name = next;
        saveSpaces(cur);
        renderSpaceSwitcher();
      };
      nameInput.addEventListener("blur", commit);
      nameInput.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          nameInput.blur();
        }
      });
    }

    row.querySelector('[data-action="cycle-emoji"]')?.addEventListener(
      "click",
      () => {
        // Simple inline cycle — full emoji picker is overkill for 4 spaces.
        const PALETTE = [
          "📝", "💼", "💡", "🎨", "🧪", "📚", "🎯", "🌱",
          "🚀", "🔥", "🪐", "🧠", "🎵", "💭", "📦", "🏠",
        ];
        const cur = getSpaces();
        const idx = cur.findIndex((s) => s.id === id);
        if (idx < 0) return;
        const currentEmoji = cur[idx].emoji || DEFAULT_SPACE_EMOJI;
        const pIdx = PALETTE.indexOf(currentEmoji);
        cur[idx].emoji = PALETTE[(pIdx + 1) % PALETTE.length];
        saveSpaces(cur);
        renderSpacesSettingsList();
        renderSpaceSwitcher();
      },
    );

    row.querySelector('[data-action="delete"]')?.addEventListener(
      "click",
      async (e) => {
        e.stopPropagation();
        const target = getSpaces().find((s) => s.id === id);
        if (!target) return;
        const ok = await showConfirmDialog({
          title: "Delete space?",
          message: `Delete the "${target.name}" space and all of its notes? This cannot be undone.`,
          confirmLabel: "Delete",
          destructive: true,
        });
        if (!ok) return;
        // If the user deletes the active space, hop back to default
        // *before* removing the folder so the new sidebar can load.
        if (state.currentSpaceId === id) {
          await switchToSpace(DEFAULT_SPACE_ID);
          if (state.currentSpaceId === id) return;
        }
        try {
          await invoke("delete_space", { space: id });
        } catch (err) {
          showCopyToast(`Could not delete: ${err}`);
          renderSpacesSettingsList();
          return;
        }
        const remaining = getSpaces().filter((s) => s.id !== id);
        saveSpaces(remaining);
        localStorage.removeItem(`raynote-pinned-notes-${id}`);
        localStorage.removeItem(`raynote-last-note-${id}`);
        renderSpacesSettingsList();
        renderSpaceSwitcher();
        showCopyToast("Space deleted");
      },
    );
  });

  // Add-space button enable/disable state.
  const addBtn = document.getElementById("add-space-btn");
  if (addBtn) {
    addBtn.disabled = spaces.length >= MAX_SPACES;
    addBtn.classList.toggle("disabled", spaces.length >= MAX_SPACES);
  }
}

function addNewSpace() {
  const spaces = getSpaces();
  if (spaces.length >= MAX_SPACES) return;
  const idx = spaces.length;
  const id = `s${Date.now()}`;
  const name =
    NEW_SPACE_NAME_SUGGESTIONS[idx] || `Space ${idx + 1}`;
  const emoji =
    NEW_SPACE_EMOJI_SUGGESTIONS[idx - 1] || DEFAULT_SPACE_EMOJI;
  spaces.push({ id, name, emoji });
  saveSpaces(spaces);
  renderSpacesSettingsList();
  renderSpaceSwitcher();
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

  if (!isSticky) {
    showNotesLoadingState();
    renderSpaceSwitcher();
  }

  setupEventListeners();
  setupTauriListeners();

  // For the main window, dismiss the splash as soon as the listeners are
  // attached. The streaming note-meta-loaded events fill the sidebar in
  // real time and the red progress banner above the list narrates the
  // download — staring at a frozen splash for ~3 min on a cold-iCloud
  // boot was the original bug. Sticky windows keep the original "splash
  // until the specific note is ready" flow.
  if (!isSticky) {
    hideSplash();
  }

  // Live markdown is the default surface, so warm its module NOW, in
  // parallel with the note-metadata load below. Fire-and-forget: nothing on
  // the boot path awaits it here, but the first selectNote() awaits the same
  // promise, so the chunk import overlaps the iCloud read instead of
  // serializing after it.
  ensureLiveEditor().catch(() => {});

  await loadNotesInitial();

  // Sticky-window splash dismissal still happens here, after its single
  // note is fetched. For the main window this is a no-op (hideSplash is
  // idempotent).
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
    const stickyRead = await readNoteContent(state.currentSpaceId, stickyNoteId);
    const stickyContent = stickyRead.content;
    if (!stickyContent) {
      preview.innerHTML =
        '<div class="empty-state">This sticky could not be found.</div>';
      preview.classList.add("visible");
      editorEl.classList.remove("visible");
      setupEventListeners();
      setupTauriListeners();
      return;
    }
    cacheContent(stickyNoteId, stickyContent);
    await selectNote(stickyNoteId);
    setupStickyTintPicker();
    const target = getPreferredEditor() === "live" ? "live" : "edit";
    await setMode(target);
    editor.focus();
  } else if (state.notes.length > 0 && !state.currentId) {
    // Restore the last-selected note for this space if it still exists.
    const lastId = recallLastNote(state.currentSpaceId);
    const target =
      (lastId && state.notes.find((n) => n.id === lastId)) || state.notes[0];
    await selectNote(target.id);
  } else {
    showEmptyState();
  }

  setupEventListeners();
  setupTauriListeners();
}

// First load on the main window. The backend seeds from a local metadata cache
// and refreshes from iCloud in the background, so non-empty results can be used
// immediately. Empty results still wait for the scan to distinguish "no notes"
// from "iCloud not ready yet".
async function loadNotesInitial() {
  // If we're booting into a non-default space, the backend hasn't scanned
  // it yet (boot only scans default). Kick off the scan first so the
  // streaming events arrive while we render the cached metadata.
  if (!isSticky && state.currentSpaceId !== DEFAULT_SPACE_ID) {
    invoke("scan_space", { space: state.currentSpaceId }).catch(() => {});
  }

  await loadNotes({ warmPreviews: false });
  if (state.notes.length > 0 || isSticky) return;
  if (!(await invoke("notes_loading", { space: state.currentSpaceId }))) {
    // Scan finished between the two calls above — pick up its results.
    await loadNotes({ warmPreviews: false });
    return;
  }

  showNotesLoadingState("Loading iCloud notes...");
  await new Promise((resolve) => {
    let settled = false;
    let unlisten = null;
    let poll = null;
    const settle = async () => {
      if (settled) return;
      settled = true;
      if (poll) clearInterval(poll);
      if (unlisten) unlisten();
      await refreshNotesFromBackend({ selectIfNone: false });
      resolve();
    };
    // Normal path: the backend emits this once the scan completes.
    // notes-loaded is per-space — only settle for our current space.
    listen("notes-loaded", (event) => {
      if (event?.payload?.space === state.currentSpaceId) settle();
    }).then((fn) => {
      unlisten = fn;
      if (settled) fn();
    });
    // Safety net: if the event fired before this listener attached (very
    // fast scan), the flag will still flip — poll it as a fallback.
    poll = setInterval(async () => {
      if (!(await invoke("notes_loading", { space: state.currentSpaceId }))) {
        settle();
      } else {
        showNotesLoadingState("Still loading iCloud notes...");
      }
    }, 200);
  });
}

// ─── Notes CRUD ───
async function loadNotes({ warmPreviews = true } = {}) {
  const space = state.currentSpaceId;
  state.searchQuery = "";
  search.value = "";
  const result = await invoke("list_notes_paginated", {
    space,
    offset: 0,
    limit: PAGE_SIZE,
  });
  // Stale guard: if the user switched spaces while this was in flight,
  // discard the result so we don't display notes from the wrong space.
  if (state.currentSpaceId !== space) return;

  // Ensure pinned notes are always loaded even if not in the first page
  const loadedIds = new Set(result.notes.map((n) => n.id));
  const missingPinned = [...state.pinnedNotes].filter(
    (id) => !loadedIds.has(id),
  );
  let pinnedExtras = [];
  if (missingPinned.length > 0) {
    // Fetch all notes to find the missing pinned ones (they could be old)
    const all = await invoke("list_notes", { space });
    if (state.currentSpaceId !== space) return;
    pinnedExtras = all.filter((n) => missingPinned.includes(n.id));
  }

  state.notes = [...pinnedExtras, ...result.notes];
  state.totalNotes = result.total;
  state.notesOffset = result.notes.length;
  renderNoteList();
  if (warmPreviews) {
    scheduleWarmPreviewCache(state.notes);
  }
}

let notesRefreshPromise = null;

function refreshNotesFromBackend({ selectIfNone = false } = {}) {
  if (notesRefreshPromise) return notesRefreshPromise;
  notesRefreshPromise = (async () => {
    await loadNotes({ warmPreviews: false });

    if (state.currentId) {
      const currentStillExists = state.notes.some((n) => n.id === state.currentId);
      if (currentStillExists) {
        updateTitle();
        return;
      }
      state.currentId = null;
    }

    if (selectIfNone && state.notes.length > 0) {
      await selectNote(state.notes[0].id);
    } else if (state.notes.length === 0) {
      showEmptyState();
    }
  })().finally(() => {
    notesRefreshPromise = null;
  });
  return notesRefreshPromise;
}

// ─── Spaces switching ───
// Per-space last-selected note. Restoring on switch keeps each space's
// session feeling like its own window — typing in Work then jumping to
// Personal and back leaves you exactly where you were.
function lastNoteStorageKey(spaceId) {
  return `raynote-last-note-${spaceId}`;
}

function rememberLastNote(spaceId, noteId) {
  if (!spaceId || !noteId) return;
  localStorage.setItem(lastNoteStorageKey(spaceId), noteId);
}

function recallLastNote(spaceId) {
  return localStorage.getItem(lastNoteStorageKey(spaceId));
}

let spaceSwitchInFlight = false;

async function switchToSpace(spaceId) {
  if (isSticky) return;
  if (!spaceId || spaceId === state.currentSpaceId) return;
  if (spaceSwitchInFlight) return;
  const spaces = getSpaces();
  if (!spaces.some((s) => s.id === spaceId)) return;

  spaceSwitchInFlight = true;
  try {
    // Overlap fade-out with the invisible prep work (save, cache clear)
    // so the user only perceives whichever takes longer, not the sum.
    const fadeOut = playSpaceSwitchAnimOut();

    if (_saveTimeout) {
      clearTimeout(_saveTimeout);
      _saveTimeout = null;
    }
    if (state.dirty && state.currentId) {
      await saveCurrentNote();
    }
    cancelPendingMarkdownRender();

    if (state.currentId) {
      rememberLastNote(state.currentSpaceId, state.currentId);
    }

    previewCache.clear();
    contentCache.clear();
    warmPreviewQueued.clear();
    warmPreviewDone.clear();
    warmPreviewQueue.length = 0;

    // Wait for the fade to finish before swapping visible content.
    await fadeOut;

    // Reset sidebar + selection state.
    state.notes = [];
    state.totalNotes = 0;
    state.notesOffset = 0;
    state.currentId = null;
    state.dirty = false;
    state.searchQuery = "";
    search.value = "";
    hideNotesLoadingBanner();

    renderGeneration++;
    preview.innerHTML = '<div class="preview-loading"></div>';

    state.currentSpaceId = spaceId;
    setStoredCurrentSpaceId(spaceId);
    state.pinnedNotes = loadPinnedNotes(spaceId);
    renderSpaceSwitcher();
    updateTitle();

    invoke("scan_space", { space: spaceId }).catch(() => {});
    await loadNotes();

    const lastId = recallLastNote(spaceId);
    const target =
      (lastId && state.notes.find((n) => n.id === lastId)) ||
      state.notes[0] ||
      null;
    if (target) {
      await selectNote(target.id);
    } else {
      showEmptyState();
    }

    // Content is ready — reveal it. CSS transition handles the rest.
    playSpaceSwitchAnimIn();
  } finally {
    document.documentElement.classList.remove("space-switch-out", "space-switch-in");
    spaceSwitchInFlight = false;
  }
}

function setSpaceSwitcherOpen(open) {
  const el = document.getElementById("space-switcher");
  const trigger = document.getElementById("space-switcher-trigger");
  if (!el || !trigger || trigger.disabled) open = false;
  el?.classList.toggle("open", open);
  trigger?.classList.toggle("open", open);
  trigger?.setAttribute("aria-expanded", open ? "true" : "false");
  if (open) {
    requestAnimationFrame(() => el.querySelector(".space-btn.active")?.focus());
  }
}

function getSpaceSwitcherEl() {
  let el = document.getElementById("space-switcher");
  if (el || isSticky) return el;
  const titleRow = document.querySelector(".sidebar-title-row");
  const trigger = document.getElementById("space-switcher-trigger");
  if (!titleRow || !trigger) return null;
  el = document.createElement("div");
  el.id = "space-switcher";
  el.className = "space-switcher";
  el.setAttribute("role", "menu");
  el.setAttribute("aria-label", "Spaces");

  trigger.addEventListener("click", () => {
    setSpaceSwitcherOpen(!el.classList.contains("open"));
  });
  // Single delegated handlers — buttons get rebuilt on every render.
  el.addEventListener("click", (e) => {
    const btn = e.target.closest(".space-btn");
    if (!btn) return;
    const id = btn.dataset.space;
    setSpaceSwitcherOpen(false);
    trigger.focus();
    if (id) void switchToSpace(id);
  });
  el.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      setSpaceSwitcherOpen(false);
      trigger.focus();
      return;
    }
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)) return;
    const buttons = [...el.querySelectorAll(".space-btn")];
    if (!buttons.length) return;
    e.preventDefault();
    const current = buttons.indexOf(document.activeElement);
    const next =
      e.key === "Home"
        ? 0
        : e.key === "End"
          ? buttons.length - 1
          : e.key === "ArrowDown"
            ? (current + 1) % buttons.length
            : (current - 1 + buttons.length) % buttons.length;
    buttons[next].focus();
  });
  titleRow.appendChild(el);
  return el;
}

function renderSpaceSwitcher() {
  if (isSticky) return;
  const el = getSpaceSwitcherEl();
  const trigger = document.getElementById("space-switcher-trigger");
  if (!el || !trigger) return;
  const spaces = getSpaces();
  // A single space needs no switcher; keep the heading but remove its menu affordance.
  if (spaces.length <= 1) {
    setSpaceSwitcherOpen(false);
    trigger.disabled = true;
    trigger.removeAttribute("title");
    el.classList.add("hidden");
    el.innerHTML = "";
    return;
  }
  trigger.disabled = false;
  trigger.title = "Switch space";
  el.classList.remove("hidden");
  el.innerHTML = spaces
    .map((s, i) => {
      const isActive = s.id === state.currentSpaceId;
      return `
      <button type="button"
              class="space-btn${isActive ? " active" : ""}"
              data-space="${escapeHtml(s.id)}"
              title="${escapeHtml(s.name)} (⌘${i + 1})"
              role="menuitemradio"
              aria-checked="${isActive ? "true" : "false"}">
        <span class="space-emoji" aria-hidden="true">${escapeHtml(s.emoji || DEFAULT_SPACE_EMOJI)}</span>
        <span class="space-name">${escapeHtml(s.name)}</span>
        <kbd class="space-shortcut">⌘${i + 1}</kbd>
        <svg class="space-check" width="13" height="13" viewBox="0 0 14 14" fill="none" aria-hidden="true"><path d="m3 7.2 2.5 2.5L11 4.3" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
      </button>`;
    })
    .join("");
}

async function loadMoreNotes() {
  if (
    state.loadingMore ||
    state.searchQuery ||
    state.notesOffset >= state.totalNotes
  )
    return;
  state.loadingMore = true;
  const space = state.currentSpaceId;
  try {
    const result = await invoke("list_notes_paginated", {
      space,
      offset: state.notesOffset,
      limit: PAGE_SIZE,
    });
    if (state.currentSpaceId !== space) return;
    if (result.notes.length > 0) {
      state.notes = [...state.notes, ...result.notes];
      state.totalNotes = result.total;
      state.notesOffset += result.notes.length;
      renderNoteList();
      scheduleWarmPreviewCache(result.notes);
    }
  } finally {
    state.loadingMore = false;
  }
}

async function selectNote(id) {
  if (state.dirty && state.currentId) {
    await saveCurrentNote();
  }
  // Kill any still-armed debounce from the note we're leaving — if it fired
  // during the async load below it would save the OLD note's text under the
  // NEW note's id.
  clearTimeout(_saveTimeout);

  // If the note we're leaving still has the auto-title placeholder, generate a title in the background
  if (state.currentId) {
    const prevContent = editor.getText();
    const prevNoteId = state.currentId;
    const prevSpaceId = state.currentSpaceId;
    if (hasAutoTitlePlaceholder(prevContent)) {
      autoGenerateTitle(prevNoteId, prevContent, prevSpaceId); // fire-and-forget
    }
  }

  const prevId = state.currentId;
  const gen = ++renderGeneration;
  cancelPendingMarkdownRender();
  state.currentId = id;
  // Until the new note's text is actually in the editor, nothing may save —
  // the editor still holds the previous note's content.
  state.contentReady = false;
  state.dirty = false;
  if (!isSticky) rememberLastNote(state.currentSpaceId, id);
  updateNoteListActiveState(prevId, id);
  updateTitle();

  // The surface follows the mode the user is in: reading stays reading,
  // source stays source, live (the default) stays live.
  const surface =
    state.mode === "preview" ? "preview" : state.mode === "edit" ? "edit" : "live";

  let content = getCachedContent(id);
  const cacheHit = content !== null;

  // Show the loading pane whenever the target surface can't display the new
  // note instantly. This also hides the previous note's editor during the
  // async read so stale content is never presented under the new title.
  if (
    surface === "preview" ||
    !cacheHit ||
    (surface === "live" && !liveEditorEl)
  ) {
    preview.innerHTML = '<div class="preview-loading"></div>';
    setModeRaw("preview");
  }

  if (!cacheHit) {
    try {
      const result = await readNoteContent(state.currentSpaceId, id);
      content = result.content;
    } catch (err) {
      if (renderGeneration !== gen || state.currentId !== id) return;
      console.error("Failed to read note:", err);
      preview.innerHTML =
        '<div class="empty-state">This note could not be loaded.</div>';
      setModeRaw("preview");
      return;
    }
    cacheContent(id, content);
  }

  if (renderGeneration !== gen || state.currentId !== id) return;

  editor.setText(content);
  state.contentReady = true;
  scheduleAdjacentNotePrefetch(id);

  if (surface === "live") {
    const loaded = await ensureLiveEditor().then(
      () => true,
      (err) => {
        console.error("Failed to load live editor:", err);
        return false;
      },
    );
    if (renderGeneration !== gen || state.currentId !== id) return;
    if (loaded) {
      editor.switchTo("live");
      editor.setSelection(0, 0); // top of note, scrolled into view
      setModeRaw("live");
      editor.focus();
      return;
    }
    // Live module failed — fall through to the reading pane.
    preview.innerHTML = '<div class="preview-loading"></div>';
    setModeRaw("preview");
  } else if (surface === "edit") {
    editor.switchTo("textarea");
    editor.setSelection(0, 0);
    setModeRaw("edit");
    editor.focus();
    return;
  }

  // Empty note: show empty state instantly
  if (!content || content.trim() === "") {
    preview.innerHTML = '<div class="empty-state">Start writing...</div>';
    return;
  }

  // Cache hit: instant render, no blocking
  const cachedHtml = getCachedPreviewHtml(id, content);
  if (cachedHtml) {
    applyPreviewHtml(cachedHtml);
    return;
  }

  const contentHash = await hashContent(content);
  if (renderGeneration !== gen || state.currentId !== id) return;

  const diskCachedHtml = await getDiskCachedPreviewHtml(id, contentHash);
  if (renderGeneration !== gen || state.currentId !== id) return;
  if (diskCachedHtml) {
    cachePreviewHtml(id, content, diskCachedHtml);
    applyPreviewHtml(diskCachedHtml);
    return;
  }

  // Double-yield: rAF ensures the browser has scheduled a paint,
  // then setTimeout(0) runs after that paint completes.
  await afterNextPaint();

  // Guard: if user navigated away during the yield, abandon this render
  if (renderGeneration !== gen || state.currentId !== id) return;

  let html;
  try {
    html = await renderMarkdownAsync(content);
  } catch (err) {
    if (isMarkdownRenderCancelled(err)) return;
    console.error("Failed to render markdown:", err);
    if (renderGeneration !== gen || state.currentId !== id) return;
    preview.innerHTML =
      '<div class="empty-state">This note could not be rendered.</div>';
    return;
  }

  if (renderGeneration !== gen || state.currentId !== id) return;
  cachePreviewHtml(id, content, html);
  writeDiskCachedPreviewHtml(id, contentHash, html);
  applyPreviewHtml(html);
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
  // contentReady is false while a note switch is still fetching content — the
  // editor text belongs to the previous note and must not be saved under the
  // current id.
  if (!state.currentId || !state.contentReady) return false;
  const noteId = state.currentId;
  const spaceId = state.currentSpaceId;
  const content = editor.getText();
  invalidatePreviewCache(noteId);
  deleteDiskCachedPreviewHtml(noteId);
  cacheContent(noteId, content); // keep cache in sync with disk
  const saved = await invoke("save_note", {
    space: spaceId,
    id: noteId,
    content,
  });
  if (!saved) {
    if (state.currentId === noteId && state.currentSpaceId === spaceId) {
      state.dirty = true;
    }
    return false;
  }
  if (state.currentId === noteId && state.currentSpaceId === spaceId) {
    state.dirty = false;
  }
  // A blur-triggered title save can finish after navigation. The backend has
  // the right note, but this window may now be showing another space's list.
  if (state.currentSpaceId !== spaceId) return true;
  const rawTitle =
    (content.split("\n")[0] || noteId).replace(/^#+\s*/, "").trim() || noteId;
  const title = truncateTitle(
    rawTitle === AUTO_TITLE_PLACEHOLDER ? "New Note" : rawTitle,
  );
  const previewText = content.split("\n").slice(1, 3).join(" ").slice(0, 100);
  const now = Math.floor(Date.now() / 1000);
  const idx = state.notes.findIndex((n) => n.id === noteId);
  const updatedMeta = {
    id: noteId,
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
  updateTitle();
  return true;
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

  await invoke("save_note", { space: state.currentSpaceId, id, content });
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
    await invoke("create_sticky_window", {
      space: state.currentSpaceId,
      id: state.currentId,
    });
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
  const space = state.currentSpaceId;
  invalidatePreviewCache(id);
  invalidateContentCache(id);
  deleteDiskCachedPreviewHtml(id, space);

  await invoke("delete_note", { space, id });

  // Undo/redo entries are tagged with the space so a later undo restores
  // into the same place even if the user has switched spaces in between.
  undoDeleteStack.push({ id, wasPinned, space });
  redoDeleteStack.length = 0; // new action clears redo

  // Remove pin state
  if (wasPinned) {
    state.pinnedNotes.delete(id);
    savePinnedNotes(state.pinnedNotes, space);
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
  const entry = undoDeleteStack.pop();
  const { id, wasPinned, space: noteSpace } = entry;
  const space = noteSpace || state.currentSpaceId;
  const ok = await invoke("restore_note", { space, id });
  if (!ok) {
    showCopyToast("Could not restore note");
    return;
  }
  redoDeleteStack.push({ id, wasPinned, space });
  // Restore pin state if it was pinned before deletion
  if (wasPinned) {
    const pins = space === state.currentSpaceId
      ? state.pinnedNotes
      : loadPinnedNotes(space);
    pins.add(id);
    savePinnedNotes(pins, space);
    if (space === state.currentSpaceId) state.pinnedNotes = pins;
  }
  // Only refresh the visible sidebar if the restored note is in the active space.
  if (space === state.currentSpaceId) {
    await loadNotes();
    await selectNote(id);
  } else {
    const spaceLabel = (getSpaces().find((s) => s.id === space) || {}).name || space;
    showCopyToast(`Restored in ${spaceLabel}`);
    return;
  }
  showCopyToast("Note restored");
}

async function redoDeleteNote() {
  if (redoDeleteStack.length === 0) return;
  const entry = redoDeleteStack.pop();
  const { id, wasPinned, space: noteSpace } = entry;
  const space = noteSpace || state.currentSpaceId;

  if (space === state.currentSpaceId) {
    invalidatePreviewCache(id);
    invalidateContentCache(id);
  }
  deleteDiskCachedPreviewHtml(id, space);
  await invoke("delete_note", { space, id });
  undoDeleteStack.push({ id, wasPinned, space });

  // Remove pin state
  if (wasPinned) {
    if (space === state.currentSpaceId) {
      state.pinnedNotes.delete(id);
      savePinnedNotes(state.pinnedNotes, space);
    } else {
      const pins = loadPinnedNotes(space);
      pins.delete(id);
      savePinnedNotes(pins, space);
    }
  }

  if (space !== state.currentSpaceId) {
    const spaceLabel = (getSpaces().find((s) => s.id === space) || {}).name || space;
    showCopyToast(`Moved to Trash in ${spaceLabel}`);
    return;
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
  const ok = await invoke("restore_note", {
    space: state.currentSpaceId,
    id,
  });
  if (!ok) {
    showCopyToast("Could not restore note");
    return;
  }
  await loadNotes();
  await selectNote(id);
  showCopyToast("Note restored");
}

async function emptyTrash() {
  const trashNotes = await invoke("list_trash", { space: state.currentSpaceId });
  if (trashNotes.length === 0) {
    showCopyToast("Trash is empty");
    return;
  }
  await invoke("empty_trash", { space: state.currentSpaceId });
  // Clear undo/redo entries that pointed into THIS space's trash since
  // those notes are now gone forever. Other spaces' history survives.
  for (let i = undoDeleteStack.length - 1; i >= 0; i--) {
    if (undoDeleteStack[i].space === state.currentSpaceId) {
      undoDeleteStack.splice(i, 1);
    }
  }
  for (let i = redoDeleteStack.length - 1; i >= 0; i--) {
    if (redoDeleteStack[i].space === state.currentSpaceId) {
      redoDeleteStack.splice(i, 1);
    }
  }
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

/** In-app confirm — window.confirm is unreliable in Tauri/WKWebView. */
let confirmDialogResolve = null;

function ensureConfirmDialog() {
  let dialog = document.getElementById("confirm-dialog");
  if (dialog) return dialog;

  dialog = document.createElement("div");
  dialog.id = "confirm-dialog";
  dialog.className = "confirm-dialog hidden";
  dialog.innerHTML = `
    <div class="confirm-backdrop" data-action="cancel"></div>
    <div class="confirm-modal" role="alertdialog" aria-modal="true">
      <h3 class="confirm-title"></h3>
      <p class="confirm-message"></p>
      <div class="confirm-actions">
        <button type="button" class="confirm-cancel-btn" data-action="cancel">Cancel</button>
        <button type="button" class="confirm-ok-btn" data-action="confirm">Confirm</button>
      </div>
    </div>
  `;
  document.getElementById("app").appendChild(dialog);

  const finish = (result) => {
    if (!confirmDialogResolve) return;
    const resolve = confirmDialogResolve;
    confirmDialogResolve = null;
    dialog.classList.add("hidden");
    document.removeEventListener("keydown", onKeyDown, true);
    resolve(result);
  };

  const onKeyDown = (e) => {
    if (dialog.classList.contains("hidden")) return;
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      finish(false);
    }
  };

  dialog.addEventListener("click", (e) => {
    const action = e.target.closest("[data-action]")?.dataset.action;
    if (action === "confirm") finish(true);
    else if (action === "cancel") finish(false);
  });

  dialog._confirmKeyHandler = onKeyDown;
  return dialog;
}

function showConfirmDialog({
  title = "Are you sure?",
  message = "",
  confirmLabel = "Confirm",
  destructive = false,
}) {
  const dialog = ensureConfirmDialog();
  dialog.querySelector(".confirm-title").textContent = title;
  dialog.querySelector(".confirm-message").textContent = message;
  const okBtn = dialog.querySelector(".confirm-ok-btn");
  okBtn.textContent = confirmLabel;
  okBtn.classList.toggle("confirm-ok-btn-danger", destructive);

  return new Promise((resolve) => {
    confirmDialogResolve = resolve;
    dialog.classList.remove("hidden");
    document.addEventListener("keydown", dialog._confirmKeyHandler, true);
    dialog.querySelector(".confirm-cancel-btn").focus();
  });
}

function copyNoteMarkdown() {
  const text = editor.getText();
  if (!text) return;
  copyToClipboard(text);
  showCopyToast("Markdown copied!");
}

// ─── Render ───
let codeObserver = null;
let imageObserver = null;

function disconnectPreviewObservers() {
  if (codeObserver) {
    codeObserver.disconnect();
    codeObserver = null;
  }
  if (imageObserver) {
    imageObserver.disconnect();
    imageObserver = null;
  }
}

function applyPreviewHtml(html) {
  disconnectPreviewObservers();
  preview.innerHTML = html;
  // Only observers need setup here - click/change/keydown handlers use event
  // delegation on the preview element (registered once at startup).
  lazyHighlightCodeBlocks();
  lazyLoadAssetImages();
  setupTodoAttributes();
}

async function renderPreview(content, noteId = null) {
  const gen = ++renderGeneration;
  cancelPendingMarkdownRender();

  if (!content || content.trim() === "") {
    disconnectPreviewObservers();
    preview.innerHTML = '<div class="empty-state">Start writing...</div>';
    return;
  }

  // Check cache when a noteId is provided
  if (noteId) {
    const cachedHtml = getCachedPreviewHtml(noteId, content);
    if (cachedHtml) {
      applyPreviewHtml(cachedHtml);
      return;
    }
  }

  const contentHash = noteId ? await hashContent(content) : null;
  if (renderGeneration !== gen || (noteId && state.currentId !== noteId)) {
    return;
  }

  if (noteId && contentHash) {
    const diskCachedHtml = await getDiskCachedPreviewHtml(noteId, contentHash);
    if (renderGeneration !== gen || state.currentId !== noteId) return;
    if (diskCachedHtml) {
      cachePreviewHtml(noteId, content, diskCachedHtml);
      applyPreviewHtml(diskCachedHtml);
      return;
    }
  }

  preview.innerHTML = '<div class="preview-loading"></div>';
  await afterNextPaint();
  if (renderGeneration !== gen || (noteId && state.currentId !== noteId)) {
    return;
  }

  let html;
  try {
    html = await renderMarkdownAsync(content);
  } catch (err) {
    if (isMarkdownRenderCancelled(err)) return;
    console.error("Failed to render markdown:", err);
    if (renderGeneration !== gen || (noteId && state.currentId !== noteId)) {
      return;
    }
    preview.innerHTML =
      '<div class="empty-state">This note could not be rendered.</div>';
    return;
  }

  if (renderGeneration !== gen || (noteId && state.currentId !== noteId)) {
    return;
  }
  if (noteId) {
    cachePreviewHtml(noteId, content, html);
    if (contentHash) {
      writeDiskCachedPreviewHtml(noteId, contentHash, html);
    }
  }
  applyPreviewHtml(html);
}

// ─── Bounded idle note prefetch ───
// A cold iCloud read is the dominant note-switch cost. Warm a few notes near
// the current sidebar position while the app is idle, one at a time. The
// native layer persists them in a 64 MB source-validated disk cache; only
// small results enter the byte-bounded JS cache below.
const CONTENT_PREFETCH_MAX_NOTES = 6;
const CONTENT_PREFETCH_MAX_BYTES = 768 * 1024;
let contentPrefetchToken = 0;

function adjacentPrefetchCandidates(currentId) {
  const currentIndex = state.notes.findIndex((note) => note.id === currentId);
  if (currentIndex < 0) return state.notes.slice(0, CONTENT_PREFETCH_MAX_NOTES);

  const candidates = [];
  for (
    let distance = 1;
    candidates.length < CONTENT_PREFETCH_MAX_NOTES &&
    (currentIndex + distance < state.notes.length || currentIndex - distance >= 0);
    distance++
  ) {
    if (currentIndex + distance < state.notes.length) {
      candidates.push(state.notes[currentIndex + distance]);
    }
    if (
      candidates.length < CONTENT_PREFETCH_MAX_NOTES &&
      currentIndex - distance >= 0
    ) {
      candidates.push(state.notes[currentIndex - distance]);
    }
  }
  return candidates;
}

function scheduleAdjacentNotePrefetch(currentId) {
  const token = ++contentPrefetchToken;
  const space = state.currentSpaceId;
  const candidates = adjacentPrefetchCandidates(currentId).filter(
    (note) => note?.id && note.id !== currentId && !hasCachedContent(note.id),
  );
  if (candidates.length === 0) return;

  (async () => {
    for (const note of candidates) {
      await idleDelay(1200);
      if (
        token !== contentPrefetchToken ||
        state.currentSpaceId !== space ||
        document.visibilityState === "hidden" ||
        state.dirty
      ) {
        return;
      }
      if (hasCachedContent(note.id)) continue;

      let result;
      try {
        result = await readNoteContent(space, note.id);
      } catch {
        continue;
      }
      if (token !== contentPrefetchToken || state.currentSpaceId !== space) {
        return;
      }

      const content = result.content;
      if (content.length * 2 > CONTENT_PREFETCH_MAX_BYTES) continue;
      if (cacheContent(note.id, content)) {
        // HTML generation remains worker-backed, idle-only, and limited to
        // content that is now already resident in the bounded memory cache.
        scheduleWarmPreviewCache([note]);
      }
    }
  })();
}

// ─── Background preview warming ───
const WARM_PREVIEW_BATCH_MAX = 12;
const warmPreviewQueued = new Set();
const warmPreviewDone = new Set();
let warmPreviewQueue = [];
let warmPreviewRunning = false;

function scheduleWarmPreviewCache(notes) {
  if (!Array.isArray(notes) || notes.length === 0) return;
  for (const note of notes.slice(0, WARM_PREVIEW_BATCH_MAX)) {
    const id = note?.id;
    if (
      !id ||
      id === state.currentId ||
      warmPreviewQueued.has(id) ||
      !hasCachedContent(id)
    ) {
      continue;
    }
    warmPreviewQueued.add(id);
    warmPreviewQueue.push(id);
  }
  if (!warmPreviewRunning) {
    warmPreviewRunning = true;
    runWarmPreviewQueue();
  }
}

async function runWarmPreviewQueue() {
  try {
    while (warmPreviewQueue.length > 0) {
      const id = warmPreviewQueue.shift();
      warmPreviewQueued.delete(id);
      if (!id || id === state.currentId || warmPreviewDone.has(id)) continue;

      await idleDelay();
      if (state.dirty || id === state.currentId) continue;

      await warmPreviewForNote(id);
    }
  } finally {
    warmPreviewRunning = false;
    if (warmPreviewQueue.length > 0) {
      warmPreviewRunning = true;
      runWarmPreviewQueue();
    }
  }
}

async function warmPreviewForNote(id) {
  const content = getCachedContent(id);
  if (content === null) return;

  if (!content || content.trim() === "") {
    warmPreviewDone.add(id);
    return;
  }

  if (getCachedPreviewHtml(id, content)) {
    warmPreviewDone.add(id);
    return;
  }

  const contentHash = await hashContent(content);
  const diskCachedHtml = await getDiskCachedPreviewHtml(id, contentHash);
  if (diskCachedHtml) {
    cachePreviewHtml(id, content, diskCachedHtml);
    warmPreviewDone.add(id);
    return;
  }

  const html = await renderMarkdownWarmAsync(content).catch((err) => {
    console.warn("Failed to warm preview cache:", err);
    return null;
  });
  if (!html) return;

  cachePreviewHtml(id, content, html);
  writeDiskCachedPreviewHtml(id, contentHash, html);
  warmPreviewDone.add(id);
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
    deleteDiskCachedPreviewHtml(state.currentId);
    const content = editor.getText();
    await invoke("save_note", {
      space: state.currentSpaceId,
      id: state.currentId,
      content,
    });
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
// Browser File blobs cross IPC as base64 and temporarily exist several times
// in memory. Remote URLs still use the native streaming 100 MB path.
const MAX_BROWSER_FILE_BYTES = 20 * 1024 * 1024;
let assetImportQueue = Promise.resolve();

function setDropStatus(message, detail = "") {
  const editorArea = document.getElementById("editor-area");
  let status = editorArea.querySelector(".drop-status");
  if (!status) {
    status = document.createElement("div");
    status.className = "drop-status";
    status.innerHTML = `<span class="drop-status-spinner"></span><span class="drop-status-copy"><strong></strong><small></small></span>`;
    editorArea.appendChild(status);
  }
  status.querySelector("strong").textContent = message;
  status.querySelector("small").textContent = detail;
  status.classList.add("visible");
}

function hideDropStatus() {
  document.querySelector("#editor-area .drop-status")?.classList.remove("visible");
}

function markdownForAsset(assetName, originalName) {
  // CommonMark link destinations containing spaces must be enclosed in angle
  // brackets. Escape the only punctuation that can terminate that form.
  const destination = `<asset:${assetName
    .replace(/\\/g, "\\\\")
    .replace(/</g, "\\<")
    .replace(/>/g, "\\>")}>`;
  const label = originalName.replace(/\\/g, "\\\\").replace(/([\[\]])/g, "\\$1");
  return IMAGE_EXTS.test(originalName)
    ? `![${label}|100%|center](${destination})`
    : `[${label}](${destination})`;
}

function queueAssetImports(imports) {
  const job = {
    imports,
    noteId: state.currentId,
    spaceId: state.currentSpaceId,
  };
  assetImportQueue = assetImportQueue
    .catch(() => {})
    .then(() => runAssetImports(job));
}

function isCurrentImportTarget(job) {
  return state.currentId === job.noteId && state.currentSpaceId === job.spaceId;
}

async function runAssetImports(job) {
  const { imports } = job;
  if (!job.noteId || imports.length === 0) return;
  if (!isCurrentImportTarget(job)) {
    showCopyToast("Attachment cancelled because the note changed");
    return;
  }
  if (state.mode === "preview") {
    setMode("edit");
    editor.focus();
  }

  let attached = 0;
  let failed = 0;
  let cancelled = false;
  let firstError = "";
  for (let index = 0; index < imports.length; index++) {
    if (!isCurrentImportTarget(job)) {
      cancelled = true;
      break;
    }
    const item = imports[index];
    setDropStatus(
      item.loadingLabel,
      imports.length > 1 ? `${index + 1} of ${imports.length} · ${item.name}` : item.name,
    );
    try {
      const [assetName, originalName] = await item.import();
      if (!isCurrentImportTarget(job)) {
        // The uniquely named file was never linked, so remove it rather than
        // leaving a surprise orphan after a slow download.
        await invoke("delete_assets", { names: [assetName] }).catch(() => {});
        cancelled = true;
        break;
      }
      await insertAtCursor(markdownForAsset(assetName, originalName) + "\n");
      attached++;
    } catch (err) {
      console.error("Asset import failed", err);
      if (!firstError) firstError = String(err);
      failed++;
    }
  }
  managedFiles = [];
  managedFilesScanComplete = false;
  hideDropStatus();
  if (cancelled) {
    showCopyToast(
      attached > 0
        ? `${attached} attached · remaining files cancelled because the note changed`
        : "Attachment cancelled because the note changed",
    );
  } else if (attached > 0) {
    showCopyToast(`${attached} ${attached === 1 ? "file" : "files"} attached${failed ? `, ${failed} failed` : ""}`);
  } else if (failed > 0) {
    showCopyToast(firstError ? `Failed: ${firstError}` : "Failed to attach file");
  }
}

function browserFileToBase64(file) {
  if (file.size > MAX_BROWSER_FILE_BYTES) {
    return Promise.reject(new Error("Browser file blobs are limited to 20 MB; download the file locally and drag it from Finder"));
  }
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error || new Error("Could not read dropped file"));
    reader.onload = () => resolve(String(reader.result).split(",", 2)[1] || "");
    reader.readAsDataURL(file);
  });
}

function urlsFromDataTransfer(dataTransfer) {
  const uriList = dataTransfer.getData("text/uri-list");
  const urls = uriList
    .split(/\r?\n/)
    .map((value) => value.trim())
    .filter((value) => value && !value.startsWith("#") && /^https?:\/\//i.test(value));
  if (urls.length > 0) return [...new Set(urls)];

  const html = dataTransfer.getData("text/html");
  if (html) {
    const documentNode = new DOMParser().parseFromString(html, "text/html");
    const candidate = documentNode.querySelector("img[src], a[href]")?.getAttribute("src") ||
      documentNode.querySelector("a[href]")?.getAttribute("href");
    if (candidate && /^https?:\/\//i.test(candidate)) return [candidate];
  }
  return [];
}

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

  // Browser-origin drags (images, download links, and File blobs) do not have
  // native filesystem paths. Handle them through the DOM and let Rust fetch
  // remote URLs so CORS and slow network responses do not block the WebView.
  editorArea.addEventListener("dragover", (event) => {
    if (!event.dataTransfer) return;
    const types = [...event.dataTransfer.types];
    if (types.includes("Files") || types.includes("text/uri-list") || types.includes("text/html")) {
      event.preventDefault();
      event.dataTransfer.dropEffect = "copy";
      editorArea.classList.add("drop-active");
    }
  });
  editorArea.addEventListener("dragleave", (event) => {
    if (!editorArea.contains(event.relatedTarget)) editorArea.classList.remove("drop-active");
  });
  editorArea.addEventListener("drop", (event) => {
    const dataTransfer = event.dataTransfer;
    if (!dataTransfer) return;
    const urls = urlsFromDataTransfer(dataTransfer);
    const files = [...dataTransfer.files];
    if (urls.length === 0 && files.length === 0) return;
    event.preventDefault();
    event.stopPropagation();
    editorArea.classList.remove("drop-active");

    if (urls.length > 0) {
      queueAssetImports(
        urls.map((url, index) => ({
          name: (() => {
            try { return decodeURIComponent(new URL(url).pathname.split("/").pop()) || "Download"; }
            catch { return "Download"; }
          })(),
          loadingLabel: "Fetching file…",
          import: async () => {
            try {
              return await invoke("import_asset_url", { url });
            } catch (networkError) {
              // Some browser drags include both a protected URL and an
              // already-materialized File blob. Use that blob when the native
              // downloader cannot access the user's authenticated resource.
              const fallback = files[index] || (files.length === 1 ? files[0] : null);
              if (!fallback) throw networkError;
              return invoke("save_asset", {
                name: fallback.name || "file",
                dataBase64: await browserFileToBase64(fallback),
              });
            }
          },
        })),
      );
      return;
    }
    queueAssetImports(
      files.map((file) => ({
        name: file.name || "Dropped file",
        loadingLabel: "Importing file…",
        import: async () =>
          invoke("save_asset", {
            name: file.name || "file",
            dataBase64: await browserFileToBase64(file),
          }),
      })),
    );
  });
}

function handleDroppedPaths(paths) {
  queueAssetImports(
    paths.map((filePath) => ({
      name: filePath.split(/[\\/]/).pop() || "File",
      loadingLabel: "Copying file…",
      import: () => invoke("copy_to_assets", { sourcePath: filePath }),
    })),
  );
}

async function insertAtCursor(text) {
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
  await saveCurrentNote();
}

const BOOKMARK_ICON_SVG = `<svg width="12" height="12" viewBox="0 0 24 24" aria-hidden="true"><path d="M0 0h24v24H0V0z" fill="none"/><path d="M17 3H7c-1.1 0-2 .9-2 2v16l7-3 7 3V5c0-1.1-.9-2-2-2z" fill="currentColor"/></svg>`;

function renderNoteItem(n) {
  const isPinned = isNotePinned(n.id);
  const isAutoTitle = n.title === "New Note" || n.title === AUTO_TITLE_PLACEHOLDER;
  const titleClass = `note-item-title${isAutoTitle ? " auto-title" : ""}`;
  const fullTitle = n.title === AUTO_TITLE_PLACEHOLDER ? "New Note" : n.title;
  const displayTitle = truncateTitle(fullTitle);
  const titleAttr =
    displayTitle !== fullTitle ? ` title="${escapeHtml(fullTitle)}"` : "";
  return `
  <li class="note-item ${n.id === state.currentId ? "active" : ""}${isPinned ? " pinned" : ""}" data-id="${n.id}">
    <div class="note-item-header">
        <div class="${titleClass}"${titleAttr}>${escapeHtml(displayTitle)}</div>
        <button class="note-pin-btn${isPinned ? " is-pinned" : ""}" data-pin-id="${n.id}" title="${isPinned ? "Unpin" : "Pin"} note" aria-label="${isPinned ? "Unpin" : "Pin"} note">
          ${BOOKMARK_ICON_SVG}
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
  const space = state.currentSpaceId;
  if (!query) {
    // Restore paginated list
    const result = await invoke("list_notes_paginated", {
      space,
      offset: 0,
      limit: PAGE_SIZE,
    });
    if (state.currentSpaceId !== space) return;
    state.notes = result.notes;
    state.totalNotes = result.total;
    state.notesOffset = result.notes.length;
    renderNoteList();
    scheduleWarmPreviewCache(state.notes);
    return;
  }
  // Search on backend — returns up to 100 results
  const results = await invoke("search_notes", { space, query, limit: 100 });
  if (state.currentSpaceId !== space) return;
  state.notes = results;
  state.totalNotes = results.length;
  state.notesOffset = results.length;
  renderNoteList();
  scheduleWarmPreviewCache(results);
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

let titleRenameNoteId = null;

function closeTitleRenameInput() {
  titleRenameNoteId = null;
  titlebarChip.classList.remove("renaming");
  titlebarTitleInput.hidden = true;
  titlebarTitle.hidden = false;
}

function beginTitleRename() {
  if (isSticky || !state.currentId || !state.contentReady || titleRenameNoteId) {
    return;
  }
  const firstLine = editor.getText().split("\n", 1)[0] || "";
  const currentTitle = firstLine.replace(/^#+\s*/, "").trim();
  titleRenameNoteId = state.currentId;
  titlebarTitleInput.value =
    currentTitle === AUTO_TITLE_PLACEHOLDER ? "" : currentTitle;
  titlebarTitle.hidden = true;
  titlebarTitleInput.hidden = false;
  titlebarChip.classList.add("renaming");
  titlebarTitleInput.focus();
  titlebarTitleInput.select();
}

async function finishTitleRename(shouldSave) {
  const noteId = titleRenameNoteId;
  if (!noteId) return;
  const title = titlebarTitleInput.value.trim();
  closeTitleRenameInput();

  if (
    !shouldSave ||
    !title ||
    state.currentId !== noteId ||
    !state.contentReady
  ) {
    updateTitle();
    return;
  }

  const content = editor.getText();
  const newlineIndex = content.indexOf("\n");
  const oldFirstLine = newlineIndex >= 0 ? content.slice(0, newlineIndex) : content;
  const rest = newlineIndex >= 0 ? content.slice(newlineIndex) : "";
  const newFirstLine = `# ${title}`;
  if (newFirstLine === oldFirstLine) {
    updateTitle();
    return;
  }

  const selection = editor.getSelection();
  const delta = newFirstLine.length - oldFirstLine.length;
  const remapPosition = (position) =>
    position > oldFirstLine.length
      ? Math.max(0, position + delta)
      : Math.min(position, newFirstLine.length);
  const updatedContent = newFirstLine + rest;
  editor.setText(updatedContent);
  editor.setSelection(
    remapPosition(selection.start),
    remapPosition(selection.end),
  );
  state.dirty = true;
  clearTimeout(_saveTimeout);
  _saveTimeout = null;

  const note = state.notes.find((item) => item.id === noteId);
  if (note) note.title = truncateTitle(title);
  renderNoteList(state.searchQuery);
  updateTitle();

  const saved = await saveCurrentNote();
  if (!saved) {
    showCopyToast("Note title could not be saved");
    return;
  }
  if (state.currentId === noteId && state.mode === "preview") {
    renderPreview(updatedContent, noteId);
  }
}

function updateTitle() {
  const note = state.notes.find((n) => n.id === state.currentId);
  if (!note) {
    titlebarTitle.textContent = "Raynote";
    titlebarTitle.removeAttribute("title");
    return;
  }
  const fullTitle =
    note.title === AUTO_TITLE_PLACEHOLDER ? "New Note" : note.title;
  const display = truncateTitle(fullTitle);
  titlebarTitle.textContent = display;
  if (display !== fullTitle) {
    titlebarTitle.title = fullTitle;
  } else {
    titlebarTitle.removeAttribute("title");
  }
}

// ─── Mode switching ───
// Three modes:
//   - "live"    : live markdown editor (Notion/Obsidian style) — the default
//   - "edit"    : raw markdown source in a textarea
//   - "preview" : read-only rendered HTML (marked)
//
// "live" and "edit" both put an editor in front; the adapter's active
// backend tracks which one owns the doc text. Switching between them
// transfers the text over.

const MODE_LABELS = {
  edit: "source",
  preview: "reading",
  live: "live",
};

let liveEditorEl = null; // populated on first entry into live mode
let liveEditorLoadPromise = null;

async function ensureLiveEditor() {
  if (liveEditorEl) return liveEditorEl;
  if (liveEditorLoadPromise) return liveEditorLoadPromise;
  liveEditorLoadPromise = (async () => {
    const mod = await import("./livemark/index.js");
    liveEditorEl = mod.setupLiveEditor({
      container: document.getElementById("editor-area"),
      adapter: editor,
      onOpenLink: (url) =>
        shellOpen(url).catch(() => showCopyToast("Failed to open link")),
      onOpenAsset: (name) =>
        invoke("reveal_asset", { name }).catch(() =>
          showCopyToast("Failed to open file"),
        ),
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
    // Deliberately NOT persisted as the preferred editor: source mode is a
    // per-session peek (⌘E, file drops), and persisting it here would
    // silently flip the app's default surface away from live.
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
        label: "Toggle Source Mode",
        hint: formatShortcut(state.shortcuts.toggleEdit),
        action: () => setMode(state.mode === "edit" ? "live" : "edit"),
      },
      {
        label: "Toggle Reading Mode",
        hint: formatShortcut(state.shortcuts.toggleLive),
        action: () =>
          setMode(
            state.mode === "preview"
              ? getPreferredEditor() === "live"
                ? "live"
                : "edit"
              : "preview",
          ),
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
      label: "Toggle Source Mode",
      hint: formatShortcut(state.shortcuts.toggleEdit),
      action: () => setMode(state.mode === "edit" ? "live" : "edit"),
    },
    {
      label: "Toggle Reading Mode",
      hint: formatShortcut(state.shortcuts.toggleLive),
      action: () =>
        setMode(
          state.mode === "preview"
            ? getPreferredEditor() === "live"
              ? "live"
              : "edit"
            : "preview",
        ),
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
      const trashNotes = await invoke("list_trash", {
        space: state.currentSpaceId,
      });
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
        const results = await invoke("search_notes", {
          space: state.currentSpaceId,
          query,
          limit: 50,
        });
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
      <span class="palette-item-label">${item.pinned ? `<span class="palette-pin-icon">${BOOKMARK_ICON_SVG}</span>` : ""}${escapeHtml(item.label)}</span>
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
  const button = document.getElementById("btn-sidebar");
  button.classList.toggle("active", state.sidebarOpen);
  button.setAttribute("aria-expanded", state.sidebarOpen ? "true" : "false");
  button.setAttribute("aria-label", state.sidebarOpen ? "Hide notes" : "Show notes");
  button.title = `${state.sidebarOpen ? "Hide" : "Show"} notes (Cmd+Shift+S)`;
}

// ─── Pin ───
async function togglePin() {
  state.pinned = !state.pinned;
  await getCurrentWindow().setAlwaysOnTop(state.pinned);
  const button = document.getElementById("btn-pin");
  button.classList.toggle("active", state.pinned);
  button.setAttribute("aria-pressed", state.pinned ? "true" : "false");
  button.title = state.pinned ? "Stop keeping app on top" : "Keep app on top";
}

// ─── Event listeners ───
let _saveTimeout = null;
let eventListenersReady = false;
function scheduleSave() {
  if (!state.contentReady) return; // mid note-switch; editor text is stale
  state.dirty = true;
  clearTimeout(_saveTimeout);
  _saveTimeout = setTimeout(() => saveCurrentNote(), 800);
}

function setupEventListeners() {
  if (eventListenersReady) return;
  eventListenersReady = true;

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

  document.addEventListener("mousedown", (e) => {
    const switcher = document.getElementById("space-switcher");
    if (
      switcher?.classList.contains("open") &&
      !e.target.closest("#space-switcher, #space-switcher-trigger")
    ) {
      setSpaceSwitcherOpen(false);
    }
  });

  // Titlebar title editing
  titlebarChip.addEventListener("click", (e) => {
    if (e.target !== titlebarTitleInput) beginTitleRename();
  });
  titlebarChip.addEventListener("keydown", (e) => {
    if (e.target === titlebarTitleInput) return;
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      beginTitleRename();
    }
  });
  titlebarTitleInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      void finishTitleRename(true);
    } else if (e.key === "Escape") {
      e.preventDefault();
      finishTitleRename(false);
    }
  });
  titlebarTitleInput.addEventListener("blur", () => {
    void finishTitleRename(true);
  });

  // Titlebar buttons
  document
    .getElementById("btn-sidebar")
    .addEventListener("click", toggleSidebar);
  document.getElementById("btn-settings")?.addEventListener("click", openSettings);
  document.getElementById("btn-popout")?.addEventListener("click", openNewSticky);
  document.getElementById("btn-pin").addEventListener("click", togglePin);
  document.getElementById("btn-new").addEventListener("click", createNote);
  document
    .getElementById("btn-close")
    .addEventListener("click", () => closeCurrentWindow());
  document
    .getElementById("btn-minimize")
    ?.addEventListener("click", () => getCurrentWindow().minimize());

  // Titlebar dragging (all windows): CSS -webkit-app-region /
  // data-tauri-drag-region leave dead zones between children on the
  // transparent WKWebView, so drive dragging through the window API instead —
  // every pixel of the bar is a drag handle except the interactive controls.
  {
    const tb = document.getElementById("titlebar");
    tb.addEventListener("mousedown", (e) => {
      if (e.button !== 0) return;
      if (e.target.closest(".titlebar-btn, .note-title-chip, .sticky-tint-dd")) {
        return;
      }
      void getCurrentWindow().startDragging();
    });
    // macOS titlebar convention: double-click zooms the window.
    tb.addEventListener("dblclick", (e) => {
      if (e.target.closest(".titlebar-btn, .note-title-chip, .sticky-tint-dd")) {
        return;
      }
      void getCurrentWindow().toggleMaximize();
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

    // Cmd/Ctrl + 1..4 — switch spaces (only matters once a second space
    // exists; with only the default space this is a no-op so the digit
    // can still be typed when there are other modifier conflicts).
    if (
      !isSticky &&
      (e.metaKey || e.ctrlKey) &&
      !e.altKey &&
      !e.shiftKey &&
      /^[1-4]$/.test(e.key)
    ) {
      const idx = parseInt(e.key, 10) - 1;
      const spaces = getSpaces();
      if (spaces.length > 1 && idx < spaces.length) {
        e.preventDefault();
        switchToSpace(spaces[idx].id);
        return;
      }
    }

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
      // ⌘E: flip between the live editor and raw markdown source.
      if (state.currentId) {
        setMode(state.mode === "edit" ? "live" : "edit").then(() =>
          editor.focus(),
        );
      }
      return;
    }

    if (matchesShortcut(e, sc.toggleLive)) {
      e.preventDefault();
      // ⌘⇧L: flip between reading mode and the preferred editor.
      if (state.currentId) {
        if (state.mode === "preview") {
          setMode(getPreferredEditor() === "live" ? "live" : "edit");
        } else {
          setMode("preview");
        }
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

    // Escape: collapse transient UI before leaving the current editor mode.
    if (e.key === "Escape") {
      const spaceSwitcher = document.getElementById("space-switcher");
      if (spaceSwitcher?.classList.contains("open")) {
        setSpaceSwitcherOpen(false);
        document.getElementById("space-switcher-trigger")?.focus();
      } else if (state.settingsOpen) {
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
let tauriListenersReady = false;
function setupTauriListeners() {
  if (tauriListenersReady) return;
  tauriListenersReady = true;

  listen("quick-capture", () => {
    if (isSticky) return;
    createNote();
  });
  // Streamed per-note metadata during the iCloud scan. Each event is tagged
  // with the space it belongs to — drop events from other spaces so a scan
  // running in the background doesn't pollute the active sidebar.
  listen("note-meta-loaded", (event) => {
    if (isSticky) return;
    const payload = event.payload || {};
    if (payload.space !== state.currentSpaceId) return;
    upsertNoteFromScan(payload.meta);
  });
  listen("notes-loading-progress", (event) => {
    if (isSticky) return;
    const payload = event.payload || {};
    if (payload.space !== state.currentSpaceId) return;
    updateNotesLoadingBanner(payload);
  });
  listen("notes-loaded", (event) => {
    if (isSticky) return;
    const payload = event.payload || {};
    if (payload.space !== state.currentSpaceId) return;
    hideNotesLoadingBanner();
    refreshNotesFromBackend({ selectIfNone: true }).catch((err) => {
      console.error("Failed to refresh notes after iCloud scan:", err);
    });
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
