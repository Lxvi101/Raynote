# Raynote Contributor Guide

Raynote is a fast, local-first markdown notes app built with Tauri 2, Vite, plain browser DOM APIs, and CodeMirror 6 for optional live-preview editing. Notes are stored as `.md` files in iCloud Drive at `~/Library/Mobile Documents/com~apple~CloudDocs/Raynote`, with a small native Rust backend handling file IO, metadata caches, global shortcuts, tray behavior, sticky windows, and macOS glass effects.

The app feels fast because it avoids doing expensive work on the interaction path. Keep that property intact.

## Project Shape

- `index.html`: static shell, custom titlebar, sidebar, preview, textarea editor, command palette, and an inline first-paint splash.
- `src/main.js`: main frontend controller. Owns UI state, note selection, CRUD, shortcuts, settings, preview caching, lazy loading, and Tauri IPC calls.
- `src/editor-adapter.js`: backend-neutral editor API. All app code should talk to `editor`, not directly to a textarea or CodeMirror view.
- `src/markdown-preview.js`: full markdown-to-HTML preview renderer using `marked`, KaTeX, custom image/link/code renderers.
- `src/markdown-worker.js`: worker wrapper around `renderMarkdown()` so cache misses do not block the UI thread.
- `src/asset-cache.js`: shared asset blob URL cache for preview and live editor widgets.
- `src/livepreview/*`: CodeMirror 6 live-preview editor, decorations, image widgets, KaTeX widgets, and theme.
- `src/style.css`: full visual system and component styling.
- `src-tauri/src/lib.rs`: native backend, note metadata cache, iCloud file IO, preview cache files, sticky windows, global shortcuts, tray, vibrancy.
- `vite.config.js`: Safari 16 target, strict dev port `5173`, ignores `src-tauri` during Vite watch.

Useful commands:

- `npm run dev`: Vite dev server.
- `npm run build`: frontend build.
- `npm run tauri`: Tauri CLI entry.
- `npm run tauri:build`: production app and DMG build.

## How The App Works

Startup has two halves:

1. Rust setup reads the persisted metadata cache from the OS cache directory and exposes it immediately through `list_notes_paginated`.
2. Rust starts a background iCloud scan. It emits `note-meta-loaded` for each note, `notes-loading-progress` while scanning, and `notes-loaded` when complete.

The frontend attaches listeners early, hides the splash for the main window quickly, renders cached metadata, and then progressively fills or refreshes the list as the backend scan catches up. Sticky windows use `index.html?sticky=1&id=<noteId>` and wait for their note before dismissing the splash.

Notes are represented by markdown files. The first heading becomes the title, the next two lines become the sidebar preview, and modified time controls sort order. Deleted notes are moved into `.trash` under the Raynote iCloud folder so undo/restore can work.

The editor has three modes:

- `preview`: rendered markdown in `#preview`.
- `edit`: raw textarea through `TextareaBackend`.
- `live`: CodeMirror 6 through `LiveBackend`, loaded only when first needed.

The `EditorAdapter` is the contract between app behavior and editor implementation. Features such as save, insert-at-cursor, todo toggles, dropped assets, auto-title, and copy markdown should use the adapter methods.

## Why It Is Fast

The speed comes from several specific design decisions:

- Rust metadata cache: startup can show notes before iCloud scanning finishes.
- Mtime fast path: during scan, unchanged notes reuse cached metadata after a cheap `metadata().modified()` check. This avoids downloading evicted iCloud file contents.
- Prefix metadata reads: metadata parsing reads only the first 4 KB of a note, not the whole file.
- Background scan thread: iCloud reads happen off the Tauri setup path.
- Progressive loading events: the sidebar can fill while scanning instead of waiting for all notes.
- Pagination: the frontend loads `PAGE_SIZE = 50` notes, then infinite-scrolls more through `list_notes_paginated`.
- Search runs against Rust's in-memory metadata cache, not against the filesystem.
- Content cache: `contentCache` avoids re-reading note bodies from iCloud when switching back to a note.
- Preview memory cache: `previewCache` keeps recent rendered HTML keyed by note id plus exact content.
- Preview disk cache: rendered HTML is persisted under the OS cache directory and keyed by a SHA-256 content hash.
- Markdown workers: full markdown rendering happens in Web Workers on cache misses.
- Render cancellation: selecting another note terminates stale markdown work and ignores late results using `renderGeneration`.
- Paint yielding: expensive preview rendering waits until after a paint so the UI can show immediate selection/loading feedback.
- Lazy CodeMirror: live editor code and plugins are imported only when the user enters live mode.
- Live preview works only over visible ranges. CM6 decorations inspect `view.visibleRanges`, not the full document.
- KaTeX live widgets memoize rendered math per note.
- Asset images share cached blob URLs across preview and live editor.
- Code highlighting and asset image loading use `IntersectionObserver` with a margin, so hidden content is not processed immediately.
- Event delegation keeps preview and note-list handlers stable instead of rebinding many per-element listeners.
- Warm preview caching is idle-time only, bounded, and only warms notes whose content is already in memory.

