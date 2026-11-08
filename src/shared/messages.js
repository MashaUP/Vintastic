/**
 * Messaggi privati — logica pura (testata in tests/unit/messages.test.mjs).
 *
 * - Destinatari: i messaggi partono SOLO verso i venditori nell'elenco di
 *   Impostazioni › Messaggi (i tuoi account e quelli di chi ti ha dato l'ok).
 *   Un annuncio di un altro venditore non riceve mai un messaggio.
 * - Testo: si sceglie per campagna da varie fonti (predefinito, modello, scritto
 *   ora, rotazione o scelta casuale tra modelli, domanda sull'annuncio) e si può
 *   personalizzare con segnaposto. Il testo viene calcolato nell'anteprima,
 *   fotografato con l'approvazione e inviato così com'è.
 * - Il contenuto dei messaggi non va mai in log, journal, ledger o Support Bundle.
 */

import { suggestLocal } from "./suggest.js";
import { OP_PENDING } from "./states.js";

export const MESSAGE_MAX = 1000;
export const MANUAL_WAIT_DEFAULT = 240;   // secondi: attesa dell'invio manuale (modalità B)

export const MESSAGE_SOURCES = {
  default: "Messaggio predefinito (Impostazioni)",
  template: "Un modello salvato",
  custom: "Scritto ora per questa campagna",
  rotate: "A rotazione tra i modelli",
  random: "Casuale tra i modelli",
  suggested: "Domanda sull'annuncio (suggerimento automatico)",
};

export const MESSAGE_MODES = {
  auto: "A — Automatica: Vintastic preme Invia e verifica",
  manual: "B — Manuale: Vintastic compila, premi tu Invia",
};

export const PLACEHOLDERS = {
  "{titolo}": "titolo dell'annuncio",
  "{prezzo}": "prezzo (es. 12,00 €)",
  "{marca}": "marca, se nota",
  "{taglia}": "taglia, se nota",
  "{venditore}": "nome del venditore",
};

const norm = (s) => String(s ?? "").replace(/\r\n/g, "\n").trim();

/** Id numerico di un account Vinted da id, URL del profilo (/member/123-nome) o «@nome (123)». */
export function parseRecipientId(input) {
  const s = String(input ?? "").trim();
  const m = s.match(/\/member\/(\d+)/) || s.match(/^(\d{1,12})$/) || s.match(/\((\d{1,12})\)\s*$/);
  return m ? m[1] : null;
}

/** Elenco pulito dei destinatari: id unici, etichette brevi. */
export function cleanRecipients(list) {
  const out = [];
  const seen = new Set();
  for (const r of Array.isArray(list) ? list : []) {
    const id = parseRecipientId(r?.id ?? r);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push({ id, label: String(r?.label || "").trim().slice(0, 60) });
  }
  return out;
}

/**
 * Si può scrivere al venditore di questo annuncio?
 * @param selfUserId id dell'account che invia (non si scrive a se stessi)
 */
export function recipientCheck(settings, sellerId, selfUserId = null) {
  const list = cleanRecipients(settings?.messages?.recipients);
  if (!list.length) return { ok: false, code: "noRecipients", reason: "Nessun destinatario autorizzato: aggiungili in Impostazioni › Messaggi" };
  if (!sellerId) return { ok: false, code: "unknownSeller", reason: "Venditore dell'annuncio sconosciuto: riscansiona l'armadio" };
  const id = String(sellerId);
  if (selfUserId && id === String(selfUserId)) return { ok: false, code: "self", reason: "È un annuncio dell'account che invia: non si può scrivere a se stessi" };
  const hit = list.find((r) => r.id === id);
  if (!hit) return { ok: false, code: "notAllowed", reason: `Il venditore ${id} non è tra i destinatari autorizzati` };
  return { ok: true, recipient: hit };
}

export function validateText(text) {
  const t = norm(text);
  if (!t) return { ok: false, reason: "Testo del messaggio vuoto" };
  if (t.length > MESSAGE_MAX) return { ok: false, reason: `Testo troppo lungo: ${t.length} caratteri, massimo ${MESSAGE_MAX}` };
  return { ok: true, text: t };
}

function fmtPrice(price, currency = "EUR") {
  const n = Number(price);
  if (!Number.isFinite(n)) return "";
  try { return new Intl.NumberFormat("it-IT", { style: "currency", currency: currency || "EUR" }).format(n).replace(/\s/g, " "); }
  catch { return `${n.toFixed(2).replace(".", ",")} €`; }
}

