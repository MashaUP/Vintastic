/**
 * Coda dinamica di una campagna — operazioni pure.
 *
 * Ogni funzione riceve gli elementi e restituisce { items, changed, rejected }
 * senza toccare l'originale. Gli elementi e le operazioni completati non si
 * modificano mai; quelli in esecuzione nemmeno. Tutto il resto si può cambiare
 * anche a campagna avviata.
 */

import { uid } from "./util.js";
import { OP_TYPES } from "./constants.js";
import { OP_PENDING, itemStatus } from "./states.js";

const now = () => Date.now();
const hist = (item, action, detail = "") => ({ ...item, history: [...(item.history || []), { at: now(), action, detail }].slice(-50) });

export function makeOp(type, spec = {}) {
  return {
    id: uid("op_"),
    type,
    status: "waiting",
    attempts: 0,
    amount: type === "offer" ? (spec.amount ?? null) : undefined,
    offerCfg: type === "offer" ? (spec.offerCfg || null) : undefined,
    // Messaggio: testo e modalità si calcolano nell'anteprima (engine.fillMessages).
    text: type === "message" ? null : undefined,
    mode: type === "message" ? null : undefined,
    requireConfirm: Boolean(spec.requireConfirm?.[type]),
    cycle: spec.cycle || 1,                 // ciclo di esecuzione (vedi refreshPlan)
    cycleId: spec.cycleId || null,
    createdAt: now(),
  };
}

/** Riduce un annuncio ai dati che servono alla coda (fotografia al momento dell'aggiunta). */
export function listingRef(l) {
  return {
    id: String(l.id), title: l.title || "", price: l.price ?? null, currency: l.currency || "EUR",
    url: l.url || null, photo: l.photo || null, sellerId: l.sellerId ? String(l.sellerId) : null,
    sellerLogin: l.sellerLogin || null, origin: l.origin || null, publishedAt: l.publishedAt ?? null,
    brand: l.brand || null, size: l.size || null,
    status: l.status || "active",
  };
}

export function buildItem(listing, spec, campaignId, position = 0) {
  const types = (spec.order || OP_TYPES).filter((t) => (spec.types || []).includes(t));
  return {
    id: uid("it_"),
    campaignId,
    listingId: String(listing.id),
    listing: listingRef(listing),
    position,
    addSeq: position,           // ordine di aggiunta: non cambia con i riordini (rotazione dei messaggi)
    priority: Number(spec.priority || 0),
    ops: types.map((t) => makeOp(t, spec)),
    addedAt: now(),
    history: [{ at: now(), action: "aggiunto", detail: types.join(" + ") }],
  };
}

export const activeItems = (items) => items.filter((i) => !i.removed);

/** Ordine di esecuzione: priorità alta prima, poi posizione. */
export function executionOrder(items) {
  return activeItems(items).slice().sort((a, b) => (b.priority || 0) - (a.priority || 0) || a.position - b.position);
}

/**
 * Un'operazione in attesa si può eseguire adesso?
 * - retryAfter: un tentativo non partito si riprova più tardi, senza bloccare le altre;
 * - blocked: tipi sospesi nella campagna (errori di fila) o moduli isolati dal circuit breaker.
 */
export function isEligible(op, { now: t = Date.now(), blocked = new Set() } = {}) {
  return OP_PENDING.has(op.status) && !(op.retryAfter > t) && !blocked.has(op.type);
}

/**
 * Prossima operazione da eseguire (nessuna se una è già in esecuzione).
 * Un'operazione rinviata o di un tipo sospeso non ferma le altre: si passa alla successiva,
 * anche sullo stesso annuncio.
 */
export function nextOp(items, opts = {}) {
  if (items.some((i) => i.ops.some((o) => o.status === "running"))) return null;
  for (const item of executionOrder(items)) {
    const op = item.ops.find((o) => isEligible(o, opts));
    if (op) return { item, op };
  }
  return null;
}

/** Ci sono ancora operazioni in attesa (eseguibili subito o più tardi)? */
export const hasPending = (items) => activeItems(items).some((i) => i.ops.some((o) => OP_PENDING.has(o.status)));

/**
 * Perché non c'è niente da eseguire adesso: il primo nuovo tentativo programmato e i tipi bloccati
 * che hanno ancora operazioni in attesa.
 */
