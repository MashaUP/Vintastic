/**
 * Motore delle campagne.
 *
 * - Una sola operazione alla volta in tutto Vintastic.
 * - Journal write-ahead: prima di inviare qualcosa a Vinted si scrive l'intento,
 *   subito prima dell'invio la fase "sending". Dopo un crash: senza "sending"
 *   non è partito niente (si rimette in attesa), con "sending" e senza esito
 *   l'operazione diventa DA VERIFICARE e non viene mai ripetuta da sola.
 * - Global Interaction Ledger: niente doppioni per (account, annuncio, tipo).
 * - 403/429/CAPTCHA/restrizioni: pausa di tutto, indipendentemente dai timer.
 * - Le code si modificano anche durante l'esecuzione; le operazioni completate
 *   o in corso non si toccano.
 * - Mai acquisti: il content script usa solo le richieste ammesse da guard-core.js.
 */

import * as db from "./db.js";
import { getSettings, getState, setState } from "./store.js";
import { log, activity } from "./logger.js";
import { notify } from "./notify.js";
import { broadcast } from "./bus.js";
import * as tabs from "./tabs.js";
import * as health from "./health.js";
import * as session from "./session.js";
import * as connectivity from "./connectivity.js";
import { suggestFor } from "./ai.js";
import { uid, sleep } from "../shared/util.js";
import { OP_LABEL, OP_TYPES } from "../shared/constants.js";
import { transitionCampaign, OP_PENDING } from "../shared/states.js";
import { ledgerKey, canInteract, ledgerUpdate } from "../shared/ledger.js";
import { delayBefore, checkLimit, countOp } from "../shared/timers.js";
import * as Q from "../shared/queue.js";
import { validateCampaign, makeSnapshot, diffSnapshot } from "../shared/policy.js";
import { computeOffer } from "../shared/offer.js";
import { sortItems } from "../shared/filters.js";

const ALARM = "vt-engine";
let busy = false;
let timer = null;
let lockChain = Promise.resolve();

export const engineState = () => ({ busy });

/** Serializza tutte le modifiche a campagne e code (niente scritture concorrenti). */
export function withLock(fn) {
  const run = lockChain.then(fn, fn);
  lockChain = run.catch(() => {});
  return run;
}

// ------------------------------------------------------------------ dati

export const getCampaign = (id) => db.get("campaigns", id);
export const listCampaigns = () => db.getAll("campaigns");
export const campaignItems = (id) => db.byIndex("items", "campaignId", id);

async function saveCampaign(c, items = null) {
  if (items) c.progress = Q.progress(items);
  c.updatedAt = Date.now();
  await db.put("campaigns", c);
  broadcast("vt:campaign", { campaign: c });
  return c;
}

async function saveItems(items) {
  await db.putMany("items", items);
}

const histC = (c, action, detail = "") => {
  c.history = [...(c.history || []), { at: Date.now(), action, detail }].slice(-300);
  return c;
};

export async function createCampaign(input) {
  const s = await getSettings();
  const sess = await session.current();
  const c = {
    id: uid("c_"),
    name: String(input.name || "Nuova campagna").slice(0, 80),
    accountId: input.accountId || sess.accountId || null,
    origin: input.origin || sess.origin || "https://www.vinted.it",
    scanAccountId: input.scanAccountId || sess.accountId || null,
    status: "draft",
    dryRun: input.dryRun !== false,               // simulazione finché non scegli il contrario
    createdAt: Date.now(),
    opsDefaults: {
      types: (input.types || ["like"]).filter((t) => OP_TYPES.includes(t)),
      order: input.order || OP_TYPES.slice(),
      offerCfg: input.offerCfg || s.offer?.defaultRules || null,
      comment: input.comment || "",
      requireConfirm: input.requireConfirm || {},
    },
    timers: input.timers || {},
    skipRules: { notActive: true, ...(input.skipRules || {}) },
    sort: { mode: input.sortMode || "manual", seed: Date.now() % 100000 },
    snapshot: null,
    history: [],
    progress: null,
    consecutiveFailures: 0,
    blockedCount: 0,
  };
  histC(c, "creata", c.dryRun ? "simulazione" : "reale");
  await saveCampaign(c, []);
  await activity("campaign", `Campagna creata: ${c.name}`, { campaignId: c.id });
  if (input.listings?.length) await addToCampaign(c.id, input.listings, { types: c.opsDefaults.types });
  return getCampaign(c.id);
}

/** Calcola gli importi delle offerte che non ne hanno uno (anteprima). */
function fillOfferAmounts(c, items) {
  return items.map((i) => ({
    ...i,
    ops: i.ops.map((o) => {
      if (o.type !== "offer" || !OP_PENDING.has(o.status) || Number(o.amount) > 0) return o;
      const r = computeOffer(i.listing.price, o.offerCfg || c.opsDefaults.offerCfg || {});
      return { ...o, amount: r.ok ? r.amount : null, offerPreview: r };
    }),
  }));
}

export function addToCampaign(campaignId, listings, spec = {}, where = "end") {
  return withLock(async () => {
    const c = await getCampaign(campaignId);
    if (!c) throw new Error("Campagna non trovata");
    const items = await campaignItems(campaignId);
    const sess = await session.current();
    const withScan = listings.map((l) => ({ ...l, scannedBy: l.scannedBy || sess.accountId || null }));
    const r = Q.addItems(items, withScan, { ...c.opsDefaults, ...spec, order: c.opsDefaults.order }, campaignId, where);
    let next = fillOfferAmounts(c, r.items);
    await saveItems(next.filter((i) => r.changed.includes(i.id)));
    histC(c, "aggiunti annunci", `${r.changed.length} aggiunti/aggiornati, ${r.rejected.length} scartati`);
    if (c.status === "completed") Object.assign(c, transitionCampaign(c, "ready"));
    if (c.snapshot && c.status !== "draft") c.snapshot = makeSnapshot(next);   // modifica dell'utente = nuova approvazione
    await saveCampaign(c, next);
    await activity("queue", `${r.changed.length} annunci aggiunti a «${c.name}»`, { campaignId });
    if (c.status === "running") kick();
    return { added: r.changed.length, rejected: r.rejected };
  });
}

