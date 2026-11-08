/** Annunci: tabella con filtri combinati (recenza, Top N, prezzo, stato), selezione e invio a una campagna. */

import { h, icon, rpc, toast, modal, fmtEuro, fmtDay, statusPill, downloadText } from "../lib.js";
import { DATE_FIELDS, RANGES, TOP_N } from "../../shared/filters.js";
import { OP_LABEL } from "../../shared/constants.js";

const state = { filters: { range: "all", dateField: "auto", topN: "", status: "all" }, offset: 0, sort: "date", dir: "desc", selected: new Set(), allIds: null };

const LST = { active: ["Attivo", "good"], sold: ["Venduto", "bad"], reserved: ["Riservato", "warn"], hidden: ["Nascosto", ""], unavailable: ["Non disponibile", ""] };

export async function render(ctx) {
  if (ctx.route.query.seller) state.filters.sellerId = ctx.route.query.seller;
  if (ctx.route.query.search) state.filters.search = ctx.route.query.search;
  const [res, sellers, saved] = await Promise.all([
    rpc("listings.query", { filters: cleanFilters(), offset: state.offset, limit: 50, sort: state.sort, dir: state.dir, withIds: true }),
    rpc("listings.sellers"), rpc("filters.list"),
  ]);
  state.allIds = res.ids;
  const f = state.filters;

  const input = (key, attrs = {}) => {
    const el = h("input", { class: "input", value: f[key] ?? "", ...attrs });
    el.addEventListener("change", () => { f[key] = el.value; state.offset = 0; ctx.refresh(); });
    return el;
  };
  const select = (key, options, attrs = {}) => {
    const el = h("select", { class: "input", ...attrs }, Object.entries(options).map(([v, l]) => h("option", { value: v }, l)));
    el.value = f[key] ?? Object.keys(options)[0];
    el.addEventListener("change", () => { f[key] = el.value; state.offset = 0; ctx.refresh(); });
    return el;
  };
  const sellerOpts = { "": "Tutti i venditori", ...Object.fromEntries(sellers.map((s) => [s.sellerId, `${s.login || s.sellerId} (${s.count})`])) };
  const topSel = select("topN", { "": "Tutti", ...Object.fromEntries(TOP_N.map((n) => [String(n), `Ultimi ${n}`])), custom: "Numero personalizzato" }, { "aria-label": "Top N" });
  const topCustom = input("topNCustom", { type: "number", min: 1, placeholder: "N", style: { width: "90px", display: f.topN === "custom" ? "" : "none" }, "aria-label": "Numero personalizzato" });
  const excl = h("select", { class: "input", "aria-label": "Escludi già fatti" }, h("option", { value: "" }, "Includi tutti"), h("option", { value: "like" }, "Escludi già con like"), h("option", { value: "offer" }, "Escludi già con offerta"), h("option", { value: "like,offer" }, "Escludi con like o offerta"));
  excl.value = (f.excludeDone || []).join(",");
  excl.addEventListener("change", () => { f.excludeDone = excl.value ? excl.value.split(",") : undefined; ctx.refresh(); });

  const filtersBox = h("div", { class: "card" },
    h("div", { class: "toolbar" },
      h("label", { class: "field", style: { minWidth: "220px" } }, "Cerca", input("search", { type: "search", placeholder: "Titolo, marca, venditore, id" })),
      h("label", { class: "field" }, "Venditore", select("sellerId", sellerOpts)),
      h("label", { class: "field" }, "Stato", select("status", { all: "Tutti", active: "Attivi", sold: "Venduti", reserved: "Riservati", hidden: "Nascosti" })),
      h("label", { class: "field" }, "Data da usare", select("dateField", DATE_FIELDS)),
      h("label", { class: "field" }, "Periodo", select("range", Object.fromEntries(Object.entries(RANGES).map(([k, v]) => [k, v.label])))),
      f.range === "custom" ? h("label", { class: "field" }, "Dal", dateInput("from")) : null,
      f.range === "custom" ? h("label", { class: "field" }, "Al", dateInput("to")) : null,
      h("label", { class: "field" }, "Più recenti", h("div", { class: "row" }, topSel, topCustom)),
      h("label", { class: "field" }, "Prezzo min", input("priceMin", { type: "number", min: 0, step: "0.5", style: { width: "90px" } })),
      h("label", { class: "field" }, "Prezzo max", input("priceMax", { type: "number", min: 0, step: "0.5", style: { width: "90px" } })),
      h("label", { class: "field" }, "No Repeat", excl)),
    h("div", { class: "row", style: { marginTop: "10px" } },
      h("span", { class: "muted small" }, `${res.total} annunci su ${res.all}`, res.noDate ? ` · ${res.noDate} esclusi perché senza «${DATE_FIELDS[f.dateField]}»` : ""),
      h("span", { class: "grow" }),
      saved.length ? h("select", { class: "input", style: { width: "200px" }, "aria-label": "Filtri salvati", onchange: (e) => { const s = saved.find((x) => x.name === e.target.value); if (s) { state.filters = { ...s.filters }; ctx.refresh(); } } },
        h("option", { value: "" }, "Filtri salvati…"), saved.map((s) => h("option", { value: s.name }, s.name))) : null,
      h("button", { class: "btn sm", onclick: async () => {
        const name = h("input", { class: "input", placeholder: "Es. Ultimi 20 · 7 giorni" });
        if (await modal("Salva filtri", name, [{ label: "Annulla", value: false }, { label: "Salva", value: true, cls: "primary" }]) && name.value.trim()) { await rpc("filters.save", { name: name.value.trim(), filters: state.filters }); toast("Filtri salvati"); ctx.refresh(); }
      } }, icon("download", 14), "Salva filtri"),
      h("button", { class: "btn sm ghost", onclick: () => { state.filters = { range: "all", dateField: "auto", topN: "", status: "all" }; state.offset = 0; ctx.navigate("#listings"); ctx.refresh(); } }, "Azzera")));

  function dateInput(key) {
    const el = h("input", { class: "input", type: "date", value: f[key] ? new Date(Number(f[key])).toISOString().slice(0, 10) : "" });
    el.addEventListener("change", () => { f[key] = el.value ? String(new Date(el.value + (key === "to" ? "T23:59:59" : "T00:00:00")).getTime()) : ""; ctx.refresh(); });
    return el;
  }

  const selCount = h("b", {}, String(state.selected.size));
  const bulk = h("div", { class: "row" },
    h("span", { class: "small" }, "Selezionati: ", selCount),
    h("button", { class: "btn sm", onclick: () => { (state.allIds || []).forEach((id) => state.selected.add(id)); ctx.refresh(); } }, `Seleziona tutti i ${res.total} filtrati`),
    h("button", { class: "btn sm ghost", onclick: () => { state.selected.clear(); ctx.refresh(); } }, "Deseleziona"),
    h("span", { class: "grow" }),
    h("button", { class: "btn sm primary", disabled: !state.selected.size, onclick: () => addToCampaign(ctx) }, icon("zap", 14), "Aggiungi a campagna"),
    h("button", { class: "btn sm", onclick: () => exportCsv(res) }, icon("download", 14), "CSV"),
    h("button", { class: "btn sm danger", disabled: !state.selected.size, onclick: async () => {
      if (!confirm(`Togliere ${state.selected.size} annunci dall'archivio locale? Su Vinted non cambia niente.`)) return;
      await rpc("listings.delete", { ids: [...state.selected] }); state.selected.clear(); ctx.refresh();
    } }, icon("trash", 14), "Togli dall'archivio"));

  const sortSel = h("select", { class: "input", style: { width: "190px" }, "aria-label": "Ordina per" },
    h("option", { value: "date" }, "Data"), h("option", { value: "price" }, "Prezzo"), h("option", { value: "title" }, "Titolo"),
    h("option", { value: "seen" }, "Visti di recente"), h("option", { value: "default" }, "Ordine dei filtri"));
  sortSel.value = state.sort;
  sortSel.addEventListener("change", () => { state.sort = sortSel.value; state.offset = 0; ctx.refresh(); });
  const DIR = { date: ["Più recenti in cima", "Meno recenti in cima"], price: ["Più cari in cima", "Meno cari in cima"], title: ["Z → A", "A → Z"], seen: ["Visti di recente in cima", "Visti da più tempo in cima"], default: ["Ordine normale", "Ordine ribaltato"] }[state.sort] || ["Decrescente", "Crescente"];
  const dirBtn = h("button", { class: "btn", title: "Ribalta l'ordine", "aria-label": `Ribalta l'ordine (ora: ${state.dir === "desc" ? DIR[0] : DIR[1]})`, onclick: () => { state.dir = state.dir === "desc" ? "asc" : "desc"; state.offset = 0; ctx.refresh(); } },
    icon(state.dir === "desc" ? "down" : "up", 16), state.dir === "desc" ? DIR[0] : DIR[1]);

  const rows = res.items.map((l) => {
    const cb = h("input", { type: "checkbox", checked: state.selected.has(l.id), "aria-label": `Seleziona ${l.title}` });
    cb.addEventListener("change", () => { cb.checked ? state.selected.add(l.id) : state.selected.delete(l.id); selCount.textContent = String(state.selected.size); bulk.querySelectorAll(".btn.primary, .btn.danger").forEach((b) => { b.disabled = !state.selected.size; }); });
    const inter = l.interactions;
    const st = LST[l.status] || [l.status, ""];
    return h("tr", {},
      h("td", {}, cb),
      h("td", {}, l.photo ? h("img", { class: "thumb", src: l.photo, alt: "", loading: "lazy" }) : h("div", { class: "thumb" })),
      h("td", { style: { maxWidth: "320px" } }, h("a", { href: l.url, target: "_blank", rel: "noopener", style: { color: "var(--text)" } }, l.title || `Annuncio ${l.id}`),
        h("div", { class: "muted small" }, [l.brand, l.size].filter(Boolean).join(" · ") || `id ${l.id}`), l.relistOf ? h("div", { class: "small" }, h("span", { class: "pill info" }, `ripubblicato da ${l.relistOf}`)) : null),
      h("td", {}, fmtEuro(l.price, l.currency)),
      h("td", { class: "small" }, l.sellerLogin || l.sellerId || "—"),
      h("td", { class: "small" }, l.publishedAt ? fmtDay(l.publishedAt) : l.photoAt ? h("span", { title: "Vinted non fornisce la data di pubblicazione: questa è la data della foto principale (stima)" }, `${fmtDay(l.photoAt)} `, h("span", { class: "muted" }, "(foto)")) : "—"),
      h("td", { class: "small" }, fmtDay(l.updatedAt), l.repostedAt ? h("div", { class: "muted" }, `ripubbl.: ${fmtDay(l.repostedAt)}`) : null),
      h("td", {}, h("span", { class: `pill ${st[1]}` }, st[0])),
      h("td", {}, inter ? h("div", { class: "ops" }, ["like", "offer", "message"].filter((t) => inter[t]).map((t) => h("span", { class: `op-chip ${inter[t]}`, title: inter[t] }, OP_LABEL[t]))) : h("span", { class: "muted small" }, "Mai elaborato")),
      h("td", { class: "small" }, inter?.accounts?.map((a) => a.split("@")[0]).join(", ") || "—"),
      h("td", { class: "small" }, l.campaigns?.join(", ") || "—"));
  });

  const pager = h("div", { class: "pager" },
    h("span", { class: "muted small" }, `${state.offset + 1}–${Math.min(state.offset + 50, res.total)} di ${res.total}`),
    h("button", { class: "btn sm", disabled: state.offset === 0, onclick: () => { state.offset = Math.max(0, state.offset - 50); ctx.refresh(); } }, "← Precedenti"),
    h("button", { class: "btn sm", disabled: state.offset + 50 >= res.total, onclick: () => { state.offset += 50; ctx.refresh(); } }, "Successivi →"));

  return h("div", { class: "grid" },
    h("div", { class: "page-head" }, h("div", { class: "grow" }, h("h1", {}, "Annunci"), h("p", {}, "Tutto ciò che hai scansionato. Filtra, seleziona e manda in una campagna.")),
      h("label", { class: "field" }, "Ordina per", h("div", { class: "row" }, sortSel, dirBtn))),
    filtersBox, bulk,
    res.items.length ? h("div", { class: "table-wrap" }, h("table", { class: "table" },
      h("thead", {}, h("tr", {}, ["", "Immagine", "Titolo", "Prezzo", "Venditore", "Pubblicato", "Aggiornato", "Stato", "Interazioni", "Account", "Campagne"].map((x) => h("th", {}, x)))),
      h("tbody", {}, rows)), pager) : h("div", { class: "empty" }, res.all ? `Nessun annuncio con questi filtri.${res.noDate ? ` ${res.noDate} esclusi perché senza la data scelta: prova «Qualsiasi data».` : ""}` : "Nessun annuncio: avvia una scansione dallo Scanner."));
}

