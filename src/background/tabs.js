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

/**
 * Porta in primo piano una scheda di Vintastic: scheda attiva, finestra a fuoco e, se era ridotta
 * a icona, di nuovo aperta (una finestra ridotta a icona resta «in background» per la pagina).
 */
export async function focus(tabId) {
  if (!(await isOwned(tabId))) return false;
  const tab = await chrome.tabs.update(tabId, { active: true }).catch(() => null);
  if (!tab) return false;
  if (tab.windowId != null && chrome.windows?.update) {
    const win = await chrome.windows.get(tab.windowId).catch(() => null);
    const patch = win?.state === "minimized" ? { state: "normal", focused: true } : { focused: true };
    await chrome.windows.update(tab.windowId, patch).catch(() => {});
  }
  return true;
}

export async function closeOwned(tabId) {
  if (!(await isOwned(tabId))) return false;
  await chrome.tabs.remove(tabId).catch(() => {});
  await release(tabId);
  return true;
}

/**
 * Esegue una lettura su una pagina di Vinted.
 * separate = false: nella scheda di lavoro (come prima).
 * separate = true (campagna in corso): in una scheda nuova in background, chiusa alla fine, così
 * la scheda di lavoro della campagna non cambia pagina a metà di un'operazione.
 */
export async function withReaderTab(origin, url, fn, { separate = false, timeoutMs = 45_000 } = {}) {
  if (!separate) {
    const { tabId, page } = await ensureAt(origin, url, { timeoutMs });
    return fn(tabId, page);
  }
  const tab = await chrome.tabs.create({ url, active: false });
  await claim(tab.id, "reader", origin);
  try {
    // Si chiede alla pagina se è pronta (un annuncio «pronto» arrivato prima di mettersi in ascolto non si perde).
    const end = Date.now() + timeoutMs;
    let page = null;
    let last = "";
    let misses = 0;
    let renavigated = false;
    while (!page && Date.now() < end) {
      await new Promise((r) => setTimeout(r, 800));
      const t = await chrome.tabs.get(tab.id).catch(() => null);
      if (!t) throw new Error("La scheda di lettura è stata chiusa.");
      last = `${t.status} ${String(t.url || t.pendingUrl || "").split("?")[0]}`;
      // Scheda in background non caricata (o pagina d'errore): la si carica di nuovo, una volta.
      if ((t.status === "unloaded" || /^chrome-error:|^about:blank/.test(String(t.url || ""))) && !renavigated) {
        renavigated = true;
        await chrome.tabs.update(tab.id, { url }).catch(() => {});
        continue;
      }
      if (t.status !== "complete") continue;
      const pong = await sendToTab(tab.id, { type: "vt:ping" }, 3000).catch((e) => ({ error: e.message }));
      if (pong?.ok) page = pong.page;
      else {
        last += ` · ${pong?.error || "nessuna risposta"}`;
        // Pagina caricata ma Vintastic assente: prima la si ricarica, poi si inserisce Vintastic.
        misses++;
        if (misses === 3 && !renavigated) { renavigated = true; await chrome.tabs.update(tab.id, { url }).catch(() => {}); }
        else if (misses === 6) await reinject(tab.id);
      }
    }
    if (!page) throw Object.assign(new Error(`La pagina di Vinted non si è caricata in tempo (${last}).`), { code: "timeout", notSent: true });
    if (page.challenge) throw new Error("Vinted chiede una verifica (CAPTCHA): aprila e completala tu.");
    return await fn(tab.id, page);
  } finally {
    await closeOwned(tab.id);
  }
}

/** Content script assente su una pagina già caricata: lo si reinserisce (stessi file del manifest). */
export async function reinject(tabId) {
  if (!chrome.scripting?.executeScript) return false;
  try {
    const files = chrome.runtime.getManifest().content_scripts?.[0]?.js || [];
    await chrome.scripting.executeScript({ target: { tabId }, files });
    return true;
  } catch {
    return false;
  }
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

/**
 * Invia un comando al content script della scheda, con limite di tempo.
 * notSent: true SOLO se il comando non è mai arrivato alla pagina (nessun content
 * script in ascolto). Se la pagina cambia o si chiude mentre il comando è in corso
 * («message port closed»), il comando può essere già stato eseguito: per una
 * scrittura su Vinted l'esito diventa incerto, mai «non inviato».
 */
export function sendToTab(tabId, message, timeoutMs = 90_000) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(Object.assign(new Error("Nessuna risposta dalla pagina di Vinted."), { code: "timeout" })), timeoutMs);
    chrome.tabs.sendMessage(tabId, message).then((r) => { clearTimeout(t); resolve(r); }, (e) => {
      clearTimeout(t);
      const msg = String(e?.message || e);
      if (/Receiving end does not exist|Could not establish connection/i.test(msg)) {
        return reject(Object.assign(new Error("La pagina di Vinted non ha Vintastic attivo: ricaricala."), { code: "noContent", notSent: true }));
      }
      reject(Object.assign(new Error(`Pagina di Vinted cambiata o chiusa durante il comando (${msg})`), { code: "lost" }));
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
