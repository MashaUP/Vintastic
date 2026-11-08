/**
 * Dashboard — guscio dell'applicazione: sidebar, barra superiore, router,
 * ricerca globale, comando rapido (Ctrl+K), scorciatoie, aggiornamenti live.
 */

import { h, icon, logo, rpc, live, toast, modal, installTooltips, confirmBox } from "./lib.js";
import { VERSION, DEFAULT_LINKS } from "../shared/constants.js";
import * as home from "./pages/home.js";
import * as accounts from "./pages/accounts.js";
import * as scanner from "./pages/scanner.js";
import * as listings from "./pages/listings.js";
import * as campaigns from "./pages/campaigns.js";
import * as offers from "./pages/offers.js";
import * as suggestions from "./pages/suggestions.js";
import * as notifications from "./pages/notifications.js";
import * as stats from "./pages/stats.js";
import * as logs from "./pages/logs.js";
import * as health from "./pages/health.js";
import * as recovery from "./pages/recovery.js";
import * as settingsPage from "./pages/settings.js";
import * as help from "./pages/help.js";
import { startOnboarding } from "./pages/onboarding.js";

export const PAGES = [
  { id: "", label: "Dashboard", icon: "home", mod: home },
  { id: "accounts", label: "Account", icon: "user", mod: accounts },
  { id: "scanner", label: "Scanner", icon: "scan", mod: scanner },
  { id: "listings", label: "Annunci", icon: "list", mod: listings },
  { id: "campaigns", label: "Campagne", icon: "zap", mod: campaigns },
  { id: "offers", label: "Smart Offer", icon: "tag", mod: offers },
  { id: "suggestions", label: "Domande al venditore", icon: "sparkles", mod: suggestions },
  { id: "notifications", label: "Notifiche", icon: "bell", mod: notifications },
  { id: "stats", label: "Statistiche", icon: "chart", mod: stats },
  { id: "logs", label: "Log", icon: "file", mod: logs },
  { id: "health", label: "Salute", icon: "pulse", mod: health },
  { id: "recovery", label: "Recupero", icon: "lifebuoy", mod: recovery },
  { id: "settings", label: "Impostazioni", icon: "settings", mod: settingsPage },
  { id: "help", label: "Aiuto", icon: "help", mod: help },
];

const ctx = {
  rpc,
  overview: null,
  settings: null,
  links: DEFAULT_LINKS,
  route: { page: "", params: [], query: {} },
  navigate: (hash) => { location.hash = hash; },
  refresh: () => renderPage(),
  toast,
};
window.__vt = ctx;          // utile per il debug dalla console della dashboard

const app = document.getElementById("app");
let current = null;
let unreadCount = 0;

