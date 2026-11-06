/**
 * Tab Ownership Manager.
 * Vintastic naviga, chiude o mette in primo piano SOLO le schede che ha aperto
 * lui (registrate qui). Le schede dell'utente non vengono mai modificate:
 * al massimo vi si legge (scansione avviata da te su quella pagina).
 */

import { getSession, setSession } from "./store.js";

const readyWaiters = new Map();    // tabId → [resolve]
const removedHandlers = new Set();

async function owned() { return getSession("ownedTabs", {}); }
async function saveOwned(map) { await setSession("ownedTabs", map); }

export async function isOwned(tabId) { return Boolean((await owned())[tabId]); }
export async function listOwned() { return owned(); }

export async function claim(tabId, purpose, origin) {
  const map = await owned();
  map[tabId] = { purpose, origin, createdAt: Date.now() };
  await saveOwned(map);
}

export async function release(tabId) {
  const map = await owned();
  delete map[tabId];
  await saveOwned(map);
}

/** Scheda di lavoro per un'origine Vinted: riusa quella di Vintastic se esiste ancora. */
export async function workerTab(origin, url = null, { active = false } = {}) {
  const map = await owned();
  for (const [id, info] of Object.entries(map)) {
    if (info.purpose !== "worker" || info.origin !== origin) continue;
    try {
      const tab = await chrome.tabs.get(Number(id));
      if (url && tab.url !== url) await chrome.tabs.update(tab.id, { url });
      if (active) await chrome.tabs.update(tab.id, { active: true });
      return tab.id;
    } catch {
      delete map[id];
    }
  }
  await saveOwned(map);
  const tab = await chrome.tabs.create({ url: url || `${origin}/`, active });
  await claim(tab.id, "worker", origin);
  return tab.id;
}

export async function navigate(tabId, url) {
  if (!(await isOwned(tabId))) throw new Error("Scheda non di Vintastic: non la tocco.");
  await chrome.tabs.update(tabId, { url });
}

export async function focus(tabId) {
  if (!(await isOwned(tabId))) return false;
  const tab = await chrome.tabs.update(tabId, { active: true });
  if (tab?.windowId != null) await chrome.windows.update(tab.windowId, { focused: true }).catch(() => {});
  return true;
}

export async function closeOwned(tabId) {
  if (!(await isOwned(tabId))) return false;
  await chrome.tabs.remove(tabId).catch(() => {});
  await release(tabId);
  return true;
}

/** Il content script annuncia che la pagina è pronta (con lo stato della pagina). */
export function markReady(tabId, pageState) {
  const list = readyWaiters.get(tabId) || [];
  const keep = list.filter((w) => !w(pageState));     // ogni waiter decide se questa pagina è quella attesa
  if (keep.length) readyWaiters.set(tabId, keep);
  else readyWaiters.delete(tabId);
}

/** Aspetta che il content script della scheda sia pronto dopo una navigazione. */
export function waitReady(tabId, timeoutMs = 45_000, match = null) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      const list = (readyWaiters.get(tabId) || []).filter((f) => f !== waiter);
      readyWaiters.set(tabId, list);
      reject(Object.assign(new Error("La pagina di Vinted non si è caricata in tempo."), { code: "timeout", notSent: true }));
    }, timeoutMs);
    // Una pagina che chiede una verifica è sempre "quella attesa": va gestita subito.
    const waiter = (state) => {
      if (match && !state?.challenge && !match(state)) return false;
      clearTimeout(t);
      resolve(state);
      return true;
    };
    readyWaiters.set(tabId, [...(readyWaiters.get(tabId) || []), waiter]);
  });
}

export function onOwnedRemoved(fn) { removedHandlers.add(fn); }

chrome.tabs?.onRemoved?.addListener(async (tabId) => {
  const map = await owned();
  if (!map[tabId]) return;
  const info = map[tabId];
  delete map[tabId];
  await saveOwned(map);
  for (const fn of removedHandlers) { try { fn(tabId, info); } catch { /* ignora */ } }
});

/** Invia un comando al content script della scheda, con limite di tempo. */
export function sendToTab(tabId, message, timeoutMs = 90_000) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(Object.assign(new Error("Nessuna risposta dalla pagina di Vinted."), { code: "timeout" })), timeoutMs);
    chrome.tabs.sendMessage(tabId, message).then((r) => { clearTimeout(t); resolve(r); }, (e) => {
      clearTimeout(t);
      reject(Object.assign(new Error(/Receiving end/i.test(e?.message) ? "La pagina di Vinted non ha Vintastic attivo: ricaricala." : e?.message), { code: "noContent", notSent: true }));
    });
  });
}

/**
 * Porta la scheda di lavoro all'indirizzo voluto e aspetta il content script.
 * Se è già lì e risponde, non ricarica niente.
 */
export async function ensureAt(origin, url, { active = false, timeoutMs = 45_000 } = {}) {
  const tabId = await workerTab(origin, null, { active });
  const target = new URL(url);
  const tab = await chrome.tabs.get(tabId);
  let here = false;
  try { here = new URL(tab.url).pathname.split("-")[0] === target.pathname.split("-")[0]; } catch { here = false; }
  if (here && tab.status === "complete") {
    const pong = await sendToTab(tabId, { type: "vt:ping" }, 3000).catch(() => null);
    if (pong?.ok) return { tabId, page: pong.page };
  }
  // /items/123-titolo può diventare /items/123-altro-titolo: conta l'id, non lo slug.
  const key = target.pathname.match(/^\/(?:items|member)\/\d+/)?.[0] || target.pathname;
  const re = new RegExp(`^${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:$|[-/])`);
  const ready = waitReady(tabId, timeoutMs, (pg) => re.test(String(pg?.path || "")));
  await chrome.tabs.update(tabId, { url });
  return { tabId, page: await ready };
}