/** Sostituisce i segnaposto; quelli senza dato spariscono senza lasciare doppi spazi. */
export function fillPlaceholders(text, listing = {}) {
  const values = {
    "{titolo}": listing.title || "",
    "{prezzo}": fmtPrice(listing.price, listing.currency),
    "{marca}": listing.brand || "",
    "{taglia}": listing.size || "",
    "{venditore}": listing.sellerLogin || "",
  };
  let out = String(text ?? "");
  for (const [k, v] of Object.entries(values)) out = out.split(k).join(v);
  return out.replace(/[ \t]{2,}/g, " ").replace(/ +([,.!?;:])/g, "$1").trim();
}

const hash = (s) => {
  let h = 2166136261;
  for (const c of String(s)) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619); }
  return h >>> 0;
};

/** Configurazione dei messaggi di una campagna, con i valori predefiniti. */
export function messageConfig(campaign) {
  const m = campaign?.opsDefaults?.message || {};
  return {
    source: MESSAGE_SOURCES[m.source] ? m.source : "default",
    templateId: m.templateId || null,
    templateIds: Array.isArray(m.templateIds) ? m.templateIds : [],
    text: typeof m.text === "string" ? m.text : "",
    mode: m.mode === "auto" || m.mode === "manual" ? m.mode : null,   // null = quella delle impostazioni
  };
}

export const effectiveMode = (cfg, settings) => cfg?.mode || (settings?.messages?.mode === "manual" ? "manual" : "auto");

/**
 * Testo per un annuncio.
 * @param index posizione stabile dell'annuncio nella campagna (per la rotazione)
 * @param seed  seme della campagna (per la scelta casuale, riproducibile)
 */
export function resolveMessage(cfg, listing, settings, { index = 0, seed = 0 } = {}) {
  const templates = (settings?.messages?.templates || []).filter((t) => norm(t?.text));
  const pickFrom = () => {
    const ids = cfg.templateIds?.length ? cfg.templateIds : templates.map((t) => t.id);
    return ids.map((id) => templates.find((t) => t.id === id)).filter(Boolean);
  };
  let raw;
  let templateId = null;
  switch (cfg.source) {
    case "template": {
      const t = templates.find((x) => x.id === cfg.templateId);
      if (!t) return { ok: false, reason: "Il modello scelto non esiste più: sceglierne un altro" };
      raw = t.text; templateId = t.id; break;
    }
    case "custom":
      raw = cfg.text; break;
    case "rotate":
    case "random": {
      const pool = pickFrom();
      if (!pool.length) return { ok: false, reason: "Nessun modello salvato per la rotazione: creane in Impostazioni › Messaggi" };
      const t = cfg.source === "rotate" ? pool[Math.abs(index) % pool.length] : pool[hash(`${seed}|${listing?.id}`) % pool.length];
      raw = t.text; templateId = t.id; break;
    }
    case "suggested": {
      const s = suggestLocal(listing || {}, { language: settings?.ai?.language, tone: settings?.ai?.tone, count: 1 });
      raw = s[0] || settings?.messages?.text; break;
    }
    default:
      raw = settings?.messages?.text;
  }
  const v = validateText(fillPlaceholders(raw, listing));
  return v.ok ? { ok: true, text: v.text, source: cfg.source, templateId } : { ok: false, reason: v.reason };
}

/**
 * Testo e modalità dei messaggi in attesa (anteprima). I testi scritti a mano per un
 * annuncio (textLocked) restano. Un venditore non autorizzato non riceve niente:
 * il messaggio viene saltato subito, prima di qualsiasi apertura di chat.
 */
export function fillMessageOps(c, items, settings, now = Date.now()) {
  if (!items.some((i) => i.ops.some((o) => o.type === "message" && OP_PENDING.has(o.status)))) return items;
  const cfg = messageConfig(c);
  const mode = effectiveMode(cfg, settings);
  const self = c.accountId ? String(c.accountId).split("@")[0] : null;
  // Rotazione: ordine di aggiunta (stabile anche se la coda viene riordinata).
  const stable = [...items].sort((a, b) => (a.addedAt || 0) - (b.addedAt || 0) || (a.addSeq ?? a.position ?? 0) - (b.addSeq ?? b.position ?? 0) || String(a.id).localeCompare(String(b.id))).map((i) => i.id);
  const seed = c.sort?.seed ?? 0;
  return items.map((i) => {
    if (i.removed || !i.ops.some((o) => o.type === "message" && OP_PENDING.has(o.status))) return i;
    const who = recipientCheck(settings, i.listing?.sellerId, self);
    return {
      ...i,
      ops: i.ops.map((o) => {
        if (o.type !== "message" || !OP_PENDING.has(o.status)) return o;
        if (!who.ok && who.code !== "noRecipients") return { ...o, status: "skipped", reason: who.reason, updatedAt: now };
        if (o.textLocked && o.text) return { ...o, mode };
        const r = resolveMessage(cfg, i.listing, settings, { index: stable.indexOf(i.id), seed });
        return { ...o, mode, text: r.ok ? r.text : null, msgSource: r.ok ? r.source : null, msgError: r.ok ? null : r.reason };
      }),
    };
  });
}