export function waitingState(items, { now: t = Date.now(), blocked = new Set() } = {}) {
  const pending = activeItems(items).flatMap((i) => i.ops.filter((o) => OP_PENDING.has(o.status)));
  const later = pending.filter((o) => !blocked.has(o.type) && o.retryAfter > t).map((o) => o.retryAfter);
  return {
    pending: pending.length,
    retryAt: later.length ? Math.min(...later) : null,
    blockedTypes: [...new Set(pending.filter((o) => blocked.has(o.type)).map((o) => o.type))],
  };
}

/** Aggiunge annunci. Se l'annuncio c'è già, aggiunge solo i tipi di operazione mancanti. */
export function addItems(items, listings, spec, campaignId, where = "end") {
  let out = items.slice();
  const changed = [];
  const rejected = [];
  let maxPos = Math.max(-1, ...out.map((i) => i.position));
  // «In cima»: il gruppo aggiunto va sopra la coda esistente MANTENENDO il suo ordine
  // (prima della 2.0.0 ogni annuncio finiva sopra il precedente e il gruppo si capovolgeva).
  let topPos = Math.min(0, ...out.map((i) => i.position)) - listings.length - 1;
  for (const l of listings) {
    const existing = out.find((i) => i.listingId === String(l.id) && !i.removed);
    if (existing) {
      const r = addOps(existing, spec.types || [], spec);
      if (r.added.length) {
        out = out.map((i) => (i.id === existing.id ? r.item : i));
        changed.push(existing.id);
      } else {
        rejected.push({ listingId: String(l.id), reason: "già in coda con le stesse operazioni" });
      }
      continue;
    }
    const pos = where === "start" ? ++topPos : ++maxPos;
    const item = buildItem(l, spec, campaignId, pos);
    if (!item.ops.length) { rejected.push({ listingId: String(l.id), reason: "nessuna operazione scelta" }); continue; }
    out.push(item);
    changed.push(item.id);
  }
  return { items: out, changed, rejected };
}

/** Aggiunge tipi di operazione a un elemento (solo quelli che non ha già in attesa o fatti). */
export function addOps(item, types, spec = {}) {
  const added = [];
  let ops = item.ops.slice();
  for (const t of types) {
    const same = ops.filter((o) => o.type === t);
    if (same.some((o) => o.status !== "cancelled" && o.status !== "skipped" && o.status !== "failed")) continue;
    ops.push(makeOp(t, spec));
    added.push(t);
  }
  // Mantieni l'ordine scelto, ma le operazioni già eseguite restano dove sono.
  if (spec.order) {
    const done = ops.filter((o) => !OP_PENDING.has(o.status));
    const pending = ops.filter((o) => OP_PENDING.has(o.status)).sort((a, b) => spec.order.indexOf(a.type) - spec.order.indexOf(b.type));
    ops = [...done, ...pending];
  }
  return { item: added.length ? hist({ ...item, ops }, "operazioni aggiunte", added.join(" + ")) : item, added };
}

/** Modifica le operazioni in attesa di un elemento. Le altre restano intatte. */
export function editItemOps(item, patch) {
  let rejected = null;
  const ops = item.ops.map((o) => {
    const p = patch[o.id];
    if (!p) return o;
    if (!OP_PENDING.has(o.status)) { rejected = `L'operazione ${o.type} è ${o.status}: non si può modificare.`; return o; }
    if (p.remove) return { ...o, status: "cancelled", updatedAt: now() };
    // Testo del messaggio scritto a mano per questo annuncio: resta fisso (textLocked);
    // vuoto = torna a quello della campagna.
    const text = "text" in p && o.type === "message"
      ? (String(p.text || "").trim() ? { text: String(p.text).trim(), textLocked: true, msgSource: "manuale", msgError: null } : { text: null, textLocked: false })
      : {};
    return { ...o, ...("amount" in p ? { amount: p.amount } : {}), ...("offerCfg" in p ? { offerCfg: p.offerCfg, amount: null } : {}), ...("requireConfirm" in p ? { requireConfirm: Boolean(p.requireConfirm) } : {}), ...text, updatedAt: now() };
  });
  return { item: hist({ ...item, ops }, "modificato"), rejected };
}

export function removeItems(items, ids) {
  const rejected = [];
  const out = items.map((i) => {
    if (!ids.includes(i.id)) return i;
    if (i.ops.some((o) => o.status === "running")) { rejected.push({ id: i.id, reason: "in esecuzione" }); return i; }
    const ops = i.ops.map((o) => (OP_PENDING.has(o.status) ? { ...o, status: "cancelled", updatedAt: now() } : o));
    return hist({ ...i, ops, removed: true }, "rimosso");
  });
  return { items: out, rejected };
}