/** Modifiche alla coda: remove, skip, move, reorder, priority, editOps, addOps, retry, sort. */
export function mutateQueue(campaignId, action, args = {}) {
  return withLock(async () => {
    const c = await getCampaign(campaignId);
    if (!c) throw new Error("Campagna non trovata");
    let items = await campaignItems(campaignId);
    let rejected = null;
    let detail = "";
    switch (action) {
      case "remove": { const r = Q.removeItems(items, args.ids || []); items = r.items; rejected = r.rejected; detail = `${(args.ids || []).length} elementi`; break; }
      case "skip": items = Q.skipItem(items, args.id); detail = args.id; break;
      case "move": { const r = Q.move(items, args.id, args.where); items = r.items; rejected = r.rejected; detail = args.where; break; }
      case "reorder": { const r = Q.reorder(items, args.ids || []); items = r.items; rejected = r.rejected; break; }
      case "priority": items = Q.setPriority(items, args.id, args.priority); detail = String(args.priority); break;
      case "editOps": {
        items = items.map((i) => {
          if (i.id !== args.id) return i;
          const r = Q.editItemOps(i, args.patch || {});
          rejected = r.rejected;
          return r.item;
        });
        break;
      }
      case "addOps": {
        items = items.map((i) => (args.ids?.includes(i.id) ? Q.addOps(i, args.types || [], { ...c.opsDefaults, ...(args.spec || {}) }).item : i));
        detail = (args.types || []).join(" + ");
        break;
      }
      case "retry": { const r = Q.retryFailed(items, args.ids || null); items = r.items; detail = `${r.count} operazioni`; break; }
      case "sort": {
        const mode = args.mode || "manual";
        const seed = args.seed ?? Date.now() % 100000;
        const order = sortItems(Q.activeItems(items), mode, seed).map((i) => i.id);
        if (args.preview) return { preview: order.map((id) => items.find((i) => i.id === id)) };
        items = Q.reorder(items, order).items;
        c.sort = { mode, seed };
        detail = mode;
        break;
      }
      case "resolveVerify": {
        // L'utente ha controllato su Vinted: done = l'operazione c'è, notDone = non è arrivata.
        items = items.map((i) => (i.id !== args.id ? i : {
          ...i,
          ops: i.ops.map((o) => (o.id !== args.opId || o.status !== "verify" ? o : { ...o, status: args.done ? "completed" : "failed", retryable: !args.done, resolvedAt: Date.now(), error: args.done ? null : "Non arrivata a Vinted (verificato dall'utente)" })),
        }));
        const it = items.find((i) => i.id === args.id);
        const op = it?.ops.find((o) => o.id === args.opId);
        if (op) await setLedger(c.accountId, it, op, args.done ? "completed" : "failed", c.id, { resolvedByUser: true });
        detail = args.done ? "verificata: eseguita" : "verificata: non eseguita";
        break;
      }
      default: throw new Error(`Azione sconosciuta: ${action}`);
    }
    items = fillOfferAmounts(c, items);
    await saveItems(items);
    histC(c, action, detail);
    if (c.snapshot && ["running", "paused", "ready"].includes(c.status)) c.snapshot = makeSnapshot(items);
    if (c.status === "completed" && Q.nextOp(items)) Object.assign(c, transitionCampaign(c, "ready"));
    await saveCampaign(c, items);
    if (c.status === "running") kick();
    return { ok: !rejected, rejected };
  });
}

export function updateCampaign(id, patch) {
  return withLock(async () => {
    const c = await getCampaign(id);
    if (!c) throw new Error("Campagna non trovata");
    const allowed = ["name", "dryRun", "timers", "skipRules", "opsDefaults", "accountId", "origin"];
    if (c.status === "running" && "dryRun" in patch && patch.dryRun !== c.dryRun) throw new Error("Metti in pausa la campagna prima di passare tra simulazione e modalità reale.");
    for (const k of allowed) if (k in patch) c[k] = patch[k];
    histC(c, "impostazioni modificate", Object.keys(patch).join(", "));
    const items = await campaignItems(id);
    if ("dryRun" in patch || "accountId" in patch) c.snapshot = null;     // cambia il significato: va riapprovata
    await saveCampaign(c, items);
    return c;
  });
}

export function deleteCampaign(id) {
  return withLock(async () => {
    const c = await getCampaign(id);
    if (c?.status === "running") throw new Error("Interrompi la campagna prima di eliminarla.");
    for (const i of await campaignItems(id)) await db.del("items", i.id);
    await db.del("campaigns", id);
    broadcast("vt:campaign", { deleted: id });
    return true;
  });
}

// ------------------------------------------------------------------ anteprima e avvio

export async function policyContext(c, items) {
  const settings = await getSettings();
  const ledgerEntries = await db.byIndex("ledger", "accountId", c.accountId || "");
  return {
    campaign: c,
    items,
    session: await session.current(),
    ledger: new Map(ledgerEntries.map((e) => [e.key, e])),
    counters: await getState("counters", null),
    settings,
    breakers: await health.breakers(),
    online: (await connectivity.state()).online,
  };
}

