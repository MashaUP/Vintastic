/** Popup e side panel: campagna in corso, azioni rapide sulla scheda Vinted aperta, account, statistiche del giorno. */

import { h, icon, logo, rpc, live, toast, countdown, fmtNum } from "./lib.js";
import { VERSION, DEFAULT_LINKS, OP_LABEL } from "../shared/constants.js";
import { listingIdFrom, memberIdFrom } from "../shared/util.js";

const root = document.getElementById("pop");
const isPanel = new URLSearchParams(location.search).get("mode") === "panel";
document.body.classList.toggle("panel", isPanel);
let tab = "quick";
let o = null;
let activeTab = null;
let timerNode = null;

const openDash = (hash = "") => { chrome.tabs.create({ url: chrome.runtime.getURL(`src/ui/dashboard.html${hash}`) }); if (!isPanel) window.close(); };

async function pageListing() {
  const id = listingIdFrom(activeTab?.url);
  if (!id) return null;
  const info = await chrome.tabs.sendMessage(activeTab.id, { type: "vt:listingInfo", id }).catch(() => null);
  return info || { id, url: activeTab.url.split("?")[0], title: activeTab.title?.split("|")[0]?.trim() || `Annuncio ${id}` };
}

/** Azione rapida: l'annuncio aperto entra nella campagna scelta (o in una nuova simulazione). */
async function quickAdd(types) {
  const listing = await pageListing();
  if (!listing) return toast("Apri un annuncio su Vinted", "Le azioni rapide lavorano sull'annuncio nella scheda attiva.", "warning");
  const camps = (o.campaigns || []).filter((c) => ["running", "paused", "ready", "draft"].includes(c.status));
  let id = camps.find((c) => c.status === "running")?.id || camps[0]?.id;
  if (!id) id = (await rpc("campaigns.create", { name: `Rapida ${new Date().toLocaleDateString("it-IT")}`, types, dryRun: true })).id;
  const r = await rpc("campaigns.add", { id, listings: [listing], spec: { types } });
  toast(r.added ? `${types.map((t) => OP_LABEL[t]).join(" + ")} in coda` : "Già in coda", r.added ? `Aggiunto a «${camps.find((c) => c.id === id)?.name || "nuova campagna"}». Parte secondo i timer e i controlli.` : r.rejected?.[0]?.reason || "", r.added ? "success" : "warning");
}