## Do Not Break The Speed

Treat these as invariants:

- Do not synchronously read every note body during startup or sidebar render.
- Do not replace `read_meta_prefix()` with `read_to_string()` for metadata. Full reads can trigger iCloud downloads.
- Do not move iCloud scans onto the UI/setup thread.
- Do not make note selection wait on work that can happen after paint.
- Do not remove `renderGeneration` checks around async rendering and disk-cache reads.
- Do not remove `cancelPendingMarkdownRender()` when switching notes.
- Do not run `marked.parse()`, Highlight.js, or KaTeX over large content on the UI thread unless it is already off the critical path.
- Do not eagerly initialize CodeMirror at boot.
- Do not eagerly highlight every code block or load every asset image after preview render.
- Do not attach per-block/per-link/per-checkbox listeners inside rendered preview HTML. Use delegation on `preview`.
- Do not rebuild the whole note list just to change active selection. Use `updateNoteListActiveState()` when possible.
- Do not invalidate both content and preview caches unless the underlying note content actually changed.
- Do not call `loadNotes()` after every small UI action if local state can be updated directly.
- Do not add broad filesystem watchers or polling loops against iCloud files without a hard performance reason.
- Do not store huge data in `localStorage`; use disk files or Tauri commands where appropriate.

When in doubt, ask: "Does this run during startup, note selection, typing, scrolling, or preview rendering?" If yes, keep it bounded, cached, cancellable, lazy, or off-thread.

## Clean Integration Rules

Follow the existing ownership boundaries:

- Native file/system behavior belongs in `src-tauri/src/lib.rs`.
- Frontend app orchestration belongs in `src/main.js`.
- Markdown preview output belongs in `src/markdown-preview.js`.
- Raw/live editor details belong behind `src/editor-adapter.js` or `src/livepreview/*`.
- Shared asset loading belongs in `src/asset-cache.js`.
- Visual styling belongs in `src/style.css`; avoid inline styles except generated markdown width/alignment hints and dynamic CSS variables.

For a new note operation:

1. Add or reuse a Tauri command only if filesystem/native access is needed.
2. Update Rust's `notes_cache` and call `write_notes_meta_cache()` after mutations.
3. Update frontend `state.notes` locally when possible instead of reloading everything.
4. Invalidate `previewCache`, disk preview cache, and `contentCache` only for affected note ids.
5. Preserve pinned-note behavior, pagination counters, and active selection state.

For new markdown syntax or rendering:

1. Add full preview support in `src/markdown-preview.js`.
2. If live mode should match it, add a CM6 plugin/widget in `src/livepreview/*`.
3. Keep preview renderer output inert and escaped. All custom renderer text must pass through `escapeHtml()` unless generated by a trusted library like KaTeX.
4. Keep heavy transforms out of `applyPreviewHtml()`. It should swap HTML and set up lazy observers/attributes.

For editor features:

1. Use `editor.getText()`, `editor.setText()`, `editor.getSelection()`, `editor.setSelection()`, and `editor.replaceRange()`.
2. Do not reach into `editorEl.value` from feature code unless implementing the textarea backend.
3. If a programmatic edit should save, make it go through a path that emits or explicitly marks `state.dirty` and saves.
4. Keep cursor position stable when switching editor backends or rewriting content.

For settings and shortcuts:

- Store user preferences in `localStorage` with the existing `raynote-*` key pattern.
- Apply visual settings by updating CSS variables/classes on `document.documentElement`.
- Register global shortcuts through `set_global_shortcut`; Rust intentionally registers the new shortcut before unregistering the old one.
- Keep shortcut recording synchronous at the event interception layer, even if actual registration is async.

For async code:

- Always guard note-specific async work with `state.currentId` and/or `renderGeneration`.
- Prefer fire-and-forget only for optional work that can fail silently, such as auto-title generation or cache writes.
- Use `requestAnimationFrame`, `setTimeout(0)`, `requestIdleCallback`, workers, or backend threads to keep user-visible actions responsive.

## Design Schema

Raynote's design is dark, compact, glassy, and utilitarian. It should feel like a focused native Mac utility, not a marketing site.

Core tokens live in `:root` in `src/style.css`:

- Backgrounds: `--bg`, `--bg-solid`, `--surface`, `--surface-hover`, `--surface-active`.
- Borders: `--border`, `--border-focus`.
- Text: `--text`, `--text-secondary`, `--text-dim`.
- Accents: `--accent` purple for selection/editor focus, `--danger` for destructive states, `--accent-red`/`--accent-red-bright`/`--accent-red-glow` for Raynote's edge-glow identity.
- Radii: `--radius: 10px`, `--radius-lg: 14px`.
- Motion: `--transition: 180ms cubic-bezier(0.4, 0, 0.2, 1)`.
- Fonts: `--font` Inter/system sans, `--font-mono` JetBrains Mono/ui monospace.

Window design:

- The Tauri window is transparent, undecorated, and shadowless. CSS and native vibrancy create the visible shell.
- `#app` is the main rounded glass container with 12px radius, subtle border, black translucent fill, and strong shadow.
- macOS vibrancy is applied in Rust through `apply_glass_effects()`.
- The titlebar is 42px tall, draggable except controls, and uses compact icon buttons.

Edge glow:

- `#app::before` is the crisp conic-gradient rim.
- `#app::after` is the inner ambient glow behind content.
- JS writes `--glow-rim-width`, `--glow-stop-inner`, `--glow-stop-outer`, and `--glow-intensity`.
- `.glow-disabled` hides both layers. `.glow-static` freezes the angle at the top.
- Respect `prefers-reduced-motion`.

Layout:

- `#main` contains the sidebar and editor area.
- Sidebar is dense: search, new-note button, virtual-ish paginated list, pinned section, preview text, date.
- Editor area overlays preview, textarea, and live editor surfaces; modes toggle visibility/chrome.
- Sticky windows hide the sidebar and use tinted glass presets from `STICKY_TINT_PRESETS`.

Component style:

- Buttons are small, icon-first, translucent, and hover through surface tokens.
- Cards are used mainly inside settings groups, not as page-level containers.
- Settings use a modal with left nav, grouped cards, compact labels, descriptions, toggles, ranges, selects, and keycaps.
- Code preview blocks use a small "window" treatment with copy and collapse affordances.
- Inline code is clickable and visually distinct.
- Asset links and external links are rendered differently and handled through delegated preview clicks.

Typography:

- Base UI text is 13px.
- Preview content should stay readable and calm, with generous line-height.
- Editor/live editor uses monospace at about 13.5px.
- Headings should scale modestly; avoid oversized hero-style text.

Design rules for new UI:

- Prefer existing tokens over new colors.
- Keep controls compact and aligned to the app's dense utility feel.
- Use icon buttons for obvious commands.
- Avoid large decorative gradients, landing-page layouts, and oversized cards.
- Keep motion subtle and cancellable through reduced-motion.
- Make empty/loading states concise and non-blocking.

## Performance Checklist Before Shipping

- Startup still shows cached notes quickly.
- Cold iCloud scans still show progress and do not freeze the window.
- Switching rapidly between notes does not show stale preview HTML.
- Typing in textarea and live mode stays responsive.
- Preview cache is invalidated on content changes and reused otherwise.
- Code blocks and images below the fold are still lazy.
- Search does not read note files.
- Pinned notes still appear even when outside the first page.
- Sticky windows still open by note id and do not depend on sidebar state.