export function skipItem(items, id) {
  return items.map((i) => {
    if (i.id !== id) return i;
    const ops = i.ops.map((o) => (OP_PENDING.has(o.status) ? { ...o, status: "skipped", reason: "saltato dall'utente", updatedAt: now() } : o));
    return hist({ ...i, ops }, "saltato");
  });
}

/** Riordino completo. Rifiutato se l'insieme degli elementi è cambiato nel frattempo. */
export function reorder(items, orderedIds) {
  const act = activeItems(items).map((i) => i.id).sort();
  if (JSON.stringify([...orderedIds].sort()) !== JSON.stringify(act)) return { items, rejected: "La coda è cambiata nel frattempo: riprova." };
  const pos = new Map(orderedIds.map((id, idx) => [id, idx]));
  return { items: items.map((i) => (pos.has(i.id) ? { ...i, position: pos.get(i.id) } : i)), rejected: null };
}

export function move(items, id, where) {
  const order = executionOrder(items).map((i) => i.id);
  const idx = order.indexOf(id);
  if (idx < 0) return { items, rejected: "Elemento non trovato" };
  order.splice(idx, 1);
  const target = { top: 0, bottom: order.length, up: Math.max(0, idx - 1), down: Math.min(order.length, idx + 1) }[where];
  order.splice(target ?? idx, 0, id);
  return { items: items.map((i) => (i.removed ? i : { ...i, position: order.indexOf(i.id), priority: 0 })), rejected: null };
}

export function setPriority(items, id, priority) {
  return items.map((i) => (i.id === id ? hist({ ...i, priority: Number(priority) }, "priorità", String(priority)) : i));
}

/** Ripete solo le operazioni fallite con esito CERTO. Mai quelle da verificare. */
export function retryFailed(items, ids = null) {
  let count = 0;
  const out = items.map((i) => {
    if (i.removed || (ids && !ids.includes(i.id))) return i;
    let local = 0;
    const ops = i.ops.map((o) => {
      if (o.status !== "failed" || o.retryable === false) return o;
      local++;
      // Nuova serie di tentativi: il contatore riparte (opRetry), lo storico resta nella cronologia.
      return { ...o, status: "waiting", attempts: 0, retryAfter: null, retries: (o.retries || 0) + 1, error: null, updatedAt: now() };
    });
    count += local;
    return local ? hist({ ...i, ops }, "riprova falliti") : i;
  });
  return { items: out, count };
}

/**
 * Dopo l'azzeramento dello storico: le operazioni saltate dal No Repeat («già fatta») tornano in
 * attesa. listingIds null = tutti gli annunci.
 */
export function resetLedgerSkipped(items, { listingIds = null, types = [] } = {}) {
  const kinds = new Set(types);
  let count = 0;
  const out = items.map((i) => {
    if (i.removed || (listingIds && !listingIds.has(String(i.listingId)))) return i;
    let local = 0;
    const ops = i.ops.map((o) => {
      if (o.status !== "skipped" || !kinds.has(o.type) || !["done", "sameCycle"].includes(o.result?.ledger)) return o;
      local++;
      return { ...o, status: "waiting", attempts: 0, retryAfter: null, result: null, error: null, startedAt: null, finishedAt: null, updatedAt: now() };
    });
    count += local;
    return local ? hist({ ...i, ops }, "storico azzerato", `${local} di nuovo in attesa`) : i;
  });
  return { items: out, count };
}

export function progress(items) {
  const act = activeItems(items);
  const ops = act.flatMap((i) => i.ops);
  const by = (s) => ops.filter((o) => o.status === s).length;
  const itemsDone = act.filter((i) => !i.ops.some((o) => OP_PENDING.has(o.status) || o.status === "running")).length;
  return {
    items: act.length,
    itemsDone,
    ops: ops.length,
    completed: by("completed"),
    failed: by("failed"),
    verify: by("verify"),
    skipped: by("skipped"),
    cancelled: by("cancelled"),
    pending: ops.filter((o) => OP_PENDING.has(o.status)).length,
    running: by("running"),
    percent: ops.length ? Math.round(((ops.length - ops.filter((o) => OP_PENDING.has(o.status) || o.status === "running").length) / ops.length) * 100) : 0,
    statuses: act.map(itemStatus),
  };
}

// ------------------------------------------------------------------ cicli (riprocessare)

/**
 * Cosa si ripeterebbe in un nuovo ciclo.
 * Si ripetono solo operazioni concluse con certezza: completate, oppure saltate perché
 * già fatte prima (No Repeat). Mai quelle da verificare, in corso, in coda o fallite
 * (per queste c'è «Ripeti falliti»).
 * @param sel { itemIds: string[]|null (null = tutti), types: string[]|null (null = tutti) }
 */
