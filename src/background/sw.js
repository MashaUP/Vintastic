/**
 * Vintastic — service worker (Manifest V3).
 * Punto d'ingresso: eventi del browser, router dei messaggi, allarmi, recupero.
 * Il worker può essere sospeso in qualsiasi momento: tutto lo stato vive in
 * IndexedDB / chrome.storage, mai solo in memoria.
 */

import "../shared/guard-core.js";
import * as db from "./db.js";
import * as store from "./store.js";
import * as engine from "./engine.js";
import * as scanner from "./scanner.js";
import * as session from "./session.js";
import * as tabs from "./tabs.js";
import * as health from "./health.js";
import * as notifyMod from "./notify.js";
import * as cleaner from "./cleaner.js";
import * as updates from "./updates.js";
import * as backup from "./backup.js";
import * as connectivity from "./connectivity.js";
import { suggestFor } from "./ai.js";
import { log, activity } from "./logger.js";
import { attachPort, broadcast } from "./bus.js";
import { applyFilters, newestFirst } from "../shared/filters.js";
import { summarize } from "../shared/ledger.js";
import { computeStats } from "../shared/stats.js";
import { freshCounters, checkLimit } from "../shared/timers.js";
import { OP_TYPES, VERSION } from "../shared/constants.js";
import { uid } from "../shared/util.js";
import { sanitizeMessagesPatch } from "../shared/messages.js";

session.installWebRequest();

// ------------------------------------------------------------------ avvio e recupero

let ready = null;
function init(reason) {
  if (!ready) {
    ready = (async () => {
      const { applied } = await store.loadSettings();
      await db.openDb();
      if (db.lastUpgrade?.steps?.length) await log({ level: "info", category: "persistence", message: `Migrazione database: ${db.lastUpgrade.steps.join(", ")}` });
      if (applied.length) await log({ level: "info", category: "persistence", message: `Migrazione impostazioni: ${applied.join(", ")} (backup salvato)` });
      await engine.recover();
      await ensureAlarms();
      await notifyMod.refreshBadge();
      if (reason) await log({ level: "info", category: "system", message: `Service worker avviato (${reason}) · v${VERSION}` });
      engine.kick(500);
    })().catch(async (e) => {
      ready = null;
      console.error("[Vintastic] avvio", e);
      try { await log({ level: "critical", category: "persistence", message: `Avvio non riuscito: ${e.message}`, stack: e.stack, code: "persistence" }); } catch { /* db non disponibile */ }
      throw e;
    });
  }
  return ready;
}

async function ensureAlarms() {
  const s = await store.getSettings();
  const want = {
    "vt-watchdog": { periodInMinutes: 1 },
    "vt-retention": { periodInMinutes: 24 * 60 },
    "vt-links": { periodInMinutes: 12 * 60 },
  };
  if (s.updates?.autoCheck) want["vt-updates"] = { periodInMinutes: Math.max(1, s.updates.everyHours || 12) * 60 };
  for (const [name, info] of Object.entries(want)) {
    const a = await chrome.alarms.get(name);
    if (!a) chrome.alarms.create(name, { ...info, delayInMinutes: name === "vt-watchdog" ? 0.5 : 1 });
  }
  if (!s.updates?.autoCheck) chrome.alarms.clear("vt-updates");
}

chrome.runtime.onInstalled.addListener(async (details) => {
  await init(details.reason);
  if (details.reason === "install") {
    await activity("system", "Vintastic installato");
    chrome.tabs.create({ url: chrome.runtime.getURL("src/ui/dashboard.html#onboarding") });
  } else if (details.reason === "update") {
    await log({ level: "info", category: "update", message: `Aggiornato da ${details.previousVersion} a ${VERSION}` });
  }
});
chrome.runtime.onStartup.addListener(() => init("startup"));
init(null);

chrome.alarms.onAlarm.addListener(async (alarm) => {
  await init(null);
  switch (alarm.name) {
    case "vt-engine": engine.kick(0); break;
    case "vt-watchdog": await watchdog(); break;
    case "vt-retention": await backup.applyRetention().catch((e) => log({ level: "warn", category: "persistence", message: `Retention: ${e.message}` })); break;
    case "vt-updates": await updates.check().catch(() => {}); break;
    case "vt-links": await updates.refreshLinks().catch(() => {}); break;
    default: break;
  }
});

