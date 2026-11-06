/**
 * IndexedDB — persistenza principale (annunci, campagne, code, ledger, journal,
 * log, notifiche, scansioni). Disponibile nel service worker MV3; sopravvive
 * alla sospensione del worker e al riavvio del browser.
 */

import { DB_NAME, DB_VERSION } from "../shared/constants.js";
import { runDbUpgrade } from "../shared/migrations.js";

let dbPromise = null;
export let lastUpgrade = null;

export function openDb(name = DB_NAME, version = DB_VERSION, idb = globalThis.indexedDB) {
  if (dbPromise && name === DB_NAME) return dbPromise;
  const p = new Promise((resolve, reject) => {
    const req = idb.open(name, version);
    req.onupgradeneeded = (ev) => {
      try {
        lastUpgrade = { from: ev.oldVersion, to: version, at: Date.now(), steps: runDbUpgrade(req.result, req.transaction, ev.oldVersion, version) };
      } catch (e) {
        req.transaction.abort();       // rollback: il database resta alla versione precedente
        reject(e);
      }
    };
    req.onsuccess = () => {
      const db = req.result;
      db.onversionchange = () => { db.close(); dbPromise = null; };
      resolve(db);
    };
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error("Database bloccato da un'altra scheda di Vintastic: chiudila e riprova."));
  });
  if (name === DB_NAME) dbPromise = p.catch((e) => { dbPromise = null; throw e; });
  return p;
}

const wrap = (req) => new Promise((resolve, reject) => {
  req.onsuccess = () => resolve(req.result);
  req.onerror = () => reject(req.error);
});

async function tx(stores, mode, fn) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const t = db.transaction(stores, mode);
    let result;
    Promise.resolve(fn(t)).then((r) => { result = r; }, (e) => { try { t.abort(); } catch { /* già chiusa */ } reject(e); });
    t.oncomplete = () => resolve(result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error || new Error("Transazione annullata"));
  });
}

export const get = (store, key) => tx([store], "readonly", (t) => wrap(t.objectStore(store).get(key)));
export const getAll = (store, query = null, count) => tx([store], "readonly", (t) => wrap(t.objectStore(store).getAll(query, count)));
export const put = (store, value) => tx([store], "readwrite", (t) => wrap(t.objectStore(store).put(value)));
export const del = (store, key) => tx([store], "readwrite", (t) => wrap(t.objectStore(store).delete(key)));
export const clear = (store) => tx([store], "readwrite", (t) => wrap(t.objectStore(store).clear()));
export const count = (store) => tx([store], "readonly", (t) => wrap(t.objectStore(store).count()));

export const putMany = (store, values) => tx([store], "readwrite", async (t) => {
  const s = t.objectStore(store);
  for (const v of values) s.put(v);
});

export const byIndex = (store, index, value) => tx([store], "readonly", (t) => wrap(t.objectStore(store).index(index).getAll(value)));

/** Più store nella stessa transazione: o tutto o niente (journal atomico). */
export const atomic = (stores, fn) => tx(stores, "readwrite", (t) => fn(Object.fromEntries(stores.map((s) => [s, {
  get: (k) => wrap(t.objectStore(s).get(k)),
  put: (v) => wrap(t.objectStore(s).put(v)),
  del: (k) => wrap(t.objectStore(s).delete(k)),
  getAll: (q) => wrap(t.objectStore(s).getAll(q)),
  byIndex: (i, v) => wrap(t.objectStore(s).index(i).getAll(v)),
}]))));

/** Elimina dall'indice `at` tutto ciò che è più vecchio di `before`. */
export const pruneBefore = (store, before) => tx([store], "readwrite", (t) => new Promise((resolve, reject) => {
  let n = 0;
  const req = t.objectStore(store).index("at").openCursor(IDBKeyRange.upperBound(before));
  req.onsuccess = () => {
    const cur = req.result;
    if (!cur) return resolve(n);
    cur.delete();
    n++;
    cur.continue();
  };
  req.onerror = () => reject(req.error);
}));

/** Tiene solo gli ultimi `keep` record (store con chiave autoincrementale). */
export const trimTo = (store, keep) => tx([store], "readwrite", (t) => new Promise((resolve, reject) => {
  const s = t.objectStore(store);
  const cr = s.count();
  cr.onsuccess = () => {
    let excess = cr.result - keep;
    if (excess <= 0) return resolve(0);
    const removed = excess;
    const req = s.openCursor();
    req.onsuccess = () => {
      const cur = req.result;
      if (!cur || excess <= 0) return resolve(removed);
      cur.delete();
      excess--;
      cur.continue();
    };
    req.onerror = () => reject(req.error);
  };
  cr.onerror = () => reject(cr.error);
}));

/** Controllo di integrità: ogni store esiste, si legge, e i riferimenti tra store tornano. */
export async function integrityCheck() {
  const db = await openDb();
  const expected = ["listings", "campaigns", "items", "ledger", "logs", "notifications", "meta", "journal", "scans", "suggestions", "activity", "accounts"];
  const missing = expected.filter((s) => !db.objectStoreNames.contains(s));
  const problems = missing.map((s) => `Store mancante: ${s}`);
  if (missing.length) return { ok: false, problems, counts: {} };
  const counts = {};
  for (const s of expected) counts[s] = await count(s);
  const campaigns = new Set((await getAll("campaigns")).map((c) => c.id));
  const items = await getAll("items");
  const orphans = items.filter((i) => !campaigns.has(i.campaignId));
  if (orphans.length) problems.push(`${orphans.length} elementi di coda senza campagna`);
  const running = items.flatMap((i) => i.ops.filter((o) => o.status === "running"));
  return { ok: problems.length === 0, problems, counts, orphans: orphans.map((o) => o.id), runningOps: running.length, version: db.version };
}

export function _resetForTests() { dbPromise = null; }
