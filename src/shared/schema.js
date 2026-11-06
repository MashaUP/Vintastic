/**
 * Formato dei file di backup (JSON) — creazione, validazione, anteprima.
 * L'importazione non esegue mai niente: le campagne importate arrivano come
 * bozze e le operazioni "in esecuzione" diventano "da verificare".
 */

import { EXPORT_SCHEMA, VERSION } from "./constants.js";
import { redact } from "./redact.js";
import { isPlainObject } from "./util.js";

export const EXPORT_PARTS = {
  settings: "Impostazioni",
  accounts: "Account ed etichette (senza credenziali)",
  campaigns: "Campagne e code",
  filters: "Filtri salvati",
  dashboard: "Preferenze dashboard",
  listings: "Annunci scansionati",
  history: "Storico interazioni (ledger)",
};

export function buildExport(data, parts) {
  const out = { app: "Vintastic", schema: EXPORT_SCHEMA, version: VERSION, exportedAt: new Date().toISOString(), parts: {} };
  for (const p of parts) {
    if (!(p in EXPORT_PARTS) || data[p] === undefined) continue;
    let v = data[p];
    if (p === "settings") {
      // Mai esportare webhook, chiavi API o altri segreti.
      v = { ...v, discord: { ...(v.discord || {}), webhookUrl: "" }, ai: { ...(v.ai || {}), apiKey: "" } };
    }
    if (p === "accounts") v = v.map(({ id, label, customLabel, login, origin, favorite, notes, createdAt }) => ({ id, label, customLabel, login, origin, favorite, notes, createdAt }));
    out.parts[p] = redact(v);
  }
  return out;
}

const isArr = Array.isArray;

/** @returns {{ok:boolean, errors:string[], warnings:string[], preview:Object, data:Object}} */
export function validateImport(json) {
  const errors = [];
  const warnings = [];
  let doc = json;
  if (typeof json === "string") {
    try { doc = JSON.parse(json); } catch (e) { return { ok: false, errors: [`JSON non valido: ${e.message}`], warnings, preview: {}, data: {} }; }
  }
  if (!isPlainObject(doc) || doc.app !== "Vintastic") return { ok: false, errors: ["Il file non è un backup di Vintastic."], warnings, preview: {}, data: {} };
  if (!Number.isInteger(doc.schema) || doc.schema < 1) errors.push("Versione del formato mancante.");
  if (doc.schema > EXPORT_SCHEMA) errors.push(`Il file viene da una versione più recente (formato ${doc.schema}): aggiorna Vintastic.`);
  const parts = isPlainObject(doc.parts) ? doc.parts : {};
  const data = {};
  const preview = {};

  if (parts.settings !== undefined) {
    if (!isPlainObject(parts.settings)) errors.push("Impostazioni non valide.");
    else { data.settings = parts.settings; preview.settings = Object.keys(parts.settings).length + " chiavi"; }
  }
  if (parts.accounts !== undefined) {
    if (!isArr(parts.accounts) || parts.accounts.some((a) => !a || typeof a.id !== "string")) errors.push("Account non validi.");
    else { data.accounts = parts.accounts; preview.accounts = parts.accounts.length; }
  }
  if (parts.campaigns !== undefined) {
    if (!isArr(parts.campaigns) || parts.campaigns.some((c) => !c || typeof c.id !== "string" || !isArr(c.items))) errors.push("Campagne non valide.");
    else {
      data.campaigns = parts.campaigns.map((c) => ({
        ...c,
        status: "draft",
        snapshot: null,
        importedAt: Date.now(),
        items: c.items.map((i) => ({ ...i, ops: (i.ops || []).map((o) => (o.status === "running" ? { ...o, status: "verify", error: "Importata mentre era in esecuzione" } : o)) })),
      }));
      preview.campaigns = data.campaigns.length;
      warnings.push("Le campagne importate arrivano come bozze: nessuna operazione partirà da sola.");
    }
  }
  for (const k of ["filters", "listings", "history"]) {
    if (parts[k] === undefined) continue;
    if (!isArr(parts[k])) { errors.push(`${EXPORT_PARTS[k]} non validi.`); continue; }
    data[k] = parts[k];
    preview[k] = parts[k].length;
  }
  if (parts.dashboard !== undefined) {
    if (!isPlainObject(parts.dashboard)) errors.push("Preferenze dashboard non valide.");
    else { data.dashboard = parts.dashboard; preview.dashboard = "sì"; }
  }
  if (!Object.keys(data).length && !errors.length) errors.push("Il file non contiene dati da importare.");
  return { ok: errors.length === 0, errors, warnings, preview, data };
}

/** Unione senza doppioni: per id, vince la voce più recente (updatedAt / lastSeenAt / at). */
export function dedupeMerge(existing, incoming, key = "id") {
  const stamp = (x) => Number(x?.updatedAt || x?.lastSeenAt || x?.at || 0);
  const map = new Map(existing.map((x) => [x[key], x]));
  let added = 0;
  let updated = 0;
  for (const x of incoming) {
    const cur = map.get(x[key]);
    if (!cur) { map.set(x[key], x); added++; }
    else if (stamp(x) > stamp(cur)) { map.set(x[key], { ...cur, ...x }); updated++; }
  }
  return { items: [...map.values()], added, updated };
}
