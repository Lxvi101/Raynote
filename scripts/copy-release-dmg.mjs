import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");
const dmgDir = path.join(root, "src-tauri/target/release/bundle/dmg");
const releasesDir = path.join(root, "releases");

if (!fs.existsSync(dmgDir)) {
  console.error(`Missing ${dmgDir}. Run a release Tauri build first.`);
  process.exit(1);
}

const dmgs = fs.readdirSync(dmgDir).filter((f) => f.endsWith(".dmg"));
if (!dmgs.length) {
  console.error(`No .dmg files in ${dmgDir}.`);
  process.exit(1);
}

const name =
  dmgs.find((f) => f.startsWith("Raynote")) ?? dmgs.sort().at(-1);
fs.mkdirSync(releasesDir, { recursive: true });
const src = path.join(dmgDir, name);
const dest = path.join(releasesDir, name);
fs.copyFileSync(src, dest);
console.log(`Copied release DMG to ${dest}`);
