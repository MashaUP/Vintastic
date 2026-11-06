/**
 * Log diagnostici e centro attività.
 * Ogni voce: timestamp, categoria, gravità, account, campagna, operazione,
 * annuncio, messaggio, stack, possibile soluzione. Tutto passa da redact().
 */

import * as db from "./db.js";
import { broadcast } from "./bus.js";
import { redact, redactString } from "../shared/redact.js";

export const LOG_CATEGORIES = {
  system: "Sistema", campaign: "Campagna", op: "Operazione", scan: "Scansione", account: "Account",
  auth: "Autenticazione", network: "Rete", dom: "DOM", js: "JavaScript", persistence: "Persistenza",
  compat: "Compatibilità", update: "Aggiornamenti", discord: "Discord", policy: "Regole", notif: "Notifiche Vinted",
};
export const LEVELS = ["debug", "info", "warn", "error", "critical"];

/** Possibili soluzioni per i codici di errore più comuni. */
export const SOLUTIONS = {
  blocked403: "Vinted ha rifiutato la richiesta. Le operazioni sono in pausa: aspetta, apri Vinted e controlla che non ci siano verifiche da completare.",
  rate429: "Vinted sta limitando le richieste. Vintastic riprende dopo la pausa automatica; allunga i timer della campagna.",
  captcha: "Vinted chiede una verifica. Completala tu nella scheda di Vinted, poi premi Riprendi.",
  auth: "Sessione scaduta o account diverso. Accedi a Vinted con l'account della campagna, poi premi Riprendi.",
  network: "Connessione assente o instabile. Vintastic riprende da solo quando la rete torna e la sessione è valida.",
  dom: "La pagina di Vinted è cambiata e un elemento non è stato trovato. Il modulo è stato isolato: controlla gli aggiornamenti di Vintastic.",
  api: "Una risposta di Vinted non ha la forma attesa. Il modulo è stato isolato: controlla gli aggiornamenti di Vintastic.",
  noTab: "Serve una scheda di Vinted aperta. Vintastic ne apre una sua quando avvii una campagna.",
  limit: "Hai raggiunto una soglia che hai impostato. Si azzera a mezzanotte, oppure alzala nelle impostazioni.",
  persistence: "Errore di salvataggio locale. Esegui il controllo completo in Salute ed esporta un backup.",
  uncertain: "Non si sa se l'operazione è arrivata a Vinted. Controlla l'annuncio su Vinted e risolvi l'elemento in Recupero.",
};

export async function log(entry) {
  const e = redact({
    at: Date.now(),
    level: LEVELS.includes(entry.level) ? entry.level : "info",
    category: entry.category || "system",
    accountId: entry.accountId || null,
    campaignId: entry.campaignId || null,
    opId: entry.opId || null,
    opType: entry.opType || null,
    listingId: entry.listingId || null,
    message: redactString(String(entry.message || "").slice(0, 2000)),
    stack: entry.stack ? redactString(String(entry.stack).slice(0, 4000)) : null,
    code: entry.code || null,
    solution: entry.solution || (entry.code && SOLUTIONS[entry.code]) || null,
    data: entry.data || null,
  });
  try {
    await db.put("logs", e);
  } catch (err) {
    // Il log non deve mai rompere il chiamante.
    console.warn("[Vintastic] log non salvato", err, e);
  }
  if (e.level !== "debug") broadcast("vt:log", { entry: e });
  return e;
}

/** Evento del centro attività in tempo reale (scansione iniziata, like completato…). */
export async function activity(kind, text, extra = {}) {
  const a = { at: Date.now(), kind, text: redactString(text), ...redact(extra) };
  try { await db.put("activity", a); } catch { /* non bloccante */ }
  broadcast("vt:activity", { item: a });
  return a;
}

export const logError = (category, error, extra = {}) => log({
  level: "error", category, message: error?.message || String(error), stack: error?.stack, ...extra,
});