function render() {
  const sess = o?.session || {};
  const run = (o?.campaigns || []).find((c) => c.status === "running") || (o?.campaigns || []).find((c) => c.status === "paused");
  const links = o?.links || DEFAULT_LINKS;
  const onVinted = /^https:\/\/www\.vinted\./.test(activeTab?.url || "");
  const onItem = onVinted && Boolean(listingIdFrom(activeTab?.url));
  const onWardrobe = onVinted && /\/member\/\d+/.test(activeTab?.url || "");
  timerNode = null;

  const head = h("div", { class: "p-head" }, logo(44), h("div", { class: "grow" }, h("h1", {}, "Vintastic"),
    h("span", { class: `status ${o?.killSwitch ? "kill" : sess.loggedIn ? "" : "off"}` }, o?.killSwitch ? "Kill Switch attivo" : sess.loggedIn ? "Attivo" : "Sessione Vinted non rilevata")),
    !isPanel && chrome.sidePanel ? h("button", { class: "btn ghost sm", title: "Apri nel pannello laterale", "aria-label": "Pannello laterale", onclick: async () => { const w = await chrome.windows.getCurrent(); await chrome.sidePanel.open({ windowId: w.id }); window.close(); } }, icon("layers", 18)) : null,
    h("button", { class: "btn ghost sm", title: "Impostazioni", "aria-label": "Impostazioni", onclick: () => openDash("#settings") }, icon("settings", 18)));

  let runCard = null;
  if (run) {
    timerNode = h("small", {}, run.status === "running" && run.nextAt ? `prossima tra ${countdown(run.nextAt - Date.now())}` : run.pauseDetail?.slice(0, 70) || "In pausa");
    runCard = h("div", { class: "run-card" }, icon("zap", 28),
      h("div", {}, h("b", {}, run.status === "running" ? "Campagna in esecuzione" : "Campagna in pausa"), h("div", { class: "small" }, `${run.name}${run.dryRun ? " · simulazione" : ""}`),
        h("small", {}, `${run.progress?.percent || 0}% · ${run.progress?.itemsDone || 0}/${run.progress?.items || 0} annunci · `), timerNode,
        h("div", { class: "progress" }, h("i", { style: { width: `${run.progress?.percent || 0}%` } }))),
      run.status === "running" ? h("button", { class: "btn sm", "aria-label": "Pausa", onclick: () => rpc("campaigns.pause", { id: run.id }).then(refresh) }, icon("pause", 16))
        : h("button", { class: "btn sm", "aria-label": "Riprendi", onclick: async () => { const r = await rpc("campaigns.resume", { id: run.id }); if (!r.ok) toast("Non riprende", r.validation?.errors?.[0] || "", "warning"); refresh(); } }, icon("play", 16)));
  }

  const tabs = h("div", { class: "tabs", role: "tablist" }, [["quick", "zap", "Rapida"], ["account", "user", "Account"], ["stats", "chart", "Stats"]].map(([k, ic, l]) =>
    h("button", { role: "tab", class: tab === k ? "on" : "", "aria-selected": String(tab === k), onclick: () => { tab = k; render(); } }, icon(ic, 16), l)));

  let pane;
  if (tab === "quick") {
    pane = h("div", { class: "grid" }, h("div", { class: "tiles" },
      h("button", { class: "tile like", disabled: !onItem, onclick: () => quickAdd(["like"]) }, icon("heart"), "Metti like", h("small", {}, onItem ? "aggiunge alla coda" : "apri un annuncio")),
      h("button", { class: "tile comment", disabled: !onItem, onclick: async () => { const l = await pageListing(); openDash(`#suggestions?listing=${l?.id || ""}`); } }, icon("message"), "Commenta", h("small", {}, "suggerimenti da copiare")),
      h("button", { class: "tile offer", disabled: !onItem, onclick: () => quickAdd(["offer"]) }, icon("tag"), "Fai offerta", h("small", {}, "con anteprima")),
      h("button", { class: "tile scan", disabled: !onWardrobe, onclick: async () => { try { await rpc("scan.start", { url: activeTab.url }); toast("Scansione avviata", "", "success"); } catch (e) { toast("Non avviata", e.message, "error"); } } }, icon("search"), "Scansiona", h("small", {}, onWardrobe ? `armadio ${memberIdFrom(activeTab.url)}` : "apri un armadio"))),
      !onVinted ? h("p", { class: "small muted", style: { margin: 0 } }, "Le azioni lavorano sulla pagina Vinted di questa scheda.") : null);
  } else if (tab === "account") {
    pane = h("div", { class: "grid" },
      h("div", { class: "acc" }, h("span", { class: "avatar" }, (o?.account?.login || "?").slice(0, 1).toUpperCase()),
        h("div", { class: "grow" }, h("b", {}, o?.account?.login ? `@${o.account.login}` : sess.loggedIn ? `Utente ${sess.userId}` : "Nessun account"), h("div", { class: "small muted" }, sess.origin || "Apri Vinted da loggato")),
        h("button", { class: "btn ghost sm", "aria-label": "Account", onclick: () => openDash("#accounts") }, icon("external", 16))),
      h("button", { class: "btn", onclick: async () => { const r = await rpc("session.openLogin", {}); toast("Vinted aperto", r.hint, "info", 8000); } }, icon("key", 16), "Accedi / cambia account"),
      h("button", { class: "btn", onclick: async () => { const r = await rpc("session.check").catch((e) => ({ error: e.message })); toast(r.session?.loggedIn ? "Sessione valida" : "Sessione non attiva", r.error || "", r.session?.loggedIn ? "success" : "warning"); refresh(); } }, icon("refresh", 16), "Verifica sessione"));
  } else {
    const c = o?.counters?.accounts?.[sess.accountId] || {};
    const lim = o?.limits || {};
    pane = h("div", { class: "card" }, h("h3", {}, "Oggi"), h("div", { class: "lim" },
      h("span", {}, "Like"), h("b", {}, `${fmtNum(c.like || 0)} / ${lim.perDay?.like ?? "∞"}`),
      h("span", {}, "Offerte"), h("b", {}, `${fmtNum(c.offer || 0)} / ${lim.perDay?.offer ?? "∞"}`),
      h("span", {}, "Totale account"), h("b", {}, `${fmtNum(c.total || 0)} / ${lim.perAccountDay ?? "∞"}`),
      h("span", {}, "Campagne in corso"), h("b", {}, String((o?.campaigns || []).filter((x) => x.status === "running").length))),
      h("p", { class: "small muted" }, "Soglie scelte da te, non limiti di Vinted. Si azzerano a mezzanotte."));
  }

  const foot = h("div", { class: "grid" },
    h("div", { class: "row" }, h("button", { class: "btn primary grow", style: { justifyContent: "center" }, onclick: () => openDash() }, icon("home", 16), "Apri dashboard"),
      h("button", { class: `btn ${o?.killSwitch ? "" : "danger"}`, title: "Kill Switch", "aria-label": "Kill Switch", onclick: async () => { await rpc("health.killSwitch", { on: !o?.killSwitch }); refresh(); } }, icon("power", 16)),
      h("button", { class: "btn", title: "Aiuto", "aria-label": "Aiuto", onclick: () => openDash("#help") }, icon("help", 16))),
    h("div", { class: "p-foot" }, h("span", {}, "●"), h("span", { class: "grow" }, `v${VERSION}${o?.update?.available ? ` · nuova ${o.update.latest}` : ""}`),
      h("a", { href: "#", onclick: async (e) => { e.preventDefault(); const r = await rpc("updates.check"); toast(r.ok ? (r.available ? `Disponibile la ${r.latest}` : "Sei all'ultima versione") : "Controllo non riuscito", r.error || "", r.ok ? "success" : "warning"); refresh(); } }, "Cerca aggiornamento"),
      "|", h("a", { href: links.discord?.url, target: "_blank" }, "Discord"), "|", h("a", { href: links.github?.url, target: "_blank" }, "GitHub"), "|", h("a", { href: links.kofi?.url, target: "_blank" }, "Ko-fi")));

  const mismatch = o?.version && o.version !== VERSION ? h("div", { class: "callout bad small" }, h("b", {}, "Aggiornamento a metà: "), `motore v${o.version}, interfaccia v${VERSION}. `,
    h("button", { class: "btn sm primary", onclick: () => chrome.runtime.reload() }, "Ricarica Vintastic")) : null;
  root.replaceChildren(...[head, mismatch, runCard, tabs, pane, foot].filter(Boolean));
  root.removeAttribute("aria-busy");
}

async function refresh() {
  o = await rpc("overview").catch(() => o);
  document.documentElement.dataset.theme = o?.theme === "light" ? "light" : "dark";
  [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true }).catch(() => [null]);
  render();
}

setInterval(() => {
  const run = (o?.campaigns || []).find((c) => c.status === "running");
  if (timerNode && run?.nextAt) timerNode.textContent = `prossima tra ${countdown(run.nextAt - Date.now())}`;
}, 1000);

let t = null;
live((msg) => { if (msg.type !== "vt:overview") { clearTimeout(t); t = setTimeout(refresh, 300); } });
chrome.tabs.onActivated?.addListener(() => refresh());
refresh();
