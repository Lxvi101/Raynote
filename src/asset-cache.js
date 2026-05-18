import { invoke } from "@tauri-apps/api/core";

// Shared blob-URL cache so the preview pane (marked) and the live editor
// (CM6 image widgets) don't decode the same asset twice.
const blobCache = new Map();
const inFlight = new Map();

const MIME_MAP = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
};

function mimeFor(name) {
  const ext = (name.split(".").pop() || "").toLowerCase();
  return MIME_MAP[ext] || "image/png";
}

async function fetchAsBlobUrl(assetName) {
  const base64 = await invoke("read_asset", { name: assetName });
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  const blob = new Blob([bytes], { type: mimeFor(assetName) });
  return URL.createObjectURL(blob);
}

/** Resolve an asset to a blob: URL, caching across calls. */
export function getAssetBlobUrl(assetName) {
  const cached = blobCache.get(assetName);
  if (cached) return Promise.resolve(cached);

  const pending = inFlight.get(assetName);
  if (pending) return pending;

  const p = fetchAsBlobUrl(assetName)
    .then((url) => {
      blobCache.set(assetName, url);
      inFlight.delete(assetName);
      return url;
    })
    .catch((err) => {
      inFlight.delete(assetName);
      throw err;
    });
  inFlight.set(assetName, p);
  return p;
}

/** Load an image into the given .lazy-image container — used by the preview pane. */
export async function loadAssetImage(container, assetName) {
  try {
    const blobUrl = await getAssetBlobUrl(assetName);
    const img = document.createElement("img");
    img.src = blobUrl;
    img.alt = assetName;
    img.className = "asset-image";
    container.innerHTML = "";
    container.appendChild(img);
    container.classList.add("loaded");
  } catch {
    const span = container.querySelector(".lazy-image-placeholder span");
    if (span) span.textContent = "Failed to load image";
    container.classList.add("error");
  }
}
