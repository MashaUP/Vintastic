/**
 * Global Interaction Ledger — logica pura dell'anti-duplicazione.
 *
 * Una voce per (account, annuncio, tipo di interazione). La verifica è separata
 * per tipo: un like già messo non blocca un'offerta, e viceversa.
 * Una voce "running" o "verify" blocca: l'esito potrebbe essere già arrivato a
 * Vinted, quindi ripetere rischierebbe un duplicato.
 */

export const ledgerKey = (accountId, listingId, type) => `${accountId}|${listingId}|${type}`;

/** Può partire questa interazione? */
export function canInteract(entry) {
  if (!entry || entry.simulated) return { allowed: true, reason: "mai eseguita" };
  switch (entry.status) {
    case "completed":
      return { allowed: false, code: "done", reason: `già eseguita il ${new Date(entry.at).toLocaleString("it-IT")}` };
    case "running":
      return { allowed: false, code: "running", reason: "esito non ancora registrato: va verificata prima di ripeterla" };
    case "verify":
      return { allowed: false, code: "verify", reason: "da verificare: Vintastic non sa se è arrivata a Vinted" };
    case "failed":
    case "cancelled":
    case "skipped":
    default:
      return { allowed: true, reason: "tentativo precedente non andato a buon fine" };
  }
}

/** Nuova versione di una voce, con storico. */
export function ledgerUpdate(prev, patch) {
  const at = patch.at || Date.now();
  const base = prev || { history: [] };
  const next = { ...base, ...patch, at };
  next.history = [...(base.history || []), { at, status: patch.status, campaignId: patch.campaignId || null }].slice(-20);
  return next;
}

const normTitle = (t) => String(t || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, " ").trim();

/**
 * Riconosce un annuncio ripubblicato (nuovo id) come continuazione di uno già noto.
 * Prudente: stesso venditore, stesso titolo normalizzato e (stessa foto oppure prezzo entro il 15%).
 * In caso di dubbio restituisce null: l'annuncio è trattato come nuovo.
 */
export function findRelistMatch(listing, known) {
  if (!listing?.sellerId || !listing.title) return null;
  const t = normTitle(listing.title);
  if (t.length < 6) return null;
  const candidates = known.filter((k) => String(k.id) !== String(listing.id)
    && String(k.sellerId) === String(listing.sellerId) && normTitle(k.title) === t);
  const sure = candidates.filter((k) => {
    const samePhoto = k.photoKey && listing.photoKey && k.photoKey === listing.photoKey;
    const p1 = Number(k.price); const p2 = Number(listing.price);
    const closePrice = p1 > 0 && p2 > 0 && Math.abs(p1 - p2) / Math.max(p1, p2) <= 0.15;
    return samePhoto || closePrice;
  });
  if (sure.length !== 1) return null;           // zero o ambiguo: nessun collegamento
  return sure[0].id;
}

/** Riepilogo per annuncio (quali account hanno fatto cosa). */
export function summarize(entries) {
  const out = {};
  for (const e of entries) {
    if (e.simulated) continue;
    const s = (out[e.listingId] ||= { like: null, comment: null, offer: null, accounts: new Set() });
    s[e.type] = e.status;
    s.accounts.add(e.accountId);
  }
  return out;
}
