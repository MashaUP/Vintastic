/**
 * Account seguiti su Vinted (per il menu «Venditore») e menu completo.
 * Lettura con GET /users/:id/followed_users (in lista in guard-core.js), nessuna scrittura.
 * Se una campagna è in esecuzione la lettura usa una scheda separata, così la scheda di lavoro
 * della campagna non viene toccata.
 */
import * as db from "./db.js";
import * as tabs from "./tabs.js";
import * as session from "./session.js";
import { getSettings } from "./store.js";
import { cleanRecipients } from "../shared/messages.js";
import { buildSellerMenu } from "../shared/sellers.js";

const MAX_AGE_MS = 24 * 3600_000;   // più vecchio di un giorno: si rilegge all'apertura del menu
const metaKey = (accountId) => `following:${accountId}`;

export async function campaignRunning() {
  return (await db.getAll("campaigns")).some((c) => c.status === "running");
}

/** Elenco degli account seguiti dall'account collegato: dalla memoria se recente, altrimenti da Vinted. */
export async function following({ refresh = false } = {}) {
  const s = await session.current();
  if (!s.userId || !s.accountId) return { users: [], at: null, error: "Nessun account Vinted collegato" };
  const cached = (await db.get("meta", metaKey(s.accountId)))?.value || null;
  if (cached && !refresh && Date.now() - cached.at < MAX_AGE_MS) return { ...cached, cached: true };
  const origin = s.origin || "https://www.vinted.it";
  try {
    const r = await tabs.withReaderTab(origin, `${origin}/member/general/following/${s.userId}`,
      (tabId) => tabs.sendToTab(tabId, { type: "vt:following", userId: s.userId }, 60_000),
      { separate: await campaignRunning() });
    if (r?.outcome !== "done") return { ...(cached || { users: [], at: null }), error: r?.message || "Elenco dei seguiti non letto" };
    const value = { users: r.users, at: Date.now(), accountId: s.accountId };
    await db.put("meta", { key: metaKey(s.accountId), value });
    return value;
  } catch (e) {
    return { ...(cached || { users: [], at: null }), error: e.message };
  }
}

/** Menu Venditore: seguiti, poi destinatari dei messaggi non seguiti, poi gli altri venditori scansionati. */
export async function menu({ refresh = false } = {}) {
  const all = await db.getAll("listings");
  const m = {};
  for (const l of all) { const k = l.sellerId; if (!k) continue; m[k] = m[k] || { sellerId: k, login: l.sellerLogin, count: 0 }; m[k].count++; }
  const fol = await following({ refresh });
  const settings = await getSettings();
  const out = buildSellerMenu({ scanned: Object.values(m), following: fol.users || [], recipients: cleanRecipients(settings.messages?.recipients) });
  return { ...out, followingAt: fol.at || null, followingError: fol.error || null };
}