/** Ogni minuto: rete, sessione in attesa, riprese automatiche, motore. */
async function watchdog() {
  const campaigns = await engine.listCampaigns();
  const active = campaigns.filter((c) => c.status === "running" || (c.status === "paused" && c.autoPaused));
  let sess = await session.current();
  if (sess.origin) sess = (await session.detectFromCookies(sess.origin)) || sess;
  if (active.length || !(await connectivity.state()).online) await connectivity.check(sess.origin || active[0]?.origin);
  await engine.checkAuthPending();
  await engine.autoResumeCheck();
  if (campaigns.some((c) => c.status === "running")) engine.kick(0);
}

// ------------------------------------------------------------------ porte (tempo reale)

chrome.runtime.onConnect.addListener((port) => {
  if (!["vt-ui", "vt-page"].includes(port.name)) return;
  attachPort(port);
  port.onMessage.addListener(async (msg) => {
    if (msg?.type === "ping") port.postMessage({ type: "pong", at: Date.now() });
  });
  overview().then((o) => { try { port.postMessage({ type: "vt:overview", overview: o }); } catch { /* chiusa */ } });
});

// ------------------------------------------------------------------ messaggi

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg.type !== "string" || !msg.type.startsWith("vt:")) return false;
  if (sender.id !== chrome.runtime.id) return false;
  (async () => {
    await init(null);
    switch (msg.type) {
      case "vt:rpc": return rpc(msg.method, msg.params || {}, sender);
      case "vt:ready": {
        if (sender.tab?.id != null) tabs.markReady(sender.tab.id, msg.page);
        if (msg.page) await pageState(msg.page, sender);
        return { ok: true, owned: sender.tab?.id != null && (await tabs.isOwned(sender.tab.id)) };
      }
      case "vt:pageState": await pageState(msg.page, sender); return { ok: true };
      case "vt:scanBatch": return scanner.receiveBatch(msg);
      case "vt:tokens": return session.tokensFor(msg.origin);
      case "vt:clientError":
        await log({ level: "error", category: msg.category || "js", message: msg.message, stack: msg.stack, data: { url: sender.url?.split("?")[0] } });
        return { ok: true };
      default: return { ok: false, error: "messaggio sconosciuto" };
    }
  })().then((r) => sendResponse(r), (e) => {
    log({ level: "error", category: "js", message: `${msg.type}${msg.method ? `/${msg.method}` : ""}: ${e.message}`, stack: e.stack });
    sendResponse({ ok: false, error: e.message, guard: Boolean(e.guard), __vtError: true });
  });
  return true;
});

/** Stato della pagina Vinted riferito dal content script (login, verifica in corso). */
async function pageState(page, sender) {
  if (!page?.origin) return;
  await session.detectFromCookies(page.origin);
  const patch = { origin: page.origin, challenge: Boolean(page.challenge) };
  if (page.loggedIn === false) Object.assign(patch, { loggedIn: false, userId: null });
  if (page.login) patch.login = page.login;
  if (page.itemCount != null) patch.itemCount = page.itemCount;
  const prev = await session.current();
  if (prev.challenge !== patch.challenge || page.loggedIn === false || (page.login && page.login !== prev.login)) await session.updateSession(patch);
  if (page.challenge) await log({ level: "warn", category: "auth", message: `Vinted chiede una verifica sulla pagina ${sender.url?.split("?")[0]}`, code: "captcha" });
  // Nome utente: una sola lettura (GET /users/:id, in lista) dalla scheda appena caricata, al massimo ogni 30 minuti.
  const cur = await session.current();
  const lastFetch = await store.getSession("loginFetchAt", 0);
  if (cur.loggedIn && cur.userId && !page.challenge && sender.tab?.id != null && (!cur.login || Date.now() - lastFetch > 30 * 60_000) && Date.now() - lastFetch > 60_000) {
    await store.setSession("loginFetchAt", Date.now());
    const r = await tabs.sendToTab(sender.tab.id, { type: "vt:session", userId: cur.userId }, 15_000).catch(() => null);
    if (r?.login) await session.updateSession({ login: r.login, itemCount: r.itemCount ?? null });
  }
}