export async function preview(id) {
  const c = await getCampaign(id);
  let items = fillOfferAmounts(c, await campaignItems(id));
  await saveItems(items);
  const v = validateCampaign(await policyContext(c, items));
  return { campaign: c, items: Q.executionOrder(items), validation: v, snapshotDiff: diffSnapshot(c.snapshot, items) };
}

/** L'utente approva l'anteprima: fotografia delle operazioni e degli importi. */
export function approve(id) {
  return withLock(async () => {
    const c = await getCampaign(id);
    const items = fillOfferAmounts(c, await campaignItems(id));
    await saveItems(items);
    c.snapshot = makeSnapshot(items);
    if (c.status === "draft") Object.assign(c, transitionCampaign(c, "ready"));
    if (c.status === "stopped") Object.assign(c, transitionCampaign(c, "ready"));
    if (c.pauseReason === "snapshot") { c.pauseReason = null; c.pauseDetail = null; }
    histC(c, "anteprima approvata", `${c.snapshot.count} annunci`);
    await saveCampaign(c, items);
    return c;
  });
}

export function start(id) {
  return withLock(async () => {
    const c = await getCampaign(id);
    if (!c) throw new Error("Campagna non trovata");
    if (c.status === "running") return { ok: true, already: true };
    const items = await campaignItems(id);
    const v = validateCampaign(await policyContext(c, items));
    if (!v.ok) return { ok: false, validation: v };
    const from = c.status;
    if (from === "draft") Object.assign(c, transitionCampaign(c, "ready"));
    Object.assign(c, transitionCampaign(c, "running"), { startedAt: c.startedAt || Date.now(), pauseReason: null, pauseDetail: null, autoPaused: false, resumeAt: null, consecutiveFailures: 0, nextAt: Date.now() });
    histC(c, from === "paused" ? "ripresa" : "avviata", c.dryRun ? "simulazione" : "reale");
    await saveCampaign(c, items);
    await notify({ category: "campaignStart", level: "info", title: `${from === "paused" ? "Ripresa" : "Avviata"}: ${c.name}`, body: c.dryRun ? "Simulazione: niente viene inviato a Vinted." : `${c.progress.pending} operazioni in coda.`, link: `#campaigns/${c.id}`, campaignId: c.id });
    await activity("campaign", `${from === "paused" ? "Ripresa" : "Avviata"} «${c.name}»${c.dryRun ? " (simulazione)" : ""}`, { campaignId: c.id });
    kick();
    return { ok: true, validation: v };
  });
}

export const resume = start;

export function pause(id, reason = "user", detail = "", { auto = false, resumeAt = null } = {}) {
  return withLock(() => pauseNoLock(id, reason, detail, { auto, resumeAt }));
}

async function pauseNoLock(id, reason, detail, { auto = false, resumeAt = null } = {}) {
  const c = await getCampaign(id);
  if (!c || !["running", "paused"].includes(c.status)) return c;
  if (c.status === "running") Object.assign(c, transitionCampaign(c, "paused"));
  Object.assign(c, { pauseReason: reason, pauseDetail: detail, autoPaused: auto, resumeAt, nextAt: null });
  histC(c, "pausa", `${reason}${detail ? `: ${detail}` : ""}`);
  await saveCampaign(c, await campaignItems(id));
  const titles = { user: "In pausa", offline: "In pausa: connessione assente", blocked: "In pausa: Vinted ha limitato le richieste", captcha: "In pausa: verifica richiesta da Vinted", auth: "In pausa: sessione da verificare", limit: "In pausa: soglia raggiunta", errors: "In pausa: troppi errori di fila", snapshot: "In pausa: serve una nuova approvazione", confirm: "Conferma richiesta", kill: "Fermata dal Kill Switch", tabClosed: "In pausa: scheda di lavoro chiusa", module: "In pausa: modulo non disponibile" };
  await notify({ category: reason === "auth" ? "sessionExpired" : reason === "limit" ? "limitReached" : reason === "offline" ? "connection" : "campaignPaused", level: reason === "user" || reason === "confirm" ? "info" : "warning", title: `${titles[reason] || "In pausa"} — ${c.name}`, body: detail, link: `#campaigns/${c.id}`, campaignId: c.id, persistent: !["user"].includes(reason), groupKey: `pause-${c.id}` });
  await activity("campaign", `«${c.name}» in pausa (${titles[reason] || reason})`, { campaignId: c.id });
  return c;
}

export async function pauseAll(reason = "user", detail = "", opts = {}) {
  const running = (await listCampaigns()).filter((c) => c.status === "running");
  for (const c of running) await pause(c.id, reason, detail, opts);
  return running.length;
}

export function stop(id) {
  return withLock(async () => {
    const c = await getCampaign(id);
    if (!c) return null;
    let items = await campaignItems(id);
    items = items.map((i) => ({ ...i, ops: i.ops.map((o) => (OP_PENDING.has(o.status) ? { ...o, status: "cancelled", updatedAt: Date.now() } : o)) }));
    await saveItems(items);
    if (c.status !== "stopped" && c.status !== "completed") {
      if (c.status === "draft") c.status = "ready";
      Object.assign(c, transitionCampaign(c, "stopped"), { nextAt: null, stoppedAt: Date.now() });
    }
    histC(c, "interrotta");
    await saveCampaign(c, items);
    await activity("campaign", `«${c.name}» interrotta`, { campaignId: id });
    return c;
  });
}