function parseHash() {
  const raw = location.hash.replace(/^#/, "");
  const [path, qs] = raw.split("?");
  const parts = path.split("/").filter(Boolean);
  return { page: parts[0] || "", params: parts.slice(1), query: Object.fromEntries(new URLSearchParams(qs || "")) };
}

function applyTheme() {
  document.documentElement.dataset.theme = ctx.settings?.theme === "light" ? "light" : "dark";
  app.classList.toggle("compact", ctx.settings?.layout === "compact");
}

function sidebar() {
  const links = ctx.links || DEFAULT_LINKS;
  return h("aside", { class: "side", "aria-label": "Navigazione" },
    h("div", { class: "brand" }, logo(44), h("b", {}, "Vintastic")),
    h("nav", { class: "nav" }, PAGES.map((p) => h("a", {
      href: `#${p.id}`, class: ctx.route.page === p.id ? "active" : "", "aria-current": ctx.route.page === p.id ? "page" : null, title: p.label,
    }, icon(p.icon, 20), h("span", { class: "label" }, p.label), p.id === "notifications" && unreadCount ? h("span", { class: "count" }, String(unreadCount)) : null,
    p.id === "recovery" && ctx.overview?.campaigns?.some((c) => c.progress?.verify) ? h("span", { class: "count" }, "!") : null))),
    h("div", { class: "side-foot" },
      h("div", { class: "ver" }, h("div", { class: "row" }, h("b", {}, `Versione v${VERSION}`)),
        h("div", { class: "muted small" }, ctx.overview?.update?.available ? `Disponibile la ${ctx.overview.update.latest}` : ctx.overview?.update?.checkedAt ? "Sei all'ultima versione" : "Aggiornamenti non ancora controllati"),
        h("button", { class: "btn sm", style: { marginTop: "8px" }, onclick: checkUpdates }, icon("refresh", 14), "Cerca aggiornamento")),
      h("div", { class: "side-links" },
        h("a", { href: links.discord?.url, target: "_blank", rel: "noopener" }, icon("discord", 16), h("span", {}, "Discord")),
        h("a", { href: links.github?.url, target: "_blank", rel: "noopener" }, icon("github", 16), h("span", {}, "GitHub")),
        h("a", { href: links.kofi?.url, target: "_blank", rel: "noopener" }, icon("coffee", 16), h("span", {}, "Ko-fi")))));
}

async function checkUpdates() {
  const st = await rpc("updates.check").catch((e) => ({ ok: false, error: e.message }));
  if (!st.ok) toast("Controllo aggiornamenti", st.error, "warning");
  else if (st.available) { toast(`Disponibile Vintastic ${st.latest}`, "Apri Salute › Aggiornamenti per scaricarla.", "success"); ctx.navigate("#health"); }
  else toast("Nessun aggiornamento", `Hai già l'ultima versione (${st.installed}).`, "success");
}

function topbar() {
  const o = ctx.overview || {};
  const acc = o.account;
  const search = h("input", { type: "search", placeholder: "Cerca account, campagne, annunci… (/)", "aria-label": "Ricerca globale", id: "global-search" });
  search.addEventListener("keydown", (e) => { if (e.key === "Enter" && search.value.trim()) globalSearch(search.value.trim()); });
  return h("header", { class: "top" },
    h("label", { class: "search" }, icon("search"), search, h("kbd", {}, "Ctrl K")),
    h("span", { class: "spacer" }),
    h("button", { class: "icon-btn", title: "Comando rapido (Ctrl+K)", "aria-label": "Comando rapido", onclick: palette }, icon("zap")),
    h("button", { class: "icon-btn", title: "Notifiche", "aria-label": `Notifiche, ${unreadCount} non lette`, onclick: () => ctx.navigate("#notifications") }, icon("bell"), unreadCount ? h("span", { class: "badge-dot" }, String(unreadCount)) : null),
    h("button", { class: "icon-btn", title: "Tema chiaro / scuro", "aria-label": "Cambia tema", onclick: toggleTheme }, icon(ctx.settings?.theme === "light" ? "moon" : "sun")),
    h("button", { class: `icon-btn kill ${o.killSwitch ? "on" : ""}`, title: o.killSwitch ? "Kill Switch ATTIVO: clic per spegnerlo" : "Kill Switch: ferma tutto subito", "aria-label": "Kill Switch", onclick: toggleKill }, icon("power")),
    h("button", { class: "acct-chip", title: "Account attivo", onclick: () => ctx.navigate("#accounts") },
      h("span", { class: "avatar" }, (acc?.login || "?").slice(0, 1).toUpperCase()),
      h("span", { class: "small" }, acc?.login ? `@${acc.login}` : o.session?.loggedIn ? `id ${o.session.userId}` : "Nessuna sessione")));
}

async function toggleTheme() {
  ctx.settings = await rpc("settings.save", { patch: { theme: ctx.settings?.theme === "light" ? "dark" : "light" } });
  applyTheme();
  renderShell();
}

async function toggleKill() {
  const on = !ctx.overview?.killSwitch;
  if (on && !(await confirmBox("Attivare il Kill Switch?", "Tutte le campagne si fermano subito e nessuna operazione può ripartire finché non lo spegni.", "Ferma tutto", true))) return;
  await rpc("health.killSwitch", { on });
  toast(on ? "Kill Switch attivato" : "Kill Switch spento", on ? "Tutto fermo." : "Le campagne in pausa si riprendono a mano.", on ? "warning" : "success");
  await refreshOverview();
}

async function globalSearch(q) {
  const [camps, list, accs] = await Promise.all([rpc("campaigns.list"), rpc("listings.query", { filters: { search: q }, limit: 20 }), rpc("accounts.list")]);
  const ql = q.toLowerCase();
  const pages = PAGES.filter((p) => p.label.toLowerCase().includes(ql));
  const cs = camps.filter((c) => c.name.toLowerCase().includes(ql));
  const as = accs.filter((a) => `${a.login} ${a.label} ${a.customLabel} ${a.id}`.toLowerCase().includes(ql));
  const go = (hash) => { ctx.navigate(hash); closeIt(); };
  let closeIt = () => {};
  const content = h("div", {},
    !pages.length && !cs.length && !as.length && !list.items.length ? h("div", { class: "empty" }, "Nessun risultato.") : null,
    pages.length ? h("h3", {}, "Pagine") : null, h("ul", { class: "palette-list" }, pages.map((p) => h("li", { onclick: () => go(`#${p.id}`) }, icon(p.icon, 16), p.label))),
    cs.length ? h("h3", {}, "Campagne") : null, h("ul", { class: "palette-list" }, cs.map((c) => h("li", { onclick: () => go(`#campaigns/${c.id}`) }, icon("zap", 16), c.name))),
    as.length ? h("h3", {}, "Account") : null, h("ul", { class: "palette-list" }, as.map((a) => h("li", { onclick: () => go("#accounts") }, icon("user", 16), a.login || a.id, h("span", { class: "muted small" }, a.customLabel || a.label)))),
    list.items.length ? h("h3", {}, `Annunci (${list.total})`) : null,
    h("ul", { class: "palette-list" }, list.items.map((l) => h("li", { onclick: () => go(`#listings?search=${encodeURIComponent(q)}`) }, l.photo ? h("img", { src: l.photo, class: "thumb", style: { width: "28px", height: "28px" }, alt: "" }) : icon("tag", 16), l.title))));
  const p = modal(`Risultati per «${q}»`, content);
  closeIt = () => document.querySelector(".modal-back")?.remove();
  await p;
}

/** Comando rapido: azioni e pagine da tastiera. */
async function palette() {
  const actions = [
    ...PAGES.map((p) => ({ label: `Vai a ${p.label}`, icon: p.icon, run: () => ctx.navigate(`#${p.id}`) })),
    { label: "Nuova campagna", icon: "plus", run: () => ctx.navigate("#campaigns?new=1") },
    { label: "Nuova scansione", icon: "scan", run: () => ctx.navigate("#scanner") },
    { label: "Metti in pausa tutte le campagne", icon: "pause", run: async () => { await rpc("campaigns.pauseAll"); toast("Campagne in pausa"); } },
    { label: ctx.overview?.killSwitch ? "Spegni il Kill Switch" : "Attiva il Kill Switch", icon: "power", run: toggleKill },
    { label: "Esegui controllo completo", icon: "pulse", run: () => ctx.navigate("#health?run=1") },
    { label: "Cerca aggiornamento", icon: "refresh", run: checkUpdates },
    { label: "Cambia tema", icon: "sun", run: toggleTheme },
    { label: "Riavvia la guida iniziale", icon: "help", run: () => startOnboarding(ctx, true) },
    { label: "Esporta backup", icon: "download", run: () => ctx.navigate("#settings?tab=backup") },
  ];
  const input = h("input", { class: "input", placeholder: "Scrivi un comando…", "aria-label": "Comando" });
  const list = h("ul", { class: "palette-list", role: "listbox" });
  let sel = 0;
  let filtered = actions;
  let close;
  const draw = () => {
    const q = input.value.toLowerCase();
    filtered = actions.filter((a) => a.label.toLowerCase().includes(q));
    sel = Math.min(sel, Math.max(0, filtered.length - 1));
    list.replaceChildren(...filtered.map((a, i) => h("li", { class: i === sel ? "sel" : "", role: "option", "aria-selected": String(i === sel), onclick: () => { close(); a.run(); } }, icon(a.icon, 16), a.label)));
  };
  input.addEventListener("input", () => { sel = 0; draw(); });
  input.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown") { sel = Math.min(filtered.length - 1, sel + 1); draw(); e.preventDefault(); }
    if (e.key === "ArrowUp") { sel = Math.max(0, sel - 1); draw(); e.preventDefault(); }
    if (e.key === "Enter" && filtered[sel]) { close(); filtered[sel].run(); }
  });
  draw();
  const p = modal("Comando rapido", h("div", {}, input, list));
  close = () => document.querySelector(".modal-back")?.remove();
  await p;
}

