import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { listen } from "@tauri-apps/api/event";
import { open as shellOpen } from "@tauri-apps/plugin-shell";
import { marked } from "marked";
import hljs from "highlight.js";
import "highlight.js/styles/github-dark-dimmed.min.css";
import katex from "katex";
import "katex/dist/katex.min.css";
import "./style.css";

const urlParams = new URLSearchParams(window.location.search);
const isSticky = urlParams.get("sticky") === "1";
const stickyNoteId = urlParams.get("id");
if (isSticky) {
  document.documentElement.classList.add("sticky-mode");
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
  { id: "mist", label: "Mist", c1: "rgba(20, 22, 28, 0.92)", c2: "rgba(15, 17, 22, 0.90)" },
  { id: "lavender", label: "Lavender", c1: "rgba(24, 21, 30, 0.92)", c2: "rgba(17, 16, 24, 0.90)" },
  { id: "rose", label: "Rose", c1: "rgba(28, 20, 23, 0.92)", c2: "rgba(21, 17, 19, 0.90)" },
  { id: "clay", label: "Clay", c1: "rgba(28, 22, 19, 0.92)", c2: "rgba(22, 18, 16, 0.90)" },
  { id: "mint", label: "Mint", c1: "rgba(18, 24, 22, 0.92)", c2: "rgba(15, 20, 19, 0.90)" },
  { id: "olive", label: "Olive", c1: "rgba(24, 25, 19, 0.92)", c2: "rgba(19, 20, 16, 0.90)" },
  { id: "sky", label: "Sky", c1: "rgba(18, 22, 30, 0.92)", c2: "rgba(15, 18, 24, 0.90)" },
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
    align === "left" ? "0 auto 0 0" :
    align === "right" ? "0 0 0 auto" :
    "0 auto";
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
    const label = token.tokens ? this.parser.parseInline(token.tokens) : escapeHtml(token.text || href);
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
};

// ─── Configure marked ───
marked.use({ extensions: [latexBlock, latexInline] });
marked.use({ renderer: { ...codeRenderer, ...imageRenderer, ...assetLinkRenderer } });
marked.setOptions({
  breaks: true,
  gfm: true,
});

// ─── Shortcuts system ───
const defaultShortcuts = {
  newNote:        { label: "New Note",             key: "n", meta: true },
  newSticky:      { label: "Open Sticky (this note)", key: "n", meta: true, shift: true },
  deleteNote:     { label: "Delete Note",          key: "Backspace", meta: true, shift: true },
  toggleEdit:     { label: "Toggle Edit/Preview",  key: "e", meta: true },
  toggleSidebar:  { label: "Toggle Sidebar",       key: "s", meta: true, shift: true },
  save:           { label: "Save Note",            key: "s", meta: true },
  closeWindow:    { label: "Close Window",         key: "w", meta: true },
  openPalette:    { label: "Search Notes",         key: "k", meta: true },
  commandPalette: { label: "Command Palette",      key: "p", meta: true, shift: true },
  pinWindow:      { label: "Pin Window on Top",    key: "t", meta: true, shift: true },
  copyNote:       { label: "Copy Note as Markdown", key: "c", meta: true, shift: true },
  undoDelete:     { label: "Undo Delete Note",     key: "Tab", meta: true, shift: true },
  settings:       { label: "Settings",             key: ",", meta: true },
};

function loadShortcuts() {
  try {
    const saved = JSON.parse(localStorage.getItem("levinote-shortcuts") || "{}");
    return { ...structuredClone(defaultShortcuts), ...saved };
  } catch {
    return structuredClone(defaultShortcuts);
  }
}

function saveShortcuts(shortcuts) {
  const toSave = {};
  for (const [id, sc] of Object.entries(shortcuts)) {
    const def = defaultShortcuts[id];
    if (def && (sc.key !== def.key || !!sc.meta !== !!def.meta || !!sc.shift !== !!def.shift || !!sc.alt !== !!def.alt)) {
      toSave[id] = { label: sc.label, key: sc.key, meta: !!sc.meta, shift: !!sc.shift, alt: !!sc.alt };
    }
  }
  localStorage.setItem("levinote-shortcuts", JSON.stringify(toSave));
}

