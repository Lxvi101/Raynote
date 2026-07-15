// Live markdown engine — a Notion/Obsidian-style editor where the document
// is always editable and markdown renders in place. Markers reveal when the
// selection touches an element and hide again when it leaves.
//
// Lazily imported by main.js so CM6 stays off the boot path.

import { EditorState } from "@codemirror/state";
import {
  EditorView,
  keymap,
  drawSelection,
  placeholder,
} from "@codemirror/view";
import {
  history,
  historyKeymap,
  defaultKeymap,
  indentWithTab,
} from "@codemirror/commands";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { languages } from "@codemirror/language-data";
import { GFM } from "@lezer/markdown";

import { LiveBackend } from "./backend.js";
import { inlinePlugin } from "./inline.js";
import { blockField } from "./blocks.js";
import { raynoteTheme, raynoteHighlight } from "./theme.js";
import { formatKeymap } from "./commands.js";

let setupDone = false;

/**
 * Create the live markdown editor.
 *
 * Mounts a `<div id="live-editor">` inside the supplied container and
 * registers a `LiveBackend` with the provided adapter under the name "live".
 *
 * @param onOpenLink  called with an http(s) URL on ⌘-click of a link
 * @param onOpenAsset called with an asset name on ⌘-click of an asset: link
 * @returns the wrapper element (so the caller can toggle .visible on it).
 */
export function setupLiveEditor({ container, adapter, onOpenLink, onOpenAsset }) {
  if (setupDone) {
    throw new Error("setupLiveEditor called twice");
  }
  setupDone = true;

  const wrapper = document.createElement("div");
  wrapper.id = "live-editor";
  wrapper.className = "editor-surface";
  container.appendChild(wrapper);

  const backend = new LiveBackend();

  const openUrl = (url) => {
    if (!url) return;
    if (url.startsWith("asset:")) {
      onOpenAsset?.(url.slice(6));
    } else {
      onOpenLink?.(url);
    }
  };

  const view = new EditorView({
    state: EditorState.create({
      doc: adapter.getText(),
      extensions: [
        history(),
        drawSelection(),
        placeholder("Start writing..."),
        markdown({
          base: markdownLanguage,
          extensions: [GFM],
          codeLanguages: languages, // lazy per-language highlighting in fences
          addKeymap: true, // list continuation, blockquote continuation, etc.
        }),
        EditorView.lineWrapping,
        inlinePlugin,
        blockField,
        raynoteHighlight,
        raynoteTheme,
        EditorView.domEventHandlers({
          mousedown(e) {
            // ⌘-click opens links (plain click positions the cursor to edit).
            if (!(e.metaKey || e.ctrlKey)) return false;
            const link = e.target.closest?.(".cm-link[data-url]");
            if (!link) return false;
            e.preventDefault();
            openUrl(link.getAttribute("data-url"));
            return true;
          },
        }),
        keymap.of([
          ...formatKeymap,
          indentWithTab,
          ...defaultKeymap,
          ...historyKeymap,
        ]),
        EditorView.updateListener.of((update) => backend._emit(update)),
      ],
    }),
    parent: wrapper,
  });

  backend.setView(view);
  adapter.register("live", backend);

  return wrapper;
}