// ------------------------------------------------------------------ comandi da tastiera e notifiche

chrome.commands?.onCommand.addListener(async (cmd) => {
  await init(null);
  if (cmd === "open-dashboard") chrome.tabs.create({ url: chrome.runtime.getURL("src/ui/dashboard.html") });
  if (cmd === "toggle-pause") {
    const running = (await engine.listCampaigns()).filter((c) => c.status === "running");
    if (running.length) await engine.pauseAll("user", "Pausa da tastiera");
    else for (const c of (await engine.listCampaigns()).filter((x) => x.status === "paused" && x.pauseReason === "user")) await engine.resume(c.id);
  }
  if (cmd === "kill-switch") await killAll();
  if (cmd === "toggle-widget") {
    const s = await store.getSettings();
    await store.saveSettings({ overlay: { widget: !s.overlay?.widget } });
    broadcast("vt:settings", { settings: await store.getSettings() });
  }
});

chrome.notifications?.onClicked.addListener(async (id) => {
  const n = await db.get("notifications", id);
  const hash = n?.link?.startsWith("#") ? n.link : "#notifications";
  chrome.tabs.create({ url: chrome.runtime.getURL(`src/ui/dashboard.html${hash}`) });
  chrome.notifications.clear(id);
});

async function killAll() {
  await health.setKillSwitch(true);
  const n = await engine.pauseAll("kill", "Kill Switch globale attivato: nessuna operazione riparte finché non lo spegni.");
  await cleaner.cancelClean();
  await notifyMod.notify({ category: "error", level: "critical", title: "Kill Switch attivato", body: `${n} campagne fermate. Spegnilo da Salute o dal popup per ripartire.`, link: "#health", persistent: true });
  return n;
}

// ------------------------------------------------------------------ RPC

async function overview() {
  const [settings, sess, campaigns, conn, upd, counters, authPending] = await Promise.all([
    store.getSettings(), session.current(), engine.listCampaigns(), connectivity.state(),
    store.getState("updateStatus", null), store.getState("counters", null), store.getState("authPending", null),
  ]);
  const accounts = await db.getAll("accounts");
  const c = freshCounters(counters);
  return {
    version: VERSION,
    killSwitch: settings.killSwitch,
    session: sess,
    account: accounts.find((a) => a.id === sess.accountId) || null,
    connectivity: conn,
    update: upd,
    authPending,
    counters: c,
    limits: settings.limits,
    overlay: settings.overlay,
    features: settings.features,
    moduleKill: settings.moduleKill,
    theme: settings.theme,
    campaigns: campaigns.map((x) => ({ id: x.id, name: x.name, status: x.status, dryRun: x.dryRun, progress: x.progress, nextAt: x.nextAt, nextLabel: x.nextLabel, current: x.current, pauseReason: x.pauseReason, pauseDetail: x.pauseDetail, accountId: x.accountId, pendingConfirm: x.pendingConfirm, updatedAt: x.updatedAt, createdAt: x.createdAt })),
    links: (await store.getState("links", null))?.links || null,
  };
}

async function opsLog() {
  return (await db.getAll("journal")).filter((j) => j.phase === "result" && j.status !== "notSent");
}

