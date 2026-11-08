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
 * - Messaggi privati: solo verso i destinatari autorizzati, testo fotografato
 *   nell'anteprima, invio in due fasi (apertura chat → compilazione/invio) e
 *   conferma solo quando il nuovo messaggio compare nella conversazione.
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
import { uid, sleep, stableStringify } from "../shared/util.js";
import { OP_LABEL, OP_TYPES } from "../shared/constants.js";
import { transitionCampaign, OP_PENDING } from "../shared/states.js";
import { ledgerKey, cycleKey, canInteract, ledgerUpdate } from "../shared/ledger.js";
import { delayBefore, checkLimit, countOp } from "../shared/timers.js";
import * as Q from "../shared/queue.js";
import { validateCampaign, makeSnapshot, diffSnapshot } from "../shared/policy.js";
import { computeOffer } from "../shared/offer.js";
import { sortItems } from "../shared/filters.js";
import { fillMessageOps, recipientCheck, cleanRecipients, chatDiagnosis, MANUAL_WAIT_DEFAULT } from "../shared/messages.js";

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
  if (input.types && !input.types.some((t) => OP_TYPES.includes(t))) throw new Error("Scegli almeno un'operazione: like, offerta o messaggio privato.");
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
      order: (input.order || OP_TYPES).filter((t) => OP_TYPES.includes(t)),
      offerCfg: input.offerCfg || s.offer?.defaultRules || null,
      message: input.message || { source: "default" },   // vedi shared/messages.js: messageConfig
      requireConfirm: input.requireConfirm || {},
    },
    // Like già presente su Vinted: "relike" = toglilo e rimettilo, "keep" = lascialo (operazione completata).
    likeExisting: ["relike", "keep"].includes(input.likeExisting) ? input.likeExisting : (s.campaignDefaults?.likeExisting === "keep" ? "keep" : "relike"),
    timers: input.timers || {},
    skipRules: { notActive: true, ...(input.skipRules || {}) },
    sort: { mode: input.sortMode || "manual", seed: Date.now() % 100000 },
    addPosition: input.addPosition === "end" ? "end" : input.addPosition === "start" ? "start" : (s.campaignDefaults?.addPosition === "end" ? "end" : "start"),
    snapshot: null,
    history: [],
    progress: null,
    cycle: null,                                   // impostato qui sotto: { n, id, startedAt }
    cycles: [],                                    // cicli conclusi (cronologia)
    consecutiveFailures: 0,
    blockedCount: 0,
  };
  c.cycle = { n: 1, id: `${c.id}-1`, startedAt: Date.now() };
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

/** Importi delle offerte e testi dei messaggi: ciò che l'anteprima mostra e l'approvazione fotografa. */
async function prepare(c, items) {
  return fillMessageOps(c, fillOfferAmounts(c, items), await getSettings());
}

/**
 * @param where "start" (In cima) | "end" (In fondo) | null = la «Posizione» salvata nella campagna.
 *              Una scelta esplicita viene salvata nella campagna e riproposta la volta dopo.
 */
export function addToCampaign(campaignId, listings, spec = {}, where = null) {
  return withLock(async () => {
    const c = await getCampaign(campaignId);
    if (!c) throw new Error("Campagna non trovata");
    if (where === "start" || where === "end") c.addPosition = where;
    else where = c.addPosition === "end" ? "end" : "start";
    const items = await campaignItems(campaignId);
    const sess = await session.current();
    const withScan = listings.map((l) => ({ ...l, scannedBy: l.scannedBy || sess.accountId || null }));
    const r = Q.addItems(items, withScan, { ...c.opsDefaults, ...spec, order: c.opsDefaults.order, cycle: c.cycle?.n || 1, cycleId: c.cycle?.id || null }, campaignId, where);
    const next = await prepare(c, r.items);
    await saveItems(next.filter((i) => r.changed.includes(i.id)));
    histC(c, "aggiunti annunci", `${r.changed.length} aggiunti/aggiornati, ${r.rejected.length} scartati`);
    if (c.status === "completed") Object.assign(c, transitionCampaign(c, "ready"));
    if (c.snapshot && c.status !== "draft") c.snapshot = makeSnapshot(next); // modifica esplicita della coda = nuova fotografia approvata
    await saveCampaign(c, next);
    await activity("queue", `${r.changed.length} annunci aggiunti a «${c.name}»`, { campaignId });
    if (c.status === "running") kick();
    return { added: r.changed.length, rejected: r.rejected };
  });
}

// ------------------------------------------------------------------ cicli

/** Anteprima di un nuovo ciclo: cosa si ripeterebbe e cosa no (con il motivo). Non cambia niente. */
export async function refreshPreview(campaignId, sel = {}) {
  const c = await getCampaign(campaignId);
  if (!c) throw new Error("Campagna non trovata");
  const items = await campaignItems(campaignId);
  const plan = Q.refreshPlan(items, sel);
  return { ...plan, nextCycle: nextCycleNumber(c, items), dryRun: c.dryRun, status: c.status };
}

/** Il ciclo corrente si riusa se non è ancora partito niente (tutte le sue operazioni in attesa). */
function nextCycleNumber(c, items) {
  const n = c.cycle?.n || 1;
  const ops = Q.activeItems(items).flatMap((i) => i.ops.filter((o) => (o.cycle || 1) === n));
  return n > 1 && ops.length && ops.every((o) => OP_PENDING.has(o.status)) ? n : n + 1;
}

/**
 * Nuovo ciclo: riattiva le operazioni già concluse degli annunci scelti, senza cancellare
 * niente (la cronologia resta in pastCycles, nel ledger e nei log). Serve una conferma
 * esplicita e poi una nuova approvazione dell'anteprima: è una scelta intenzionale.
 */
