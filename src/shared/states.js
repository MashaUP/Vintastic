/**
 * Macchine a stati esplicite per campagne, elementi della coda e operazioni.
 * Ogni cambio di stato passa da transition(): le transizioni non previste
 * lanciano un errore invece di creare stati incoerenti.
 */

export const OP_STATES = {
  never: "Mai elaborato",
  prepared: "Preparato",
  waiting: "In attesa",
  running: "In esecuzione",
  completed: "Completato",
  failed: "Fallito",
  verify: "Da verificare",
  cancelled: "Annullato",
  skipped: "Saltato",
};

export const OP_TRANSITIONS = {
  never: ["prepared", "waiting", "skipped", "cancelled"],
  prepared: ["waiting", "skipped", "cancelled"],
  waiting: ["running", "skipped", "cancelled", "prepared"],
  // running → waiting solo quando l'operazione NON è partita (es. 403 prima dell'invio).
  running: ["completed", "failed", "verify", "waiting", "skipped"],
  failed: ["waiting", "cancelled", "skipped"],          // retry solo dopo verifica dell'esito
  verify: ["completed", "failed", "cancelled"],         // risolto dall'utente o da una verifica
  completed: [],
  cancelled: ["waiting"],
  skipped: ["waiting"],
};

export const OP_TERMINAL = new Set(["completed", "failed", "verify", "cancelled", "skipped"]);
export const OP_PENDING = new Set(["prepared", "waiting"]);

export const CAMPAIGN_STATES = {
  draft: "Bozza",
  ready: "Pronta",
  running: "In esecuzione",
  paused: "In pausa",
  stopped: "Interrotta",
  completed: "Completata",
};

export const CAMPAIGN_TRANSITIONS = {
  draft: ["ready", "stopped"],
  ready: ["running", "draft", "stopped"],
  running: ["paused", "stopped", "completed"],
  paused: ["running", "stopped", "ready"],
  stopped: ["ready"],
  completed: ["ready"],                 // riattivata perché sono stati aggiunti elementi
};

export class TransitionError extends Error {
  constructor(kind, from, to) {
    super(`Transizione non valida (${kind}): ${from} → ${to}`);
    this.name = "TransitionError";
  }
}

export function canTransition(table, from, to) {
  return from === to || (table[from] || []).includes(to);
}

export function transitionOp(op, to, extra = {}) {
  if (!canTransition(OP_TRANSITIONS, op.status, to)) throw new TransitionError("operazione", op.status, to);
  return { ...op, ...extra, status: to, updatedAt: Date.now() };
}

export function transitionCampaign(c, to, extra = {}) {
  if (!canTransition(CAMPAIGN_TRANSITIONS, c.status, to)) throw new TransitionError("campagna", c.status, to);
  return { ...c, ...extra, status: to, updatedAt: Date.now() };
}

/** Stato riassuntivo di un elemento della coda dalle sue operazioni. */
export function itemStatus(item) {
  if (item.removed) return "removed";
  const s = (item.ops || []).map((o) => o.status);
  if (!s.length) return "waiting";
  if (s.includes("running")) return "running";
  if (s.some((x) => OP_PENDING.has(x))) return "waiting";
  if (s.includes("verify")) return "verify";
  if (s.includes("failed")) return "failed";
  if (s.every((x) => x === "skipped")) return "skipped";
  if (s.every((x) => x === "cancelled")) return "cancelled";
  return "completed";
}