function formatShortcut(sc) {
  const parts = [];
  if (sc.meta) parts.push("Cmd");
  if (sc.alt) parts.push("Alt");
  if (sc.shift) parts.push("Shift");
  const keyName = sc.key === " " ? "Space" : sc.key === "," ? "," : sc.key.length === 1 ? sc.key.toUpperCase() : sc.key;
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

// ─── State ───
const state = {
  notes: [],
  totalNotes: 0,
  notesOffset: 0,
  loadingMore: false,
  searchQuery: "",
  currentId: null,
  mode: "preview", // 'preview' | 'edit'
  sidebarOpen: true,
  pinned: false,
  dirty: false,
  paletteMode: null, // null | 'notes' | 'commands'
  selectedPaletteIndex: 0,
  settingsOpen: false,
  recordingShortcut: null, // shortcut id being recorded
  shortcuts: loadShortcuts(),
};

// ─── DOM refs ───
const $ = (s) => document.querySelector(s);
const editor = $("#editor");
const preview = $("#preview");
const noteList = $("#note-list");
const search = $("#search");
const palette = $("#command-palette");
const paletteInput = $("#palette-input");
const paletteResults = $("#palette-results");
const sidebar = $("#sidebar");
const titlebarTitle = $("#titlebar-title");

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
    <div class="settings-modal">
      <div class="settings-header">
        <div class="settings-tabs">
          <button class="settings-tab active" data-tab="general">General</button>
          <button class="settings-tab" data-tab="shortcuts">Shortcuts</button>
        </div>
        <button class="settings-close-btn" title="Close (Esc)">
          <svg width="14" height="14" viewBox="0 0 14 14"><path d="M1 1l12 12M13 1L1 13" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>
        </button>
      </div>
      <div class="settings-body">
        <div class="settings-page" data-page="general">
          <div class="settings-section">
            <div class="settings-section-title">Appearance</div>
            <div class="setting-row">
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
          <div class="settings-section">
            <div class="settings-section-title">System</div>
            <div class="setting-row">
              <div class="setting-info">
                <span class="setting-label">Global Shortcut</span>
                <span class="setting-desc">Summon LeviNote from anywhere on your Mac</span>
              </div>
              <div class="setting-keys">
                <kbd>Ctrl</kbd><span class="shortcut-plus">+</span><kbd>Cmd</kbd><span class="shortcut-plus">+</span><kbd>Option</kbd><span class="shortcut-plus">+</span><kbd>Shift</kbd><span class="shortcut-plus">+</span><kbd>N</kbd>
              </div>
            </div>
            <div class="setting-row">
              <div class="setting-info">
                <span class="setting-label">Storage</span>
                <span class="setting-desc">Notes sync via iCloud Drive automatically</span>
              </div>
              <span class="setting-badge">iCloud</span>
            </div>
          </div>
        </div>
        <div class="settings-page hidden" data-page="shortcuts">
          <div class="settings-section">
            <div class="settings-section-title">Keyboard Shortcuts</div>
            <div class="settings-section-desc">Click any shortcut to rebind. Press Escape to cancel.</div>
            <div id="shortcuts-list"></div>
          </div>
        </div>
      </div>
    </div>
  `;
  document.getElementById("app").appendChild(panel);

  panel.querySelector(".settings-backdrop").addEventListener("click", closeSettings);
  panel.querySelector(".settings-close-btn").addEventListener("click", closeSettings);

  // Tab switching
  panel.querySelectorAll(".settings-tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      panel.querySelectorAll(".settings-tab").forEach((t) => t.classList.remove("active"));
      tab.classList.add("active");
      panel.querySelectorAll(".settings-page").forEach((p) => p.classList.add("hidden"));
      panel.querySelector(`.settings-page[data-page="${tab.dataset.tab}"]`).classList.remove("hidden");
    });
  });

  // Dock hide toggle
  panel.querySelector("#toggle-dock-hide").addEventListener("change", (e) => {
    const hide = e.target.checked;
    localStorage.setItem("levinote-hide-dock", hide ? "1" : "0");
    invoke("set_dock_visible", { visible: !hide });
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
  const dockHidden = localStorage.getItem("levinote-hide-dock") === "1";
  document.getElementById("toggle-dock-hide").checked = dockHidden;
  renderShortcutsList();
}

function closeSettings() {
  state.settingsOpen = false;
  state.recordingShortcut = null;
  settingsPanel.classList.add("hidden");
}

function renderShortcutsList() {
  const list = document.getElementById("shortcuts-list");
  list.innerHTML = Object.entries(state.shortcuts)
    .map(([id, sc]) => {
      const isRecording = state.recordingShortcut === id;
      const isModified = (() => {
        const def = defaultShortcuts[id];
        return def && (sc.key !== def.key || !!sc.meta !== !!def.meta || !!sc.shift !== !!def.shift || !!sc.alt !== !!def.alt);
      })();
      return `
        <div class="shortcut-row ${isRecording ? "recording" : ""}" data-id="${id}">
          <span class="shortcut-label">${escapeHtml(sc.label)}</span>
          <div class="shortcut-keys-area">
            ${isModified ? `<button class="shortcut-reset-btn" data-id="${id}" title="Reset to default">
              <svg width="12" height="12" viewBox="0 0 16 16" fill="none"><path d="M2 2v5h5M14 14v-5H9" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/><path d="M13.5 6A6 6 0 003.3 3.3L2 7m12 3l-1.3 3.7A6 6 0 012.5 10" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>
            </button>` : ""}
            <button class="shortcut-key-btn ${isRecording ? "recording" : ""}" data-id="${id}">
              ${isRecording
                ? '<span class="recording-pulse"></span>Press keys...'
                : formatShortcut(sc).split("+").map(k => `<kbd>${escapeHtml(k)}</kbd>`).join('<span class="shortcut-plus">+</span>')}
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
    if (localStorage.getItem("levinote-hide-dock") === "1") {
      invoke("set_dock_visible", { visible: false });
    }
  }

  if (isSticky && stickyNoteId) {
    const raw = localStorage.getItem(`levinote-sticky-tint-${stickyNoteId}`);
    applyStickyTintById(stickyTintIdFromStorage(raw) || "mist");
  }

  await loadNotes();

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
      preview.innerHTML = '<div class="empty-state">This sticky could not be found.</div>';
      preview.classList.add("visible");
      editor.classList.remove("visible");
      setupEventListeners();
      setupTauriListeners();
      return;
    }
    await selectNote(stickyNoteId);
    setupStickyTintPicker();
    setMode("edit");
    editor.focus();
  } else if (state.notes.length > 0) {
    await selectNote(state.notes[0].id);
  } else {
    showEmptyState();
  }

  setupEventListeners();
  setupTauriListeners();
}