export function startNewCycle(campaignId, { itemIds = null, types = null, confirm = false } = {}) {
  return withLock(async () => {
    if (!confirm) throw new Error("Serve la conferma esplicita per ripetere operazioni già eseguite.");
    const c = await getCampaign(campaignId);
    if (!c) throw new Error("Campagna non trovata");
    let items = await campaignItems(campaignId);
    const plan = Q.refreshPlan(items, { itemIds, types });
    if (!plan.repeat.length) return { ok: false, rejected: "Niente da ripetere: nessuna operazione conclusa negli annunci scelti.", plan };
    const n = nextCycleNumber(c, items);
    const id = n === (c.cycle?.n || 1) && c.cycle?.id ? c.cycle.id : `${c.id}-${n}-${Date.now().toString(36)}`;
    if (n !== (c.cycle?.n || 1)) {
      c.cycles = [...(c.cycles || []), { ...(c.cycle || { n: 1, id: `${c.id}-1` }), endedAt: Date.now() }];
      c.cycle = { n, id, startedAt: Date.now() };
    }
    const r = Q.applyRefresh(items, plan, { cycle: n, cycleId: id, spec: { ...c.opsDefaults } });
    items = await prepare(c, r.items);
    await saveItems(items.filter((i) => r.changed.includes(i.id)));
    const what = Object.entries(plan.repeat.reduce((m, x) => ({ ...m, [x.type]: (m[x.type] || 0) + 1 }), {})).map(([t, k]) => `${k} ${OP_LABEL[t].toLowerCase()}`).join(", ");
    histC(c, `ciclo ${n}`, `${plan.items} annunci: ${what}`);
    c.snapshot = null;                       // operazioni ripetute = nuova anteprima da approvare
    if (["completed", "stopped"].includes(c.status)) Object.assign(c, transitionCampaign(c, "ready"));
    if (c.status === "running") Object.assign(c, transitionCampaign(c, "paused"), { pauseReason: "snapshot", pauseDetail: `Nuovo ciclo ${n}: rivedi e approva l'anteprima, poi riprendi.`, nextAt: null });
    await saveCampaign(c, items);
    await log({ level: "info", category: "campaign", campaignId, message: `Ciclo ${n} di «${c.name}»: ${plan.repeat.length} operazioni da ripetere su ${plan.items} annunci (${what})` });
    await activity("campaign", `Nuovo ciclo ${n} per «${c.name}»: ${what}`, { campaignId });
    return { ok: true, cycle: n, repeated: plan.repeat.length, items: plan.items, excluded: plan.excluded.length };
  });
}

/**
 * Azzera lo storico (registro No Repeat) di alcune operazioni, scelto dall'utente: per annunci
 * (tutti se listingIds è null) e tipi. Mai le voci «in corso» o «da verificare»: un esito incerto
 * resta bloccato finché non lo risolvi. Nelle campagne aperte le operazioni saltate perché «già
 * fatte» tornano in attesa, così la coda le esegue.
 */
export function clearHistory({ listingIds = null, types = [], campaignId = null } = {}) {
  return withLock(async () => {
    const kinds = new Set((types || []).filter((t) => OP_TYPES.includes(t)));
    if (!kinds.size) throw new Error("Scegli almeno un tipo di operazione da azzerare.");
    let ids = listingIds ? new Set(listingIds.map(String)) : null;
    if (campaignId) {
      const own = (await campaignItems(campaignId)).filter((i) => !i.removed).map((i) => String(i.listingId));
      ids = new Set(ids ? own.filter((x) => ids.has(x)) : own);
    }
    let removed = 0;
    let kept = 0;
    for (const e of await db.getAll("ledger")) {
      if (!kinds.has(e.type) || (ids && !ids.has(String(e.listingId)))) continue;
      if (["running", "verify"].includes(e.status)) { kept++; continue; }
      await db.del("ledger", e.key);
      removed++;
    }
    let reset = 0;
    for (const c of await db.getAll("campaigns")) {
      // Campagne aperte; quella da cui si azzera anche se già completata (torna «pronta»).
      if (c.status === "stopped" || (c.status === "completed" && c.id !== campaignId)) continue;
      const items = await campaignItems(c.id);
      const r = Q.resetLedgerSkipped(items, { listingIds: ids, types: [...kinds] });
      if (!r.count) continue;
      reset += r.count;
      const next = await prepare(c, r.items);
      await saveItems(next);
      histC(c, "storico azzerato", `${r.count} operazioni di nuovo in attesa`);
      if (c.snapshot && ["running", "paused", "ready"].includes(c.status)) c.snapshot = makeSnapshot(next);
      if (c.status === "completed") Object.assign(c, transitionCampaign(c, "ready"), { completedAt: null, snapshot: null });
      await saveCampaign(c, next);
    }
    const what = [...kinds].map((t) => OP_LABEL[t].toLowerCase()).join(", ");
    await log({ level: "info", category: "campaign", message: `Storico azzerato (${what}): ${removed} voci tolte${kept ? `, ${kept} in corso o da verificare lasciate` : ""}; ${reset} operazioni di nuovo in attesa`, data: { listings: ids ? ids.size : "tutti", types: [...kinds] } });
    await activity("campaign", `Storico azzerato: ${removed} ${what}`, {});
    kick();
    return { removed, kept, reset };
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
    items = await prepare(c, items);
    await saveItems(items);
    histC(c, action, detail);
    if (c.snapshot && ["running", "paused", "ready"].includes(c.status)) c.snapshot = makeSnapshot(items);
    if (c.status === "completed" && Q.hasPending(items)) Object.assign(c, transitionCampaign(c, "ready"));
    await saveCampaign(c, items);
    if (c.status === "running") kick();
    return { ok: !rejected, rejected };
  });
}

/**
 * Le operazioni "completate" in simulazione non sono mai arrivate a Vinted:
 * passando alla modalità reale tornano in attesa (il ledger non le ha mai registrate).
 */
function resetSimulated(c, items) {
  let n = 0;
  const out = items.map((i) => {
    if (i.removed) return i;
    let touched = false;
    const ops = i.ops.map((o) => {
      if (o.status !== "completed" || !o.result?.simulated) return o;
      n++;
      touched = true;
      return { ...o, status: "waiting", result: null, startedAt: null, finishedAt: null, error: null, updatedAt: Date.now() };
    });
    return touched ? { ...i, ops, history: [...(i.history || []), { at: Date.now(), action: "pronto per la modalità reale" }].slice(-50) } : i;
  });
  if (["completed", "stopped"].includes(c.status) && n) Object.assign(c, transitionCampaign(c, "ready"), { completedAt: null, lastOp: null });
  return { items: out, count: n };
}

