/**
 * Menu «Venditore» (Aggiungi annunci alla coda): account che segui su Vinted, poi i destinatari
 * dei messaggi che non segui, poi gli altri venditori di cui hai annunci scansionati.
 * Funzione pura (testata in tests/unit/sellers.test.mjs).
 */

/**
 * @param scanned    [{ sellerId, login, count }] venditori con annunci scansionati
 * @param following  [{ id, login }] account seguiti (da Vinted)
 * @param recipients [{ id, label }] destinatari autorizzati dei messaggi
 * @returns {{ following: Entry[], recipients: Entry[], scanned: Entry[], all: Entry[] }}
 *   Entry = { sellerId, login, label, count, following, recipient }
 */
export function buildSellerMenu({ scanned = [], following = [], recipients = [] } = {}) {
  const counts = new Map();
  const logins = new Map();
  for (const s of scanned) {
    const id = String(s?.sellerId ?? "");
    if (!/^\d+$/.test(id)) continue;
    counts.set(id, (counts.get(id) || 0) + (Number(s.count) || 0));
    if (s.login) logins.set(id, s.login);
  }
  const fol = new Map();
  for (const u of following) {
    const id = String(u?.id ?? "");
    if (/^\d+$/.test(id) && !fol.has(id)) fol.set(id, u.login || null);
  }
  const rec = new Map();
  for (const r of recipients) {
    const id = String(r?.id ?? "");
    if (/^\d+$/.test(id) && !rec.has(id)) rec.set(id, r.label || "");
  }
  const entry = (id) => ({
    sellerId: id,
    login: fol.get(id) || logins.get(id) || null,
    label: rec.get(id) || "",
    count: counts.get(id) || 0,
    following: fol.has(id),
    recipient: rec.has(id),
  });
  const byName = (a, b) => String(a.login || a.label || a.sellerId).localeCompare(String(b.login || b.label || b.sellerId), "it");
  const out = { following: [], recipients: [], scanned: [] };
  for (const id of fol.keys()) out.following.push(entry(id));
  for (const id of rec.keys()) if (!fol.has(id)) out.recipients.push(entry(id));
  for (const id of counts.keys()) if (!fol.has(id) && !rec.has(id)) out.scanned.push(entry(id));
  out.following.sort(byName);
  out.recipients.sort(byName);
  out.scanned.sort((a, b) => b.count - a.count || byName(a, b));
  out.all = [...out.following, ...out.recipients, ...out.scanned];
  return out;
}

/** Testo dell'opzione nel menu. */
export function sellerOptionLabel(e) {
  const name = e.login ? `@${e.login}` : e.label || e.sellerId;
  const extra = e.label && e.login ? ` · ${e.label}` : "";
  const n = e.count ? `${e.count} annunci` : "da scansionare";
  return `${name}${extra} (${n})`;
}
