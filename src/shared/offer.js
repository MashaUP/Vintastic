/**
 * Smart Offer Engine — calcolo dell'importo di un'offerta.
 *
 * Funzione pura: dato il prezzo e la configurazione restituisce l'importo con
 * tutti i passaggi (per l'anteprima) e gli avvisi. Non inventa i limiti di
 * Vinted: quelli si scoprono solo all'invio, e l'errore di Vinted viene mostrato
 * così com'è. Un'offerta non è mai un acquisto.
 */

import { randInt } from "./util.js";

export const OFFER_MODES = {
  saving: "Risparmio",
  interaction: "Interazione",
  custom: "Personalizzata",
};

export const RULE_KINDS = {
  percent: "Percentuale ± sul prezzo",
  percentOff: "Sconto %",
  percentUp: "Incremento %",
  fixedOff: "Sconto fisso €",
  fixedUp: "Incremento fisso €",
  exact: "Importo fisso €",
  random: "Casuale nell'intervallo",
};

export const ROUNDING = {
  none: "Nessuno",
  "99": "Finale ,99",
  "00": "Finale ,00",
  "5": "Multipli di 5",
  "10": "Multipli di 10",
};

export const DIRECTIONS = { nearest: "Al più vicino", up: "Per eccesso", down: "Per difetto" };

/** Predefinito: +5% sul prezzo, centesimi esatti (l'importante è che l'offerta parta). */
export const DEFAULT_OFFER = {
  mode: "interaction",
  rule: { kind: "percent", value: 5 },
  bands: [],                // [{ upTo: 20, rule: {...} }] — la prima fascia con prezzo <= upTo vince
  min: null,
  max: null,
  rounding: { style: "none", direction: "nearest" },
};

const cents = (n) => Math.round(Number(n) * 100) / 100;

/** Arrotondamento con stile e direzione. */
export function roundAmount(x, style = "none", direction = "nearest") {
  const v = Number(x);
  if (!Number.isFinite(v)) return NaN;
  const pick = (down, up) => {
    if (direction === "up") return up;
    if (direction === "down") return down;
    return Math.abs(v - down) <= Math.abs(up - v) ? down : up;
  };
  switch (style) {
    case "99": {
      const down = Math.floor(v - 0.99 + 1e-9) + 0.99;   // il ,99 più alto che non supera v
      if (Math.abs(down - v) < 1e-9) return cents(down);
      return cents(pick(down, down + 1));
    }
    case "00": return cents(pick(Math.floor(v), Math.ceil(v)));
    case "5": return cents(pick(Math.floor(v / 5) * 5, Math.ceil(v / 5) * 5));
    case "10": return cents(pick(Math.floor(v / 10) * 10, Math.ceil(v / 10) * 10));
    default: return cents(v);
  }
}

function applyRule(price, rule, rng) {
  const value = Number(rule?.value ?? 0);
  switch (rule?.kind) {
    case "percent": return { amount: price * (1 + value / 100), text: `${value >= 0 ? "+" : ""}${value}%` };
    case "percentOff": return { amount: price * (1 - value / 100), text: `-${value}%` };
    case "percentUp": return { amount: price * (1 + value / 100), text: `+${value}%` };
    case "fixedOff": return { amount: price - value, text: `-${value.toFixed(2)} €` };
    case "fixedUp": return { amount: price + value, text: `+${value.toFixed(2)} €` };
    case "exact": return { amount: value, text: `importo fisso ${value.toFixed(2)} €` };
    case "random": {
      // from/to in percentuale del prezzo (unit "percent") o in euro (unit "amount")
      const unit = rule.unit === "amount" ? "amount" : "percent";
      const lo = Number(rule.from ?? 0);
      const hi = Number(rule.to ?? lo);
      const a = unit === "percent" ? price * lo / 100 : lo;
      const b = unit === "percent" ? price * hi / 100 : hi;
      const c = randInt(Math.round(Math.min(a, b) * 100), Math.round(Math.max(a, b) * 100), rng) / 100;
      return { amount: c, text: `casuale tra ${unit === "percent" ? `${lo}% e ${hi}%` : `${lo.toFixed(2)} € e ${hi.toFixed(2)} €`}`, random: true };
    }
    default: return { amount: price, text: "nessuna regola" };
  }
}

