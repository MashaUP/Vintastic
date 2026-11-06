/**
 * Account Session Health.
 *
 * L'id dell'utente Vinted sta nel cookie HttpOnly v_uid: la pagina non lo vede,
 * il service worker sì, leggendo le intestazioni delle richieste che Vinted fa
 * da sé (webRequest, sola lettura, come in Vinted_Relist). CSRF e anon id
 * restano in chrome.storage.session: mai su disco, mai nei log o negli export.
 * Vintastic NON acquisisce codici di verifica, password o 2FA.
 */

import * as db from "./db.js";
import { getSession, setSession, getState, setState } from "./store.js";
import { broadcast } from "./bus.js";
import { VINTED_DOMAINS } from "../shared/constants.js";

export const API_PATTERNS = VINTED_DOMAINS.map((d) => `https://www.${d}/api/*`);

export function userIdFromCookie(cookie) {
  if (!cookie) return null;
  const direct = cookie.match(/(?:^|;\s*)v_uid=(\d+)/);
  if (direct) return direct[1];
  const token = cookie.match(/(?:^|;\s*)access_token_web=[^.;]+\.([^.;]+)\./);
  if (!token) return null;
  try {
    const b64 = token[1].replace(/-/g, "+").replace(/_/g, "/");
    const sub = JSON.parse(atob(b64 + "===".slice((b64.length + 3) % 4)))?.sub;
    return /^\d+$/.test(String(sub)) ? String(sub) : null;
  } catch {
    return null;
  }
}

let lastKey = null;

export function installWebRequest() {
  if (!chrome.webRequest?.onSendHeaders) return;
  chrome.webRequest.onSendHeaders.addListener((details) => {
    let csrf = null;
    let anonId = null;
    let cookie = null;
    for (const h of details.requestHeaders || []) {
      const n = h.name.toLowerCase();
      if (n === "x-csrf-token") csrf = h.value;
      else if (n === "x-anon-id") anonId = h.value;
      else if (n === "cookie") cookie = h.value;
    }
    const origin = new URL(details.url).origin;
    const userId = userIdFromCookie(cookie);
    // Solo rilevamento positivo: un'intestazione Cookie assente non prova un logout
    // (può essere nascosta); il logout lo dicono il cookie v_uid, la pagina o un 401.
    const key = `${userId}@${origin}`;
    if (userId && key !== lastKey) {
      lastKey = key;
      updateSession({ origin, userId, loggedIn: true, source: "headers" }).catch(() => {});
    }
    if (csrf || anonId) {
      getSession("vintedTokens", {}).then((prev) => setSession("vintedTokens", {
        ...prev, [origin]: { csrf: csrf || prev?.[origin]?.csrf || null, anonId: anonId || prev?.[origin]?.anonId || null, at: Date.now() },
      }));
    }
  }, { urls: API_PATTERNS }, ["requestHeaders", "extraHeaders"]);
}

/**
 * Id dell'utente dal cookie v_uid (solo l'id numerico: nessun token viene letto
 * o salvato). Fonte principale; webRequest resta come complemento.
 */
export async function detectFromCookies(origin) {
  if (!chrome.cookies?.get || !origin) return null;
  try {
    const c = await chrome.cookies.get({ url: `${origin}/`, name: "v_uid" });
    const userId = c?.value && /^\d+$/.test(c.value) ? c.value : null;
    const prev = await current();
    if (userId && (prev.userId !== userId || prev.origin !== origin || !prev.loggedIn)) return updateSession({ origin, userId, loggedIn: true, source: "cookie" });
    if (!userId && prev.loggedIn && prev.origin === origin) return updateSession({ origin, userId: null, loggedIn: false, source: "cookie" });
    return prev;
  } catch {
    return null;
  }
}

export async function tokensFor(origin) {
  return (await getSession("vintedTokens", {}))[origin] || {};
}

/** Stato della sessione (ultimo noto). */
export async function current() {
  return getState("session", { loggedIn: false, accountId: null, checkedAt: null });
}

/** Aggiorna lo stato e registra l'account rilevato. */
export async function updateSession(patch) {
  const prev = await current();
  const next = { ...prev, ...patch, checkedAt: Date.now() };
  if (patch.userId === null && patch.loggedIn === false) next.accountId = null;
  if (next.userId && next.origin) next.accountId = `${next.userId}@${next.origin}`;
  if (!next.loggedIn) { next.accountId = patch.accountId ?? null; }
  await setState("session", next);
  if (next.loggedIn && next.accountId) await upsertAccount(next);
  broadcast("vt:session", { session: next });
  return next;
}

export async function upsertAccount(s) {
  const prev = (await db.get("accounts", s.accountId)) || {
    id: s.accountId, userId: s.userId, origin: s.origin, label: "Principale", customLabel: "",
    favorite: true, createdAt: Date.now(), notes: "",
  };
  const acc = {
    ...prev,
    login: s.login || prev.login || null,
    itemCount: s.itemCount ?? prev.itemCount ?? null,
    lastSeenAt: Date.now(),
    sessionStatus: s.challenge ? "verifica richiesta" : s.loggedIn ? "attiva" : "scaduta",
    authProblem: s.challenge ? "Vinted chiede una verifica" : null,
  };
  await db.put("accounts", acc);
  return acc;
}

/**
 * Un account rilevato in passato ma non è quello attivo ora: la sessione è
 * "non corrispondente". Il cambio di account si fa su Vinted (logout/login):
 * un'estensione non può cambiare da sola una sessione autenticata.
 */
export async function matches(accountId) {
  const s = await current();
  return { ok: Boolean(s.loggedIn && s.accountId === accountId), session: s };
}

export const ACCOUNT_SESSION_HINT = "Per cambiare account: esci da Vinted e accedi con l'altro account nella scheda aperta da Vintastic. Codici di verifica e 2FA li inserisci tu: Vintastic non li legge e non li salva.";
