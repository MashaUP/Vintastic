/**
 * Config Migration Engine.
 *
 * - DB_STEPS: passi versionati dello schema IndexedDB (db_v1 → db_v2 → db_v3).
 *   onupgradeneeded esegue in ordine tutti i passi da oldVersion+1 a DB_VERSION,
 *   dentro la stessa transazione di upgrade: se uno fallisce, IndexedDB annulla
 *   tutto e il database resta alla versione precedente (rollback automatico).
 * - SETTINGS_STEPS: passi delle impostazioni (schema 1 → 2 → 3). Prima di
 *   migrare, il service worker salva una copia (backup) delle impostazioni.
 * - migrateExport: porta un file di backup vecchio al formato attuale.
 */

import { DEFAULT_SETTINGS, DB_VERSION } from "./constants.js";
import { deepMerge, isPlainObject } from "./util.js";

const ensureStore = (db, tx, name, opts) => (db.objectStoreNames.contains(name) ? tx.objectStore(name) : db.createObjectStore(name, opts));
const ensureIndex = (store, name, keyPath, opts = {}) => { if (!store.indexNames.contains(name)) store.createIndex(name, keyPath, opts); };

export const DB_STEPS = {
  1: (db, tx) => {
    const listings = ensureStore(db, tx, "listings", { keyPath: "id" });
    ensureIndex(listings, "sellerId", "sellerId");
    ensureIndex(listings, "lastSeenAt", "lastSeenAt");
    ensureStore(db, tx, "campaigns", { keyPath: "id" });
    const items = ensureStore(db, tx, "items", { keyPath: "id" });
    ensureIndex(items, "campaignId", "campaignId");
    const ledger = ensureStore(db, tx, "ledger", { keyPath: "key" });
    ensureIndex(ledger, "listingId", "listingId");
    ensureIndex(ledger, "accountId", "accountId");
    const logs = ensureStore(db, tx, "logs", { keyPath: "seq", autoIncrement: true });
    ensureIndex(logs, "at", "at");
    const notes = ensureStore(db, tx, "notifications", { keyPath: "id" });
    ensureIndex(notes, "at", "at");
    ensureStore(db, tx, "meta", { keyPath: "key" });
  },
  2: (db, tx) => {
    const journal = ensureStore(db, tx, "journal", { keyPath: "seq", autoIncrement: true });
    ensureIndex(journal, "opId", "opId");
    ensureIndex(journal, "at", "at");
    const scans = ensureStore(db, tx, "scans", { keyPath: "id" });
    ensureIndex(scans, "startedAt", "startedAt");
    const sugg = ensureStore(db, tx, "suggestions", { keyPath: "id" });
    ensureIndex(sugg, "listingId", "listingId");
  },
  3: (db, tx) => {
    ensureIndex(tx.objectStore("items"), "listingId", "listingId");
    ensureIndex(tx.objectStore("ledger"), "at", "at");
    ensureIndex(tx.objectStore("listings"), "publishedAt", "publishedAt");
    const activity = ensureStore(db, tx, "activity", { keyPath: "seq", autoIncrement: true });
    ensureIndex(activity, "at", "at");
    ensureStore(db, tx, "accounts", { keyPath: "id" });
    // Dati del v2: le voci del registro senza "simulated" diventano reali esplicite.
    const req = tx.objectStore("ledger").openCursor();
    req.onsuccess = () => {
      const cur = req.result;
      if (!cur) return;
      if (cur.value.simulated === undefined) cur.update({ ...cur.value, simulated: false });
      cur.continue();
    };
  },
};

export function runDbUpgrade(db, tx, oldVersion, newVersion = DB_VERSION) {
  const applied = [];
  for (let v = oldVersion + 1; v <= newVersion; v++) {
    if (!DB_STEPS[v]) throw new Error(`Passo di migrazione db_v${v} mancante`);
    DB_STEPS[v](db, tx);
    applied.push(`db_v${v - 1} → db_v${v}`);
  }
  return applied;
}

/** Passi delle impostazioni. Ogni passo riceve lo schema precedente e restituisce il successivo. */
export const SETTINGS_STEPS = {
  // schema 1 (sviluppo iniziale): timers piatti { minDelay, maxDelay } e limiti { daily }.
  2: (s) => {
    const out = { ...s, schema: 2 };
    if (isPlainObject(s.timers) && ("minDelay" in s.timers || "maxDelay" in s.timers)) {
      out.timers = { betweenItems: { min: Number(s.timers.minDelay ?? 45), max: Number(s.timers.maxDelay ?? 120) } };
    }
    if (isPlainObject(s.limits) && "daily" in s.limits) {
      out.limits = { perDay: { like: Number(s.limits.daily), comment: Number(s.limits.daily), offer: Number(s.limits.daily) } };
    }
    return out;
  },
  // schema 2 → 3: le notifiche diventano per categoria, gli overlay hanno fab/widget separati.
  3: (s) => {
    const out = { ...s, schema: 3 };
    if (typeof s.notifications === "boolean") out.notifications = { enabled: s.notifications };
    if (typeof s.overlay === "boolean") out.overlay = { fab: s.overlay, widget: s.overlay };
    return out;
  },
};

export function migrateSettings(stored) {
  const from = Number(stored?.schema || (stored && Object.keys(stored).length ? 1 : DEFAULT_SETTINGS.schema));
  let s = { ...(stored || {}) };
  const applied = [];
  for (let v = from + 1; v <= DEFAULT_SETTINGS.schema; v++) {
    s = SETTINGS_STEPS[v](s);
    applied.push(`settings_v${v - 1} → settings_v${v}`);
  }
  // Le chiavi nuove prendono i valori predefiniti; quelle dell'utente restano.
  const merged = deepMerge(DEFAULT_SETTINGS, s);
  merged.schema = DEFAULT_SETTINGS.schema;
  return { settings: merged, applied, from };
}
