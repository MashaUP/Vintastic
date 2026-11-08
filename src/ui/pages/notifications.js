/** Centro notifiche di Vintastic + Pulitore delle notifiche dell'account Vinted. */

import { h, icon, rpc, toast, ago, fmtDate, confirmBox } from "../lib.js";

const LEVEL = { info: ["Info", "info"], success: ["OK", "good"], warning: ["Avviso", "warn"], error: ["Errore", "bad"], critical: ["Critico", "bad"] };
const CAT = { campaignStart: "Campagna iniziata", campaignDone: "Campagna completata", campaignPaused: "Campagna in pausa", error: "Errore", sessionExpired: "Sessione", newVersion: "Nuova versione", limitReached: "Limite raggiunto", connection: "Connessione", verify: "Da verificare", info: "Informazione" };
const filt = { level: "", category: "", unread: false, group: true };
let cleaner = { items: null, selected: new Set(), status: null };
let statusNode = null;

export async function render(ctx) {
  const [notes, status] = await Promise.all([rpc("notifications.list", { limit: 300 }), rpc("cleaner.status")]);
  cleaner.status = status;
  let list = notes.filter((n) => (!filt.level || n.level === filt.level) && (!filt.category || n.category === filt.category) && (!filt.unread || !n.read));
  const sel = (key, opts) => {
    const s = h("select", { class: "input" }, h("option", { value: "" }, "Tutte"), Object.entries(opts).map(([k, v]) => h("option", { value: k }, Array.isArray(v) ? v[0] : v)));
    s.value = filt[key];
    s.addEventListener("change", () => { filt[key] = s.value; ctx.refresh(); });
    return s;
  };
  const groups = {};
  for (const n of list) (groups[filt.group ? n.groupKey : n.id] ||= []).push(n);

  const center = h("div", { class: "card" },
    h("div", { class: "panel-head" }, h("h2", {}, icon("bell"), "Centro notifiche"), h("span", { class: "grow" }),
      h("button", { class: "btn sm", onclick: async () => { await rpc("notifications.read", {}); ctx.refresh(); } }, icon("check", 14), "Segna tutte come lette"),
      h("button", { class: "btn sm", onclick: () => rpc("notifications.test").then(() => toast("Notifica di prova inviata")) }, "Prova"),
      h("button", { class: "btn sm", onclick: async () => { const r = await rpc("notifications.delete", { ids: notes.filter((n) => n.read).map((n) => n.id) }); toast(`${r.deleted} notifiche lette eliminate`); ctx.refresh(); } }, icon("trash", 14), "Elimina lette"),
      h("button", { class: "btn sm danger", onclick: async () => { if (await confirmBox("Eliminare tutte le notifiche?", `Si cancellano tutte le ${notes.length} notifiche, lette e non lette, comprese quelle persistenti.`, "Elimina tutte", true)) { const r = await rpc("notifications.delete", { all: true }); toast(`${r.deleted} notifiche eliminate`, "", "success"); ctx.refresh(); } } }, icon("trash", 14), "Elimina tutte")),
    h("div", { class: "toolbar" }, h("label", { class: "field" }, "Gravità", sel("level", LEVEL)), h("label", { class: "field" }, "Categoria", sel("category", CAT)),
      h("label", { class: "check" }, h("input", { type: "checkbox", checked: filt.unread, onchange: (e) => { filt.unread = e.target.checked; ctx.refresh(); } }), "Solo non lette"),
      h("label", { class: "check" }, h("input", { type: "checkbox", checked: filt.group, onchange: (e) => { filt.group = e.target.checked; ctx.refresh(); } }), "Raggruppa")),
    Object.keys(groups).length ? h("ul", { class: "feed notes", style: { maxHeight: "none", marginTop: "10px" } }, Object.values(groups).map((g) => {
      const n = g[0];
      const lv = LEVEL[n.level] || LEVEL.info;
      return h("li", { style: { opacity: n.read ? 0.65 : 1 } },
        h("span", { class: `pill ${lv[1]}` }, lv[0]),
        h("div", {}, h("b", {}, n.title), g.length > 1 || n.count > 1 ? h("span", { class: "pill", style: { marginLeft: "6px" } }, `×${Math.max(g.length, n.count || 1)}`) : null, n.persistent ? h("span", { class: "pill warn", style: { marginLeft: "6px" } }, "persistente") : null,
          h("div", { class: "small muted" }, n.body), h("div", { class: "small muted" }, `${CAT[n.category] || n.category} · ${fmtDate(n.at)}`)),
        h("div", { class: "row" }, n.link ? h("a", { class: "btn sm", href: n.link.startsWith("#") ? n.link : n.link, target: n.link.startsWith("#") ? null : "_blank", onclick: () => rpc("notifications.read", { ids: g.map((x) => x.id) }) }, "Apri") : null,
          !n.read ? h("button", { class: "btn ghost sm", title: "Segna come letta", "aria-label": "Segna come letta", onclick: async () => { await rpc("notifications.read", { ids: g.map((x) => x.id) }); ctx.refresh(); } }, icon("check", 14)) : null,
          h("button", { class: "btn ghost sm", title: "Elimina", "aria-label": "Elimina la notifica", onclick: async () => { await rpc("notifications.delete", { ids: g.map((x) => x.id) }); ctx.refresh(); } }, icon("trash", 14))));
    })) : h("div", { class: "empty", style: { marginTop: "10px" } }, "Nessuna notifica."));

  statusNode = h("div", {});
  drawStatus();
  const preview = h("div", {});
  drawCleaner(preview, ctx);
  const cleanerCard = h("div", { class: "card" },
    h("div", { class: "panel-head" }, h("h2", {}, icon("sparkles"), "Pulitore notifiche di Vinted")),
    h("p", { class: "small muted" }, "Segna come lette le notifiche dell'account Vinted con cui sei collegato. Non elimina conversazioni, messaggi, offerte o altro, e non clicca niente sulla pagina: usa solo la lettura delle notifiche e «segna come letta»."),
    h("div", { class: "row" },
      h("button", { class: "btn", onclick: async (e) => {
        e.target.disabled = true;
        try { cleaner.items = await rpc("cleaner.preview", { pages: 3 }); cleaner.selected = new Set(cleaner.items.filter((n) => !n.isRead).map((n) => n.id)); drawCleaner(preview, ctx); }
        catch (err) { toast("Notifiche non lette", err.message, "error"); }
        e.target.disabled = false;
      } }, icon("refresh", 16), "Carica anteprima"),
      h("span", { class: "grow" }), statusNode),
    preview);
  return h("div", { class: "grid" },
    h("div", { class: "page-head" }, h("div", { class: "grow" }, h("h1", {}, "Notifiche"), h("p", {}, "Le notifiche di Vintastic e la pulizia di quelle di Vinted."))),
    center, cleanerCard,
    h("div", { class: "card small" }, h("h3", {}, icon("settings", 16), "Preferenze"), "Durata, categorie, notifiche di sistema e Discord si scelgono in ", h("a", { href: "#settings?tab=notifications" }, "Impostazioni › Notifiche"), "."));
}

