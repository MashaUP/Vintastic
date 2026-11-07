/** Home: banner, statistiche, campagne attive, attività in tempo reale, grafico, stato sistema, code. */

import { h, icon, logo, rpc, fmtNum, ago, countdown, duration, lineChart, modal, toast, statusPill } from "../lib.js";
import { STAT_RANGES } from "../../shared/stats.js";
import { startOnboarding } from "./onboarding.js";

const WIDGETS = {
  stats: "Riepilogo numerico",
  campaigns: "Campagne attive",
  activity: "Attività recenti",
  chart: "Andamento attività",
  system: "Stato sistema",
  queue: "Riepilogo code",
};

let range = "7d";
let activityList = null;
let timerNodes = [];

const ACT_ICON = { like: "heart", offer: "tag", message: "send", comment: "message", scan: "scan", listing: "list", campaign: "zap", queue: "layers", notif: "bell", system: "settings" };

function feedItem(a) {
  return h("li", {}, h("span", { class: `fi ${a.kind}` }, icon(ACT_ICON[a.kind] || "pulse", 14)), h("span", { class: "small" }, a.text, a.simulated ? h("span", { class: "pill", style: { marginLeft: "6px" } }, "sim.") : null), h("span", { class: "muted small" }, ago(a.at)));
}

function statCard(cls, ic, label, value, sub) {
  return h("div", { class: `stat ${cls}` }, h("div", { class: "k" }, h("span", { class: "ic" }, icon(ic, 18)), label), h("div", { class: "v" }, fmtNum(value)), sub ? h("div", { class: "d" }, sub) : null);
}

