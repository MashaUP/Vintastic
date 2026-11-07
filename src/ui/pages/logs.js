/** Log e diagnostica: filtri, ricerca, dettagli con soluzione, esportazione, Support Bundle, pulizia selettiva. */

import { h, icon, rpc, toast, fmtDate, copyText, downloadJson, downloadText, confirmBox } from "../lib.js";

const CATS = { system: "Sistema", campaign: "Campagna", op: "Operazione", scan: "Scansione", account: "Account", auth: "Autenticazione", network: "Rete", dom: "DOM", js: "JavaScript", persistence: "Persistenza", compat: "Compatibilità", update: "Aggiornamenti", discord: "Discord", policy: "Regole", notif: "Notifiche Vinted" };
const LV = { debug: "", info: "info", warn: "warn", error: "bad", critical: "bad" };
const f = { level: "", category: "", search: "", campaignId: "", opType: "" };

export async function render(ctx) {
  const [logs, camps] = await Promise.all([rpc("logs.query", { ...f, limit: 800 }), rpc("campaigns.list")]);
  const sel = (key, opts, label) => {
    const s = h("select", { class: "input", "aria-label": label }, h("option", { value: "" }, "Tutti"), Object.entries(opts).map(([k, v]) => h("option", { value: k }, v)));
    s.value = f[key];
    s.addEventListener("change", () => { f[key] = s.value; ctx.refresh(); });
    return s;
  };
  const search = h("input", { class: "input", type: "search", value: f.search, placeholder: "Cerca nel messaggio" });
  search.addEventListener("change", () => { f.search = search.value; ctx.refresh(); });

  return h("div", { class: "grid" },
    h("div", { class: "page-head" }, h("div", { class: "grow" }, h("h1", {}, "Log e diagnostica"), h("p", {}, "Per capire perché un'operazione non è andata. Cookie, token e webhook non vengono mai registrati.")),
      h("button", { class: "btn", onclick: async () => downloadJson(await rpc("support.bundle"), `vintastic-support-${Date.now()}.json`) }, icon("lifebuoy", 16), "Support Bundle"),
      h("button", { class: "btn", onclick: async () => copyText(JSON.stringify(await rpc("support.bundle"), null, 2)) }, icon("copy", 16), "Copia diagnostica")),
    h("div", { class: "card" }, h("div", { class: "toolbar" },
      h("label", { class: "field", style: { minWidth: "220px" } }, "Ricerca", search),
      h("label", { class: "field" }, "Gravità", sel("level", { debug: "Debug", info: "Info", warn: "Avviso", error: "Errore", critical: "Critico" }, "Gravità")),
      h("label", { class: "field" }, "Categoria", sel("category", CATS, "Categoria")),
      h("label", { class: "field" }, "Campagna", sel("campaignId", Object.fromEntries(camps.map((c) => [c.id, c.name])), "Campagna")),
      h("label", { class: "field" }, "Operazione", sel("opType", { like: "Like", offer: "Offerta", comment: "Commento", message: "Messaggio privato" }, "Operazione")),
      h("span", { class: "grow" }),
      h("button", { class: "btn sm", onclick: () => downloadJson(logs, `vintastic-log-${Date.now()}.json`) }, icon("download", 14), "JSON"),
      h("button", { class: "btn sm", onclick: () => downloadText(["data;gravita;categoria;campagna;operazione;annuncio;messaggio;soluzione", ...logs.map((l) => [new Date(l.at).toISOString(), l.level, l.category, l.campaignId || "", l.opType || "", l.listingId || "", `"${(l.message || "").replace(/"/g, '""')}"`, `"${(l.solution || "").replace(/"/g, '""')}"`].join(";"))].join("\n"), `vintastic-log-${Date.now()}.csv`) }, icon("download", 14), "CSV"),
      h("button", { class: "btn sm danger", onclick: async () => {
        if (!(await confirmBox("Pulizia selettiva", `Elimino i log che corrispondono ai filtri di gravità e categoria attuali${f.level || f.category ? "" : " (tutti)"}.`, "Elimina", true))) return;
        const n = await rpc("logs.clear", { level: f.level || null, category: f.category || null });
        toast(`${n} voci eliminate`); ctx.refresh();
      } }, icon("trash", 14), "Pulisci")),
    h("p", { class: "small muted" }, `${logs.length} voci. Conservazione: ${ctx.settings.retention?.logsDays || 30} giorni (modificabile in Impostazioni).`)),
    logs.length ? h("div", { class: "table-wrap" }, h("table", { class: "table" },
      h("thead", {}, h("tr", {}, ["Quando", "Gravità", "Categoria", "Messaggio", "Contesto"].map((x) => h("th", {}, x)))),
      h("tbody", {}, logs.map((l) => h("tr", {},
        h("td", { class: "small", style: { whiteSpace: "nowrap" } }, fmtDate(l.at)),
        h("td", {}, h("span", { class: `pill ${LV[l.level]}` }, l.level)),
        h("td", { class: "small" }, CATS[l.category] || l.category),
        h("td", { style: { maxWidth: "560px" } }, l.message,
          l.solution ? h("div", { class: "small", style: { color: "var(--good)" } }, "→ ", l.solution) : null,
          l.stack ? h("details", {}, h("summary", { class: "small muted" }, "Stack trace"), h("pre", { class: "mono", style: { whiteSpace: "pre-wrap" } }, l.stack)) : null),
        h("td", { class: "small muted" }, [l.accountId && `account ${l.accountId.split("@")[0]}`, l.campaignId && `campagna ${camps.find((c) => c.id === l.campaignId)?.name || l.campaignId}`, l.opType, l.listingId && `annuncio ${l.listingId}`].filter(Boolean).join(" · ") || "—")))))) : h("div", { class: "empty" }, "Nessun log con questi filtri."));
}

export function onEvent(msg, ctx) {
  if (msg.type === "vt:log") { clearTimeout(onEvent.t); onEvent.t = setTimeout(() => ctx.refresh(), 2000); }
}
