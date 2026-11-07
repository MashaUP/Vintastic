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
    comment: type === "comment" ? (spec.comment || "") : undefined,
    // Messaggio: testo e modalità si calcolano nell'anteprima (engine.fillMessages).
    text: type === "message" ? null : undefined,
    mode: type === "message" ? null : undefined,
    requireConfirm: Boolean(spec.requireConfirm?.[type]),
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

/** Prossima operazione da eseguire (nessuna se una è già in esecuzione). */
export function nextOp(items) {
  if (items.some((i) => i.ops.some((o) => o.status === "running"))) return null;
  for (const item of executionOrder(items)) {
    const op = item.ops.find((o) => OP_PENDING.has(o.status));
    if (op) return { item, op };
  }
  return null;
}

/** Aggiunge annunci. Se l'annuncio c'è già, aggiunge solo i tipi di operazione mancanti. */
export function addItems(items, listings, spec, campaignId, where = "end") {
  let out = items.slice();
  const changed = [];
  const rejected = [];
  let minPos = Math.min(0, ...out.map((i) => i.position));
  let maxPos = Math.max(-1, ...out.map((i) => i.position));
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
    const pos = where === "start" ? --minPos : ++maxPos;
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
    return { ...o, ...("amount" in p ? { amount: p.amount } : {}), ...("comment" in p ? { comment: p.comment } : {}), ...("offerCfg" in p ? { offerCfg: p.offerCfg, amount: null } : {}), ...("requireConfirm" in p ? { requireConfirm: Boolean(p.requireConfirm) } : {}), ...text, updatedAt: now() };
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
      return { ...o, status: "waiting", attempts: (o.attempts || 0) + 1, error: null, updatedAt: now() };
    });
    count += local;
    return local ? hist({ ...i, ops }, "riprova falliti") : i;
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