export function refreshPlan(items, { itemIds = null, types = null } = {}) {
  const repeat = [];
  const excluded = [];
  const want = itemIds ? new Set(itemIds) : null;
  for (const it of activeItems(items)) {
    if (want && !want.has(it.id)) continue;
    for (const o of it.ops) {
      if (types && !types.includes(o.type)) continue;
      const base = { itemId: it.id, listingId: it.listingId, title: it.listing?.title || it.listingId, type: o.type, opId: o.id, cycle: o.cycle || 1, status: o.status, at: o.finishedAt || o.updatedAt || null, amount: o.amount ?? null };
      if (o.status === "completed") repeat.push({ ...base, simulated: Boolean(o.result?.simulated) });
      else if (o.status === "skipped" && o.result?.ledger === "done") repeat.push({ ...base, noRepeat: true });
      else excluded.push({ ...base, why: o.status === "verify" ? "esito da verificare: risolvilo in Recupero, non si ripete da solo"
        : o.status === "running" ? "in esecuzione"
          : OP_PENDING.has(o.status) ? "già in coda in questo ciclo"
            : o.status === "failed" ? "fallita: per riprovarla usa «Ripeti falliti»"
              : `saltata${o.reason ? `: ${o.reason}` : ""}` });
    }
  }
  return { repeat, excluded, items: new Set(repeat.map((r) => r.itemId)).size };
}

/**
 * Applica il piano: le operazioni ripetute passano nella cronologia dell'elemento
 * (pastCycles: data, stato, risultato, errori restano) e al loro posto arriva una
 * nuova operazione del ciclo `cycle`, marcata newCycle (il ledger la lascia partire).
 */
export function applyRefresh(items, plan, { cycle, cycleId, spec = {} }) {
  const byItem = new Map();
  for (const r of plan.repeat) byItem.set(r.itemId, [...(byItem.get(r.itemId) || []), r.opId]);
  const changed = [];
  const out = items.map((it) => {
    const ids = byItem.get(it.id);
    if (!ids) return it;
    changed.push(it.id);
    const archived = it.ops.filter((o) => ids.includes(o.id));
    const ops = it.ops.map((o) => (ids.includes(o.id)
      ? { ...makeOp(o.type, { ...spec, cycle, cycleId }), newCycle: true, prevOpId: o.id, requireConfirm: o.requireConfirm, text: o.type === "message" && o.textLocked ? o.text : (o.type === "message" ? null : undefined), textLocked: o.type === "message" ? Boolean(o.textLocked) : undefined }
      : o));
    const past = [...(it.pastCycles || [])];
    for (const o of archived) {
      const n = o.cycle || 1;
      let entry = past.find((p) => p.cycle === n);
      if (!entry) { entry = { cycle: n, cycleId: o.cycleId || null, archivedAt: now(), ops: [] }; past.push(entry); }
      entry.ops.push({ ...o });
    }
    past.sort((a, b) => a.cycle - b.cycle);
    return hist({ ...it, ops, pastCycles: past }, `nuovo ciclo ${cycle}`, archived.map((o) => o.type).join(" + "));
  });
  return { items: out, changed };
}

/**
 * Riepilogo dei cicli di una campagna (per la tabella «Cicli»): per ogni ciclo,
 * annunci e operazioni per stato, prese dalle operazioni attuali e dalla cronologia.
 */
export function cycleSummary(items) {
  const map = new Map();
  const add = (n, it, o) => {
    const c = map.get(n) || { cycle: n, items: new Set(), ops: 0, completed: 0, failed: 0, verify: 0, skipped: 0, pending: 0, first: null, last: null };
    c.items.add(it.id);
    c.ops++;
    if (o.status === "completed") c.completed++;
    else if (o.status === "failed") c.failed++;
    else if (o.status === "verify") c.verify++;
    else if (o.status === "skipped" || o.status === "cancelled") c.skipped++;
    else c.pending++;
    const at = o.finishedAt || null;
    if (at) { c.first = c.first ? Math.min(c.first, at) : at; c.last = c.last ? Math.max(c.last, at) : at; }
    map.set(n, c);
  };
  for (const it of activeItems(items)) {
    for (const o of it.ops) add(o.cycle || 1, it, o);
    for (const p of it.pastCycles || []) for (const o of p.ops) add(p.cycle || o.cycle || 1, it, o);
  }
  return [...map.values()].sort((a, b) => a.cycle - b.cycle).map((c) => ({ ...c, items: c.items.size }));
}