export function updateCampaign(id, patch) {
  return withLock(async () => {
    const c = await getCampaign(id);
    if (!c) throw new Error("Campagna non trovata");
    const allowed = ["name", "dryRun", "timers", "skipRules", "opsDefaults", "accountId", "origin", "likeExisting"];
    if (c.status === "running" && "dryRun" in patch && patch.dryRun !== c.dryRun) throw new Error("Metti in pausa la campagna prima di passare tra simulazione e modalità reale.");
    const goingLive = c.dryRun && patch.dryRun === false;
    const offerChanged = "opsDefaults" in patch && stableStringify(patch.opsDefaults?.offerCfg || null) !== stableStringify(c.opsDefaults?.offerCfg || null);
    const messageChanged = "opsDefaults" in patch && stableStringify(patch.opsDefaults?.message || null) !== stableStringify(c.opsDefaults?.message || null);
    for (const k of allowed) if (k in patch) c[k] = patch[k];
    histC(c, "impostazioni modificate", Object.keys(patch).join(", "));
    let items = await campaignItems(id);
    if (goingLive) {
      const r = resetSimulated(c, items);
      items = await prepare(c, r.items);
      await saveItems(items);
      histC(c, "passata in modalità reale", `${r.count} operazioni simulate rimesse in coda`);
    }
    if (offerChanged) {
      // Nuove regole: si ricalcolano le offerte in attesa e quelle rifiutate da Vinted per l'importo.
      let n = 0;
      items = items.map((i) => (i.removed ? i : {
        ...i,
        ops: i.ops.map((o) => {
          if (o.type !== "offer") return o;
          const rejected = o.status === "failed" && o.retryable === false;
          if (!OP_PENDING.has(o.status) && !rejected) return o;
          n++;
          return { ...o, status: "waiting", amount: null, offerCfg: null, offerPreview: null, error: null, retryable: undefined, updatedAt: Date.now() };
        }),
      }));
      items = await prepare(c, items);
      await saveItems(items);
      if (n && ["completed", "stopped"].includes(c.status)) Object.assign(c, transitionCampaign(c, "ready"), { completedAt: null });
      histC(c, "regole offerte cambiate", `${n} offerte ricalcolate`);
    }
    if (messageChanged) {
      items = await prepare(c, items);
      await saveItems(items);
      histC(c, "messaggi cambiati", "testo o modalità da riapprovare");
    }
    if ("dryRun" in patch || "accountId" in patch || offerChanged || messageChanged) c.snapshot = null;     // cambia il significato: va riapprovata
    await saveCampaign(c, items);
    return c;
  });
}

/** Dopo una simulazione: stessa campagna, stesse operazioni, ora davvero su Vinted (da riapprovare). */
export function goLive(id) {
  return updateCampaign(id, { dryRun: false });
}

/**
 * Elimina più campagne, anche in corso: prima le ferma e aspetta che l'operazione
 * in invio finisca (mai interrompere a metà una scrittura su Vinted). Il ledger resta.
 */
export async function deleteCampaigns(ids) {
  const out = { deleted: 0, failed: [] };
  for (const id of ids) {
    try {
      const c = await getCampaign(id);
      if (!c) continue;
      if (["running", "paused", "ready", "draft"].includes(c.status)) await stop(id);
      for (let i = 0; i < 120; i++) {
        const cur = await getCampaign(id);
        const items = await campaignItems(id);
        if (!cur?.current && !items.some((it) => it.ops.some((o) => o.status === "running"))) break;
        await sleep(500);
      }
      await withLock(async () => {
        for (const i of await campaignItems(id)) await db.del("items", i.id);
        await db.del("campaigns", id);
      });
      broadcast("vt:campaign", { deleted: id });
      out.deleted++;
    } catch (e) {
      out.failed.push({ id, error: e.message });
    }
  }
  if (out.deleted) await activity("campaign", `${out.deleted} campagne eliminate`);
  return out;
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
  const items = await prepare(c, await campaignItems(id));
  await saveItems(items);
  const v = validateCampaign(await policyContext(c, items));
  return { campaign: c, items: Q.executionOrder(items), validation: v, snapshotDiff: diffSnapshot(c.snapshot, items) };
}