export async function render(ctx) {
  const s = ctx.settings;
  const [st, act, health, recov] = await Promise.all([
    rpc("stats.get", { range }), rpc("activity.list", { limit: 40 }), rpc("updates.status").catch(() => null), rpc("recovery.list").catch(() => null),
  ]);
  const o = ctx.overview || {};
  const t = st.totals;
  const order = (s.dashboardWidgets || Object.keys(WIDGETS)).filter((w) => WIDGETS[w]);

  const hero = h("section", { class: "hero" }, logo(92),
    h("div", {}, h("h1", {}, "Benvenuto in Vintastic!"), h("p", {}, "Il tuo assistente per Vinted: scansioni, campagne e offerte, senza mai acquistare nulla."),
      h("div", { class: "row" }, h("button", { class: "btn primary", onclick: () => startOnboarding(ctx, true) }, icon("play", 14), "Guida rapida"),
        h("button", { class: "btn", onclick: () => ctx.navigate("#campaigns?new=1") }, icon("plus", 14), "Nuova campagna"),
        h("button", { class: "btn ghost", onclick: () => customize(ctx) }, icon("layers", 14), "Personalizza"))),
    h("svg", { class: "art", viewBox: "0 0 120 90", width: 160, height: 120, "aria-hidden": "true", html: '<path d="M60 14a9 9 0 1 1 9 9v6" fill="none" stroke="#b69cff" stroke-width="4" stroke-linecap="round"/><path d="M14 58 60 32l46 26H14Z" fill="none" stroke="#b69cff" stroke-width="4" stroke-linejoin="round"/><rect x="62" y="48" width="38" height="36" rx="7" fill="#8f6ef2"/><path d="M73 52v-4a8 8 0 0 1 16 0v4" fill="none" stroke="#ddd0ff" stroke-width="3"/><path d="M81 74c-5-3-8-6-8-9a4 4 0 0 1 8-1 4 4 0 0 1 8 1c0 3-3 6-8 9Z" fill="#ff6fb5"/><path d="M104 12l2 5 5 2-5 2-2 5-2-5-5-2 5-2Z" fill="#ff6fb5"/>' }));

  const rangeSeg = h("div", { class: "seg", role: "group", "aria-label": "Periodo" }, Object.entries(STAT_RANGES).filter(([k]) => k !== "custom").map(([k, v]) => h("button", { class: range === k ? "on" : "", "aria-pressed": String(range === k), onclick: () => { range = k; ctx.refresh(); } }, v)));

  const blocks = {
    stats: () => h("section", { "data-w": "stats" },
      h("div", { class: "row", style: { marginBottom: "10px" } }, h("h2", { style: { margin: 0, fontSize: "16px" } }, "Riepilogo"), h("span", { class: "grow" }), rangeSeg),
      h("div", { class: "stats" },
        statCard("scan", "search", "Annunci analizzati", t.listings, `${fmtNum(t.listingsAll)} in archivio · ${t.scans} scansioni`),
        statCard("like", "heart", "Like effettuati", t.likes),
        statCard("comment", "message", "Commenti suggeriti", t.comments, "Vinted non ha commenti pubblici: si copiano"),
        statCard("offer", "tag", "Offerte inviate", t.offers),
        statCard("neutral", "user", "Account attivi", t.accounts),
        statCard("neutral", "zap", "Campagne", t.campaignsRunning, `${t.campaignsDone} completate nel periodo`),
        statCard("neutral", "x", "Operazioni fallite", t.failed, `${t.verify} da verificare · ${t.skipped} saltate`),
        statCard("neutral", "layers", "In attesa", t.pending, `Tempo di attività: ${duration(t.activeMs)}`))),
    campaigns: () => {
      const list = (o.campaigns || []).filter((c) => ["running", "paused", "ready"].includes(c.status)).slice(0, 5);
      timerNodes = [];
      return h("section", { class: "card", "data-w": "campaigns" },
        h("div", { class: "panel-head" }, h("h2", {}, icon("zap"), "Campagne attive"), h("a", { class: "more", href: "#campaigns" }, "Vedi tutte →")),
        list.length ? list.map((c) => {
          const timer = h("span", { class: "muted small" }, c.status === "running" && c.nextAt ? `prossima tra ${countdown(c.nextAt - Date.now())}` : "");
          timerNodes.push([timer, c]);
          return h("div", { class: "camp-row" }, h("span", { class: "camp-ic" }, icon("zap", 22)),
            h("div", { class: "grow" }, h("div", { class: "row" }, h("a", { href: `#campaigns/${c.id}`, style: { color: "var(--text)", fontWeight: 650, textDecoration: "none" } }, c.name), statusPill(c.status), c.dryRun ? h("span", { class: "pill" }, "simulazione") : null),
              h("div", { class: "muted small" }, `${c.progress?.itemsDone || 0}/${c.progress?.items || 0} annunci · ${c.progress?.pending || 0} in attesa`, " · ", timer),
              h("div", { class: "progress", style: { marginTop: "8px" } }, h("i", { style: { width: `${c.progress?.percent || 0}%` } }))),
            h("div", { class: "row" },
              c.status === "running" ? h("button", { class: "btn sm", "aria-label": "Pausa", onclick: () => rpc("campaigns.pause", { id: c.id }) }, icon("pause", 14)) : h("button", { class: "btn sm primary", "aria-label": "Avvia", onclick: async () => { const r = await rpc("campaigns.start", { id: c.id }); if (!r.ok) ctx.navigate(`#campaigns/${c.id}`); } }, icon("play", 14)),
              h("button", { class: "btn sm danger", "aria-label": "Stop", onclick: () => rpc("campaigns.stop", { id: c.id }) }, icon("stop", 14))));
        }) : h("div", { class: "empty" }, "Nessuna campagna attiva. ", h("a", { href: "#campaigns?new=1" }, "Creane una")));
    },
    activity: () => {
      activityList = h("ul", { class: "feed", "aria-live": "polite" }, act.length ? act.map(feedItem) : h("li", { class: "muted" }, "Ancora nessuna attività."));
      return h("section", { class: "card", "data-w": "activity" }, h("div", { class: "panel-head" }, h("h2", {}, icon("history"), "Attività recenti"), h("a", { class: "more", href: "#logs" }, "Vedi tutte →")), activityList);
    },
    chart: () => h("section", { class: "card", "data-w": "chart" },
      h("div", { class: "panel-head" }, h("h2", {}, icon("chart"), "Andamento attività"), h("span", { class: "grow" })),
      lineChart(st.days, [
        { name: "Like", color: "var(--s-like)", values: st.days.map((d) => st.series.like[d] || 0) },
        { name: "Commenti", color: "var(--s-comment)", values: st.days.map((d) => st.series.comment[d] || 0) },
        { name: "Offerte", color: "var(--s-offer)", values: st.days.map((d) => st.series.offer[d] || 0) },
      ])),
    system: () => {
      const sess = o.session || {};
      const row = (ic, label, val, cls) => h("div", { class: "sys-row" }, icon(ic, 18), h("span", { class: "grow" }, label), h("span", { class: `pill ${cls}` }, val));
      return h("section", { class: "card", "data-w": "system" },
        h("div", { class: "panel-head" }, h("h2", {}, icon("pulse"), "Stato sistema"), h("a", { class: "more", href: "#health" }, "Salute →")),
        row("layers", "Database", "OK", "good"),
        row("user", "Sessione Vinted", sess.loggedIn ? (sess.challenge ? "Verifica richiesta" : "Attiva") : "Non rilevata", sess.loggedIn && !sess.challenge ? "good" : "warn"),
        row("wifi", "Connessione", o.connectivity?.online === false ? "Offline" : "OK", o.connectivity?.online === false ? "bad" : "good"),
        row("power", "Kill Switch", o.killSwitch ? "ATTIVO" : "Spento", o.killSwitch ? "bad" : "good"),
        row("lifebuoy", "Da verificare", String(recov?.verify?.length || 0), recov?.verify?.length ? "warn" : "good"),
        row("refresh", "Versione", health?.available ? `${health.latest} disponibile` : `v${o.version}`, health?.available ? "warn" : "good"),
        h("button", { class: "btn primary", style: { width: "100%", justifyContent: "center", marginTop: "12px" }, onclick: async () => {
          const r = await rpc("updates.check");
          toast(r.ok ? (r.available ? `Disponibile la ${r.latest}` : "Sei all'ultima versione") : "Controllo non riuscito", r.error || "", r.ok ? "success" : "warning");
          ctx.refresh();
        } }, icon("refresh", 16), "Controlla aggiornamenti"));
    },
    queue: () => {
      const list = (o.campaigns || []).filter((c) => ["running", "paused"].includes(c.status));
      return h("section", { class: "card", "data-w": "queue" },
        h("div", { class: "panel-head" }, h("h2", {}, icon("layers"), "Riepilogo code")),
        list.length ? h("table", { class: "table" }, h("thead", {}, h("tr", {}, ["Campagna", "Progresso", "Completati", "In attesa", "Errori", "Prossimo", "Account"].map((x) => h("th", {}, x)))),
          h("tbody", {}, list.map((c) => h("tr", {},
            h("td", {}, h("a", { href: `#campaigns/${c.id}` }, c.name)), h("td", {}, `${c.progress?.percent || 0}%`), h("td", {}, String(c.progress?.completed || 0)),
            h("td", {}, String(c.progress?.pending || 0)), h("td", {}, String((c.progress?.failed || 0) + (c.progress?.verify || 0))),
            h("td", { class: "small" }, c.status === "running" ? (c.nextLabel || "—") : c.pauseDetail || "In pausa"),
            h("td", { class: "small" }, c.accountId?.split("@")[0] || "—"))))) : h("div", { class: "empty small" }, "Nessuna coda attiva."));
    },
  };

  const full = order.filter((w) => w === "stats");
  const panels = order.filter((w) => w !== "stats");
  return h("div", { class: "grid" }, hero, ...full.map((w) => blocks[w]()), h("div", { class: "panels" }, panels.map((w) => blocks[w]())));
}