/** Riattiva una campagna interrotta: le operazioni annullate tornano in attesa (mai quelle eseguite). */
export function reopen(id) {
  return withLock(async () => {
    const c = await getCampaign(id);
    let items = await campaignItems(id);
    items = items.map((i) => (i.removed ? i : { ...i, ops: i.ops.map((o) => (o.status === "cancelled" ? { ...o, status: "waiting" } : o)) }));
    await saveItems(items);
    if (c.status === "stopped" || c.status === "completed") Object.assign(c, transitionCampaign(c, "ready"));
    c.snapshot = null;
    histC(c, "riaperta");
    await saveCampaign(c, items);
    return c;
  });
}

export function confirmOp(campaignId, opId) {
  return withLock(async () => {
    const c = await getCampaign(campaignId);
    const items = (await campaignItems(campaignId)).map((i) => ({ ...i, ops: i.ops.map((o) => (o.id === opId ? { ...o, confirmedAt: Date.now() } : o)) }));
    await saveItems(items);
    c.pendingConfirm = null;
    histC(c, "operazione confermata", opId);
    await saveCampaign(c, items);
    return c;
  });
}

// ------------------------------------------------------------------ ledger e journal

async function setLedger(accountId, item, op, status, campaignId, extra = {}) {
  const key = ledgerKey(accountId, item.listingId, op.type);
  const prev = await db.get("ledger", key);
  const entry = ledgerUpdate(prev, {
    key, accountId, listingId: item.listingId, sellerId: item.listing?.sellerId || null, type: op.type,
    status, campaignId, opId: op.id, amount: op.amount ?? null, simulated: false, title: item.listing?.title || "", ...extra,
  });
  await db.put("ledger", entry);
  return entry;
}

async function journal(entry) {
  return db.put("journal", { at: Date.now(), ...entry });
}

function updateOp(campaignId, itemId, opId, patch) {
  return withLock(() => updateOpNoLock(itemId, opId, patch));
}

async function updateOpNoLock(itemId, opId, patch) {
  const item = await db.get("items", itemId);
  if (!item) return null;
  const next = { ...item, ops: item.ops.map((o) => (o.id === opId ? { ...o, ...patch, updatedAt: Date.now() } : o)) };
  if (patch.listingPatch) next.listing = { ...next.listing, ...patch.listingPatch };
  delete next.ops.find((o) => o.id === opId)?.listingPatch;
  await db.put("items", next);
  return next;
}

/** Prende in carico l'operazione SOLO se è ancora in attesa (l'utente può averla tolta nel frattempo). */
function claimOp(itemId, opId, extra = {}) {
  return withLock(async () => {
    const item = await db.get("items", itemId);
    const op = item?.ops.find((o) => o.id === opId);
    if (!item || item.removed || !op || !OP_PENDING.has(op.status)) return null;
    return updateOpNoLock(itemId, opId, { status: "running", startedAt: Date.now(), ...extra });
  });
}

/** Modifica una campagna rileggendola dentro il lock (niente aggiornamenti persi). */
function patchCampaign(id, fn) {
  return withLock(async () => {
    const c = await getCampaign(id);
    if (!c) return null;
    await fn(c);
    return saveCampaign(c, await campaignItems(id));
  });
}

// ------------------------------------------------------------------ esecuzione

export function kick(delayMs = 50) {
  clearTimeout(timer);
  timer = setTimeout(() => { tick().catch((e) => log({ level: "error", category: "js", message: `Motore: ${e.message}`, stack: e.stack })); }, delayMs);
}

function schedule(at) {
  const delay = Math.max(0, at - Date.now());
  if (delay < 25_000) kick(delay);
  // Sveglia di riserva: se Chrome sospende il worker, l'allarme lo risveglia.
  chrome.alarms.create(ALARM, { when: Math.max(Date.now() + 1000, at) });
}

export async function tick() {
  if (busy) return;
  busy = true;
  try {
    const settings = await getSettings();
    if (settings.killSwitch) return;
    await autoResumeCheck();
    const running = (await listCampaigns()).filter((c) => c.status === "running").sort((a, b) => (a.nextAt || 0) - (b.nextAt || 0));
    if (!running.length) return;
    const c = running[0];
    if (c.nextAt && c.nextAt > Date.now() + 200) { schedule(c.nextAt); return; }
    const items = await campaignItems(c.id);
    const next = Q.nextOp(items);
    if (!next) {
      if (items.some((i) => i.ops.some((o) => o.status === "running"))) { schedule(Date.now() + 5000); return; }
      await completeCampaign(c);
      kick();
      return;
    }
    await runOp(c, next.item, next.op, settings);
    const fresh = await getCampaign(c.id);
    if (fresh?.status === "running") {
      const after = Q.nextOp(await campaignItems(c.id));
      if (!after) { await completeCampaign(fresh); }
      else {
        const d = delayBefore(after.op, fresh.lastOp, fresh.lastOp?.itemId === after.item.id, fresh.timers, settings.timers);
        if (fresh.dryRun) d.seconds = Math.min(d.seconds, 2);       // la simulazione non aspetta davvero
        const updated = await patchCampaign(c.id, (x) => {
          if (x.status !== "running") return;
          x.nextAt = Date.now() + d.seconds * 1000;
          x.nextLabel = `${d.label} · ${OP_LABEL[after.op.type]} su «${after.item.listing.title?.slice(0, 40) || after.item.listingId}»`;
          x.nextOp = { itemId: after.item.id, opId: after.op.id, type: after.op.type };
        });
        if (updated?.status === "running") broadcast("vt:timer", { campaignId: c.id, nextAt: updated.nextAt, label: updated.nextLabel });
      }
    }
    kick(300);
  } finally {
    busy = false;
  }
}

