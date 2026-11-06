/**
 * Policy Validator e Preview Snapshot.
 *
 * Prima dell'avvio (e prima di ogni ripresa) la campagna viene controllata.
 * Gli "errori" bloccano l'avvio, gli "avvisi" no.
 * Lo snapshot fotografa ciò che hai approvato: se dopo cambiano annunci,
 * prezzi o operazioni, serve una nuova approvazione.
 */

import { ledgerKey, canInteract } from "./ledger.js";
import { checkLimit } from "./timers.js";
import { OP_PENDING } from "./states.js";
import { stableStringify } from "./util.js";

export function snapshotEntries(items) {
  return items.filter((i) => !i.removed).map((i) => ({
    itemId: i.id,
    listingId: i.listingId,
    price: i.listing?.price ?? null,
    ops: i.ops.filter((o) => OP_PENDING.has(o.status)).map((o) => [o.type, o.amount ?? null, o.comment || null]),
  })).filter((e) => e.ops.length);
}

export function makeSnapshot(items, at = Date.now()) {
  const entries = snapshotEntries(items);
  return { at, hash: stableStringify(entries), count: entries.length };
}

/** Differenze tra lo snapshot approvato e la coda attuale (solo operazioni ancora da fare). */
export function diffSnapshot(snapshot, items) {
  if (!snapshot) return ["Nessuna anteprima approvata."];
  let approved;
  try { approved = JSON.parse(snapshot.hash); } catch { return ["Anteprima illeggibile: va riapprovata."]; }
  const now = snapshotEntries(items);
  const byItem = new Map(approved.map((e) => [e.itemId, e]));
  const diffs = [];
  for (const e of now) {
    const a = byItem.get(e.itemId);
    if (!a) { diffs.push(`Nuovo elemento non approvato: annuncio ${e.listingId}`); continue; }
    if (a.price !== e.price) diffs.push(`Prezzo cambiato per l'annuncio ${e.listingId}: ${a.price} → ${e.price}`);
    // Le operazioni approvate possono essersi ridotte (eseguite); ne contano solo di nuove o cambiate.
    const approvedOps = new Set(a.ops.map((o) => JSON.stringify(o)));
    for (const o of e.ops) if (!approvedOps.has(JSON.stringify(o))) diffs.push(`Operazione nuova o modificata sull'annuncio ${e.listingId}: ${o[0]}${o[1] != null ? ` ${o[1]} €` : ""}`);
  }
  return diffs;
}

/**
 * @param ctx {campaign, items, session, ledger: Map, counters, settings, breakers, online}
 */
export function validateCampaign(ctx) {
  const { campaign, items = [], session, ledger = new Map(), counters, settings = {}, breakers = {}, online = true } = ctx;
  const errors = [];
  const warnings = [];
  const infos = [];
  const live = items.filter((i) => !i.removed);
  const pendingOps = live.flatMap((i) => i.ops.filter((o) => OP_PENDING.has(o.status)).map((o) => ({ item: i, op: o })));

  if (settings.killSwitch) errors.push("Il Kill Switch globale è attivo: spegnilo per avviare.");
  if (!campaign?.accountId) errors.push("Nessun account associato alla campagna.");
  if (!pendingOps.length) {
    const simulated = live.some((i) => i.ops.some((o) => o.status === "completed" && o.result?.simulated));
    errors.push(simulated && campaign?.dryRun
      ? "La simulazione è già stata eseguita. Per farlo davvero su Vinted usa «Esegui davvero su Vinted»."
      : "Non ci sono operazioni da eseguire.");
  }
  if (!campaign?.dryRun) {
    if (!online) errors.push("Connessione assente: le interazioni restano sospese (consultazione in sola lettura).");
    if (!session?.loggedIn) errors.push("Sessione Vinted non attiva: accedi a Vinted in una scheda e riprova.");
    else if (campaign?.accountId && session.accountId !== campaign.accountId) errors.push(`L'account della sessione (${session.login || session.accountId}) non è quello della campagna.`);
    if (session?.challenge) errors.push("Vinted chiede una verifica (CAPTCHA o conferma): completala tu nella scheda di Vinted.");
  } else {
    infos.push("Simulazione: nessuna richiesta verrà inviata a Vinted.");
  }

  const types = new Set(pendingOps.map((p) => p.op.type));
  for (const t of types) {
    if (settings.moduleKill?.[t]) errors.push(`Il modulo ${t} è spento (kill switch del modulo).`);
    if (settings.features && settings.features[t] === false) errors.push(`Il modulo ${t} è disattivato nelle funzionalità.`);
    if (breakers[t]?.state === "open") errors.push(`Il modulo ${t} è sospeso dal circuit breaker: ${breakers[t].reason || "errori ripetuti"}.`);
  }
  if (types.has("comment")) warnings.push("Vinted non ha commenti pubblici sugli annunci: i commenti diventano suggerimenti da copiare, non vengono inviati.");

  let dupes = 0;
  let verify = 0;
  for (const { item, op } of pendingOps) {
    if (op.type === "comment") continue;
    const entry = ledger.get(ledgerKey(campaign?.accountId, item.listingId, op.type));
    const d = canInteract(entry);
    if (!d.allowed) { if (d.code === "verify" || d.code === "running") verify++; else dupes++; }
    if (op.type === "offer" && !(Number(op.amount) > 0)) errors.push(`Offerta senza importo per l'annuncio ${item.listingId}: apri l'anteprima.`);
    if (item.listing?.status && item.listing.status !== "active") warnings.push(`Annuncio ${item.listingId} non attivo (${item.listing.status}): verrà saltato.`);
  }
  if (dupes) warnings.push(`${dupes} operazioni sono già state eseguite: verranno saltate (No Repeat).`);
  if (verify) warnings.push(`${verify} operazioni hanno un esito da verificare: non verranno ripetute finché non le risolvi.`);

  if (!campaign?.dryRun && counters) {
    for (const t of types) {
      if (t === "comment") continue;
      const lim = checkLimit(counters, campaign?.accountId, t, settings.limits);
      const need = pendingOps.filter((p) => p.op.type === t).length;
      if (!lim.allowed) errors.push(lim.reason);
      else if (lim.max != null && lim.used + need > lim.max) warnings.push(`Per ${t} restano ${lim.max - lim.used} operazioni oggi su ${need} in coda: la campagna si fermerà alla soglia.`);
    }
  }

  const diffs = diffSnapshot(campaign?.snapshot, items);
  if (diffs.length) errors.push(`Serve una nuova approvazione dell'anteprima (${diffs.length} differenze).`);

  infos.push(`${live.length} annunci, ${pendingOps.length} operazioni da eseguire.`);
  return { ok: errors.length === 0, errors: [...new Set(errors)], warnings: [...new Set(warnings)], infos, diffs };
}
