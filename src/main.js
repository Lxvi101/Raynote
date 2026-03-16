import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { listen } from "@tauri-apps/api/event";
import { marked } from "marked";
import "./style.css";

// ─── Configure marked ───
marked.setOptions({
  breaks: true,
  gfm: true,
});

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

// ─── Init ───
async function init() {
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

// ─── Render ───
function renderPreview(content) {
  if (!content || content.trim() === "") {
    preview.innerHTML = '<div class="empty-state">Start writing...</div>';
    return;
  }
  preview.innerHTML = marked.parse(content);
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
const commands = [
  { label: "New Note", hint: "Cmd+N", action: createNote },
  { label: "Delete Note", hint: "Cmd+Backspace", action: deleteCurrentNote },
  {
    label: "Toggle Edit/Preview",
    hint: "Cmd+E",
    action: () => setMode(state.mode === "edit" ? "preview" : "edit"),
  },
  {
    label: "Toggle Sidebar",
    hint: "Cmd+B",
    action: () => toggleSidebar(),
  },
  {
    label: "Pin Window on Top",
    hint: "Cmd+Shift+P",
    action: () => togglePin(),
  },
  {
    label: "Close Window",
    hint: "Cmd+W",
    action: () => getCurrentWindow().hide(),
  },
];

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
    items = commands
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
  document.getElementById("btn-pin").addEventListener("click", togglePin);
  document.getElementById("btn-new").addEventListener("click", createNote);
  document.getElementById("btn-close").addEventListener("click", () => getCurrentWindow().hide());
  document.getElementById("btn-minimize").addEventListener("click", () => getCurrentWindow().minimize());


  // Global keyboard shortcuts
  document.addEventListener("keydown", (e) => {
    const meta = e.metaKey || e.ctrlKey;

    // Command palette
    if (meta && e.key === "k") {
      e.preventDefault();
      if (state.paletteMode) {
        closePalette();
      } else {
        openPalette("notes");
      }
      return;
    }

    // Command mode in palette
    if (meta && e.shiftKey && e.key === "p") {
      e.preventDefault();
      if (!state.paletteMode) {
        openPalette("commands");
      } else {
        togglePin();
      }
      return;
    }

    // New note
    if (meta && e.key === "n") {
      e.preventDefault();
      createNote();
      return;
    }

    // Toggle edit/preview
    if (meta && e.key === "e") {
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

    // Toggle sidebar
    if (meta && e.key === "b") {
      e.preventDefault();
      toggleSidebar();
      return;
    }

    // Save
    if (meta && e.key === "s") {
      e.preventDefault();
      saveCurrentNote();
      return;
    }

    // Delete note
    if (meta && e.key === "Backspace") {
      e.preventDefault();
      deleteCurrentNote();
      return;
    }

    // Close
    if (meta && e.key === "w") {
      e.preventDefault();
      getCurrentWindow().hide();
      return;
    }

    // Escape: exit edit mode or close palette
    if (e.key === "Escape") {
      if (state.paletteMode) {
        closePalette();
      } else if (state.mode === "edit") {
        setMode("preview");
      }
      return;
    }

    // Enter edit mode when typing (if in preview and no modifier)
    if (
      state.mode === "preview" &&
      state.currentId &&
      !state.paletteMode &&
      !meta &&
      !e.altKey &&
      e.key.length === 1
    ) {
      setMode("edit");
      editor.focus();
      // Let the keypress propagate to the editor
    }

    // Navigate notes with arrow keys when not editing
    if (state.mode === "preview" && !state.paletteMode) {
      if (e.key === "ArrowDown" || e.key === "j") {
        e.preventDefault();
        navigateNotes(1);
      } else if (e.key === "ArrowUp" || e.key === "k") {
        e.preventDefault();
        navigateNotes(-1);
      }
    }

    // Focus search
    if (e.key === "/" && state.mode === "preview" && !state.paletteMode) {
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
function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

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