async function rpc(method, p, sender) {
  switch (method) {
    case "overview": return overview();

    // impostazioni
    case "settings.get": return store.getSettings();
    case "settings.save": {
      if ("killSwitch" in (p.patch || {})) throw new Error("Il Kill Switch si cambia solo dal suo pulsante.");
      const patch = { ...(p.patch || {}) };
      if (patch.messages) patch.messages = sanitizeMessagesPatch(patch.messages);
      const s = await store.saveSettings(patch);
      await ensureAlarms();
      broadcast("vt:settings", { settings: s });
      return s;
    }
    case "settings.backups": return Object.fromEntries(Object.entries(await chrome.storage.local.get(null)).filter(([k]) => k.startsWith("settingsBackup_")));

    // account e sessione
    case "accounts.list": {
      const accounts = await db.getAll("accounts");
      const ledger = await db.getAll("ledger");
      const campaigns = await engine.listCampaigns();
      const listings = await db.getAll("listings");
      const sess = await session.current();
      return accounts.map((a) => ({
        ...a,
        current: a.id === sess.accountId,
        sessionStatus: a.id === sess.accountId ? (sess.challenge ? "verifica richiesta" : "attiva") : "non attiva in questo browser",
        interactions: ledger.filter((e) => e.accountId === a.id && e.status === "completed" && !e.simulated).length,
        scanned: listings.filter((l) => l.scannedBy === a.id).length,
        activeCampaigns: campaigns.filter((c) => c.accountId === a.id && c.status === "running").length,
      }));
    }
    case "accounts.update": {
      const a = await db.get("accounts", p.id);
      if (!a) throw new Error("Account non trovato");
      const allowed = ["label", "customLabel", "favorite", "notes"];
      for (const k of allowed) if (k in p.patch) a[k] = p.patch[k];
      await db.put("accounts", a);
      return a;
    }
    case "accounts.delete": {
      const used = (await engine.listCampaigns()).some((c) => c.accountId === p.id && ["running", "paused"].includes(c.status));
      if (used) throw new Error("L'account ha campagne attive o in pausa.");
      await db.del("accounts", p.id);
      return true;
    }
    case "session.get": return session.current();
    case "session.check": {
      const s = await session.current();
      const origin = p.origin || s.origin || "https://www.vinted.it";
      await session.detectFromCookies(origin);
      const { tabId: id, page } = await tabs.ensureAt(origin, `${origin}/`, { timeoutMs: 30_000 });
      const r = await tabs.sendToTab(id, { type: "vt:session", userId: (await session.current()).userId }, 30_000).catch((e) => ({ error: e.message }));
      if (r && !r.error) await session.updateSession({ origin, loggedIn: r.loggedIn !== false && Boolean((await session.current()).userId), login: r.login, itemCount: r.itemCount, challenge: Boolean(r.challenge || page?.challenge) });
      return { session: await session.current(), page, detail: r };
    }
    case "session.openLogin": {
      const s = await session.current();
      const origin = p.origin || s.origin || "https://www.vinted.it";
      const id = await tabs.workerTab(origin, `${origin}/`, { active: true });
      await tabs.focus(id);
      return { tabId: id, hint: session.ACCOUNT_SESSION_HINT };
    }

    // scansione e annunci
    case "scan.start": return scanner.startScan({ url: p.url, tabId: p.useCurrentTab ? sender.tab?.id ?? null : null, maxItems: p.maxItems });
    case "scan.cancel": return scanner.cancelScan(p.id);
    case "scans.list": return (await db.getAll("scans")).sort((a, b) => b.startedAt - a.startedAt).slice(0, p.limit || 50);
    case "listings.query": {
      const all = await db.getAll("listings");
      const sess = await session.current();
      const accountId = p.accountId || sess.accountId;
      const ledger = await db.getAll("ledger");
      let excludeKeys;
      if (p.filters?.excludeDone && accountId) {
        excludeKeys = new Set(ledger.filter((e) => e.accountId === accountId && e.status === "completed" && p.filters.excludeDone.includes(e.type)).map((e) => String(e.listingId)));
      }
      const r = applyFilters(all, { ...(p.filters || {}), excludeKeys });
      const sum = summarize(ledger);
      const items = (await db.getAll("items"));
      const camps = new Map((await engine.listCampaigns()).map((c) => [c.id, c.name]));
      const offset = p.offset || 0;
      const limit = Math.min(p.limit || 50, 500);
      // Ordinamento: campo + direzione (desc = più recenti / più cari / Z→A in cima).
      const legacy = p.dir ? null : { price: ["price", "asc"], "-price": ["price", "desc"], title: ["title", "asc"], "-date": ["date", "desc"], "-seen": ["seen", "desc"] }[p.sort];
      const [sortKey, dir] = legacy || [p.sort || "default", p.dir === "asc" ? "asc" : "desc"];
      let list = r.items;
      const cmps = {
        date: (a, b) => newestFirst(p.filters?.dateField || "auto")(b, a),           // crescente = dal meno recente
        price: (a, b) => (a.price ?? 0) - (b.price ?? 0),
        title: (a, b) => (a.title || "").localeCompare(b.title || "", "it"),
        seen: (a, b) => (a.lastSeenAt ?? 0) - (b.lastSeenAt ?? 0),
      };
      if (cmps[sortKey]) list = list.slice().sort((a, b) => (dir === "asc" ? 1 : -1) * cmps[sortKey](a, b));
      else if (dir === "asc") list = list.slice().reverse();
      const page = list.slice(offset, offset + limit).map((l) => ({
        ...l,
        interactions: sum[l.id] ? { like: sum[l.id].like, comment: sum[l.id].comment, offer: sum[l.id].offer, message: sum[l.id].message, accounts: [...sum[l.id].accounts] } : null,
        campaigns: [...new Set(items.filter((i) => i.listingId === l.id && !i.removed).map((i) => camps.get(i.campaignId)).filter(Boolean))],
      }));
      return { items: page, total: r.items.length, all: r.total, noDate: r.noDate, ids: p.withIds ? list.map((l) => l.id) : undefined };
    }
    case "listings.get": return db.get("listings", p.id);
    case "listings.byIds": return Promise.all((p.ids || []).map((id) => db.get("listings", String(id)))).then((x) => x.filter(Boolean));
    case "listings.delete": { for (const id of p.ids || []) await db.del("listings", id); return true; }
    case "listings.sellers": {
      const all = await db.getAll("listings");
      const m = {};
      for (const l of all) { const k = l.sellerId || "?"; m[k] = m[k] || { sellerId: k, login: l.sellerLogin, count: 0 }; m[k].count++; }
      return Object.values(m).sort((a, b) => b.count - a.count);
    }
    case "filters.list": return (await db.get("meta", "savedFilters"))?.value || [];
    case "filters.save": {
      const cur = (await db.get("meta", "savedFilters"))?.value || [];
      const next = [...cur.filter((f) => f.name !== p.name), { name: String(p.name).slice(0, 60), filters: p.filters, at: Date.now() }];
      await db.put("meta", { key: "savedFilters", value: next });
      return next;
    }
    case "filters.delete": {
      const cur = (await db.get("meta", "savedFilters"))?.value || [];
      await db.put("meta", { key: "savedFilters", value: cur.filter((f) => f.name !== p.name) });
      return true;
    }

    // campagne
    case "campaigns.list": return engine.listCampaigns();
    case "campaigns.get": return { campaign: await engine.getCampaign(p.id), items: await engine.campaignItems(p.id) };
    case "campaigns.create": {
      const listings = p.listingIds?.length ? (await Promise.all(p.listingIds.map((id) => db.get("listings", String(id))))).filter(Boolean) : [];
      return engine.createCampaign({ ...p, listings });
    }
    case "campaigns.update": return engine.updateCampaign(p.id, p.patch || {});
    case "campaigns.delete": return engine.deleteCampaigns([p.id]);
    case "campaigns.deleteMany": {
      const ids = p.all ? (await engine.listCampaigns()).map((c) => c.id) : (p.ids || []);
      return engine.deleteCampaigns(ids);
    }
    case "campaigns.add": {
      let listings = p.listings || [];
      if (p.listingIds?.length) listings = (await Promise.all(p.listingIds.map((id) => db.get("listings", String(id))))).filter(Boolean);
      return engine.addToCampaign(p.id, listings, p.spec || {}, p.where || "end");
    }
    case "campaigns.mutate": return engine.mutateQueue(p.id, p.action, p.args || {});
    case "campaigns.preview": return engine.preview(p.id);
    case "campaigns.approve": return engine.approve(p.id);
    case "campaigns.start": return engine.start(p.id);
    case "campaigns.pause": return engine.pause(p.id, "user", "Pausa manuale");
    case "campaigns.resume": return engine.resume(p.id);
    case "campaigns.stop": return engine.stop(p.id);
    case "campaigns.reopen": return engine.reopen(p.id);
    case "campaigns.goLive": return engine.goLive(p.id);
    case "campaigns.confirmOp": { await engine.confirmOp(p.id, p.opId); return engine.resume(p.id); }
    case "campaigns.verifyOp": return engine.verifyOp(p.id, p.itemId, p.opId);
    case "campaigns.pauseAll": return engine.pauseAll("user", "Pausa di tutte le campagne");

    // ledger, recupero
    case "ledger.list": {
      const all = await db.getAll("ledger");
      return all.filter((e) => (!p.listingId || e.listingId === String(p.listingId)) && (!p.accountId || e.accountId === p.accountId)).sort((a, b) => b.at - a.at).slice(0, p.limit || 500);
    }
    case "recovery.resolveAll": {
      // L'utente ha controllato su Vinted: tutte le operazioni «da verificare» (filtrate per tipo) erano andate / non erano andate.
      const items = await db.getAll("items");
      let n = 0;
      for (const i of items) for (const o of i.ops) {
        if (o.status !== "verify" || (p.type && o.type !== p.type)) continue;
        await engine.mutateQueue(i.campaignId, "resolveVerify", { id: i.id, opId: o.id, done: Boolean(p.done) });
        n++;
      }
      return { resolved: n };
    }
    case "recovery.list": {
      const items = await db.getAll("items");
      const camps = await engine.listCampaigns();
      const verify = items.flatMap((i) => i.ops.filter((o) => o.status === "verify").map((o) => ({ campaignId: i.campaignId, campaign: camps.find((c) => c.id === i.campaignId)?.name, itemId: i.id, op: o, listing: i.listing })));
      const failed = items.flatMap((i) => i.ops.filter((o) => o.status === "failed").map((o) => ({ campaignId: i.campaignId, campaign: camps.find((c) => c.id === i.campaignId)?.name, itemId: i.id, op: o, listing: i.listing })));
      const interrupted = camps.filter((c) => (c.status === "paused" && c.pauseReason !== "user") || c.recoveredAt);
      return { verify, failed, interrupted, lastRecovery: await store.getState("lastRecovery", null), authPending: await store.getState("authPending", null) };
    }

    // suggerimenti
    case "suggest.generate": {
      const listing = p.listing || await db.get("listings", String(p.listingId));
      if (!listing) throw new Error("Annuncio non trovato: scansiona prima l'armadio.");
      const texts = await suggestFor(listing, p.opts || {});
      const rec = { id: uid("s_"), listingId: String(listing.id), title: listing.title, url: listing.url, at: Date.now(), texts, source: "manuale", used: false };
      await db.put("suggestions", rec);
      await activity("comment", `Commento suggerito per «${listing.title?.slice(0, 40)}»`, { listingId: listing.id });
      return rec;
    }
    case "suggestions.list": return (await db.getAll("suggestions")).sort((a, b) => b.at - a.at).slice(0, p.limit || 200);
    case "suggestions.update": { const r = await db.get("suggestions", p.id); if (r) await db.put("suggestions", { ...r, ...p.patch }); return true; }

    // notifiche
    case "notifications.list": return (await db.getAll("notifications")).sort((a, b) => b.at - a.at).slice(0, p.limit || 300);
    case "notifications.read": await notifyMod.markRead(p.ids || null); return true;
    case "notifications.delete": {
      const ids = p.all ? (await db.getAll("notifications")).map((n) => n.id) : (p.ids || []);
      for (const id of ids) await db.del("notifications", id);
      await notifyMod.refreshBadge();
      for (const id of ids) chrome.notifications?.clear(id);
      return { deleted: ids.length };
    }
    case "notifications.test": return notifyMod.notify({ category: "info", level: "info", title: "Notifica di prova", body: "Le notifiche di Vintastic funzionano." });
    case "cleaner.preview": return cleaner.preview(p.pages || 3);
    case "cleaner.clean": cleaner.clean(p.ids || []).catch(() => {}); return { started: true };
    case "cleaner.pause": return cleaner.pauseClean(p.paused !== false);
    case "cleaner.cancel": return cleaner.cancelClean();
    case "cleaner.status": return cleaner.status();

    // log e diagnostica
    case "logs.query": {
      let logs = await db.getAll("logs");
      if (p.level) logs = logs.filter((l) => l.level === p.level);
      if (p.category) logs = logs.filter((l) => l.category === p.category);
      if (p.campaignId) logs = logs.filter((l) => l.campaignId === p.campaignId);
      if (p.listingId) logs = logs.filter((l) => l.listingId === p.listingId);
      if (p.accountId) logs = logs.filter((l) => l.accountId === p.accountId);
      if (p.opType) logs = logs.filter((l) => l.opType === p.opType);
      if (p.search) { const q = p.search.toLowerCase(); logs = logs.filter((l) => `${l.message} ${l.solution || ""}`.toLowerCase().includes(q)); }
      return logs.sort((a, b) => b.at - a.at).slice(0, p.limit || 500);
    }
    case "logs.clear": {
      const logs = await db.getAll("logs");
      const sel = logs.filter((l) => (!p.level || l.level === p.level) && (!p.category || l.category === p.category) && (!p.before || l.at < p.before));
      for (const l of sel) await db.del("logs", l.seq);
      return sel.length;
    }
    case "activity.list": return (await db.getAll("activity")).sort((a, b) => b.at - a.at).slice(0, p.limit || 100);
    case "support.bundle": return backup.supportBundle({ health: await health.fullCheck({ engineState: engine.engineState() }) });

    // salute
    case "health.check": return health.fullCheck({ engineState: engine.engineState() });
    case "health.breakers": return health.breakers();
    case "health.resetBreaker": await health.resetBreaker(p.module); return true;
    case "health.killSwitch": {
      if (p.on) return { paused: await killAll() };
      await health.setKillSwitch(false);
      return { paused: 0 };
    }
    case "health.moduleKill": {
      const s = await store.getSettings();
      await store.saveSettings({ moduleKill: { ...s.moduleKill, [p.module]: Boolean(p.on) } });
      await log({ level: "warn", category: "system", message: `Kill switch del modulo ${p.module}: ${p.on ? "attivo" : "spento"}` });
      return true;
    }
    case "health.repairDb": {
      const ic = await db.integrityCheck();
      for (const id of ic.orphans || []) await db.del("items", id);
      const rec = await engine.recover();
      return { removedOrphans: (ic.orphans || []).length, recovery: rec };
    }
    case "health.connectivity": return connectivity.check(p.origin);

    // statistiche
    case "stats.get": {
      const [ledger, listings, campaigns, scans, accounts] = await Promise.all([db.getAll("ledger"), db.getAll("listings"), engine.listCampaigns(), db.getAll("scans"), db.getAll("accounts")]);
      return computeStats({ ledger, listings, campaigns, scans, accounts, opsLog: await opsLog() }, p.range || "7d", Date.now(), p.from, p.to);
    }
    case "limits.status": {
      const s = await store.getSettings();
      const sess = await session.current();
      const counters = await store.getState("counters", null);
      return Object.fromEntries(OP_TYPES.filter((t) => t !== "comment").map((t) => [t, checkLimit(counters, p.accountId || sess.accountId, t, s.limits)]));
    }

    // aggiornamenti e link
    case "updates.check": return updates.check({ manual: true });
    case "updates.status": return store.getState("updateStatus", null);
    case "updates.download": return updates.downloadVerified();
    case "updates.install": setTimeout(() => chrome.runtime.reload(), 300); return { reloading: true };
    case "links.get": return updates.refreshLinks({ force: Boolean(p.force) });

    // backup
    case "backup.export": return backup.exportData(p.parts);
    case "backup.preview": return backup.previewImport(p.json);
    case "backup.import": return backup.importData(p.json, p.parts);
    case "backup.preImport": return backup.restorePreImport();
    case "retention.apply": return backup.applyRetention();

    // discord
    case "discord.test": return notifyMod.sendDiscord("test", { title: "Vintastic: prova del webhook", body: "Se leggi questo messaggio, il webhook funziona.", level: "success", at: Date.now() }, { force: true });

    default: throw new Error(`Metodo sconosciuto: ${method}`);
  }
}

self.addEventListener("unhandledrejection", (ev) => {
  log({ level: "error", category: "js", message: `Promessa non gestita: ${ev.reason?.message || ev.reason}`, stack: ev.reason?.stack });
});
self.addEventListener("error", (ev) => {
  log({ level: "error", category: "js", message: ev.message, stack: ev.error?.stack });
});