function shortcuts(e) {
  const typing = /input|textarea|select/i.test(document.activeElement?.tagName || "") || document.activeElement?.isContentEditable;
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") { e.preventDefault(); palette(); return; }
  if (typing || document.querySelector(".modal-back")) return;
  if (e.key === "/") { e.preventDefault(); document.getElementById("global-search")?.focus(); }
  if (e.key === "?") showShortcuts();
  if (e.altKey && /^[1-9]$/.test(e.key)) { const p = PAGES[Number(e.key) - 1]; if (p) ctx.navigate(`#${p.id}`); }
  if (e.key.toLowerCase() === "p" && e.shiftKey) rpc("campaigns.pauseAll").then(() => toast("Campagne in pausa"));
}

function showShortcuts() {
  const rows = [
    ["Ctrl / ⌘ + K", "Comando rapido"], ["/", "Ricerca globale"], ["Alt + 1…9", "Pagine della barra laterale"],
    ["Shift + P", "Pausa di tutte le campagne"], ["?", "Questo elenco"],
    ["Alt + Shift + V", "Apri la dashboard (ovunque nel browser)"], ["Alt + Shift + P", "Pausa / ripresa (ovunque)"], ["Alt + Shift + K", "Kill Switch (ovunque)"],
  ];
  modal("Scorciatoie da tastiera", h("div", {},
    h("table", { class: "table" }, h("tbody", {}, rows.map(([k, v]) => h("tr", {}, h("td", {}, h("kbd", {}, k)), h("td", {}, v))))),
    h("p", { class: "muted small" }, "Le scorciatoie globali si cambiano dal browser:"),
    h("button", { class: "btn", onclick: () => chrome.tabs.create({ url: "chrome://extensions/shortcuts" }) }, icon("external", 14), "Configura scorciatoie del browser")));
}

