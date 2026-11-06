/**
 * Suggerimenti di commenti/domande.
 *  - local (predefinito): regole, nessun dato esce dal browser, costo zero, istantaneo.
 *  - api: endpoint compatibile OpenAI scelto da te (servizio esterno o LLM locale
 *    come Ollama: http://localhost:11434/v1/chat/completions). Si mandano solo i
 *    dati pubblici dell'annuncio. La chiave resta nel tuo browser e non si esporta.
 * In caso di errore dell'API si ripiega sulle regole locali.
 */

import * as db from "./db.js";
import { getSettings } from "./store.js";
import { log } from "./logger.js";
import * as health from "./health.js";
import { suggestLocal, buildPrompt, parseSuggestions } from "../shared/suggest.js";

export async function suggestFor(listing, override = {}) {
  const s = await getSettings();
  const opts = { ...s.ai, ...override };
  const history = (await db.byIndex("suggestions", "listingId", String(listing.id)).catch(() => [])).flatMap((x) => x.texts || []);
  const local = () => suggestLocal(listing, { ...opts, history });
  if (opts.provider !== "api" || !opts.endpoint) return local();
  const avail = await health.moduleAvailable("ai");
  if (!avail.ok) return local();
  try {
    const origin = new URL(opts.endpoint).origin;
    const granted = await chrome.permissions.contains({ origins: [`${origin}/*`] });
    if (!granted) throw new Error(`Permesso per ${origin} non concesso (Impostazioni › AI)`);
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 30_000);
    const headers = { "Content-Type": "application/json" };
    if (opts.apiKey) headers.Authorization = `Bearer ${opts.apiKey}`;
    const res = await fetch(opts.endpoint, {
      method: "POST", headers, signal: ctrl.signal,
      body: JSON.stringify({ model: opts.model || "gpt-4o-mini", messages: buildPrompt(listing, opts), temperature: 0.7 }),
    }).finally(() => clearTimeout(t));
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    const text = json?.choices?.[0]?.message?.content ?? json?.message?.content ?? json?.response ?? "";
    const out = parseSuggestions(text, opts.count).filter((x) => !history.includes(x));
    if (!out.length) throw new Error("Risposta senza suggerimenti utilizzabili");
    await health.recordSuccess("ai");
    return out;
  } catch (e) {
    await health.recordFailure("ai", e.message);
    await log({ level: "warn", category: "system", message: `AI esterna non disponibile, uso le regole locali: ${e.message}` });
    return local();
  }
}
