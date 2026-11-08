/**
 * Timer e soglie giornaliere.
 *
 * Gli intervalli regolano il ritmo delle operazioni (niente richieste a raffica
 * per sbaglio). Non servono a imitare una persona: un segnale di Vinted (403,
 * 429, CAPTCHA, restrizione) ferma tutto indipendentemente dai timer.
 * Le soglie sono scelte dall'utente: non sono limiti ufficiali o "sicuri" di Vinted.
 */

import { randInt, dayKey, nextMidnight } from "./util.js";

const range = (r, fallback) => {
  const min = Number(r?.min ?? fallback.min);
  const max = Number(r?.max ?? fallback.max);
  return { min: Math.max(0, Math.min(min, max)), max: Math.max(0, Math.max(min, max)) };
};

/**
 * Secondi da attendere prima di `next`.
 * @param next  {type}  operazione successiva
 * @param prev  {type, itemId}|null  ultima operazione eseguita
 * @param sameItem  true se next è sullo stesso annuncio di prev
 */
export function delayBefore(next, prev, sameItem, campaignTimers = {}, settingsTimers = {}, rng = Math.random) {
  if (!prev) return { seconds: 0, kind: "start", label: "Avvio" };
  const floor = Number(settingsTimers.minFloor ?? 2);
  const pickRange = (key) => campaignTimers?.[key] || settingsTimers?.[key];
  let r;
  let kind;
  let label;
  if (sameItem) {
    const tKey = `${prev.type}>${next.type}`;
    const trans = campaignTimers?.transitions?.[tKey] || settingsTimers?.transitions?.[tKey];
    const perType = campaignTimers?.perType?.[next.type];
    if (trans) { r = range(trans, { min: 3, max: 8 }); kind = "transition"; label = `Tra ${tKey.replace(">", " → ")}`; }
    else if (perType) { r = range(perType, { min: 3, max: 8 }); kind = "perType"; label = `Prima di ${next.type}`; }
    else { r = range(pickRange("betweenOps"), { min: 3, max: 8 }); kind = "betweenOps"; label = "Tra operazioni dello stesso annuncio"; }
  } else {
    r = range(pickRange("betweenItems"), { min: 10, max: 25 });
    kind = "betweenItems";
    label = "Tra annunci diversi";
  }
  const seconds = Math.max(floor, randInt(r.min, r.max, rng));
  return { seconds, kind, label, min: r.min, max: r.max };
}

/** Contatori del giorno, azzerati a mezzanotte locale. */
export function freshCounters(counters, now = Date.now()) {
  const day = dayKey(now);
  if (!counters || counters.day !== day) return { day, accounts: {}, global: 0 };
  return counters;
}

/** Si può fare un'altra operazione di questo tipo oggi? */
export function checkLimit(counters, accountId, type, limits, now = Date.now()) {
  const c = freshCounters(counters, now);
  const acc = c.accounts[accountId] || {};
  const resetAt = nextMidnight(now);
  const perType = Number(limits?.perDay?.[type]);
  if (Number.isFinite(perType) && (acc[type] || 0) >= perType) {
    return { allowed: false, scope: type, used: acc[type] || 0, max: perType, resetAt, reason: `Soglia giornaliera per ${type} raggiunta (${perType}).` };
  }
  const perAcc = Number(limits?.perAccountDay);
  if (Number.isFinite(perAcc) && (acc.total || 0) >= perAcc) {
    return { allowed: false, scope: "account", used: acc.total || 0, max: perAcc, resetAt, reason: `Soglia giornaliera dell'account raggiunta (${perAcc}).` };
  }
  const global = Number(limits?.globalDay);
  if (Number.isFinite(global) && (c.global || 0) >= global) {
    return { allowed: false, scope: "global", used: c.global || 0, max: global, resetAt, reason: `Soglia giornaliera complessiva raggiunta (${global}).` };
  }
  return { allowed: true, resetAt, used: acc[type] || 0, max: Number.isFinite(perType) ? perType : null };
}

export function countOp(counters, accountId, type, now = Date.now()) {
  const c = freshCounters(counters, now);
  const accounts = { ...c.accounts };
  const acc = { ...(accounts[accountId] || {}) };
  acc[type] = (acc[type] || 0) + 1;
  acc.total = (acc.total || 0) + 1;
  accounts[accountId] = acc;
  return { day: c.day, accounts, global: (c.global || 0) + 1 };
}
