/**
 * Auto-pause e connettività. Non si basa su navigator.onLine (dice solo se c'è
 * una scheda di rete, non se Vinted risponde): fa una richiesta vera, leggera,
 * a Vinted. La ripresa la decide il motore dopo aver verificato anche sessione
 * e assenza di restrizioni.
 */

import { getState, setState } from "./store.js";
import { log } from "./logger.js";
import { broadcast } from "./bus.js";

const handlers = { offline: new Set(), online: new Set() };
export const on = (ev, fn) => handlers[ev].add(fn);

export async function probe(origin = "https://www.vinted.it", timeoutMs = 10_000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${origin}/robots.txt`, { method: "GET", cache: "no-store", credentials: "omit", signal: ctrl.signal });
    return { reachable: res.status > 0 && res.status < 500, status: res.status };
  } catch (e) {
    return { reachable: false, error: e?.name === "AbortError" ? "timeout" : e?.message };
  } finally {
    clearTimeout(t);
  }
}

export async function state() { return getState("connectivity", { online: true, since: null, checkedAt: null }); }

/** Controlla e notifica le transizioni. */
export async function check(origin) {
  const prev = await state();
  const r = await probe(origin);
  const next = { online: r.reachable, since: r.reachable === prev.online ? prev.since : Date.now(), checkedAt: Date.now(), detail: r.error || r.status };
  await setState("connectivity", next);
  if (prev.online && !next.online) {
    await log({ level: "warn", category: "network", message: `Vinted non raggiungibile (${next.detail})`, code: "network" });
    broadcast("vt:connectivity", { state: next });
    for (const fn of handlers.offline) await fn(next);
  } else if (!prev.online && next.online) {
    await log({ level: "info", category: "network", message: "Connessione tornata: Vinted risponde" });
    broadcast("vt:connectivity", { state: next });
    for (const fn of handlers.online) await fn(next);
  }
  return next;
}

/** Errore di rete durante un'operazione: segna offline subito, senza aspettare il prossimo controllo. */
export async function reportNetworkError(detail) {
  const prev = await state();
  if (!prev.online) return;
  const next = { online: false, since: Date.now(), checkedAt: Date.now(), detail };
  await setState("connectivity", next);
  broadcast("vt:connectivity", { state: next });
  for (const fn of handlers.offline) await fn(next);
}
