/**
 * Centro notifiche: registro con priorità, raggruppamento, storico, notifiche di
 * sistema facoltative, badge sull'icona e inoltro (facoltativo) a Discord.
 */

import * as db from "./db.js";
import { broadcast } from "./bus.js";
import { getSettings } from "./store.js";
import { log } from "./logger.js";
import { uid } from "../shared/util.js";
import { APP_NAME, VERSION } from "../shared/constants.js";

export const NOTIF_CATEGORIES = {
  campaignStart: "Campagna iniziata",
  campaignDone: "Campagna completata",
  campaignPaused: "Campagna in pausa",
  error: "Errore",
  sessionExpired: "Sessione scaduta",
  newVersion: "Nuova versione",
  limitReached: "Limite raggiunto",
  connection: "Problemi di connessione",
  verify: "Operazione da verificare",
  info: "Informazione",
};
export const PRIORITY = { info: 0, success: 1, warning: 2, error: 3, critical: 4 };

const DISCORD_RE = /^https:\/\/(?:ptb\.|canary\.)?discord(?:app)?\.com\/api\/webhooks\/\d+\/[\w-]+$/;
export const isValidWebhook = (u) => DISCORD_RE.test(String(u || "").trim());

export async function notify(n) {
  const settings = await getSettings();
  const note = {
    id: uid("n_"),
    at: Date.now(),
    category: NOTIF_CATEGORIES[n.category] ? n.category : "info",
    level: PRIORITY[n.level] != null ? n.level : "info",
    title: String(n.title || APP_NAME).slice(0, 120),
    body: String(n.body || "").slice(0, 600),
    link: n.link || null,                 // pagina interna della dashboard (#campaigns/<id>) o URL Vinted
    persistent: Boolean(n.persistent),
    groupKey: n.groupKey || n.category || "info",
    campaignId: n.campaignId || null,
    read: false,
  };
  // Raggruppamento: stesso gruppo entro 60 s → aggiorna la voce invece di duplicarla.
  try {
    const recent = (await db.getAll("notifications")).filter((x) => x.groupKey === note.groupKey && note.at - x.at < 60_000 && x.title === note.title);
    if (recent.length) {
      const prev = recent[recent.length - 1];
      note.id = prev.id;
      note.count = (prev.count || 1) + 1;
    }
    await db.put("notifications", note);
  } catch (e) {
    await log({ level: "error", category: "persistence", message: `Notifica non salvata: ${e.message}`, code: "persistence" });
  }
  broadcast("vt:notification", { note, durationSec: settings.notifications?.durationSec ?? 6 });
  await refreshBadge();

  const enabled = settings.notifications?.enabled !== false && settings.notifications?.categories?.[note.category] !== false;
  if (enabled && settings.notifications?.system && chrome.notifications) {
    try {
      chrome.notifications.create(note.id, {
        type: "basic",
        iconUrl: chrome.runtime.getURL("icons/icon128.png"),
        title: note.title,
        message: note.body || note.title,
        priority: Math.min(2, PRIORITY[note.level] >= 3 ? 2 : 0),
        requireInteraction: note.persistent || PRIORITY[note.level] >= 3,
      });
    } catch { /* notifiche di sistema non disponibili */ }
  }
  const discordEvent = { campaignDone: "campaignDone", error: "error", newVersion: "update", connection: "system", sessionExpired: "system", limitReached: "system" }[note.category];
  if (discordEvent) sendDiscord(discordEvent, note).catch(() => {});
  return note;
}

export async function refreshBadge() {
  try {
    const all = await db.getAll("notifications");
    const n = all.filter((x) => !x.read && PRIORITY[x.level] >= 2).length;
    await chrome.action.setBadgeText({ text: n ? String(Math.min(n, 99)) : "" });
    await chrome.action.setBadgeBackgroundColor({ color: "#e0245e" });
  } catch { /* badge non disponibile */ }
}

export async function markRead(ids = null) {
  const all = await db.getAll("notifications");
  const sel = all.filter((x) => !ids || ids.includes(x.id));
  await db.putMany("notifications", sel.map((x) => ({ ...x, read: true })));
  await refreshBadge();
}

let lastDiscord = 0;

/**
 * Inoltro a un webhook Discord TUO, salvato solo nel tuo browser (mai nel
 * repository né negli export). Serve il permesso facoltativo per discord.com.
 */
export async function sendDiscord(event, note, { force = false } = {}) {
  const s = await getSettings();
  const url = s.discord?.webhookUrl;
  if (!force && (!s.features?.discord || s.moduleKill?.discord || !s.discord?.events?.[event])) return { sent: false, reason: "disattivato" };
  if (!isValidWebhook(url)) return { sent: false, reason: "webhook non valido" };
  const granted = await chrome.permissions.contains({ origins: ["https://discord.com/*"] }).catch(() => false);
  if (!granted) return { sent: false, reason: "permesso per discord.com non concesso" };
  const wait = 2000 - (Date.now() - lastDiscord);
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastDiscord = Date.now();
  const colors = { info: 0x8f6ef2, success: 0x22c55e, warning: 0xf59e0b, error: 0xef4444, critical: 0xb91c1c };
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      username: APP_NAME,
      embeds: [{ title: note.title, description: note.body?.slice(0, 1800) || "", color: colors[note.level] || colors.info, footer: { text: `${APP_NAME} v${VERSION}` }, timestamp: new Date(note.at || Date.now()).toISOString() }],
      allowed_mentions: { parse: [] },
    }),
  });
  if (!res.ok) {
    await log({ level: "warn", category: "discord", message: `Discord ha risposto HTTP ${res.status}`, solution: "Controlla l'URL del webhook in Impostazioni › Discord." });
    return { sent: false, reason: `HTTP ${res.status}` };
  }
  return { sent: true };
}
