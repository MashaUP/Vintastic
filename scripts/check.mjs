/**
 * Controlli prima dei test e della release:
 * versioni allineate, domini allineati, file del manifest presenti, sintassi di
 * tutti i file JS, JSON validi, nessun segreto nel repository.
 */
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const ROOT = path.resolve(import.meta.dirname, "..");
const errors = [];
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");
const json = (p) => { try { return JSON.parse(read(p)); } catch (e) { errors.push(`${p}: JSON non valido (${e.message})`); return {}; } };

const manifest = json("manifest.json");
const pkg = json("package.json");
const versionJson = json("version.json");
json("links.json");
const constants = read("src/shared/constants.js");
const constVersion = constants.match(/export const VERSION = "([^"]+)"/)?.[1];
const versions = { manifest: manifest.version, "package.json": pkg.version, "version.json": versionJson.version, "constants.js": constVersion };
if (new Set(Object.values(versions)).size !== 1) errors.push(`Versioni non allineate: ${JSON.stringify(versions)}`);
if (!/^\d+\.\d+\.\d+$/.test(manifest.version || "")) errors.push(`Versione del manifest non semver: ${manifest.version}`);
const tag = process.env.RELEASE_TAG;
if (tag && tag.replace(/^v/, "") !== manifest.version) errors.push(`Il tag ${tag} non corrisponde alla versione ${manifest.version}`);
const changelog = read("CHANGELOG.md");
if (!changelog.includes(`[${manifest.version}]`)) errors.push(`CHANGELOG.md non ha la sezione [${manifest.version}]`);

const domains = [...constants.matchAll(/"(vinted\.[a-z.]+)"/g)].map((m) => `https://www.${m[1]}/*`).sort();
const csMatches = [...(manifest.content_scripts?.[0]?.matches || [])].sort();
if (JSON.stringify(domains) !== JSON.stringify(csMatches)) errors.push("I domini di constants.js e del manifest (content_scripts) non coincidono");
for (const d of csMatches) if (!manifest.host_permissions.includes(d)) errors.push(`host_permissions senza ${d}`);

const refs = [manifest.background?.service_worker, manifest.action?.default_popup, manifest.options_page?.split("#")[0], manifest.side_panel?.default_path?.split("?")[0],
  ...Object.values(manifest.icons || {}), ...(manifest.content_scripts || []).flatMap((c) => [...(c.js || []), ...(c.css || [])]),
  ...(manifest.web_accessible_resources || []).flatMap((w) => w.resources)];
for (const r of refs.filter(Boolean)) if (!fs.existsSync(path.join(ROOT, r))) errors.push(`File del manifest mancante: ${r}`);

function walk(dir, out = []) {
  for (const f of fs.readdirSync(dir)) {
    if (["node_modules", ".git", "dist"].includes(f)) continue;
    const p = path.join(dir, f);
    if (fs.statSync(p).isDirectory()) walk(p, out); else out.push(p);
  }
  return out;
}
const all = walk(ROOT);
for (const f of all.filter((x) => x.endsWith(".js") && x.includes(`${path.sep}src${path.sep}`))) {
  const src = fs.readFileSync(f, "utf8");
  const isModule = /^\s*(import|export)\s/m.test(src);
  try { execFileSync(process.execPath, isModule ? ["--input-type=module", "--check"] : ["--check", f], { input: isModule ? src : undefined, stdio: ["pipe", "pipe", "pipe"] }); }
  catch (e) { errors.push(`Sintassi: ${path.relative(ROOT, f)}\n${String(e.stderr).split("\n").slice(0, 5).join("\n")}`); }
}
const SECRETS = [/discord(?:app)?\.com\/api\/webhooks\/\d{6,}\/[\w-]{20,}/, /\bghp_[A-Za-z0-9]{30,}/, /\bsk-[A-Za-z0-9]{32,}/, /access_token_web=eyJ[A-Za-z0-9_-]{40,}/];
for (const f of all.filter((x) => /\.(js|mjs|json|md|yml|yaml|html|txt)$/.test(x) && !x.endsWith("check.mjs"))) {
  const s = fs.readFileSync(f, "utf8");
  for (const re of SECRETS) if (re.test(s)) errors.push(`Possibile segreto in ${path.relative(ROOT, f)} (${re})`);
}

if (errors.length) { console.error(`✖ ${errors.length} problemi:\n- ${errors.join("\n- ")}`); process.exit(1); }
console.log(`✔ check: versione ${manifest.version}, ${csMatches.length} domini, ${refs.length} file del manifest, ${all.length} file controllati`);