function banners() {
  const o = ctx.overview || {};
  const out = [];
  // File nuovi ma motore vecchio: succede se si sostituiscono i file senza ricaricare l'estensione.
  if (o.version && o.version !== VERSION) out.push(h("div", { class: "kill-bar", role: "alert" }, h("b", {}, "Aggiornamento a metà. "),
    `L'interfaccia è la v${VERSION} ma il motore è ancora la v${o.version}. `, h("button", { class: "btn sm primary", onclick: () => chrome.runtime.reload() }, "Ricarica Vintastic")));
  if (o.killSwitch) out.push(h("div", { class: "kill-bar", role: "alert" }, h("b", {}, "Kill Switch attivo. "), "Nessuna operazione può partire. ", h("button", { class: "btn sm", onclick: toggleKill }, "Spegni")));
  if (o.connectivity && o.connectivity.online === false) out.push(h("div", { class: "offline-bar", role: "status" }, h("b", {}, "Offline: sola lettura. "), "Puoi consultare i dati salvati; le interazioni sono sospese e riprendono quando Vinted torna raggiungibile."));
  if (o.authPending) out.push(h("div", { class: "offline-bar", role: "status" }, h("b", {}, "Verifica della sessione in corso. "), o.authPending.message, " ", h("button", { class: "btn sm", onclick: () => rpc("session.openLogin", { origin: o.authPending.origin }) }, "Apri Vinted")));
  return out;
}

const pageHost = h("div", { class: "content", id: "page" });