async function completeCampaign(c) {
  return withLock(async () => {
    const cur = await getCampaign(c.id);
    if (cur.status !== "running") return;
    const items = await campaignItems(c.id);
    if (Q.nextOp(items) || items.some((i) => i.ops.some((o) => o.status === "running"))) return;   // aggiunti nel frattempo
    Object.assign(cur, transitionCampaign(cur, "completed"), { completedAt: Date.now(), nextAt: null, current: null });
    histC(cur, "completata");
    await saveCampaign(cur, items);
    const p = cur.progress;
    await notify({ category: "campaignDone", level: p.failed || p.verify ? "warning" : "success", title: `Completata: ${cur.name}`, body: `${p.completed} riuscite · ${p.failed} fallite · ${p.verify} da verificare · ${p.skipped} saltate${cur.dryRun ? " (simulazione)" : ""}`, link: `#campaigns/${cur.id}`, campaignId: cur.id });
    await activity("campaign", `«${cur.name}» completata`, { campaignId: cur.id });
  });
}

async function finishOp(c, item, op, status, data = {}) {
  const t0 = op.startedAt || Date.now();
  await updateOp(c.id, item.id, op.id, { status, finishedAt: Date.now(), result: data.result || null, error: data.error || null, retryable: data.retryable, reason: data.reason || null, listingPatch: data.listingPatch });
  await journal({ phase: "result", opId: op.id, itemId: item.id, campaignId: c.id, accountId: c.accountId, listingId: item.listingId, type: op.type, status: data.statsStatus || status, simulated: Boolean(c.dryRun), durationMs: Date.now() - t0, amount: op.amount ?? null });
  await patchCampaign(c.id, (cur) => {
    cur.lastOp = { type: op.type, itemId: item.id, at: Date.now(), status };
    cur.current = null;
  });
}

async function runOp(c, item, op, settings) {
  const title = item.listing?.title?.slice(0, 50) || `annuncio ${item.listingId}`;
  const label = OP_LABEL[op.type];

  // 1. Regole prima di partire: niente di tutto questo tocca Vinted.
  if (c.skipRules?.notActive && item.listing?.status && item.listing.status !== "active") {
    return finishOp(c, item, op, "skipped", { reason: `Annuncio non attivo (${item.listing.status})` });
  }
  const mod = op.type === "comment" ? "comment" : op.type;
  const avail = await health.moduleAvailable(mod);
  if (!avail.ok) { await pauseNoLockSafe(c.id, "module", `${label}: ${avail.reason}`); return; }

  if (op.type !== "comment") {
    const entry = await db.get("ledger", ledgerKey(c.accountId, item.listingId, op.type));
    const decision = canInteract(entry);
    if (!decision.allowed && !c.dryRun) {
      return finishOp(c, item, op, "skipped", { reason: `No Repeat: ${decision.reason}`, result: { ledger: decision.code } });
    }
  }
  if (op.requireConfirm && !op.confirmedAt) {
    await patchCampaign(c.id, (cur) => { cur.pendingConfirm = { itemId: item.id, opId: op.id, type: op.type, title, amount: op.amount ?? null }; });
    await pauseNoLockSafe(c.id, "confirm", `${label} su «${title}»${op.amount ? ` · ${op.amount} €` : ""}: premi Conferma per procedere.`);
    return;
  }

  // 2. Commenti: Vinted non ha commenti pubblici sugli annunci → suggerimenti da copiare.
  if (op.type === "comment") {
    const listing = (await db.get("listings", item.listingId)) || item.listing;
    const sugg = op.comment ? [op.comment] : await suggestFor(listing).catch(() => []);
    await db.put("suggestions", { id: uid("s_"), listingId: item.listingId, title: listing.title, url: listing.url, at: Date.now(), texts: sugg, campaignId: c.id, source: op.comment ? "manuale" : "automatico", used: false });
    await activity("comment", `Commento suggerito per «${title}»`, { campaignId: c.id, listingId: item.listingId });
    return finishOp(c, item, op, "skipped", { reason: "Vinted non supporta commenti pubblici: suggerimento pronto da copiare", result: { suggestions: sugg }, statsStatus: "suggested" });
  }

  // 3. Soglie giornaliere (solo modalità reale).
  if (!c.dryRun) {
    const counters = await getState("counters", null);
    const lim = checkLimit(counters, c.accountId, op.type, settings.limits);
    if (!lim.allowed) {
      await log({ level: "warn", category: "policy", campaignId: c.id, message: lim.reason, code: "limit" });
      await pauseNoLockSafe(c.id, "limit", `${lim.reason} Si azzera alle ${new Date(lim.resetAt).toLocaleTimeString("it-IT", { hour: "2-digit", minute: "2-digit" })}.`, { auto: true, resumeAt: lim.resetAt });
      return;
    }
  }

  // 4. Offerta senza importo approvato: si ferma.
  if (op.type === "offer" && !(Number(op.amount) > 0)) {
    return finishOp(c, item, op, "failed", { error: "Importo dell'offerta mancante: apri l'anteprima", retryable: true });
  }

  // 5. Simulazione.
  if (c.dryRun) {
    if (!(await claimOp(item.id, op.id))) return null;
    await setCurrent(c.id, item, op);
    await sleep(400);
    await activity(op.type, `Simulato: ${label.toLowerCase()} su «${title}»${op.amount ? ` (${op.amount} €)` : ""}`, { campaignId: c.id, listingId: item.listingId, simulated: true });
    return finishOp(c, item, op, "completed", { result: { simulated: true } });
  }

  // 6. Reale. Sessione e account.
  const m = await session.matches(c.accountId);
  if (!m.ok) {
    await startAuthFlow(c, m.session.loggedIn ? "Account della sessione diverso da quello della campagna" : "Sessione Vinted non attiva");
    return;
  }

  // 7. Journal: intento (nessun invio ancora).
  if (!(await claimOp(item.id, op.id, { attempts: (op.attempts || 0) + 1 }))) return null;
  await setLedger(c.accountId, item, op, "running", c.id);
  await journal({ phase: "intent", opId: op.id, itemId: item.id, campaignId: c.id, type: op.type, listingId: item.listingId });
  await setCurrent(c.id, item, op);

  let tabId;
  try {
    const url = item.listing.url || `${c.origin}/items/${item.listingId}`;
    tabId = await tabs.workerTab(c.origin);
    const wantPath = settings.openListingBeforeOp ? `/items/${item.listingId}` : null;
    const ready = tabs.waitReady(tabId, 45_000, (pg) => !wantPath || String(pg?.path || "").startsWith(wantPath));
    if (settings.openListingBeforeOp) await tabs.navigate(tabId, url);
    else await chrome.tabs.reload(tabId);
    const page = await ready;
    if (page?.challenge) return notSent(c, item, op, "captcha", "Vinted chiede una verifica (CAPTCHA o conferma)", tabId);
    if (page && page.loggedIn === false) return notSent(c, item, op, "auth", "Sessione Vinted non attiva nella scheda di lavoro", tabId);
  } catch (e) {
    return notSent(c, item, op, "error", e.message);
  }

  // 8. Punto di non ritorno: da qui in poi un esito mancante = DA VERIFICARE.
  await journal({ phase: "sending", opId: op.id, itemId: item.id, campaignId: c.id, type: op.type, listingId: item.listingId });
  let res;
  try {
    res = await tabs.sendToTab(tabId, {
      type: "vt:exec",
      op: { type: op.type, amount: op.amount ?? null },
      listing: { id: item.listingId, sellerId: item.listing.sellerId, price: item.listing.price, currency: item.listing.currency, url: item.listing.url },
      expectedUserId: c.accountId?.split("@")[0],
      snapshotPrice: item.listing.price,
    });
  } catch (e) {
    if (e.notSent) return notSent(c, item, op, "error", e.message);
    res = { outcome: "uncertain", sent: true, message: e.message };
  }
  return applyOutcome(c, item, op, res || { outcome: "uncertain", message: "Risposta vuota" }, tabId);
}