// ─── Notes CRUD ───
async function loadNotes() {
  state.searchQuery = "";
  search.value = "";
  const result = await invoke("list_notes_paginated", { offset: 0, limit: PAGE_SIZE });
  state.notes = result.notes;
  state.totalNotes = result.total;
  state.notesOffset = result.notes.length;
  renderNoteList();
}

async function loadMoreNotes() {
  if (state.loadingMore || state.searchQuery || state.notesOffset >= state.totalNotes) return;
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

  state.currentId = id;
  const content = await invoke("read_note", { id });
  editor.value = content;
  renderPreview(content);
  setMode("preview");
  renderNoteList(state.searchQuery);
  updateTitle();
}

async function saveCurrentNote() {
  if (!state.currentId) return;
  await invoke("save_note", { id: state.currentId, content: editor.value });
  state.dirty = false;
  // Update the metadata for the current note in-place instead of reloading all
  const content = editor.value;
  const title = (content.split("\n")[0] || state.currentId).replace(/^#+\s*/, "").trim() || state.currentId;
  const previewText = content.split("\n").slice(1, 3).join(" ").slice(0, 100);
  const now = Math.floor(Date.now() / 1000);
  const idx = state.notes.findIndex((n) => n.id === state.currentId);
  const updatedMeta = { id: state.currentId, title, modified: now, preview: previewText };
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
  const content = `# Untitled\n\n`;
  await invoke("save_note", { id, content });
  await loadNotes();
  await selectNote(id);
  setMode("edit");
  editor.setSelectionRange(2, 10); // select "Untitled"
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
  const preset = STICKY_TINT_PRESETS.find((p) => p.id === presetId) || STICKY_TINT_PRESETS[0];
  const app = document.getElementById("app");
  app.style.setProperty("--sticky-glass-1", preset.c1);
  app.style.setProperty("--sticky-glass-2", preset.c2);
}

function setupStickyTintPicker() {
  const el = document.getElementById("sticky-tint-picker");
  if (!el || !stickyNoteId) return;
  const raw = localStorage.getItem(`levinote-sticky-tint-${stickyNoteId}`);
  const current = stickyTintIdFromStorage(raw) || "mist";
  applyStickyTintById(current);

  const currentPreset = STICKY_TINT_PRESETS.find((p) => p.id === current) || STICKY_TINT_PRESETS[0];
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
          </li>`
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
    localStorage.setItem(`levinote-sticky-tint-${stickyNoteId}`, id);
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

const deletedNotesStack = [];

async function deleteCurrentNote() {
  if (!state.currentId) return;
  const content = await invoke("read_note", { id: state.currentId });
  deletedNotesStack.push({ id: state.currentId, content });
  await invoke("delete_note", { id: state.currentId });
  // Remove from local list
  state.notes = state.notes.filter((n) => n.id !== state.currentId);
  state.totalNotes = Math.max(0, state.totalNotes - 1);
  state.currentId = null;
  state.dirty = false;
  renderNoteList(state.searchQuery);

  if (state.notes.length > 0) {
    await selectNote(state.notes[0].id);
  } else {
    editor.value = "";
    preview.innerHTML = "";
    showEmptyState();
  }
}

async function undoDeleteNote() {
  if (deletedNotesStack.length === 0) return;
  const { id, content } = deletedNotesStack.pop();
  await invoke("save_note", { id, content });
  await loadNotes();
  await selectNote(id);
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
  if (!editor.value) return;
  copyToClipboard(editor.value);
  showCopyToast("Markdown copied!");
}

// ─── Render ───
let codeObserver = null;

function renderPreview(content) {
  if (!content || content.trim() === "") {
    preview.innerHTML = '<div class="empty-state">Start writing...</div>';
    return;
  }
  // Clean up previous observer
  if (codeObserver) {
    codeObserver.disconnect();
    codeObserver = null;
  }
  preview.innerHTML = marked.parse(content);
  setupCodeCopyButtons();
  lazyHighlightCodeBlocks();
  lazyLoadAssetImages();
  setupTodoCheckboxes();
  setupAssetLinkClicks();
  setupExternalLinkClicks();
}

function lazyHighlightCodeBlocks() {
  const pending = preview.querySelectorAll('.code-window[data-highlight="pending"]');
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
    { root: preview, rootMargin: "200px" }
  );

  pending.forEach((block) => codeObserver.observe(block));
}

function setupCodeCopyButtons() {
  preview.querySelectorAll(".code-copy-btn").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const code = btn.getAttribute("data-code")
        .replace(/&amp;/g, "&")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'");
      copyToClipboard(code);
      btn.classList.add("copied");
      btn.innerHTML = `<svg width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="M3 8.5l3.5 3.5 7-7" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
      setTimeout(() => {
        btn.classList.remove("copied");
        btn.innerHTML = `<svg width="14" height="14" viewBox="0 0 16 16" fill="none"><rect x="5" y="5" width="9" height="9" rx="1.5" stroke="currentColor" stroke-width="1.3"/><path d="M11 5V3.5A1.5 1.5 0 009.5 2h-6A1.5 1.5 0 002 3.5v6A1.5 1.5 0 003.5 11H5" stroke="currentColor" stroke-width="1.3"/></svg>`;
      }, 1500);
    });
  });

  // Collapsible code blocks via yellow dot
  preview.querySelectorAll(".dot-yellow[role='button']").forEach((dot) => {
    dot.addEventListener("click", (e) => {
      e.stopPropagation();
      const codeWindow = dot.closest(".code-window");
      codeWindow.classList.toggle("collapsed");
    });
  });
}