function cleanFilters() {
  const f = { ...state.filters };
  if (f.topN === "custom") f.topN = Number(f.topNCustom) || "";
  return f;
}

async function addToCampaign(ctx) {
  const camps = (await rpc("campaigns.list")).filter((c) => !["completed", "stopped"].includes(c.status));
  const sel = h("select", { class: "input" }, h("option", { value: "__new" }, "+ Nuova campagna"), camps.map((c) => h("option", { value: c.id }, `${c.name} (${c.status})`)));
  const name = h("input", { class: "input", placeholder: "Nome della nuova campagna", value: `Campagna ${new Date().toLocaleDateString("it-IT")}` });
  const types = ["like", "offer", "message"].map((t) => ({ t, cb: h("input", { type: "checkbox", checked: t === "like" }) }));
  const where = h("select", { class: "input", "aria-label": "Posizione" }, h("option", { value: "start" }, "In cima alla coda"), h("option", { value: "end" }, "In fondo alla coda"));
  // «Posizione»: quella salvata nella campagna scelta; per una campagna nuova, la predefinita (In cima).
  const syncWhere = () => { const c = camps.find((x) => x.id === sel.value); where.value = c?.addPosition || ctx.settings.campaignDefaults?.addPosition || "start"; };
  sel.addEventListener("change", syncWhere);
  syncWhere();
  const ok = await modal(`Aggiungi ${state.selected.size} annunci`, h("div", { class: "grid" },
    h("label", { class: "field" }, "Campagna", sel), name,
    h("div", {}, h("div", { class: "small muted" }, "Operazioni (combinabili)"), h("div", { class: "row" }, types.map(({ t, cb }) => h("label", { class: "check" }, cb, OP_LABEL[t])))),
    h("label", { class: "field" }, "Posizione", where),
    h("div", { class: "muted small" }, "Le nuove campagne partono in Simulazione: niente viene inviato a Vinted finché non scegli la modalità reale.")),
  [{ label: "Annulla", value: false }, { label: "Aggiungi", value: true, cls: "primary" }]);
  if (!ok) return;
  const chosen = types.filter((x) => x.cb.checked).map((x) => x.t);
  if (!chosen.length) return toast("Scegli almeno un'operazione", "", "warning");
  try {
    let id = sel.value;
    if (id === "__new") id = (await rpc("campaigns.create", { name: name.value, types: chosen, dryRun: true, addPosition: where.value })).id;
    const r = await rpc("campaigns.add", { id, listingIds: [...state.selected], spec: { types: chosen }, where: where.value });
    toast(`${r.added} annunci aggiunti`, r.rejected.length ? `${r.rejected.length} scartati (${r.rejected[0].reason})` : "", "success");
    state.selected.clear();
    ctx.navigate(`#campaigns/${id}`);
  } catch (e) { toast("Non aggiunti", e.message, "error"); }
}

/** CSV preparato in un Web Worker: la pagina non si blocca anche con migliaia di righe. */
async function exportCsv(res) {
  const all = await rpc("listings.byIds", { ids: state.allIds || res.items.map((x) => x.id) });
  const worker = new Worker(new URL("../workers/data-worker.js", import.meta.url), { type: "module" });
  worker.postMessage({ type: "csv", rows: all, columns: ["id", "title", "price", "currency", "sellerLogin", "sellerId", "status", "publishedAt", "updatedAt", "repostedAt", "url"] });
  worker.onmessage = (e) => { downloadText(e.data.text, `vintastic-annunci-${new Date().toISOString().slice(0, 10)}.csv`); worker.terminate(); };
}