const pauseNoLockSafe = (id, reason, detail, opts) => pause(id, reason, detail, opts);

function setCurrent(campaignId, item, op) {
  return patchCampaign(campaignId, (c) => {
    c.current = { itemId: item.id, opId: op.id, type: op.type, title: item.listing?.title, listingId: item.listingId, startedAt: Date.now() };
  });
}

/** Niente è stato inviato: l'operazione torna in attesa. */
async function notSent(c, item, op, kind, message, tabId = null) {
  await updateOp(c.id, item.id, op.id, { status: "waiting", error: message, startedAt: null });
  const prev = await db.get("ledger", ledgerKey(c.accountId, item.listingId, op.type));
  if (prev?.status === "running") await db.put("ledger", { ...prev, status: prev.history?.length > 1 ? prev.history[prev.history.length - 2].status : "failed" });
  await journal({ phase: "result", opId: op.id, itemId: item.id, campaignId: c.id, type: op.type, status: "notSent", note: message });
  const cur = await patchCampaign(c.id, (x) => {
    x.current = null;
    if (kind !== "captcha" && kind !== "blocked" && kind !== "auth") x.consecutiveFailures = (x.consecutiveFailures || 0) + 1;
  });
  if (kind === "captcha" || kind === "blocked") return platformBlock(cur, kind, message, tabId);
  if (kind === "auth") return startAuthFlow(cur, message, tabId);
  await log({ level: "warn", category: "op", campaignId: c.id, listingId: item.listingId, opType: op.type, message: `Non inviato: ${message}`, code: /scheda|tab/i.test(message) ? "noTab" : null });
  const s = await getSettings();
  if (cur.consecutiveFailures >= (s.maxConsecutiveFailures || 3)) await pause(c.id, "errors", `${cur.consecutiveFailures} problemi di fila. Ultimo: ${message}`);
}

/** Segnale di Vinted (403/429/CAPTCHA/restrizione): pausa di TUTTE le campagne. */
async function platformBlock(c, kind, message, tabId = null) {
  const s = await getSettings();
  const n = (await getState("blockStreak", 0)) + 1;
  await setState("blockStreak", n);
  const minutes = s.backoffMinutes?.[n - 1];
  await log({ level: "error", category: kind === "captcha" ? "auth" : "network", campaignId: c.id, message: `${message} (segnale n. ${n})`, code: kind === "captcha" ? "captcha" : /429/.test(message) ? "rate429" : "blocked403" });
  const reason = kind === "captcha" ? "captcha" : "blocked";
  const detail = kind === "captcha"
    ? "Completa tu la verifica nella scheda di Vinted, poi premi Riprendi. Vintastic non la aggira."
    : minutes ? `${message}. Ripresa automatica tra ${minutes} minuti, se la sessione è valida.` : `${message}. Troppi segnali di fila: ripresa solo manuale.`;
  const all = (await listCampaigns()).filter((x) => x.status === "running");
  for (const x of all) await pause(x.id, reason, detail, { auto: kind !== "captcha" && Boolean(minutes), resumeAt: kind !== "captcha" && minutes ? Date.now() + minutes * 60_000 : null });
  if (kind === "captcha" && tabId) await tabs.focus(tabId);
  await session.updateSession({ challenge: kind === "captcha" });
}