function renderShell() {
  applyTheme();
  app.replaceChildren(sidebar(), h("div", { class: "main" }, topbar(), ...banners(), h("main", { id: "main", tabindex: "-1" }, pageHost)));
  app.removeAttribute("aria-busy");
}

let renderSeq = 0;
async function renderPage() {
  const seq = ++renderSeq;              // vince solo l'ultimo disegno (es. filtri cambiati in fretta)
  const route = parseHash();
  ctx.route = route;
  const page = PAGES.find((p) => p.id === route.page) || (route.page === "onboarding" ? PAGES[0] : PAGES[0]);
  const samePage = current === page && pageHost.isConnected && pageHost.firstChild;
  current = page;
  renderShell();
  document.title = `${page.label} · Vintastic`;
  if (!samePage) pageHost.replaceChildren(h("div", { class: "muted" }, "Caricamento…"));
  try {
    const node = await page.mod.render(ctx);
    if (current === page && seq === renderSeq) pageHost.replaceChildren(node);
  } catch (e) {
    console.error(e);
    pageHost.replaceChildren(h("div", { class: "callout bad" }, h("b", {}, "Questa sezione non si è caricata. "), e.message, h("div", { class: "small muted" }, "Il resto di Vintastic funziona. L'errore è nei Log.")));
    chrome.runtime.sendMessage({ type: "vt:clientError", category: "js", message: `Pagina ${page.label}: ${e.message}`, stack: e.stack }).catch(() => {});
  }
  if (route.page === "onboarding") startOnboarding(ctx, true);
}

let ovTimer = null;
async function refreshOverview() {
  ctx.overview = await rpc("overview").catch(() => ctx.overview);
  const notes = await rpc("notifications.list", { limit: 200 }).catch(() => []);
  unreadCount = notes.filter((n) => !n.read).length;
  if (ctx.overview?.links) ctx.links = ctx.overview.links;
  // Aggiorna solo il guscio: la pagina gestisce i suoi eventi.
  const main = app.querySelector(".main");
  if (main) {
    const newSide = sidebar();
    app.querySelector(".side")?.replaceWith(newSide);
    main.querySelector(".top")?.replaceWith(topbar());
    main.querySelectorAll(".kill-bar, .offline-bar").forEach((n) => n.remove());
    main.querySelector(".top")?.after(...banners());
  }
}

function onLive(msg) {
  if (msg.type === "vt:overview") { ctx.overview = msg.overview; return; }
  clearTimeout(ovTimer);
  ovTimer = setTimeout(refreshOverview, 300);
  if (msg.type === "vt:settings") { ctx.settings = msg.settings; applyTheme(); }
  if (msg.type === "vt:notification" && ["warning", "error", "critical"].includes(msg.note.level)) toast(msg.note.title, msg.note.body, msg.note.level, (msg.durationSec || 6) * 1000);
  try { current?.mod.onEvent?.(msg, ctx); } catch (e) { console.warn(e); }
}

async function boot() {
  installTooltips();
  ctx.settings = await rpc("settings.get");
  ctx.overview = await rpc("overview").catch(() => null);
  ctx.links = await rpc("links.get").catch(() => DEFAULT_LINKS);
  const notes = await rpc("notifications.list", { limit: 200 }).catch(() => []);
  unreadCount = notes.filter((n) => !n.read).length;
  window.addEventListener("hashchange", renderPage);
  document.addEventListener("keydown", shortcuts);
  live(onLive);
  await renderPage();
  if (!ctx.settings.onboardingDone && parseHash().page !== "onboarding") startOnboarding(ctx, false);
}

window.addEventListener("error", (e) => chrome.runtime.sendMessage({ type: "vt:clientError", category: "js", message: `Dashboard: ${e.message}`, stack: e.error?.stack }).catch(() => {}));
window.addEventListener("unhandledrejection", (e) => chrome.runtime.sendMessage({ type: "vt:clientError", category: "js", message: `Dashboard: ${e.reason?.message || e.reason}`, stack: e.reason?.stack }).catch(() => {}));
boot().catch((e) => { app.textContent = `Avvio della dashboard non riuscito: ${e.message}`; });
