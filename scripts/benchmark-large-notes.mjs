import { performance } from "node:perf_hooks";
import { EditorState } from "@codemirror/state";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { GFM } from "@lezer/markdown";
import { ByteLruCache } from "../src/byte-lru-cache.js";
import { blockField } from "../src/livemark/blocks.js";
import { renderMarkdown } from "../src/markdown-preview.js";

const quick = process.argv.includes("--quick");
const targetSizes = (quick ? [64, 256] : [64, 256, 1024]).map(
  (kilobytes) => kilobytes * 1024,
);
const rounds = quick ? 2 : 3;

const section = `## Project section

Paragraph with **bold**, *emphasis*, [a link](https://example.com), inline
\`code\`, and math $x^2 + y^2 = z^2$.

- [ ] Follow up on the benchmark
- Keep the interaction path responsive

| Metric | Target |
| --- | ---: |
| switch | < 100 ms |

\`\`\`js
const bounded = cache.size <= cache.max;
\`\`\`

`;

function giantNote(targetBytes) {
  const header = "# Giant benchmark note\n\n";
  const count = Math.max(1, Math.ceil((targetBytes - header.length) / section.length));
  return header + section.repeat(count);
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

function measure(fn, count) {
  const timings = [];
  let result;
  for (let index = 0; index < count; index++) {
    const start = performance.now();
    result = fn();
    timings.push(performance.now() - start);
  }
  return { result, medianMs: median(timings) };
}

const liveExtensions = [
  markdown({ base: markdownLanguage, extensions: [GFM] }),
  blockField,
];
let liveState = EditorState.create({ doc: "", extensions: liveExtensions });
const previewCache = new ByteLruCache({
  maxEntries: 60,
  maxBytes: 32 * 1024 * 1024,
  sizeOf: ({ content, html }) => (content.length + html.length) * 2,
});

const rows = [];
for (const targetBytes of targetSizes) {
  const content = giantNote(targetBytes);
  const rendered = measure(() => renderMarkdown(content), rounds);
  const html = rendered.result;
  const live = measure(() => {
    liveState = liveState.update({
      changes: { from: 0, to: liveState.doc.length, insert: content },
    }).state;
    return liveState;
  }, rounds);

  const retained = previewCache.set(`note-${targetBytes}`, { content, html });
  rows.push({
    markdownKB: Math.round(Buffer.byteLength(content) / 1024),
    htmlKB: Math.round(Buffer.byteLength(html) / 1024),
    expansion: `${(Buffer.byteLength(html) / Buffer.byteLength(content)).toFixed(1)}x`,
    renderMedianMs: Number(rendered.medianMs.toFixed(1)),
    liveStateReplaceMedianMs: Number(live.medianMs.toFixed(1)),
    retainedBy32MBPreviewCache: retained ? "yes" : "no",
  });
}

console.table(rows);
console.log(
  `Preview cache retained ${previewCache.size} entries / ${(
    previewCache.totalBytes /
    1024 /
    1024
  ).toFixed(1)} MB (32 MB cap).`,
);
console.log(
  "Scope: Markdown rendering, live-editor state replacement, and cache pressure. " +
    "Run the Tauri app to measure iCloud and WebKit DOM timing.",
);