/** Autenticazione assistita: pausa, porta l'utente su Vinted, ricontrolla, consente la ripresa. */
async function startAuthFlow(c, message, tabId = null) {
  await pause(c.id, "auth", `${message}. ${session.ACCOUNT_SESSION_HINT}`);
  await setState("authPending", { campaignId: c.id, accountId: c.accountId, origin: c.origin, since: Date.now(), message });
  try {
    const id = tabId || await tabs.workerTab(c.origin, `${c.origin}/`, { active: true });
    await tabs.focus(id);
  } catch { /* nessuna scheda: l'utente la aprirà */ }
}

/** Chiamato dal controllo periodico: la sessione è tornata valida? */
export async function checkAuthPending() {
  const p = await getState("authPending", null);
  if (!p) return null;
  const m = await session.matches(p.accountId);
  if (m.ok && !m.session.challenge) {
    await setState("authPending", null);
    await notify({ category: "sessionExpired", level: "success", title: "Sessione di nuovo valida", body: "Puoi riprendere la campagna dal punto in cui si era fermata.", link: `#campaigns/${p.campaignId}`, campaignId: p.campaignId });
    await patchCampaign(p.campaignId, (c) => { histC(c, "sessione verificata"); c.pauseDetail = "Sessione verificata: premi Riprendi."; });
    return { resolved: true };
  }
  return { resolved: false, session: m.session };
}

async function applyOutcome(c, item, op, res, tabId) {
  const label = OP_LABEL[op.type];
  const title = item.listing?.title?.slice(0, 50) || item.listingId;
  if (res.capability) await health.recordCapability(res.capability.name, res.capability.value, res.capability.detail);
  const listingPatch = res.listing ? { price: res.listing.price ?? item.listing.price, status: res.listing.status || item.listing.status } : undefined;

  switch (res.outcome) {
    case "done":
    case "already": {
      await setState("blockStreak", 0);
      await setState("counters", countOp(await getState("counters", null), c.accountId, op.type));
      await setLedger(c.accountId, item, op, "completed", c.id, { result: res.outcome });
      await health.recordSuccess(op.type);
      await patchCampaign(c.id, (cur) => { cur.consecutiveFailures = 0; });
      const verb = op.type === "offer" ? (res.outcome === "already" ? "già presente" : "inviata") : (res.outcome === "already" ? "già presente" : "completato");
      await activity(op.type, `${label} ${verb}: «${title}»${op.amount ? ` · ${op.amount} €` : ""}`, { campaignId: c.id, listingId: item.listingId });
      return finishOp(c, item, op, "completed", { result: { outcome: res.outcome, detail: res.message }, listingPatch });
    }
    case "priceChanged": {
      // Lo snapshot non vale più: l'offerta non è partita, si ricalcola e si chiede una nuova approvazione.
      await updateOp(c.id, item.id, op.id, { status: "waiting", amount: null, error: res.message, listingPatch });
      await setLedger(c.accountId, item, op, "failed", c.id, { result: "priceChanged" });
      return pause(c.id, "snapshot", `Il prezzo di «${title}» è cambiato (${item.listing.price} → ${res.listing?.price}). Riapri l'anteprima e approvala di nuovo.`);
    }
    case "notFound":
    case "unavailable": {
      await setLedger(c.accountId, item, op, "failed", c.id, { result: res.outcome });
      return finishOp(c, item, op, "skipped", { reason: res.message || "Annuncio non più disponibile", listingPatch: { status: res.listing?.status || "unavailable" } });
    }
    case "blocked":
    case "captcha":
      return notSent(c, item, op, res.outcome === "captcha" ? "captcha" : "blocked", res.message || "Vinted ha rifiutato la richiesta", tabId);
    case "auth":
      return notSent(c, item, op, "auth", res.message || "Sessione non valida", tabId);
    case "unsupported":
    case "changed": {
      await health.recordFailure(op.type, res.message || "Funzione non riconosciuta sulla pagina", { hard: true });
      if (res.sent) return markVerify(c, item, op, res.message);
      await setLedger(c.accountId, item, op, "failed", c.id);
      await finishOp(c, item, op, "failed", { error: res.message, retryable: true });
      return pause(c.id, "module", `${label}: ${res.message}. Il modulo è stato isolato.`);
    }
    case "failed": {
      await setLedger(c.accountId, item, op, "failed", c.id, { result: res.message });
      await health.recordFailure(op.type, res.message || "errore");
      await log({ level: "error", category: "op", campaignId: c.id, listingId: item.listingId, opType: op.type, opId: op.id, message: `${label} fallito: ${res.message}`, data: { status: res.status } });
      const cur = await patchCampaign(c.id, (x) => { x.consecutiveFailures = (x.consecutiveFailures || 0) + 1; });
      await finishOp(c, item, op, "failed", { error: res.message, retryable: res.retryable !== false });
      const s = await getSettings();
      if (cur.consecutiveFailures >= (s.maxConsecutiveFailures || 3)) await pause(c.id, "errors", `${cur.consecutiveFailures} operazioni fallite di fila. Ultima: ${res.message}`);
      return null;
    }
    case "uncertain":
    default:
      if (res.network) await connectivity.reportNetworkError(res.message);
      return markVerify(c, item, op, res.message || "Esito sconosciuto");
  }
}

async function markVerify(c, item, op, message) {
  await setLedger(c.accountId, item, op, "verify", c.id, { result: message });
  await log({ level: "warn", category: "op", campaignId: c.id, listingId: item.listingId, opType: op.type, opId: op.id, message: `Esito incerto: ${message}`, code: "uncertain" });
  await notify({ category: "verify", level: "warning", title: `Da verificare: ${OP_LABEL[op.type]} su «${item.listing?.title?.slice(0, 40) || item.listingId}»`, body: "Non è certo che sia arrivata a Vinted. Non verrà ripetuta: controllala in Recupero.", link: "#recovery", campaignId: c.id, persistent: true, groupKey: "verify" });
  const cur = await patchCampaign(c.id, (x) => { x.consecutiveFailures = (x.consecutiveFailures || 0) + 1; });
  await finishOp(c, item, op, "verify", { error: message });
  const s = await getSettings();
  if (cur.consecutiveFailures >= (s.maxConsecutiveFailures || 3)) await pause(c.id, "errors", `${cur.consecutiveFailures} esiti problematici di fila.`);
}