// ─── Lazy asset image loading ───
let imageObserver = null;
const blobCache = new Map();

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
    { root: preview, rootMargin: "200px" }
  );

  pending.forEach((el) => imageObserver.observe(el));
}

async function loadAssetImage(container, assetName) {
  try {
    let blobUrl = blobCache.get(assetName);
    if (!blobUrl) {
      const base64 = await invoke("read_asset", { name: assetName });
      const ext = assetName.split(".").pop().toLowerCase();
      const mimeMap = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", svg: "image/svg+xml" };
      const mime = mimeMap[ext] || "image/png";
      const binary = atob(base64);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      const blob = new Blob([bytes], { type: mime });
      blobUrl = URL.createObjectURL(blob);
      blobCache.set(assetName, blobUrl);
    }
    const img = document.createElement("img");
    img.src = blobUrl;
    img.alt = assetName;
    img.className = "asset-image";
    container.innerHTML = "";
    container.appendChild(img);
    container.classList.add("loaded");
  } catch {
    container.querySelector(".lazy-image-placeholder span").textContent = "Failed to load image";
    container.classList.add("error");
  }
}

// ─── Asset link click handler ───
function setupAssetLinkClicks() {
  preview.querySelectorAll(".asset-link[data-asset]").forEach((link) => {
    link.addEventListener("click", async (e) => {
      e.preventDefault();
      const assetName = link.dataset.asset;
      try {
        await invoke("reveal_asset", { name: assetName });
      } catch {
        showCopyToast("Failed to open file");
      }
    });
  });
}

