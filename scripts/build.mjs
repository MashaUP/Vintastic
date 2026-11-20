/**
 * Pacchetti (standard comuni, sezione 5).
 *   npm run build    → dist/Vintastic-<versione>.zip (cartella «Vintastic/» con solo i file
 *                      dell'estensione, più LICENSE, README, CHANGELOG) e il suo .sha256.
 *   npm run package  → in più: aggiorna la versione nel README, sostituisce lo zip nella radice
 *                      del repository, scrive nome e SHA-256 dello zip in version.json e crea
 *                      dist/Vintastic_GitHub.zip (cartella «Vintastic_GitHub/» con tutti i file
 *                      del repository tranne node_modules, dist, .git).
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";

const ROOT = path.resolve(import.meta.dirname, "..");
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, "manifest.json"), "utf8"));
const version = manifest.version;
const INCLUDE = ["manifest.json", "icons", "assets", "src", "LICENSE", "README.md", "CHANGELOG.md"];
const github = process.argv.includes("--github");
const SKIP = /(\.DS_Store|Thumbs\.db|\.map|\.log)$/;
// Il README finisce anche nello zip: la riga della versione si aggiorna prima di comprimere.
if (github) {
  const readme = path.join(ROOT, "README.md");
  const text = fs.readFileSync(readme, "utf8");
  const next = text.replace(/(\| Versione \| \*\*)\d+\.\d+\.\d+(\*\* \|)/, `$1${version}$2`);
  if (next !== text) fs.writeFileSync(readme, next);
}
const dist = path.join(ROOT, "dist");
const stage = path.join(dist, "Vintastic");
fs.rmSync(dist, { recursive: true, force: true });
fs.mkdirSync(stage, { recursive: true });
for (const item of INCLUDE) {
  const from = path.join(ROOT, item);
  if (!fs.existsSync(from)) throw new Error(`Manca ${item}`);
  fs.cpSync(from, path.join(stage, item), { recursive: true, filter: (p) => !SKIP.test(p) });
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

if (github) {
  for (const f of fs.readdirSync(ROOT)) if (/^Vintastic-.+\.zip$/i.test(f)) fs.rmSync(path.join(ROOT, f));
  fs.copyFileSync(zipPath, path.join(ROOT, zipName));
  const vPath = path.join(ROOT, "version.json");
  const v = JSON.parse(fs.readFileSync(vPath, "utf8"));
  if (v.version !== version) throw new Error(`version.json è alla ${v.version}, il manifest alla ${version}`);
  v.zip = zipName;
  v.sha256 = hash;
  fs.writeFileSync(vPath, `${JSON.stringify(v, null, 2)}\n`);
  const gh = path.join(dist, "Vintastic_GitHub");
  fs.mkdirSync(gh, { recursive: true });
  const EXCLUDE = new Set(["node_modules", "dist", ".git"]);
  for (const f of fs.readdirSync(ROOT)) {
    if (EXCLUDE.has(f)) continue;
    fs.cpSync(path.join(ROOT, f), path.join(gh, f), { recursive: true, filter: (p) => !SKIP.test(p) && !/__pycache__|[\\/]artifacts([\\/]|$)/.test(p) });
  }
  const ghZip = path.join(dist, "Vintastic_GitHub.zip");
  execFileSync("zip", ["-r", "-X", "-q", ghZip, "Vintastic_GitHub"], { cwd: dist });
  const ghList = execFileSync("unzip", ["-Z1", ghZip], { encoding: "utf8" }).split("\n");
  for (const must of [`Vintastic_GitHub/${zipName}`, "Vintastic_GitHub/manifest.json", "Vintastic_GitHub/version.json", "Vintastic_GitHub/links.json", "Vintastic_GitHub/README.md", "Vintastic_GitHub/eslint.config.js", "Vintastic_GitHub/.github/workflows/ci.yml"]) {
    if (!ghList.includes(must)) throw new Error(`Vintastic_GitHub.zip non contiene ${must}`);
  }
  for (const mustNot of ["node_modules/", "dist/", ".git/"]) if (ghList.some((l) => l.startsWith(`Vintastic_GitHub/${mustNot}`))) throw new Error(`Vintastic_GitHub.zip contiene ${mustNot}`);
  console.log(`✔ Vintastic_GitHub.zip · ${ghList.filter((l) => l && !l.endsWith("/")).length} file · ${(fs.statSync(ghZip).size / 1024).toFixed(0)} KB\n  version.json: zip ${zipName}, sha256 ${hash}`);
}
