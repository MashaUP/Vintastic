/**
 * Version checker e link del progetto.
 *
 * Distinzione netta:
 *  - Verifica: legge l'ultima GitHub Release (API pubblica, senza credenziali).
 *  - Download: scarica lo zip, ne calcola lo SHA-256 e lo confronta con il file
 *    .sha256 della release; solo se coincide lo salva in Download.
 *  - Installazione: la fai tu estraendo lo zip sopra la cartella dell'estensione;
 *    poi «Installa» ricarica Vintastic (chrome.runtime.reload).
 *  - Aggiornamento automatico: NON possibile per un'estensione caricata da
 *    cartella (il browser non lo consente). Dal Chrome Web Store sarebbe automatico.
 */

import { getSettings, getState, setState, saveSettings } from "./store.js";
import { log } from "./logger.js";
import { notify } from "./notify.js";
import { broadcast } from "./bus.js";
import * as health from "./health.js";
import { VERSION, REPO, DEFAULT_LINKS } from "../shared/constants.js";
import { compareVersions, parseRelease, parseShaFile, githubError } from "../shared/version.js";
import { sha256Hex } from "../shared/util.js";

const MIN_INTERVAL = 60_000;

export async function check({ manual = false } = {}) {
  const s = await getSettings();
  const avail = await health.moduleAvailable("updates");
  if (!avail.ok && !manual) return { ok: false, error: avail.reason };
  const prev = await getState("updateStatus", null);
  if (prev?.checkedAt && Date.now() - prev.checkedAt < MIN_INTERVAL && !manual) return prev;
  if (prev?.rateLimitedUntil && Date.now() < prev.rateLimitedUntil) return { ...prev, error: "GitHub ha chiesto di aspettare: riprova più tardi." };
  const repo = s.updates?.repo || REPO;
  let status;
  try {
    const res = await fetch(`https://api.github.com/repos/${repo}/releases/latest`, { headers: { Accept: "application/vnd.github+json" }, credentials: "omit", cache: "no-store" });
    if (!res.ok) {
      const reset = Number(res.headers.get("x-ratelimit-reset")) * 1000;
      status = { ok: false, checkedAt: Date.now(), installed: VERSION, error: githubError(res.status), httpStatus: res.status, rateLimitedUntil: res.status === 403 || res.status === 429 ? (reset || Date.now() + 3600e3) : null };
    } else {
      const rel = parseRelease(await res.json());
      if (!rel.ok) status = { ok: false, checkedAt: Date.now(), installed: VERSION, error: rel.error };
      else {
        const cmp = compareVersions(rel.version, VERSION);
        status = { ok: true, checkedAt: Date.now(), installed: VERSION, latest: rel.version, available: cmp === 1, release: rel };
      }
    }
  } catch (e) {
    status = { ok: false, checkedAt: Date.now(), installed: VERSION, error: githubError(0), detail: e.message };
  }
  await setState("updateStatus", status);
  broadcast("vt:update", { status });
  if (status.ok) await health.recordSuccess("updates");
  else if (status.httpStatus !== 404) await log({ level: "warn", category: "update", message: status.error });
  if (status.available && s.updates?.lastNotified !== status.latest) {
    await saveSettings({ updates: { lastNotified: status.latest } });
    await notify({ category: "newVersion", level: "info", title: `Vintastic ${status.latest} disponibile`, body: "Apri Salute › Aggiornamenti per le novità e il download verificato.", link: "#health", persistent: true });
  }
  return status;
}

/** Scarica lo zip della release, verifica lo SHA-256 e lo salva. */
export async function downloadVerified() {
  const st = await getState("updateStatus", null);
  const rel = st?.release;
  if (!rel?.zip) throw new Error("Nessuno zip allegato alla release: usa il link della release.");
  const zipRes = await fetch(rel.zip.url, { credentials: "omit" });
  if (!zipRes.ok) throw new Error(`Download non riuscito (HTTP ${zipRes.status})`);
  const bytes = new Uint8Array(await zipRes.arrayBuffer());
  const hash = await sha256Hex(bytes);
  let verified = null;
  if (rel.sha) {
    const shaRes = await fetch(rel.sha.url, { credentials: "omit" });
    const expected = shaRes.ok ? parseShaFile(await shaRes.text(), rel.zip.name) : null;
    if (expected && expected !== hash) throw new Error(`Checksum NON corrispondente: lo zip non viene salvato. Atteso ${expected.slice(0, 12)}…, ottenuto ${hash.slice(0, 12)}…`);
    verified = Boolean(expected);
  }
  // data: URL → chrome.downloads (nel service worker non c'è URL.createObjectURL)
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  const downloadId = await chrome.downloads.download({ url: `data:application/zip;base64,${btoa(bin)}`, filename: `Vintastic/${rel.zip.name}`, conflictAction: "uniquify", saveAs: false });
  await log({ level: "info", category: "update", message: `Scaricato ${rel.zip.name} · SHA-256 ${hash}${verified ? " (verificato)" : " (nessun checksum da confrontare)"}` });
  return { downloadId, hash, verified, name: rel.zip.name };
}

/** Link del progetto (Discord, Ko-fi…) da links.json su GitHub: l'invito Discord si cambia senza nuova versione. */
export async function refreshLinks({ force = false } = {}) {
  const s = await getSettings();
  const cached = await getState("links", null);
  if (!force && (!s.links?.autoRefresh || (cached?.at && Date.now() - cached.at < 12 * 3600e3))) return cached?.links || DEFAULT_LINKS;
  try {
    const res = await fetch(`https://raw.githubusercontent.com/${s.updates?.repo || REPO}/main/links.json`, { credentials: "omit", cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    const links = { ...DEFAULT_LINKS };
    for (const [k, v] of Object.entries(json?.links || {})) {
      if (v && typeof v.url === "string" && /^https:\/\/[\w.-]+\//.test(v.url) && v.enabled !== false) links[k] = { url: v.url, label: String(v.label || k).slice(0, 40) };
    }
    await setState("links", { at: Date.now(), links });
    return links;
  } catch {
    await setState("links", { at: Date.now(), links: cached?.links || DEFAULT_LINKS, error: true });
    return cached?.links || DEFAULT_LINKS;
  }
}