// ─── External link click handler (open in default browser) ───
function setupExternalLinkClicks() {
  preview.querySelectorAll(".external-link[data-url]").forEach((link) => {
    link.addEventListener("click", async (e) => {
      e.preventDefault();
      const url = link.dataset.url;
      try {
        await shellOpen(url);
      } catch {
        showCopyToast("Failed to open link");
      }
    });
  });
}

// ─── Todo checkboxes ───
function setupTodoCheckboxes() {
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

    cb.addEventListener("change", () => {
      toggleTodoInMarkdown(index, cb.checked);
    });
  });

  // Make li click toggle the checkbox too (but not when clicking the checkbox itself)
  preview.querySelectorAll(".todo-item").forEach((li) => {
    li.addEventListener("keydown", (e) => {
      if (e.key === " " || e.key === "Enter") {
        e.preventDefault();
        const cb = li.querySelector('input[type="checkbox"]');
        if (cb) {
          cb.checked = !cb.checked;
          cb.dispatchEvent(new Event("change"));
        }
      }
    });
  });

}

function toggleTodoInMarkdown(index, checked) {
  const content = editor.value;
  const todoPattern = /^(\s*[-*+]\s*)\[([ xX])\]/gm;
  let match;
  let count = 0;

  while ((match = todoPattern.exec(content)) !== null) {
    if (count === index) {
      const newMark = checked ? "x" : " ";
      const before = content.slice(0, match.index + match[1].length + 1);
      const after = content.slice(match.index + match[1].length + 2);
      editor.value = before + newMark + after;
      state.dirty = true;
      saveCurrentNote();
      return;
    }
    count++;
  }
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

  // Switch to edit mode if needed
  if (state.mode !== "edit") {
    setMode("edit");
    editor.focus();
  }

  for (const filePath of paths) {
    try {
      const [assetName, originalName] = await invoke("copy_to_assets", { sourcePath: filePath });

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
  const start = editor.selectionStart;
  const end = editor.selectionEnd;
  const before = editor.value.substring(0, start);
  const after = editor.value.substring(end);
  // Ensure we're on a new line
  const needsNewline = before.length > 0 && !before.endsWith("\n");
  const insert = (needsNewline ? "\n" : "") + text;
  editor.value = before + insert + after;
  editor.selectionStart = editor.selectionEnd = start + insert.length;
  state.dirty = true;
  saveCurrentNote();
}

function renderNoteList(filter = "") {
  // When searching, state.notes already contains search results from the backend.
  // When not searching, state.notes contains the paginated list.
  const displayNotes = filter
    ? state.notes.filter(
        (n) =>
          n.title.toLowerCase().includes(filter.toLowerCase()) ||
          n.preview.toLowerCase().includes(filter.toLowerCase())
      )
    : state.notes;

  const hasMore = !state.searchQuery && state.notesOffset < state.totalNotes;

  noteList.innerHTML =
    displayNotes
      .map(
        (n) => `
    <li class="note-item ${n.id === state.currentId ? "active" : ""}" data-id="${n.id}">
      <div class="note-item-title">${escapeHtml(n.title)}</div>
      <div class="note-item-preview">${escapeHtml(n.preview)}</div>
      <div class="note-item-date">${formatDate(n.modified)}</div>
    </li>
  `
      )
      .join("") +
    (hasMore
      ? `<li class="note-list-sentinel" aria-hidden="true" style="height:1px;"></li>`
      : "");

  noteList.querySelectorAll(".note-item").forEach((el) => {
    el.addEventListener("click", () => selectNote(el.dataset.id));
  });

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
    { root: noteList, rootMargin: "200px" }
  );
  scrollObserver.observe(sentinel);
}

// ─── Debounced backend search ───
let searchTimeout = null;

async function handleSearch(query) {
  state.searchQuery = query;
  if (!query) {
    // Restore paginated list
    const result = await invoke("list_notes_paginated", { offset: 0, limit: PAGE_SIZE });
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
  preview.classList.add("visible");
  editor.classList.remove("visible");
}

function updateTitle() {
  const note = state.notes.find((n) => n.id === state.currentId);
  titlebarTitle.textContent = note ? note.title : "LeviNote";
}

// ─── Mode switching ───
function setMode(mode) {
  state.mode = mode;
  if (mode === "edit") {
    editor.classList.add("visible");
    preview.classList.remove("visible");
    modeIndicator.textContent = "editing";
    modeIndicator.classList.add("editing");
  } else {
    editor.classList.remove("visible");
    preview.classList.add("visible");
    renderPreview(editor.value);
    modeIndicator.textContent = "preview";
    modeIndicator.classList.remove("editing");
  }
}

// ─── Command Palette ───
function getCommands() {
  if (isSticky) {
    return [
      {
        label: "Open Sticky (this note)",
        hint: formatShortcut(state.shortcuts.newSticky),
        action: openNewSticky,
      },
      { label: "Delete Note", hint: formatShortcut(state.shortcuts.deleteNote), action: deleteCurrentNote },
      { label: "Undo Delete Note", hint: formatShortcut(state.shortcuts.undoDelete), action: undoDeleteNote },
      {
        label: "Toggle Edit/Preview",
        hint: formatShortcut(state.shortcuts.toggleEdit),
        action: () => setMode(state.mode === "edit" ? "preview" : "edit"),
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

  return [
    { label: "New Note", hint: formatShortcut(state.shortcuts.newNote), action: createNote },
    {
      label: "Open Sticky (this note)",
      hint: formatShortcut(state.shortcuts.newSticky),
      action: openNewSticky,
    },
    { label: "Delete Note", hint: formatShortcut(state.shortcuts.deleteNote), action: deleteCurrentNote },
    { label: "Undo Delete Note", hint: formatShortcut(state.shortcuts.undoDelete), action: undoDeleteNote },
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
    // Notes search — debounce backend call
    clearTimeout(paletteSearchTimeout);
    if (!query) {
      // Show current loaded notes immediately
      const items = state.notes.slice(0, 50).map((n) => ({
        label: n.title,
        hint: formatDate(n.modified),
        action: () => selectNote(n.id),
      }));
      renderPaletteItems(items);
    } else {
      paletteSearchTimeout = setTimeout(async () => {
        const results = await invoke("search_notes", { query, limit: 50 });
        const items = results.map((n) => ({
          label: n.title,
          hint: formatDate(n.modified),
          action: () => selectNote(n.id),
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
    <li class="palette-item ${i === state.selectedPaletteIndex ? "selected" : ""}" data-index="${i}">
      <span class="palette-item-label">${escapeHtml(item.label)}</span>
      <span class="palette-item-hint">${escapeHtml(item.hint)}</span>
    </li>
  `
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
  document
    .getElementById("btn-pin")
    .classList.toggle("active", state.pinned);
}

// ─── Event listeners ───
function setupEventListeners() {
  // Editor input
  let saveTimeout;
  editor.addEventListener("input", () => {
    state.dirty = true;
    clearTimeout(saveTimeout);
    saveTimeout = setTimeout(() => saveCurrentNote(), 800);
  });

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
        items.length - 1
      );
      renderPalette();
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      state.selectedPaletteIndex = Math.max(
        state.selectedPaletteIndex - 1,
        0
      );
      renderPalette();
    } else if (e.key === "Enter") {
      e.preventDefault();
      executePaletteItem(state.selectedPaletteIndex);
    } else if (e.key === "Escape") {
      closePalette();
    }
  });

  // Palette backdrop click
  document.querySelector(".palette-backdrop")?.addEventListener("click", closePalette);

  // Titlebar buttons
  document.getElementById("btn-sidebar").addEventListener("click", toggleSidebar);
  document.getElementById("btn-settings").addEventListener("click", openSettings);
  document.getElementById("btn-pin").addEventListener("click", togglePin);
  document.getElementById("btn-new").addEventListener("click", createNote);
  document.getElementById("btn-close").addEventListener("click", () => closeCurrentWindow());
  document.getElementById("btn-minimize").addEventListener("click", () => getCurrentWindow().minimize());

  // Sticky: CSS -webkit-app-region / data-tauri-drag-region fail to hit the gap between tint and
  // window controls on transparent WKWebView; use the window API instead.
  if (isSticky) {
    const tb = document.getElementById("titlebar");
    tb.removeAttribute("data-tauri-drag-region");
    document.querySelector(".titlebar-drag-spacer")?.removeAttribute("data-tauri-drag-region");
    tb.addEventListener("mousedown", (e) => {
      if (e.button !== 0) return;
      if (e.target.closest(".titlebar-btn") || e.target.closest(".sticky-tint-dd")) return;
      void getCurrentWindow().startDragging();
    });
  }

  // Drag & drop
  setupDropHandler();

  // ─── Block web-app behaviors to feel native ───
  // Prevent right-click context menu (except in text inputs and preview)
  document.addEventListener("contextmenu", (e) => {
    if (!e.target.closest("textarea, input, #preview")) e.preventDefault();
  });

  // Block refresh, devtools, and other browser-revealing shortcuts
  document.addEventListener("keydown", (e) => {
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
    if ((e.metaKey && e.altKey && e.key === "i") || (e.ctrlKey && e.shiftKey && e.key === "I")) {
      e.preventDefault();
      return;
    }
    // Cmd+Option+J — devtools console
    if (e.metaKey && e.altKey && e.key === "j") {
      e.preventDefault();
      return;
    }
    // Cmd+Option+U / Ctrl+U — view source
    if ((e.metaKey && e.altKey && e.key === "u") || (e.ctrlKey && e.key === "u")) {
      e.preventDefault();
      return;
    }
  }, true); // capture phase to intercept before anything else

  // Global keyboard shortcuts
  document.addEventListener("keydown", (e) => {
    // Shortcut recording intercepts everything
    if (handleShortcutRecording(e)) return;

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
        if (state.mode === "edit") {
          setMode("preview");
        } else {
          setMode("edit");
          editor.focus();
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

    if (matchesShortcut(e, sc.undoDelete)) {
      e.preventDefault();
      undoDeleteNote();
      return;
    }

    if (matchesShortcut(e, sc.copyNote)) {
      e.preventDefault();
      copyNoteMarkdown();
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

    // Escape: exit settings, palette, or edit mode
    if (e.key === "Escape") {
      if (state.settingsOpen) {
        closeSettings();
      } else if (state.paletteMode) {
        closePalette();
      } else if (state.mode === "edit") {
        setMode("preview");
      }
      return;
    }

    const meta = e.metaKey || e.ctrlKey;

    // Enter edit mode when typing (if in preview and no modifier)
    if (
      state.mode === "preview" &&
      state.currentId &&
      !state.paletteMode &&
      !state.settingsOpen &&
      !meta &&
      !e.altKey &&
      e.key.length === 1
    ) {
      setMode("edit");
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

  // Tab handling and line duplicate in editor
  editor.addEventListener("keydown", (e) => {
    if (e.key === "Tab") {
      e.preventDefault();
      const start = editor.selectionStart;
      const end = editor.selectionEnd;
      editor.value =
        editor.value.substring(0, start) + "  " + editor.value.substring(end);
      editor.selectionStart = editor.selectionEnd = start + 2;
      state.dirty = true;
    }

    // Option+Arrow: duplicate line up/down
    if (e.altKey && (e.key === "ArrowDown" || e.key === "ArrowUp") && e.shiftKey) {
      e.preventDefault();
      const val = editor.value;
      const cursor = editor.selectionStart;
      const selEnd = editor.selectionEnd;
      const lineStart = val.lastIndexOf("\n", cursor - 1) + 1;
      const lineEnd = val.indexOf("\n", selEnd);
      const end = lineEnd === -1 ? val.length : lineEnd;
      const line = val.slice(lineStart, end);

      if (e.key === "ArrowDown") {
        editor.value = val.slice(0, end) + "\n" + line + val.slice(end);
        editor.selectionStart = cursor + line.length + 1;
        editor.selectionEnd = selEnd + line.length + 1;
      } else {
        editor.value = val.slice(0, lineStart) + line + "\n" + val.slice(lineStart);
        editor.selectionStart = cursor;
        editor.selectionEnd = selEnd;
      }
      state.dirty = true;
    }
  });
}

function navigateNotes(direction) {
  if (state.notes.length === 0) return;
  const currentIndex = state.notes.findIndex(
    (n) => n.id === state.currentId
  );
  const newIndex = Math.max(
    0,
    Math.min(state.notes.length - 1, currentIndex + direction)
  );
  if (newIndex !== currentIndex) {
    selectNote(state.notes[newIndex].id);
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
init();
