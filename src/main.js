import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { listen } from "@tauri-apps/api/event";
import { marked } from "marked";
import hljs from "highlight.js";
import "highlight.js/styles/github-dark-dimmed.min.css";
import katex from "katex";
import "katex/dist/katex.min.css";
import "./style.css";

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

// ─── Custom code block renderer ───
const codeRenderer = {
  code(token) {
    const lang = token.lang || "";
    const displayLang = lang || "plain";
    let highlighted;
    if (lang && hljs.getLanguage(lang)) {
      highlighted = hljs.highlight(token.text, { language: lang }).value;
    } else {
      highlighted = hljs.highlightAuto(token.text).value;
    }
    const escaped = escapeHtml(token.text).replace(/"/g, "&quot;");
    return `<div class="code-window">
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
        <pre><code class="hljs">${highlighted}</code></pre>
      </div>
    </div>`;
  },
};

// ─── Configure marked ───
marked.use({ extensions: [latexBlock, latexInline] });
marked.use({ renderer: codeRenderer });
marked.setOptions({
  breaks: true,
  gfm: true,
});

// ─── Shortcuts system ───
const defaultShortcuts = {
  newNote:        { label: "New Note",             key: "n", meta: true },
  deleteNote:     { label: "Delete Note",          key: "Backspace", meta: true },
  toggleEdit:     { label: "Toggle Edit/Preview",  key: "e", meta: true },
  toggleSidebar:  { label: "Toggle Sidebar",       key: "b", meta: true },
  save:           { label: "Save Note",            key: "s", meta: true },
  closeWindow:    { label: "Close Window",         key: "w", meta: true },
  openPalette:    { label: "Search Notes",         key: "k", meta: true },
  commandPalette: { label: "Command Palette",      key: "p", meta: true, shift: true },
  pinWindow:      { label: "Pin Window on Top",    key: "t", meta: true, shift: true },
  copyNote:       { label: "Copy Note as Markdown", key: "c", meta: true, shift: true },
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

// ─── State ───
const state = {
  notes: [],
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
  // Restore dock visibility
  if (localStorage.getItem("levinote-hide-dock") === "1") {
    invoke("set_dock_visible", { visible: false });
  }

  await loadNotes();

  if (state.notes.length > 0) {
    await selectNote(state.notes[0].id);
  } else {
    showEmptyState();
  }

  setupEventListeners();
  setupTauriListeners();
}

// ─── Notes CRUD ───
async function loadNotes() {
  state.notes = await invoke("list_notes");
  renderNoteList();
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
  renderNoteList();
  updateTitle();
}

async function saveCurrentNote() {
  if (!state.currentId) return;
  await invoke("save_note", { id: state.currentId, content: editor.value });
  state.dirty = false;
  await loadNotes();
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

async function deleteCurrentNote() {
  if (!state.currentId) return;
  await invoke("delete_note", { id: state.currentId });
  state.currentId = null;
  state.dirty = false;
  await loadNotes();

  if (state.notes.length > 0) {
    await selectNote(state.notes[0].id);
  } else {
    editor.value = "";
    preview.innerHTML = "";
    showEmptyState();
  }
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
function renderPreview(content) {
  if (!content || content.trim() === "") {
    preview.innerHTML = '<div class="empty-state">Start writing...</div>';
    return;
  }
  preview.innerHTML = marked.parse(content);
  setupCodeCopyButtons();
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

function renderNoteList(filter = "") {
  const filtered = filter
    ? state.notes.filter(
        (n) =>
          n.title.toLowerCase().includes(filter.toLowerCase()) ||
          n.preview.toLowerCase().includes(filter.toLowerCase())
      )
    : state.notes;

  noteList.innerHTML = filtered
    .map(
      (n) => `
    <li class="note-item ${n.id === state.currentId ? "active" : ""}" data-id="${n.id}">
      <div class="note-item-title">${escapeHtml(n.title)}</div>
      <div class="note-item-preview">${escapeHtml(n.preview)}</div>
      <div class="note-item-date">${formatDate(n.modified)}</div>
    </li>
  `
    )
    .join("");

  noteList.querySelectorAll(".note-item").forEach((el) => {
    el.addEventListener("click", () => selectNote(el.dataset.id));
  });
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
  return [
    { label: "New Note", hint: formatShortcut(state.shortcuts.newNote), action: createNote },
    { label: "Delete Note", hint: formatShortcut(state.shortcuts.deleteNote), action: deleteCurrentNote },
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
      action: () => getCurrentWindow().hide(),
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

function renderPalette() {
  const query = paletteInput.value.toLowerCase();
  let items = [];

  if (state.paletteMode === "commands" || query.startsWith(">")) {
    const q = query.replace(/^>\s*/, "");
    items = getCommands()
      .filter((c) => c.label.toLowerCase().includes(q))
      .map((c) => ({
        label: c.label,
        hint: c.hint,
        action: c.action,
      }));
  } else {
    // Notes search
    const filtered = query
      ? state.notes.filter(
          (n) =>
            n.title.toLowerCase().includes(query) ||
            n.preview.toLowerCase().includes(query)
        )
      : state.notes;

    items = filtered.map((n) => ({
      label: n.title,
      hint: formatDate(n.modified),
      action: () => selectNote(n.id),
    }));
  }

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

  // Search
  search.addEventListener("input", () => {
    renderNoteList(search.value);
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
  document.getElementById("btn-close").addEventListener("click", () => getCurrentWindow().hide());
  document.getElementById("btn-minimize").addEventListener("click", () => getCurrentWindow().minimize());


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
      state.settingsOpen ? closeSettings() : openSettings();
      return;
    }

    if (matchesShortcut(e, sc.newNote)) {
      e.preventDefault();
      createNote();
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
      toggleSidebar();
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
      getCurrentWindow().hide();
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

    // Focus search
    if (e.key === "/" && state.mode === "preview" && !state.paletteMode && !state.settingsOpen) {
      e.preventDefault();
      if (!state.sidebarOpen) toggleSidebar();
      search.focus();
    }
  });

  // Tab handling in editor
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