export function onEvent(msg, ctx) {
  if (msg.type === "vt:activity" && activityList) {
    if (activityList.firstChild?.classList?.contains("muted")) activityList.replaceChildren();
    activityList.prepend(feedItem(msg.item));
    while (activityList.children.length > 60) activityList.lastChild.remove();
  }
  if (msg.type === "vt:campaign" || msg.type === "vt:timer") {
    clearTimeout(onEvent.t);
    onEvent.t = setTimeout(() => { if (!document.querySelector(".modal-back")) ctx.refresh(); }, 1200);
  }
}

setInterval(() => {
  for (const [node, c] of timerNodes) if (node.isConnected && c.nextAt) node.textContent = `prossima tra ${countdown(c.nextAt - Date.now())}`;
}, 1000);

/** Dashboard personalizzabile: widget attivi, ordine, layout. */
async function customize(ctx) {
  let order = [...(ctx.settings.dashboardWidgets || Object.keys(WIDGETS))];
  const hidden = Object.keys(WIDGETS).filter((w) => !order.includes(w));
  let all = [...order, ...hidden];
  const list = h("ul", { class: "widget-cfg", style: { listStyle: "none", padding: 0 } });
  const draw = () => list.replaceChildren(...all.map((w, i) => h("li", {},
    h("label", { class: "check grow" }, h("input", { type: "checkbox", checked: order.includes(w), onchange: (e) => { order = e.target.checked ? [...order, w] : order.filter((x) => x !== w); } }), WIDGETS[w]),
    h("button", { class: "btn ghost sm", "aria-label": "Su", disabled: i === 0, onclick: () => { [all[i - 1], all[i]] = [all[i], all[i - 1]]; draw(); } }, icon("up", 14)),
    h("button", { class: "btn ghost sm", "aria-label": "Giù", disabled: i === all.length - 1, onclick: () => { [all[i + 1], all[i]] = [all[i], all[i + 1]]; draw(); } }, icon("down", 14)))));
  draw();
  const layout = h("select", { class: "input" }, h("option", { value: "full" }, "Completo"), h("option", { value: "compact" }, "Compatto (barra laterale stretta)"));
  layout.value = ctx.settings.layout || "full";
  const ok = await modal("Personalizza la dashboard", h("div", {}, list, h("label", { class: "field" }, "Layout", layout)),
    [{ label: "Annulla", value: false }, { label: "Salva", value: true, cls: "primary" }]);
  if (!ok) return;
  ctx.settings = await rpc("settings.save", { patch: { dashboardWidgets: all.filter((w) => order.includes(w)), layout: layout.value } });
  ctx.refresh();
}