function drawStatus() {
  const s = cleaner.status;
  if (!statusNode) return;
  if (!s) { statusNode.replaceChildren(); return; }
  const pct = s.total ? Math.round(((s.done + s.failed) / s.total) * 100) : 0;
  statusNode.replaceChildren(h("div", { style: { minWidth: "260px" } },
    h("div", { class: "row small" }, h("b", {}, { running: "In corso", paused: "In pausa", done: "Terminata", cancelled: "Annullata", stopped: "Fermata", failed: "Non riuscita" }[s.status] || s.status), h("span", { class: "muted" }, `${s.done} lette · ${s.failed} errori · ${s.total} totali`)),
    h("div", { class: "progress", style: { marginTop: "6px" } }, h("i", { style: { width: `${pct}%` } })),
    s.status === "running" || s.status === "paused" ? h("div", { class: "row", style: { marginTop: "6px" } },
      h("button", { class: "btn sm", onclick: () => rpc("cleaner.pause", { paused: s.status !== "paused" }) }, s.status === "paused" ? "Riprendi" : "Pausa"),
      h("button", { class: "btn sm danger", onclick: () => rpc("cleaner.cancel") }, "Annulla")) : null,
    s.errors?.length ? h("details", {}, h("summary", { class: "small muted" }, "Errori"), h("ul", { class: "small" }, s.errors.slice(-10).map((e) => h("li", {}, e)))) : null));
}

function drawCleaner(box, ctx) {
  if (!cleaner.items) { box.replaceChildren(h("div", { class: "empty small", style: { marginTop: "10px" } }, "Carica l'anteprima per vedere le notifiche presenti.")); return; }
  const unread = cleaner.items.filter((n) => !n.isRead);
  box.replaceChildren(
    h("div", { class: "row", style: { margin: "10px 0" } }, h("span", { class: "small" }, `${cleaner.items.length} notifiche · ${unread.length} non lette · ${cleaner.selected.size} selezionate`),
      h("button", { class: "btn sm", onclick: () => { cleaner.selected = new Set(unread.map((n) => n.id)); drawCleaner(box, ctx); } }, "Seleziona non lette"),
      h("button", { class: "btn sm ghost", onclick: () => { cleaner.selected.clear(); drawCleaner(box, ctx); } }, "Nessuna"),
      h("span", { class: "grow" }),
      h("button", { class: "btn primary sm", disabled: !cleaner.selected.size, onclick: async () => {
        if (!(await confirmBox("Segnare come lette?", `${cleaner.selected.size} notifiche selezionate verranno segnate come lette su Vinted. Nient'altro viene toccato.`, "Procedi"))) return;
        await rpc("cleaner.clean", { ids: [...cleaner.selected] });
        toast("Pulizia avviata");
      } }, icon("check", 14), "Segna come lette")),
    h("div", { class: "table-wrap", style: { maxHeight: "50vh", overflow: "auto" } }, h("table", { class: "table" }, h("tbody", {}, cleaner.items.map((n) => h("tr", {},
      h("td", {}, h("input", { type: "checkbox", checked: cleaner.selected.has(n.id), disabled: n.isRead, "aria-label": "Seleziona", onchange: (e) => { e.target.checked ? cleaner.selected.add(n.id) : cleaner.selected.delete(n.id); } })),
      h("td", { class: "small" }, n.body || "(senza testo)"), h("td", {}, n.isRead ? h("span", { class: "pill" }, "letta") : h("span", { class: "pill info" }, "non letta")),
      h("td", { class: "small muted" }, n.at ? ago(n.at) : "")))))));
}

export function onEvent(msg) {
  if (msg.type === "vt:cleaner") { cleaner.status = msg.status; drawStatus(); }
}