/** L'utente approva l'anteprima: fotografia delle operazioni e degli importi. */
export function approve(id) {
  return withLock(async () => {
    const c = await getCampaign(id);
    const items = await prepare(c, await campaignItems(id));
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
    // Riprendere = nuova possibilità per tutti i tipi: via sospensioni, contatori e attese dei nuovi tentativi.
    Object.assign(c, transitionCampaign(c, "running"), { startedAt: c.startedAt || Date.now(), pauseReason: null, pauseDetail: null, autoPaused: false, resumeAt: null, consecutiveFailures: 0, typeFailures: {}, suspended: {}, nextAt: Date.now() });
    const retry = items.filter((i) => i.ops.some((o) => o.retryAfter && OP_PENDING.has(o.status)));
    if (retry.length) await saveItems(retry.map((i) => ({ ...i, ops: i.ops.map((o) => (OP_PENDING.has(o.status) ? { ...o, retryAfter: null } : o)) })));
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
  const titles = { manual: "In pausa: invio manuale non arrivato", user: "In pausa", offline: "In pausa: connessione assente", blocked: "In pausa: Vinted ha limitato le richieste", captcha: "In pausa: verifica richiesta da Vinted", auth: "In pausa: sessione da verificare", limit: "In pausa: soglia raggiunta", errors: "In pausa: troppi errori di fila", snapshot: "In pausa: serve una nuova approvazione", confirm: "Conferma richiesta", kill: "Fermata dal Kill Switch", tabClosed: "In pausa: scheda di lavoro chiusa", module: "In pausa: modulo non disponibile" };
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
    status, campaignId, opId: op.id, amount: op.amount ?? null, simulated: false, title: item.listing?.title || "",
    cycle: op.cycle || 1, cycleKey: cycleKey(campaignId, op.cycleId || op.cycle), ...extra,
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
    return updateOpNoLock(itemId, opId, { status: "running", startedAt: Date.now(), retryAfter: null, ...extra });
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
    const blocked = await blockedTypes(c);
    const next = Q.nextOp(items, { blocked: new Set(blocked.keys()) });
    if (!next) {
      if (items.some((i) => i.ops.some((o) => o.status === "running"))) { schedule(Date.now() + 5000); return; }
      if (!Q.hasPending(items)) { await completeCampaign(c); kick(); return; }
      await waitOrPause(c, items, blocked);
      return;
    }
    await runOp(c, next.item, next.op, settings);
    const fresh = await getCampaign(c.id);
    if (fresh?.status === "running") {
      const freshItems = await campaignItems(c.id);
      const after = Q.nextOp(freshItems, { blocked: new Set((await blockedTypes(fresh)).keys()) });
      if (!after) { if (!Q.hasPending(freshItems)) await completeCampaign(fresh); }
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

/**
 * Tipi che in questa campagna non si eseguono adesso, con il motivo: sospesi dopo errori di fila
 * (solo quel tipo: gli altri continuano) o modulo non disponibile (circuit breaker, kill switch).
 */
async function blockedTypes(c) {
  const out = new Map();
  for (const [t, v] of Object.entries(c.suspended || {})) out.set(t, `sospesi in questa campagna: ${v.reason}`);
  for (const t of OP_TYPES) {
    if (out.has(t)) continue;
    const a = await health.moduleAvailable(t);
    if (!a.ok) out.set(t, a.reason);
  }
  return out;
}

/** Niente da eseguire adesso: si aspetta il prossimo nuovo tentativo, oppure restano solo tipi bloccati → pausa. */
async function waitOrPause(c, items, blocked) {
  const w = Q.waitingState(items, { blocked: new Set(blocked.keys()) });
  if (w.retryAt) {
    const at = new Date(w.retryAt).toLocaleTimeString("it-IT", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
    const updated = await patchCampaign(c.id, (x) => {
      if (x.status !== "running") return;
      x.nextAt = w.retryAt;
      x.nextLabel = `Nuovo tentativo alle ${at}`;
      x.nextOp = null;
    });
    if (updated?.status === "running") broadcast("vt:timer", { campaignId: c.id, nextAt: updated.nextAt, label: updated.nextLabel });
    schedule(w.retryAt);
    return;
  }
  const why = w.blockedTypes.map((t) => `${OP_LABEL[t]}: ${blocked.get(t)}`).join(" · ");
  const onlyModules = w.blockedTypes.every((t) => !c.suspended?.[t]);
  const manual = w.blockedTypes.length && w.blockedTypes.every((t) => c.suspended?.[t]?.kind === "manual");
  await pause(c.id, manual ? "manual" : onlyModules ? "module" : "errors", `Restano solo operazioni bloccate. ${why}. Le altre sono state eseguite. Premi Riprendi per riprovare.`);
}

async function completeCampaign(c) {
  return withLock(async () => {
    const cur = await getCampaign(c.id);
    if (cur.status !== "running") return;
    const items = await campaignItems(c.id);
    if (Q.hasPending(items) || items.some((i) => i.ops.some((o) => o.status === "running"))) return;   // aggiunti nel frattempo
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
  await journal({ phase: "result", opId: op.id, itemId: item.id, campaignId: c.id, accountId: c.accountId, listingId: item.listingId, type: op.type, status: data.statsStatus || status, simulated: Boolean(c.dryRun), durationMs: Date.now() - t0, amount: op.amount ?? null, cycle: op.cycle || 1 });
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
  // Modulo non disponibile: il tick non sceglie le sue operazioni (vedi blockedTypes); qui solo per sicurezza.
  const avail = await health.moduleAvailable(op.type);
  if (!avail.ok) return null;

  {
    // No Repeat: blocca i duplicati accidentali; lascia passare solo un nuovo ciclo scelto dall'utente.
    const entry = await db.get("ledger", ledgerKey(c.accountId, item.listingId, op.type));
    const decision = canInteract(entry, { cycleKey: cycleKey(c.id, op.cycleId || op.cycle), newCycle: Boolean(op.newCycle) });
    if (!decision.allowed && !c.dryRun) {
      return finishOp(c, item, op, "skipped", { reason: `No Repeat: ${decision.reason}`, result: { ledger: decision.code } });
    }
  }
  // Messaggi: destinatario autorizzato e testo approvato, anche in simulazione.
  if (op.type === "message") {
    const who = recipientCheck(settings, item.listing?.sellerId, c.accountId?.split("@")[0]);
    if (!who.ok) return finishOp(c, item, op, "skipped", { reason: who.reason, result: { recipient: who.code } });
    if (!op.text) return finishOp(c, item, op, "failed", { error: op.msgError || "Testo del messaggio mancante: apri l'anteprima", retryable: true });
  }
  if (op.requireConfirm && !op.confirmedAt) {
    await patchCampaign(c.id, (cur) => { cur.pendingConfirm = { itemId: item.id, opId: op.id, type: op.type, title, amount: op.amount ?? null }; });
    await pauseNoLockSafe(c.id, "confirm", `${label} su «${title}»${op.amount ? ` · ${op.amount} €` : ""}: premi Conferma per procedere.`);
    return;
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
    const wantPath = settings.openListingBeforeOp || op.type === "message" ? `/items/${item.listingId}` : null;
    const ready = tabs.waitReady(tabId, 45_000, (pg) => !wantPath || String(pg?.path || "").startsWith(wantPath));
    if (wantPath) await tabs.navigate(tabId, url);
    else await chrome.tabs.reload(tabId);
    const page = await ready;
    if (page?.challenge) return notSent(c, item, op, "captcha", "Vinted chiede una verifica (CAPTCHA o conferma)", tabId);
    if (page && page.loggedIn === false) return notSent(c, item, op, "auth", "Sessione Vinted non attiva nella scheda di lavoro", tabId);
  } catch (e) {
    return notSent(c, item, op, "error", e.message);
  }

  if (op.type === "message") return runMessage(c, item, op, settings, tabId);

  // 8. Punto di non ritorno: da qui in poi un esito mancante = DA VERIFICARE.
  await journal({ phase: "sending", opId: op.id, itemId: item.id, campaignId: c.id, type: op.type, listingId: item.listingId });
  let res;
  try {
    res = await tabs.sendToTab(tabId, {
      type: "vt:exec",
      op: { type: op.type, amount: op.amount ?? null, relike: op.type === "like" && (c.likeExisting || settings.campaignDefaults?.likeExisting || "relike") === "relike" },
      listing: { id: item.listingId, sellerId: item.listing.sellerId, price: item.listing.price, currency: item.listing.currency, url: item.listing.url },
      expectedUserId: c.accountId?.split("@")[0],
      snapshotPrice: item.listing.price,
    }, 90_000);
  } catch (e) {
    if (e.notSent) return notSent(c, item, op, "error", e.message);
    res = { outcome: "uncertain", sent: true, message: e.message };
  }
  return applyOutcome(c, item, op, res || { outcome: "uncertain", message: "Risposta vuota" }, tabId);
}

const pauseNoLockSafe = (id, reason, detail, opts) => pause(id, reason, detail, opts);

// ------------------------------------------------------------------ messaggio privato

const msgListing = (item) => ({ id: item.listingId, sellerId: item.listing.sellerId, url: item.listing.url });

/** Schede aperte da una scheda: Vinted potrebbe aprire la chat in una scheda nuova. */
function watchOpenedTabs(openerId) {
  const found = [];
  const fn = (tab) => { if (tab?.openerTabId === openerId) found.push(tab.id); };
  chrome.tabs?.onCreated?.addListener(fn);
  return { list: () => found.slice(), stop: () => chrome.tabs?.onCreated?.removeListener(fn) };
}

/** Indirizzo (senza query) e stato di caricamento di una scheda, per decidere e per la diagnostica. */
async function tabInfo(tabId) {
  try {
    const t = await chrome.tabs.get(tabId);
    return { url: String(t.url || t.pendingUrl || "").split("?")[0], status: t.status, active: t.active };
  } catch {
    return { url: null, status: "closed", active: false };
  }
}


/**
 * Lettura (mai un clic) nel contesto della pagina: «Chiedi info» ha già il suo gestore di clic?
 * I content script vivono in un mondo isolato e non vedono le proprietà che React mette sugli
 * elementi; per questo si guarda con chrome.scripting nel mondo della pagina. Funzione autonoma
 * (viene serializzata). Il clic resta nel content script, con VTGuard.safeClick.
 */
function probeAskButton() {
  const b = document.querySelector('button[data-testid="ask-seller-button"]')
    || [...document.querySelectorAll("span.web_ui__Button__label")].find((s) => s.textContent.trim() === "Chiedi info")?.closest("button");
  const out = { button: Boolean(b), readyState: document.readyState, visible: document.visibilityState === "visible", react: false, hydrated: false };
  // App Next.js/React (come vinted.it): i pulsanti diventano cliccabili solo dopo l'idratazione.
  out.react = Boolean(document.querySelector('script[src*="/_next/"]')) || typeof self.__next_f === "object";
  if (!b) return out;
  let el = b;
  for (let i = 0; el && i < 12; i++, el = el.parentElement) {
    if (Object.keys(el).some((k) => k.startsWith("__react"))) { out.react = true; break; }
  }
  const key = Object.keys(b).find((k) => k.startsWith("__reactProps$"));
  out.hydrated = Boolean(key && typeof b[key]?.onClick === "function");
  return out;
}

/**
 * Aspetta che «Chiedi info» sia cliccabile (React ha finito di «idratare» la pagina).
 * Pagina senza React (o React non riconoscibile) dopo 4 s dal caricamento completo: si prosegue,
 * e se il clic non ha effetto waitChat lo ripete. Al massimo timeoutMs.
 */
async function waitClickable(tabId, { timeoutMs = 20_000, noReactGraceMs = 4_000 } = {}) {
  const t0 = Date.now();
  if (!chrome.scripting?.executeScript) { await sleep(3000); return { hydrated: null, waitedMs: Date.now() - t0, probe: "none" }; }
  let last = null;
  let completeAt = null;
  while (Date.now() - t0 < timeoutMs) {
    try {
      const [res] = await chrome.scripting.executeScript({ target: { tabId }, world: "MAIN", func: probeAskButton });
      last = res?.result || null;
    } catch {
      last = null;
    }
    if (last?.hydrated) { await sleep(300); return { ...last, waitedMs: Date.now() - t0 }; }
    if (last?.readyState === "complete") completeAt ??= Date.now();
    // Nessun segno di React sul pulsante: non c'è niente da aspettare (o non si sa riconoscerlo).
    if (last?.button && !last.react && completeAt && Date.now() - completeAt >= noReactGraceMs) break;
    // Nessun pulsante a pagina completa: lo dirà msgOpen (struttura cambiata / non disponibile).
    if (last && !last.button && completeAt && Date.now() - completeAt >= noReactGraceMs) break;
    await sleep(250);
  }
  return { ...(last || {}), hydrated: last?.hydrated ?? null, waitedMs: Date.now() - t0 };
}

/**
 * Aspetta la chat guardando lo stato reale, non un'attesa fissa: indirizzo della scheda (o di una
 * scheda nuova aperta dal clic), caricamento, presenza di Vintastic sulla pagina (se manca su una
 * pagina caricata viene reinserito), campo #composerInput. Il tempo massimo riparte quando
 * l'indirizzo cambia (navigazione in corso).
 */
async function waitChat(tabId, watcher, { quietMs = 25_000, maxMs = 60_000, reclick = null, clickable = null, focus = null, reclickAfterMs = 5_000, maxClicks = 3 } = {}) {
  const t0 = Date.now();
  const d = {
    polls: 0, noContent: 0, reinjected: false, newTab: false, url: null, status: null, visible: null, askButton: null, textareas: null, composer: false,
    clicks: 1, clickable: clickable ? { hydrated: clickable.hydrated ?? null, waitedMs: clickable.waitedMs ?? null } : null,
    focusAsked: focus?.asked ?? null, focusOk: focus?.ok ?? null,
  };
  let lastClick = Date.now();
  let target = tabId;
  let prevUrl = null;
  let lastChange = Date.now();
  while (Date.now() - t0 < maxMs && Date.now() - lastChange < quietMs) {
    const opened = watcher.list().filter((id) => id !== tabId);
    if (opened.length && target === tabId) {
      target = opened[opened.length - 1];
      d.newTab = true;
      await tabs.claim(target, "chat", null).catch(() => {});
    }
    const info = await tabInfo(target);
    Object.assign(d, { url: info.url, status: info.status });
    if (info.url !== prevUrl || info.status === "loading") { prevUrl = info.url; lastChange = Date.now(); }
    d.polls++;
    let r = null;
    try {
      r = await tabs.sendToTab(target, { type: "vt:msgComposer" }, 4000);
    } catch (e) {
      if (e.notSent) {
        d.noContent++;
        if (info.status === "complete" && d.noContent >= 4 && !d.reinjected) d.reinjected = await tabs.reinject(target);
      }
    }
    if (r) Object.assign(d, { visible: r.visible ?? d.visible, askButton: r.askButton ?? d.askButton, textareas: r.textareas ?? d.textareas, composer: Boolean(r.ready) });
    if (r?.challenge) return { challenge: true, tabId: target, diag: d };
    if (r?.ready) return { ready: true, tabId: target, diag: { ...d, waitedMs: Date.now() - t0 } };
    if (r?.loggedIn === false && !String(info.url || "").includes("/items/")) return { loggedIn: false, tabId: target, diag: d };
    // Ancora sull'annuncio con il pulsante presente, nessuna scheda nuova: il clic non ha avuto effetto. Si riprova.
    const stuck = target === tabId && /\/items\/\d+/.test(String(info.url || "")) && info.status === "complete" && r?.askButton;
    if (stuck && reclick && d.clicks < maxClicks && Date.now() - lastClick >= reclickAfterMs) {
      d.clicks++;
      lastClick = Date.now();
      lastChange = Date.now();          // un nuovo clic dà di nuovo tutto il tempo alla chat
      const again = await reclick();
      if (again && again.outcome && again.outcome !== "opened") d.reclickOutcome = again.outcome;
    }
    await sleep(400);
  }
  return { ready: false, tabId: target, diag: { ...d, waitedMs: Date.now() - t0 } };
}

/** Controlla ogni secondo se il nuovo messaggio è comparso nella conversazione. */
async function waitSent(tabId, timeoutMs) {
  const end = Date.now() + timeoutMs;
  let last = { state: "unknown" };
  while (Date.now() < end) {
    const r = await tabs.sendToTab(tabId, { type: "vt:msgStatus" }, 4000).catch(() => null);
    if (r) last = r;
    if (r?.state === "sent" || r?.state === "challenge") return r;
    await sleep(1000);
  }
  return { ...last, timedOut: true };
}

/** Dopo l'invio: la scheda di lavoro torna sull'annuncio. */
async function returnToListing(tabId, c, item) {
  try {
    const url = item.listing.url || `${c.origin}/items/${item.listingId}`;
    const re = new RegExp(`^/items/${item.listingId}(?:$|[-/])`);
    const ready = tabs.waitReady(tabId, 25_000, (pg) => re.test(String(pg?.path || "")));
    await tabs.navigate(tabId, url);
    const pg = await ready;
    return !pg?.challenge;
  } catch {
    return false;
  }
}

/**
 * Messaggio privato reale. La scheda è già sull'annuncio.
 * 1. «Chiedi info» (nessun messaggio inviato: si apre solo la chat).
 * 2. Campo #composerInput pronto.
 * 3. Punto di non ritorno (journal "sending"), compilazione e, in modalità A, clic su Invia.
 * 4. Conferma solo con un messaggio nuovo nella conversazione; altrimenti DA VERIFICARE.
 * 5. Ritorno all'annuncio.
 */
async function runMessage(c, item, op, settings, tabId) {
  const ms = settings.messages || {};
  const mode = op.mode === "manual" ? "manual" : "auto";
  const allowed = cleanRecipients(ms.recipients).map((r) => r.id);
  const title = item.listing?.title?.slice(0, 50) || item.listingId;
  // In una scheda in background la chat di Vinted può non disegnarsi: per i messaggi la scheda va in primo piano.
  const focused = ms.focusTab !== false || mode === "manual" ? await tabs.focus(tabId) : null;
  const watcher = watchOpenedTabs(tabId);
  let chatTab = tabId;
  try {
    // Vinted disegna «Chiedi info» prima che i suoi script lo rendano cliccabile (verificato il 08/11/2026:
    // pulsante a ~1,3 s, cliccabile a ~2,6–2,9 s). Un clic prima di allora non fa niente.
    const clickable = await waitClickable(tabId);
    const openMsg = { type: "vt:msgOpen", listing: msgListing(item), allowed, self: c.accountId?.split("@")[0] || null };
    let open;
    try {
      open = await tabs.sendToTab(tabId, openMsg, 30_000);
    } catch (e) {
      if (e.notSent) return notSent(c, item, op, "error", e.message);
      open = { outcome: "opened" };     // la pagina è cambiata subito dopo il clic: la chat si sta aprendo
    }
    if (open?.outcome !== "opened") return applyOutcome(c, item, op, { ...open, sent: false }, tabId);

    // Se il clic non ha effetto si riprova (aprire la chat non invia niente): al massimo 3 clic in tutto.
    const reclick = () => tabs.sendToTab(tabId, openMsg, 15_000).catch(() => null);
    const chat = await waitChat(tabId, watcher, { reclick, clickable, focus: { asked: focused !== null, ok: focused } });
    chatTab = chat.tabId;
    if (chat.challenge) return notSent(c, item, op, "captcha", "Vinted chiede una verifica per aprire la chat", chatTab);
    if (chat.loggedIn === false) return notSent(c, item, op, "auth", "Sessione Vinted non attiva nella chat", chatTab);
    if (!chat.ready) return notSent(c, item, op, "error", `La chat non si è aperta: ${chatDiagnosis(chat.diag)}`, null, chat.diag);
    if (chat.diag.newTab) await log({ level: "info", category: "op", campaignId: c.id, listingId: item.listingId, opType: op.type, message: "La chat si è aperta in una scheda nuova: Vintastic la usa e poi la chiude" });

    // Punto di non ritorno: da qui un esito mancante = DA VERIFICARE, mai ripetuto da solo.
    await journal({ phase: "sending", opId: op.id, itemId: item.id, campaignId: c.id, type: op.type, listingId: item.listingId, cycle: op.cycle || 1 });
    if (mode === "manual") {
      await tabs.focus(chatTab);
      await patchCampaign(c.id, (cur) => { if (cur.current) cur.current.awaitingUser = true; });
      await notify({ category: "info", level: "info", title: "Premi Invia su Vinted", body: `Il messaggio per «${title}» è pronto nella chat. Controllalo e premi Invia.`, link: `#campaigns/${c.id}`, campaignId: c.id, groupKey: `manual-${c.id}` });
    }
    let fill;
    try {
      fill = await tabs.sendToTab(chatTab, { type: "vt:msgFill", text: op.text, mode }, 20_000);
    } catch (e) {
      if (e.notSent) return notSent(c, item, op, "error", e.message);
      fill = { outcome: "uncertain", sent: true, message: `Pagina della chat persa durante la compilazione: ${e.message}` };
    }
    if (fill?.outcome !== "filled") return applyOutcome(c, item, op, fill || { outcome: "uncertain", sent: true, message: "Nessuna risposta dalla chat" }, chatTab);

    const waitS = mode === "manual" ? Math.max(5, Math.min(240, Number(ms.manualWaitSeconds) || MANUAL_WAIT_DEFAULT)) : 45;
    const st = await waitSent(chatTab, waitS * 1000);
    if (st.state === "challenge") {
      if (st.attempted || mode === "auto") return applyOutcome(c, item, op, { outcome: "uncertain", sent: true, message: "Verifica di Vinted comparsa durante l'invio: controlla la chat prima di riprovare" }, chatTab);
      return notSent(c, item, op, "captcha", "Vinted chiede una verifica nella chat (messaggio non inviato)", chatTab);
    }
    if (st.state !== "sent") {
      if (mode === "manual" && !st.attempted && st.state === "pending" && !st.cleared) {
        // Il testo è ancora nel campo e nessuno ha premuto Invia: certamente non inviato.
        // Si fermano solo i messaggi di questa campagna; like e offerte continuano.
        await finishOp(c, item, op, "failed", { error: `Invio manuale non arrivato entro ${waitS} secondi: il testo è rimasto nel campo, niente è stato inviato`, retryable: true });
        await setLedger(c.accountId, item, op, "failed", c.id, { result: "manualTimeout" });
        return suspendType(c, "message", `nessun invio manuale entro ${waitS} secondi per «${title}»`, "manual");
      }
      const why = st.state === "unknown" ? "la pagina della chat è cambiata prima della conferma"
        : st.cleared ? "il campo si è svuotato ma il messaggio non compare nella conversazione"
          : "nessun messaggio nuovo nella conversazione";
      return applyOutcome(c, item, op, { outcome: "uncertain", sent: true, message: `Invio non confermato: ${why}. Controlla la chat prima di riprovare` }, chatTab);
    }

    await applyOutcome(c, item, op, { outcome: "done", sent: true, message: `Messaggio inviato e verificato (${mode === "manual" ? "B, inviato da te" : "A, automatico"})` }, chatTab);
    if (chatTab !== tabId) {
      await tabs.closeOwned(chatTab);      // la scheda di lavoro è rimasta sull'annuncio
      chatTab = tabId;
    } else if (!(await returnToListing(tabId, c, item))) {
      await log({ level: "warn", category: "op", campaignId: c.id, listingId: item.listingId, opType: op.type, message: "Messaggio inviato e verificato, ma il ritorno all'annuncio non è confermato: la prossima operazione riapre la pagina giusta" });
    }
    return null;
  } finally {
    watcher.stop();
  }
}

/** Sospende un tipo di operazione in questa campagna (gli altri tipi continuano). */
async function suspendType(c, type, reason, kind = "errors") {
  const cur = await patchCampaign(c.id, (x) => {
    x.suspended = { ...(x.suspended || {}), [type]: { at: Date.now(), reason, kind } };
    histC(x, "tipo sospeso", `${OP_LABEL[type]}: ${reason}`);
  });
  await notify({ category: "campaignPaused", level: "warning", title: `${OP_LABEL[type]}: sospesi in «${cur?.name || ""}»`, body: `${reason[0].toUpperCase()}${reason.slice(1)}. Le altre operazioni continuano. Premi Riprendi per riprovare.`, link: `#campaigns/${c.id}`, campaignId: c.id, persistent: true, groupKey: `suspend-${c.id}-${type}` });
  return null;
}

function setCurrent(campaignId, item, op) {
  return patchCampaign(campaignId, (c) => {
    c.current = { itemId: item.id, opId: op.id, type: op.type, title: item.listing?.title, listingId: item.listingId, startedAt: Date.now() };
  });
}

/** Niente è stato inviato: l'operazione torna in attesa. */
/**
 * L'operazione NON è partita (niente è arrivato a Vinted).
 * - CAPTCHA, 403/429, sessione: riguardano tutto → pausa come prima.
 * - Errore della singola operazione (pagina, chat, scheda): si riprova più tardi (retryAfter),
 *   intanto la campagna esegue le altre. Dopo opRetry.attempts tentativi diventa «fallita»
 *   (ripetibile con «Ripeti falliti»). Conta per il suo tipo: 3 di fila sospendono solo quel tipo.
 */
async function notSent(c, item, op, kind, message, tabId = null, diag = null) {
  const s = await getSettings();
  const prev = await db.get("ledger", ledgerKey(c.accountId, item.listingId, op.type));
  // Torna allo stato di prima del tentativo (mai "running": bloccherebbe per sempre l'annuncio).
  if (prev?.status === "running") await db.put("ledger", { ...prev, status: [...(prev.history || [])].reverse().find((h) => h.status && h.status !== "running")?.status || "failed" });
  const local = kind === "error";
  const attempts = (await db.get("items", item.id))?.ops.find((o) => o.id === op.id)?.attempts || (op.attempts || 0) + 1;
  const maxAttempts = Math.max(1, s.opRetry?.attempts || 3);
  if (local && attempts >= maxAttempts) {
    await finishOp(c, item, op, "failed", { error: `Non partita dopo ${attempts} tentativi. Ultimo: ${message}`, retryable: true, result: diag ? { diag } : null });
  } else {
    const delays = s.opRetry?.delaysSec || [60, 300];
    const retryAfter = local ? Date.now() + 1000 * (delays[Math.min(attempts - 1, delays.length - 1)] || 60) : null;
    await updateOp(c.id, item.id, op.id, { status: "waiting", error: message, startedAt: null, retryAfter, diag: diag || null });
    await journal({ phase: "result", opId: op.id, itemId: item.id, campaignId: c.id, type: op.type, status: "notSent", note: message, cycle: op.cycle || 1 });
    await patchCampaign(c.id, (x) => { x.current = null; });
  }
  const cur = await getCampaign(c.id);
  if (kind === "captcha" || kind === "blocked") return platformBlock(cur, kind, message, tabId);
  if (kind === "auth") return startAuthFlow(cur, message, tabId);
  await log({ level: "warn", category: "op", campaignId: c.id, listingId: item.listingId, opType: op.type, message: `Non partita (tentativo ${attempts}/${maxAttempts}): ${message}`, code: /scheda di lavoro (non|chiusa)|nessuna scheda/i.test(message) ? "noTab" : null, data: diag ? { diag } : undefined });
  return countFailure(c, op.type, message);
}

/** Successo: azzera i contatori di errori (del tipo e della campagna). */
async function countSuccess(c, type) {
  await patchCampaign(c.id, (x) => {
    x.consecutiveFailures = 0;
    if (x.typeFailures?.[type]) x.typeFailures = { ...x.typeFailures, [type]: 0 };
  });
}

/**
 * Errore di un'operazione: conta per il suo tipo e per la campagna.
 * maxConsecutiveFailures di fila dello stesso tipo → solo quel tipo viene sospeso in questa campagna
 * (like e offerte non si fermano per un problema dei messaggi). maxConsecutiveFailuresAll di fila
 * di qualsiasi tipo → problema generale: pausa dell'intera campagna.
 */
async function countFailure(c, type, message) {
  const s = await getSettings();
  const per = Math.max(1, s.maxConsecutiveFailures || 3);
  const all = Math.max(per, s.maxConsecutiveFailuresAll || 6);
  const before = await getCampaign(c.id);
  const cur = await patchCampaign(c.id, (x) => {
    x.consecutiveFailures = (x.consecutiveFailures || 0) + 1;
    const n = ((x.typeFailures || {})[type] || 0) + 1;
    x.typeFailures = { ...(x.typeFailures || {}), [type]: n };
    if (n >= per && !x.suspended?.[type]) {
      x.suspended = { ...(x.suspended || {}), [type]: { at: Date.now(), reason: `${n} errori di fila. Ultimo: ${String(message).slice(0, 200)}` } };
      histC(x, "tipo sospeso", `${OP_LABEL[type]}: ${n} errori di fila`);
    }
  });
  if (!cur) return null;
  if (!before?.suspended?.[type] && cur.suspended?.[type]) {
    const others = (cur.opsDefaults?.types || []).filter((t) => t !== type).map((t) => OP_LABEL[t].toLowerCase());
    await log({ level: "warn", category: "op", campaignId: c.id, opType: type, message: `${OP_LABEL[type]} sospesi in «${cur.name}»: ${cur.suspended[type].reason}` });
    await notify({ category: "campaignPaused", level: "warning", title: `${OP_LABEL[type]}: sospesi in «${cur.name}»`, body: `${cur.suspended[type].reason}.${others.length ? ` La campagna continua con ${others.join(" e ")}.` : ""} Premi Riprendi per riprovare.`, link: `#campaigns/${c.id}`, campaignId: c.id, persistent: true, groupKey: `suspend-${c.id}-${type}` });
  }
  if (cur.status === "running" && cur.consecutiveFailures >= all) {
    return pause(c.id, "errors", `${cur.consecutiveFailures} problemi di fila, di tipi diversi: probabile problema generale (Vinted o connessione). Ultimo: ${message}`);
  }
  return null;
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
      await countSuccess(c, op.type);
      const verb = res.outcome === "already" ? "già presente" : res.relaid ? "tolto e rimesso" : op.type === "offer" ? "inviata" : op.type === "message" ? "inviato" : "completato";
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
      if (res.sent) return markVerify(c, item, op, res.message || "Esito incerto dopo una verifica Vinted");
      return notSent(c, item, op, res.outcome === "captcha" ? "captcha" : "blocked", res.message || "Vinted ha rifiutato la richiesta", tabId);
    case "auth":
      return notSent(c, item, op, "auth", res.message || "Sessione non valida", tabId);
    case "unsupported":
    case "changed": {
      await health.recordFailure(op.type, res.message || "Funzione non riconosciuta sulla pagina", { hard: true });
      if (res.sent) return markVerify(c, item, op, res.message);
      await setLedger(c.accountId, item, op, "failed", c.id);
      await finishOp(c, item, op, "failed", { error: `${res.message}. Modulo ${label} isolato: gli altri tipi continuano.`, retryable: true });
      // Il circuit breaker isola il modulo: il tick salta le sue operazioni e la campagna prosegue con gli altri tipi.
      await log({ level: "error", category: "op", campaignId: c.id, listingId: item.listingId, opType: op.type, message: `${label}: ${res.message}. Modulo isolato.` });
      return null;
    }
    case "failed": {
      await setLedger(c.accountId, item, op, "failed", c.id, { result: res.message });
      // Un importo rifiutato (400/422) è un «no» a quell'offerta, non un guasto del modulo.
      if (res.retryable !== false) await health.recordFailure(op.type, res.message || "errore");
      await log({ level: "error", category: "op", campaignId: c.id, listingId: item.listingId, opType: op.type, opId: op.id, message: `${label} fallito: ${res.message}`, data: { status: res.status } });
      await finishOp(c, item, op, "failed", { error: res.message, retryable: res.retryable !== false, result: res.diag ? { diag: res.diag } : null });
      // Un «no» di Vinted a quell'operazione (importo rifiutato, chat non disponibile) non è un guasto.
      if (res.retryable !== false) return countFailure(c, op.type, res.message);
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
  await finishOp(c, item, op, "verify", { error: message });
  return countFailure(c, op.type, `esito da verificare: ${message}`);
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
  if (op.type === "message") return { supported: false, message: "Per i messaggi la verifica è manuale: apri la chat con il venditore su Vinted e controlla se il messaggio c'è." };
  if (op.type !== "like") return { supported: false, message: "Per le offerte la verifica è manuale: apri la chat dell'annuncio su Vinted e controlla se l'offerta c'è." };
  const { tabId } = await tabs.ensureAt(c.origin, item.listing.url || `${c.origin}/items/${item.listingId}`);
  const r = await tabs.sendToTab(tabId, { type: "vt:verifyLike", listing: { id: item.listingId, sellerId: item.listing.sellerId } }, 30_000);
  if (r?.liked === true || r?.liked === false) {
    await mutateQueue(campaignId, "resolveVerify", { id: itemId, opId, done: r.liked });
    return { supported: true, resolved: true, done: r.liked };
  }
  return { supported: true, resolved: false, message: r?.message || "Stato del like non leggibile" };
}