/** Le impostazioni dei messaggi senza contenuti privati (Support Bundle, diagnostica). */
export function redactMessages(messages = {}) {
  return {
    mode: messages.mode,
    manualWaitSeconds: messages.manualWaitSeconds,
    textLength: norm(messages.text).length,
    templates: (messages.templates || []).length,
    recipients: cleanRecipients(messages.recipients).length,
  };
}

/** Pulisce una modifica alle impostazioni dei messaggi prima di salvarla. */
export function sanitizeMessagesPatch(m) {
  if (!m || typeof m !== "object") return m;
  const out = {};
  if ("mode" in m) out.mode = m.mode === "manual" ? "manual" : "auto";
  if ("text" in m) out.text = norm(m.text).slice(0, MESSAGE_MAX);
  if ("focusTab" in m) out.focusTab = Boolean(m.focusTab);
  if ("manualWaitSeconds" in m) out.manualWaitSeconds = Math.max(5, Math.min(240, Math.round(Number(m.manualWaitSeconds) || MANUAL_WAIT_DEFAULT)));
  if ("recipients" in m) out.recipients = cleanRecipients(m.recipients);
  if ("templates" in m) {
    const seen = new Set();
    out.templates = (Array.isArray(m.templates) ? m.templates : []).map((t, i) => ({
      id: String(t?.id || `t${Date.now().toString(36)}${i}`).slice(0, 40),
      name: String(t?.name || "").trim().slice(0, 60) || `Modello ${i + 1}`,
      text: norm(t?.text).slice(0, MESSAGE_MAX),
    })).filter((t) => t.text && !seen.has(t.id) && seen.add(t.id));
  }
  return out;
}

/**
 * Spiegazione leggibile di perché la chat non si è aperta, dai dati raccolti in attesa
 * (engine.waitChat). Distingue i casi: clic senza effetto, nuova scheda, Vintastic assente
 * sulla pagina, campo assente nella chat, pagina in caricamento, scheda in background.
 */
export function chatDiagnosis(d = {}) {
  const url = d.url || "?";
  const secs = Math.round((d.waitedMs || 0) / 1000);
  const parts = [];
  if (/\/items\/\d+/.test(url)) {
    const clicks = d.clicks > 1 ? ` (${d.clicks} clic)` : "";
    parts.push(d.askButton ? `il clic su «Chiedi info» non ha aperto la chat${clicks}: la scheda è rimasta sull'annuncio` : "la scheda è rimasta sull'annuncio");
    if (d.clickable && d.clickable.hydrated === false) parts.push(`il pulsante non è diventato cliccabile in ${Math.round((d.clickable.waitedMs || 0) / 1000)} s (Vinted non ha finito di caricare la pagina)`);
  } else if (/\/inbox\b/.test(url)) {
    if (d.noContent && !d.composer && d.textareas == null) parts.push(d.reinjected ? "chat aperta, ma Vintastic non risponde sulla pagina nemmeno dopo averlo reinserito" : "chat aperta, ma Vintastic non risponde sulla pagina della chat");
    else parts.push(`chat aperta (${url.replace(/^https?:\/\/[^/]+/, "")}) ma il campo #composerInput non c'è (${d.textareas ?? 0} campi di testo sulla pagina): struttura di Vinted cambiata?`);
  } else {
    parts.push(`la scheda è su ${url.replace(/^https?:\/\/[^/]+/, "") || "una pagina sconosciuta"}`);
  }
  if (d.status === "loading") parts.push("pagina ancora in caricamento");
  if (d.newTab) parts.push("la chat si è aperta in una scheda nuova");
  if (d.visible === false) {
    parts.push(d.focusAsked === false
      ? "la scheda era in background: attiva «Scheda in primo piano durante i messaggi» in Impostazioni › Messaggi"
      : "la scheda di Vinted non era visibile anche se Vintastic l'aveva portata in primo piano (finestra coperta da un'altra o tornata su un'altra scheda): lasciala visibile durante i messaggi");
  }
  return `${parts.join("; ")} (attesa ${secs} s).`;
}
