/**
 * Impostazioni e stato leggero in chrome.storage.local (persistente).
 * I token di Vinted (CSRF, anon id) stanno solo in chrome.storage.session:
 * in memoria, mai su disco, mai esportati. sessionStorage del DOM NON esiste
 * nel service worker e non viene usato.
 */

import { DEFAULT_SETTINGS } from "../shared/constants.js";
import { migrateSettings } from "../shared/migrations.js";
import { deepMerge } from "../shared/util.js";

let cache = null;
const listeners = new Set();

export async function loadSettings() {
  const { settings: stored } = await chrome.storage.local.get("settings");
  const { settings, applied, from } = migrateSettings(stored);
  if (applied.length) {
    // Backup prima della migrazione, per poter tornare indietro a mano.
    await chrome.storage.local.set({ [`settingsBackup_v${from}`]: { at: Date.now(), settings: stored } });
  }
  if (applied.length || !stored) await chrome.storage.local.set({ settings });
  cache = settings;
  return { settings, applied };
}

export async function getSettings() {
  if (!cache) await loadSettings();
  return cache;
}

export async function saveSettings(patch) {
  const cur = await getSettings();
  const next = deepMerge(cur, patch);
  next.schema = DEFAULT_SETTINGS.schema;
  cache = next;
  await chrome.storage.local.set({ settings: next });
  for (const fn of listeners) { try { fn(next, patch); } catch { /* listener rotto: non blocca gli altri */ } }
  return next;
}

export async function replaceSettings(all) {
  cache = deepMerge(DEFAULT_SETTINGS, all);
  await chrome.storage.local.set({ settings: cache });
  for (const fn of listeners) { try { fn(cache, all); } catch { /* ignora */ } }
  return cache;
}

export const onSettings = (fn) => { listeners.add(fn); return () => listeners.delete(fn); };

// Stato persistente leggero (contatori, sessione nota, link, aggiornamenti…)
export async function getState(key, fallback = null) {
  const r = await chrome.storage.local.get(key);
  return r[key] ?? fallback;
}
export const setState = (key, value) => chrome.storage.local.set({ [key]: value });

// Stato volatile (sopravvive alla sospensione del worker, non al riavvio del browser)
export async function getSession(key, fallback = null) {
  const r = await chrome.storage.session.get(key);
  return r[key] ?? fallback;
}
export const setSession = (key, value) => chrome.storage.session.set({ [key]: value });

export function _resetCache() { cache = null; }
