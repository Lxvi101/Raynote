import { EditorState } from "@codemirror/state";
import {
  EditorView,
  keymap,
  drawSelection,
  highlightActiveLine,
  rectangularSelection,
  crosshairCursor,
} from "@codemirror/view";
import {
  history,
  historyKeymap,
  defaultKeymap,
  indentWithTab,
} from "@codemirror/commands";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { GFM } from "@lezer/markdown";
import {
  syntaxHighlighting,
  defaultHighlightStyle,
  bracketMatching,
} from "@codemirror/language";

import { LiveBackend } from "./backend.js";
import { livePreviewPlugin } from "./decorations.js";
import { raynoteTheme } from "./theme.js";
import { katexPlugin } from "./katex-widget.js";
import { imagePlugin } from "./image-widget.js";

let setupDone = false;

/**
 * Create a CodeMirror 6 editor for live-preview markdown editing.
 *
 * Mounts a `<div id="live-editor">` inside the supplied container and registers
 * a `LiveBackend` with the provided adapter under the name `"live"`.
 *
 * @returns the wrapper element (so the caller can toggle .visible on it).
 */
export function setupLiveEditor({ container, adapter, getActiveNoteId }) {
  if (setupDone) {
    throw new Error("setupLiveEditor called twice");
  }
  setupDone = true;

  const wrapper = document.createElement("div");
  wrapper.id = "live-editor";
  wrapper.className = "editor-surface";
  container.appendChild(wrapper);

  const backend = new LiveBackend();

  const view = new EditorView({
    state: EditorState.create({
      doc: adapter.getText(),
      extensions: [
        history(),
        drawSelection(),
        bracketMatching(),
        highlightActiveLine(),
        rectangularSelection(),
        crosshairCursor(),
        markdown({
          base: markdownLanguage,
          extensions: [GFM],
          addKeymap: true,
        }),
        syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
        EditorView.lineWrapping,
        livePreviewPlugin,
        katexPlugin({ getActiveNoteId }),
        imagePlugin(),
        raynoteTheme,
        keymap.of([indentWithTab, ...defaultKeymap, ...historyKeymap]),
        EditorView.updateListener.of((update) => backend._emit(update)),
      ],
    }),
    parent: wrapper,
  });

  backend.setView(view);
  adapter.register("live", backend);

  return wrapper;
}
