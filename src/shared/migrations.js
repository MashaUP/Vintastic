/**
 * Config Migration Engine.
 *
 * - DB_STEPS: passi versionati dello schema IndexedDB (db_v1 → … → db_v5).
 *   onupgradeneeded esegue in ordine tutti i passi da oldVersion+1 a DB_VERSION,
 *   dentro la stessa transazione di upgrade: se uno fallisce, IndexedDB annulla
 *   tutto e il database resta alla versione precedente (rollback automatico).
 * - SETTINGS_STEPS: passi delle impostazioni (schema 1 → … → 5). Prima di
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

// db_v3 → db_v4 (Vintastic 2.0.0): via i «commenti» (operazione inesistente su Vinted),
// cicli di esecuzione e «Posizione» predefinita delle campagne.
DB_STEPS[4] = (db, tx) => {
  const each = (store, fn) => {
    const req = tx.objectStore(store).openCursor();
    req.onsuccess = () => { const cur = req.result; if (!cur) return; fn(cur); cur.continue(); };
  };
  each("items", (cur) => cur.update(migrateItemV4(cur.value)));
  each("campaigns", (cur) => cur.update(migrateCampaignV4(cur.value)));
  each("ledger", (cur) => { if (cur.value.type === "comment") cur.delete(); });
};

/** Elemento della coda senza operazioni «comment». Se non resta niente, l'elemento è tolto (non cancellato). */
export function migrateItemV4(item) {
  if (!item || !Array.isArray(item.ops)) return item;
  const ops = item.ops.filter((o) => o.type !== "comment").map((o) => ({ ...o, cycle: o.cycle || 1 }));
  const dropped = item.ops.length - ops.length;
  const out = { ...item, ops };
  if (dropped) {
    out.history = [...(item.history || []), { at: Date.now(), action: "migrazione 2.0.0", detail: `${dropped} commenti tolti (funzione rimossa)` }];
    if (!ops.length) Object.assign(out, { removed: true, removedReason: "conteneva solo commenti (funzione rimossa)" });
  }
  return out;
}

/** Campagna: niente «comment» tra i tipi, ciclo 1, Posizione «In cima» se mai scelta. */
export function migrateCampaignV4(c) {
  if (!c) return c;
  const out = { ...c };
  if (c.opsDefaults) {
    const types = (c.opsDefaults.types || []).filter((t) => t !== "comment");
    out.opsDefaults = { ...c.opsDefaults, types: types.length ? types : ["like"] };
    if (Array.isArray(c.opsDefaults.order)) out.opsDefaults.order = c.opsDefaults.order.filter((t) => t !== "comment");
    delete out.opsDefaults.comment;
  }
  if (Array.isArray(c.order)) out.order = c.order.filter((t) => t !== "comment");
  if (!c.addPosition) out.addPosition = "start";
  if (!c.cycle) out.cycle = { n: 1, id: `${c.id}-1`, startedAt: c.startedAt || c.createdAt || null };
  if (!Array.isArray(c.cycles)) out.cycles = [];
  return out;
}

/** Impostazioni senza le chiavi dei commenti. */
export function stripCommentSettings(s) {
  const out = structuredClone(s || {});
  if (out.limits?.perDay) delete out.limits.perDay.comment;
  if (out.timers?.transitions) for (const k of Object.keys(out.timers.transitions)) if (k.split(">").includes("comment")) delete out.timers.transitions[k];
  if (out.features) delete out.features.comment;
  if (out.moduleKill) delete out.moduleKill.comment;
  return out;
}

// db_v4 → db_v5 (Vintastic 2.1.0): timer predefiniti più bassi nelle campagne non concluse.
// Cambiano solo gli intervalli rimasti ESATTAMENTE ai vecchi valori predefiniti: quelli scelti a mano restano.
DB_STEPS[5] = (db, tx) => {
  const req = tx.objectStore("campaigns").openCursor();
  req.onsuccess = () => {
    const cur = req.result;
    if (!cur) return;
    const c = cur.value;
    if (!["completed", "stopped"].includes(c?.status) && c?.timers) {
      const timers = lowerOldTimers(c.timers);
      if (timers !== c.timers) cur.update({ ...c, timers });
    }
    cur.continue();
  };
};

/** Vecchi valori predefiniti dei timer (fino alla 2.0.0) e i nuovi. */
export const OLD_TIMER_DEFAULTS = { betweenOps: { min: 8, max: 20 }, betweenItems: { min: 45, max: 120 }, transition: { min: 10, max: 25 }, minFloor: 3, retryDelays: [60, 300] };
export const NEW_TIMER_DEFAULTS = { betweenOps: { min: 3, max: 8 }, betweenItems: { min: 10, max: 25 }, transition: { min: 3, max: 8 }, minFloor: 2, retryDelays: [30, 120] };

const sameRange = (r, d) => Number(r?.min) === d.min && Number(r?.max) === d.max;

/**
 * Timer con i vecchi valori predefiniti portati ai nuovi. Restituisce lo stesso oggetto se non
 * cambia niente (così chi chiama sa se salvare).
 */
export function lowerOldTimers(timers) {
  if (!isPlainObject(timers)) return timers;
  let changed = false;
  const out = structuredClone(timers);
  for (const key of ["betweenOps", "betweenItems"]) {
    if (sameRange(out[key], OLD_TIMER_DEFAULTS[key])) { out[key] = { ...NEW_TIMER_DEFAULTS[key] }; changed = true; }
  }
  for (const [k, r] of Object.entries(out.transitions || {})) {
    if (sameRange(r, OLD_TIMER_DEFAULTS.transition)) { out.transitions[k] = { ...NEW_TIMER_DEFAULTS.transition }; changed = true; }
  }
  if (Number(out.minFloor) === OLD_TIMER_DEFAULTS.minFloor) { out.minFloor = NEW_TIMER_DEFAULTS.minFloor; changed = true; }
  return changed ? out : timers;
}

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
      out.limits = { perDay: { like: Number(s.limits.daily), offer: Number(s.limits.daily) } };
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
  // schema 3 → 4 (2.0.0): via le chiavi dei commenti. La «Posizione» predefinita (In cima)
  // arriva dai valori predefiniti solo se l'utente non ne ha già scelta una.
  4: (s) => ({ ...stripCommentSettings(s), schema: 4 }),
  // schema 4 → 5 (2.1.0): timer predefiniti più bassi. Cambiano solo i valori rimasti ai vecchi
  // predefiniti (8–20 s, 45–120 s, 10–25 s, minimo 3 s, nuovi tentativi 60/300 s).
  5: (s) => {
    const out = { ...s, schema: 5 };
    if (isPlainObject(s.timers)) out.timers = lowerOldTimers(s.timers);
    const d = s.opRetry?.delaysSec;
    if (Array.isArray(d) && d.length === 2 && d[0] === OLD_TIMER_DEFAULTS.retryDelays[0] && d[1] === OLD_TIMER_DEFAULTS.retryDelays[1]) {
      out.opRetry = { ...s.opRetry, delaysSec: [...NEW_TIMER_DEFAULTS.retryDelays] };
    }
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
