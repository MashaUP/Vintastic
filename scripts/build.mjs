/**
 * Crea il pacchetto distribuibile: dist/Vintastic-<versione>.zip (solo i file
 * dell'estensione, cartella "Vintastic/" dentro) e il suo .sha256.
 * Esclude test, documentazione di sviluppo, workflow, node_modules.
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";

const ROOT = path.resolve(import.meta.dirname, "..");
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, "manifest.json"), "utf8"));
const version = manifest.version;
const INCLUDE = ["manifest.json", "icons", "assets", "src", "LICENSE", "README.md", "CHANGELOG.md"];
const dist = path.join(ROOT, "dist");
const stage = path.join(dist, "Vintastic");
fs.rmSync(dist, { recursive: true, force: true });
fs.mkdirSync(stage, { recursive: true });
for (const item of INCLUDE) {
  const from = path.join(ROOT, item);
  if (!fs.existsSync(from)) throw new Error(`Manca ${item}`);
  fs.cpSync(from, path.join(stage, item), { recursive: true, filter: (p) => !/(\.DS_Store|Thumbs\.db|\.map)$/.test(p) });
}
const zipName = `Vintastic-${version}.zip`;
const zipPath = path.join(dist, zipName);
execFileSync("zip", ["-r", "-X", "-q", zipPath, "Vintastic"], { cwd: dist });
const hash = crypto.createHash("sha256").update(fs.readFileSync(zipPath)).digest("hex");
fs.writeFileSync(`${zipPath}.sha256`, `${hash}  ${zipName}\n`);
const files = execFileSync("zip", ["-sf", zipPath], { encoding: "utf8" }).split("\n").filter((l) => l.startsWith("  ")).length;
for (const must of ["Vintastic/manifest.json", "Vintastic/src/background/sw.js", "Vintastic/src/shared/guard-core.js", "Vintastic/icons/icon128.png"]) {
  if (!execFileSync("zip", ["-sf", zipPath], { encoding: "utf8" }).includes(must)) throw new Error(`Lo zip non contiene ${must}`);
}
for (const mustNot of ["tests/", "node_modules", ".github", "scripts/"]) {
  if (execFileSync("zip", ["-sf", zipPath], { encoding: "utf8" }).includes(`Vintastic/${mustNot}`)) throw new Error(`Lo zip contiene ${mustNot}`);
}
console.log(`✔ ${zipName} · ${files} file · ${(fs.statSync(zipPath).size / 1024).toFixed(0)} KB\n  SHA-256 ${hash}`);