/** Configurazione completa dalla modalità: Risparmio e Interazione hanno regole guidate. */
export function normalizeOffer(cfg = {}) {
  const c = { ...DEFAULT_OFFER, ...cfg, rounding: { ...DEFAULT_OFFER.rounding, ...(cfg.rounding || {}) } };
  if (!OFFER_MODES[c.mode]) c.mode = "saving";
  if (!c.rule || !RULE_KINDS[c.rule.kind]) c.rule = { ...DEFAULT_OFFER.rule };
  c.bands = Array.isArray(c.bands) ? c.bands.filter((b) => b && Number(b.upTo) > 0 && RULE_KINDS[b.rule?.kind]) : [];
  return c;
}

/**
 * Calcola l'offerta.
 * @returns {{ok:boolean, amount:number|null, steps:string[], warnings:string[], error?:string, random:boolean}}
 */
export function computeOffer(price, cfg = {}, rng = Math.random) {
  const steps = [];
  const warnings = [];
  const p = Number(price);
  if (!Number.isFinite(p) || p <= 0) return { ok: false, amount: null, steps, warnings, error: "Prezzo dell'annuncio non disponibile.", random: false };
  const c = normalizeOffer(cfg);
  steps.push(`Prezzo: ${p.toFixed(2)} €`);

  const band = c.bands.slice().sort((a, b) => a.upTo - b.upTo).find((b) => p <= Number(b.upTo));
  const rule = band ? band.rule : c.rule;
  if (band) steps.push(`Fascia fino a ${Number(band.upTo).toFixed(2)} €`);

  let { amount, text, random } = applyRule(p, rule, rng);
  steps.push(`Regola: ${text} → ${cents(amount).toFixed(2)} €`);

  if (c.mode === "saving" && amount >= p) {
    warnings.push("In modalità Risparmio l'offerta deve stare sotto il prezzo: corretta a prezzo meno 1%.");
    amount = p * 0.99;
  }
  if (c.min != null && c.min !== "" && amount < Number(c.min)) { amount = Number(c.min); steps.push(`Minimo applicato: ${amount.toFixed(2)} €`); }
  if (c.max != null && c.max !== "" && amount > Number(c.max)) { amount = Number(c.max); steps.push(`Massimo applicato: ${amount.toFixed(2)} €`); }

  const before = amount;
  amount = roundAmount(amount, c.rounding.style, c.rounding.direction);
  if (c.rounding.style !== "none") steps.push(`Arrotondamento ${ROUNDING[c.rounding.style]} (${DIRECTIONS[c.rounding.direction] || ""}): ${cents(before).toFixed(2)} → ${amount.toFixed(2)} €`);

  // L'arrotondamento non deve far uscire dai limiti scelti né portare la modalità Risparmio sopra il prezzo.
  if (c.mode === "saving" && amount >= p) {
    amount = roundAmount(p - 0.01, c.rounding.style, "down");
    if (amount >= p || amount <= 0) amount = cents(p - 0.01);
    warnings.push("Arrotondamento corretto per restare sotto il prezzo.");
  }
  if (c.min != null && c.min !== "" && amount < Number(c.min)) amount = cents(Number(c.min));
  if (c.max != null && c.max !== "" && amount > Number(c.max)) amount = cents(Number(c.max));

  if (amount <= 0) return { ok: false, amount: null, steps, warnings, error: "L'importo calcolato è zero o negativo: cambia la regola.", random: Boolean(random) };
  if (amount > p) warnings.push("Importo superiore al prezzo: Vinted potrebbe non accettarlo. Lo scoprirai all'invio, e l'errore di Vinted verrà mostrato.");
  if (amount < p * 0.5) warnings.push("Sconto superiore al 50%: Vinted potrebbe rifiutare offerte troppo basse.");
  steps.push(`Offerta: ${amount.toFixed(2)} €`);
  return { ok: true, amount: cents(amount), steps, warnings, random: Boolean(random) };
}

/** Riepilogo leggibile di una configurazione. */
export function describeOffer(cfg) {
  const c = normalizeOffer(cfg);
  const r = c.rule;
  const ruleText = r.kind === "random"
    ? `${RULE_KINDS.random} ${r.from}–${r.to}${r.unit === "amount" ? " €" : "%"}`
    : `${RULE_KINDS[r.kind]} ${r.value}`;
  return `${OFFER_MODES[c.mode]} · ${ruleText}${c.bands.length ? ` · ${c.bands.length} fasce` : ""} · ${ROUNDING[c.rounding.style]}`;
}
