/**
 * «Cerca aggiornamento» e link del progetto (standard comuni, sezioni 1 e 3; flusso di Vintory).
 *
 *  - Verifica: legge version.json dal ramo main su raw.githubusercontent.com (pubblico, senza
 *    credenziali). Non usa l'API di GitHub (60 richieste l'ora) né releases/latest (vuoto finché
 *    la release non è pubblicata).
 *  - Download: scarica lo zip dalla radice del repository, ne calcola lo SHA-256 e lo confronta con
 *    version.json; se è diverso non salva niente. Poi lo salva dall'indirizzo vero di GitHub con
 *    il nome «Vintastic-x.y.z.zip» (da un indirizzo data: Chrome può ignorare il nome).
 *  - Installazione: estrai lo zip sopra la cartella dell'estensione, poi «Installa» ricarica
 *    Vintastic (chrome.runtime.reload). Un'estensione caricata da cartella non può aggiornarsi da sola.
 *  - diskVersion: dice se la cartella è già stata sovrascritta ma l'estensione non è stata ricaricata.
 */

import { getSettings, getState, setState, saveSettings } from "./store.js";
import { log } from "./logger.js";
import { notify } from "./notify.js";
import { broadcast } from "./bus.js";
import * as health from "./health.js";
import { VERSION, REPO, DEFAULT_LINKS } from "../shared/constants.js";
import { compareVersions, parseVersionFile, githubError } from "../shared/version.js";
import { sha256Hex } from "../shared/util.js";
import { normalizeLinks } from "../shared/links.js";

const MIN_INTERVAL = 60_000;
const REPO_RE = /^[\w.-]{1,60}\/[\w.-]{1,80}$/;

async function repoOf() {
  const repo = (await getSettings()).updates?.repo || REPO;
  return REPO_RE.test(repo) ? repo : REPO;
}

export async function check({ manual = false } = {}) {
  const s = await getSettings();
  const avail = await health.moduleAvailable("updates");
  if (!avail.ok && !manual) return { ok: false, error: avail.reason };
  const prev = await getState("updateStatus", null);
  // Al massimo un controllo al minuto, anche a mano.
  if (prev?.checkedAt && Date.now() - prev.checkedAt < MIN_INTERVAL) return prev;
  const repo = await repoOf();
  let status;
  try {
    const res = await fetch(`https://raw.githubusercontent.com/${repo}/main/version.json`, { credentials: "omit", cache: "no-store" });
    if (!res.ok) status = { ok: false, error: githubError(res.status), httpStatus: res.status };
    else status = parseVersionFile(await res.json(), VERSION);
  } catch (e) {
    status = { ok: false, error: githubError(0), detail: e.message };
  }
  status = { ...status, checkedAt: Date.now(), installed: VERSION, repo, manual };
  await setState("updateStatus", status);
  broadcast("vt:update", { status });
  if (manual) await refreshLinks({ force: true }).catch(() => {});
  if (status.ok) await health.recordSuccess("updates");
  else if (status.httpStatus !== 404) await log({ level: "warn", category: "update", message: status.error });
  if (status.available && s.updates?.lastNotified !== status.latest) {
    await saveSettings({ updates: { lastNotified: status.latest } });
    await notify({ category: "newVersion", level: "info", title: `Vintastic ${status.latest} disponibile`, body: "Apri Salute › Aggiornamenti per le novità e il download verificato.", link: "#health", persistent: true });
  }
  return status;
}

/** Scarica lo zip della nuova versione: prima la verifica in memoria, poi il salvataggio. */
export async function downloadVerified() {
  const st = await getState("updateStatus", null);
  if (!st?.available || !st.zip) throw new Error("version.json non indica lo zip: scaricalo dalla pagina GitHub di Vintastic.");
  const url = `https://github.com/${st.repo || (await repoOf())}/raw/HEAD/${encodeURIComponent(st.zip)}`;
  const res = await fetch(url, { credentials: "omit", cache: "no-store" });
  if (!res.ok) throw new Error(`Download non riuscito (HTTP ${res.status}).`);
  const hash = await sha256Hex(new Uint8Array(await res.arrayBuffer()));
  if (st.sha256 && st.sha256 !== hash) {
    await log({ level: "warn", category: "update", message: `SHA-256 diverso da version.json per ${st.zip}: zip non salvato` });
    throw new Error(`Lo zip scaricato non corrisponde all'impronta di version.json: non viene salvato. Atteso ${st.sha256.slice(0, 12)}…, ottenuto ${hash.slice(0, 12)}…`);
  }
  const verified = Boolean(st.sha256);
  const downloadId = await chrome.downloads.download({ url, filename: `Vintastic/${st.zip}`, conflictAction: "uniquify", saveAs: false });
  await log({ level: "info", category: "update", message: `Scaricato ${st.zip} · SHA-256 ${hash}${verified ? " (verificato)" : " (version.json senza impronta)"}` });
  return { downloadId, hash, verified, name: st.zip };
}

/**
 * La cartella dell'estensione è già stata sovrascritta con un'altra versione?
 * Il manifest.json sul disco è quello estratto; chrome.runtime.getManifest() quello in uso fino a «Installa».
 */
export async function diskVersion() {
  const loaded = chrome.runtime.getManifest().version;
  try {
    const res = await fetch(`${chrome.runtime.getURL("manifest.json")}?t=${Date.now()}`, { cache: "no-store" });
    const disk = String((await res.json()).version || "");
    const cmp = compareVersions(disk, loaded);
    return { loaded, disk, pending: cmp !== null && cmp !== 0, newer: cmp === 1 };
  } catch {
    return { loaded, disk: null, pending: false, newer: false };
  }
}

/** Link del progetto (Discord, Ko-fi…) da links.json su GitHub: l'invito Discord si cambia senza nuova versione. */
export async function refreshLinks({ force = false } = {}) {
  const s = await getSettings();
  const cached = await getState("links", null);
  // Copia salvata da una versione precedente: può avere ancora «bugReport».
  if (!force && (!s.links?.autoRefresh || (cached?.at && Date.now() - cached.at < 12 * 3600e3))) return cached?.links ? { ...DEFAULT_LINKS, ...normalizeLinks(cached.links) } : DEFAULT_LINKS;
  try {
    const res = await fetch(`https://raw.githubusercontent.com/${await repoOf()}/main/links.json`, { credentials: "omit", cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    const links = { ...DEFAULT_LINKS };
    for (const [k, v] of Object.entries(normalizeLinks(json?.links))) {
      if (v && typeof v.url === "string" && /^https:\/\/[\w.-]+\//.test(v.url) && v.enabled !== false) links[k] = { url: v.url, label: String(v.label || k).slice(0, 40) };
    }
    await setState("links", { at: Date.now(), links });
    return links;
  } catch {
    const links = { ...DEFAULT_LINKS, ...normalizeLinks(cached?.links) };
    await setState("links", { at: Date.now(), links, error: true });
    return links;
  }
}