// ------------------------------------------------------------------ recupero

/**
 * All'avvio del service worker: ricostruisce lo stato dal journal.
 * Mai ripetere alla cieca.
 */
export async function recover() {
  const report = { reset: 0, verify: 0, campaigns: 0 };
  const items = await db.getAll("items");
  const journalAll = await db.getAll("journal");
  for (const item of items) {
    let changed = false;
    const ops = [];
    for (const o of item.ops) {
      if (o.status !== "running") { ops.push(o); continue; }
      const entries = journalAll.filter((j) => j.opId === o.id && j.at >= (o.startedAt || 0) - 1000);
      const result = entries.find((j) => j.phase === "result");
      const sending = entries.find((j) => j.phase === "sending");
      changed = true;
      const c = await getCampaign(item.campaignId);
      if (result && result.status !== "notSent") {
        ops.push({ ...o, status: result.status === "suggested" ? "skipped" : result.status, recoveredAt: Date.now() });
      } else if (!sending || c?.dryRun) {
        ops.push({ ...o, status: "waiting", recoveredAt: Date.now(), error: "Interrotta prima dell'invio: rimessa in coda" });
        report.reset++;
        if (c && !c.dryRun) {
          const prev = await db.get("ledger", ledgerKey(c.accountId, item.listingId, o.type));
          if (prev?.status === "running") await db.put("ledger", { ...prev, status: "failed" });
        }
      } else {
        ops.push({ ...o, status: "verify", recoveredAt: Date.now(), error: "Interrotta durante l'invio: esito da verificare" });
        if (c) await setLedger(c.accountId, item, o, "verify", c.id, { result: "crash" });
        report.verify++;
      }
    }
    if (changed) await db.put("items", { ...item, ops, history: [...(item.history || []), { at: Date.now(), action: "recupero dopo interruzione" }] });
  }
  for (const c of await listCampaigns()) {
    if (c.current) { c.current = null; c.recoveredAt = Date.now(); await saveCampaign(c, await campaignItems(c.id)); report.campaigns++; }
  }
  if (report.reset || report.verify) {
    await log({ level: "warn", category: "system", message: `Recupero dopo interruzione: ${report.reset} rimesse in coda, ${report.verify} da verificare` });
    if (report.verify) await notify({ category: "verify", level: "warning", title: "Recupero dopo un'interruzione", body: `${report.verify} operazioni da verificare: apri il Recovery Center.`, link: "#recovery", persistent: true });
  }
  await setState("lastRecovery", { at: Date.now(), ...report });
  return report;
}

/** Ripresa automatica dopo backoff/limite/rete, solo se tutte le condizioni sono valide. */
export async function autoResumeCheck() {
  const paused = (await listCampaigns()).filter((c) => c.status === "paused" && c.autoPaused);
  if (!paused.length) return;
  const net = await connectivity.state();
  const sess = await session.current();
  for (const c of paused) {
    if (c.resumeAt && Date.now() < c.resumeAt) continue;
    if (c.pauseReason === "offline" && !net.online) continue;
    if (!c.dryRun) {
      if (!net.online || !sess.loggedIn || sess.challenge || sess.accountId !== c.accountId) continue;
    }
    // start() rivalida tutto (Policy Validator) prima di ripartire.
    setTimeout(() => start(c.id).then((r) => {
      if (!r.ok) log({ level: "info", category: "campaign", campaignId: c.id, message: `Ripresa automatica rimandata: ${r.validation?.errors?.[0] || "condizioni non valide"}` });
    }), 0);
  }
}

connectivity.on("offline", async (st) => {
  await pauseAll("offline", `Vinted non raggiungibile (${st.detail || "rete"}). Lo stato è salvato; si riprende quando la connessione torna e la sessione è valida.`, { auto: true });
});

tabs.onOwnedRemoved(async () => {
  if (busy) return;
  const running = (await listCampaigns()).filter((c) => c.status === "running" && !c.dryRun);
  for (const c of running) await pause(c.id, "tabClosed", "La scheda di lavoro di Vintastic è stata chiusa. Premi Riprendi: ne verrà aperta una nuova.");
});

export async function verifyOp(campaignId, itemId, opId) {
  const item = await db.get("items", itemId);
  const op = item?.ops.find((o) => o.id === opId);
  const c = await getCampaign(campaignId);
  if (!op || !c) throw new Error("Operazione non trovata");
  if (op.type !== "like") return { supported: false, message: "Per le offerte la verifica è manuale: apri la chat dell'annuncio su Vinted e controlla se l'offerta c'è." };
  const { tabId } = await tabs.ensureAt(c.origin, item.listing.url || `${c.origin}/items/${item.listingId}`);
  const r = await tabs.sendToTab(tabId, { type: "vt:verifyLike", listing: { id: item.listingId, sellerId: item.listing.sellerId } }, 30_000);
  if (r?.liked === true || r?.liked === false) {
    await mutateQueue(campaignId, "resolveVerify", { id: itemId, opId, done: r.liked });
    return { supported: true, resolved: true, done: r.liked };
  }
  return { supported: true, resolved: false, message: r?.message || "Stato del like non leggibile" };
}
