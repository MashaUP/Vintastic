/**
 * Link del progetto (links.json, standard comuni sezione 1) — funzioni pure.
 */

/** Chiavi vecchie ancora accettate: fino alla 2.2.0 la segnalazione si chiamava «bugReport». */
export const LINK_ALIASES = { bugReport: "bugs" };

/** Porta le chiavi vecchie a quelle nuove; se ci sono entrambe vince la nuova. */
export function normalizeLinks(links) {
  const out = {};
  for (const [k, v] of Object.entries(links || {})) {
    const key = LINK_ALIASES[k] || k;
    if (LINK_ALIASES[k] && links[key]) continue;
    out[key] = v;
  }
  return out;
}
