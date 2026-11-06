/** Scanner degli armadi: avvio, avanzamento in tempo reale, storico. */

import { h, icon, rpc, toast, fmtDate, fmtNum } from "../lib.js";

let listNode = null;
let scansCache = [];

function scanRow(s) {
  const pct = s.totalPages ? Math.round((s.pages / s.totalPages) * 100) : s.status === "done" ? 100 : null;
  const pill = { running: ["In corso", "info"], done: ["Completata", "good"], failed: ["Non riuscita", "bad"], cancelled: ["Annullata", ""] }[s.status] || [s.status, ""];
  return h("tr", { "data-id": s.id },
    h("td", {}, h("b", {}, `Armadio ${s.sellerId}`), h("div", { class: "muted small" }, s.origin)),
    h("td", {}, h("span", { class: `pill ${pill[1]}` }, pill[0]), s.method === "dom" ? h("div", { class: "muted small" }, "letta dalla pagina") : null),
    h("td", { style: { minWidth: "160px" } }, pct != null ? h("div", { class: "progress" }, h("i", { style: { width: `${pct}%` } })) : h("span", { class: "muted small" }, "—"),
      h("div", { class: "muted small" }, `pagina ${s.pages || 0}${s.totalPages ? ` di ${s.totalPages}` : ""}`)),
    h("td", {}, fmtNum(s.found)), h("td", {}, fmtNum(s.added)), h("td", {}, fmtNum(s.updated)),
    h("td", { class: "small" }, fmtDate(s.startedAt)),
    h("td", { class: "small" }, [...(s.errors || []), ...(s.inaccessible || [])].slice(-2).join(" · ") || "—"),
    h("td", {}, s.status === "running"
      ? h("button", { class: "btn sm danger", onclick: () => rpc("scan.cancel", { id: s.id }) }, "Annulla")
      : h("a", { class: "btn sm", href: `#listings?seller=${s.sellerId}` }, "Vedi annunci")));
}

export async function render(ctx) {
  scansCache = await rpc("scans.list", { limit: 50 });
  const url = h("input", { class: "input", placeholder: "https://www.vinted.it/member/12345678-nomeutente", "aria-label": "URL dell'armadio", value: ctx.route.query.url || "" });
  const max = h("input", { class: "input", type: "number", min: 1, max: 20000, value: 2000, "aria-label": "Massimo annunci" });
  const start = h("button", { class: "btn primary", onclick: async () => {
    start.disabled = true;
    try {
      await rpc("scan.start", { url: url.value.trim(), maxItems: Number(max.value) || 2000 });
      toast("Scansione avviata", "L'avanzamento compare qui sotto in tempo reale.", "success");
      ctx.refresh();
    } catch (e) { toast("Scansione non avviata", e.message, "error"); }
    start.disabled = false;
  } }, icon("scan", 16), "Avvia scansione");

  listNode = h("tbody", {}, scansCache.map(scanRow));
  return h("div", { class: "grid" },
    h("div", { class: "page-head" }, h("div", { class: "grow" }, h("h1", {}, "Scanner"), h("p", {}, "Legge gli annunci di un armadio e li salva sul tuo computer, senza doppioni."))),
    h("div", { class: "card" }, h("h3", {}, icon("search", 16), "Nuova scansione"),
      h("div", { class: "toolbar" }, h("label", { class: "field grow", style: { flex: 1, minWidth: "280px" } }, "URL dell'armadio Vinted", url), h("label", { class: "field" }, "Massimo annunci", max), start),
      h("p", { class: "muted small" }, "Suggerimento: dalla pagina di un armadio su Vinted puoi usare il pulsante Vintastic › «Scansiona questo armadio». Le pagine si leggono con calma (circa 1 secondo l'una); se Vinted limita le richieste la scansione si ferma.")),
    h("div", { class: "card" }, h("h3", {}, icon("history", 16), "Scansioni"),
      scansCache.length ? h("div", { class: "table-wrap" }, h("table", { class: "table" },
        h("thead", {}, h("tr", {}, ["Armadio", "Stato", "Progresso", "Trovati", "Nuovi", "Aggiornati", "Avvio", "Note", ""].map((x) => h("th", {}, x)))), listNode))
        : h("div", { class: "empty" }, "Nessuna scansione ancora.")),
    h("div", { class: "callout info small" }, h("b", {}, "Date degli annunci. "), "Vintastic tiene separate data di pubblicazione, aggiornamento, ripubblicazione e data della foto principale. Se Vinted non ne fornisce una, resta vuota: non viene dedotta."));
}

export function onEvent(msg, ctx) {
  if (msg.type !== "vt:scan" || !listNode) return;
  const s = msg.scan;
  const row = listNode.querySelector(`tr[data-id="${s.id}"]`);
  if (row) row.replaceWith(scanRow(s));
  else ctx.refresh();
}
