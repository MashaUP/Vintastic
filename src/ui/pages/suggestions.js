/** Domande al venditore: suggerimenti modificabili, da copiare o da salvare come modelli di messaggio. */

import { h, icon, rpc, toast, copyText, fmtDate } from "../lib.js";
import { listingIdFrom } from "../../shared/util.js";

export async function render(ctx) {
  const ai = ctx.settings.ai || {};
  const history = await rpc("suggestions.list", { limit: 150 });
  const q = h("input", { class: "input", placeholder: "Cerca tra gli annunci scansionati oppure incolla l'URL / id", value: ctx.route.query.listing || "" });
  const pick = h("select", { class: "input", "aria-label": "Annuncio" }, h("option", { value: "" }, "— scegli un annuncio —"));
  q.addEventListener("input", async () => {
    const id = listingIdFrom(q.value);
    const res = await rpc("listings.query", { filters: { search: id || q.value }, limit: 20 });
    pick.replaceChildren(h("option", { value: "" }, `${res.total} risultati`), ...res.items.map((l) => h("option", { value: l.id }, `${l.title.slice(0, 70)} · ${l.price ?? ""} €`)));
    if (res.items.length === 1) pick.value = res.items[0].id;
  });
  const lang = h("select", { class: "input" }, h("option", { value: "it" }, "Italiano"), h("option", { value: "en" }, "English"));
  lang.value = ai.language || "it";
  const tone = h("select", { class: "input" }, h("option", { value: "cordiale" }, "Cordiale"), h("option", { value: "formale" }, "Formale"), h("option", { value: "diretto" }, "Diretto"));
  tone.value = ai.tone || "cordiale";
  const count = h("input", { class: "input", type: "number", min: 1, max: 8, value: ai.count || 3, style: { width: "80px" } });
  const results = h("div", { class: "grid" });

  const gen = h("button", { class: "btn primary", onclick: async () => {
    const id = pick.value || listingIdFrom(q.value);
    if (!id) return toast("Scegli un annuncio", "", "warning");
    gen.disabled = true;
    try {
      const rec = await rpc("suggest.generate", { listingId: id, opts: { language: lang.value, tone: tone.value, count: Number(count.value) } });
      results.replaceChildren(h("div", { class: "small muted" }, `Per «${rec.title}» · motore: ${ai.provider === "api" && ai.endpoint ? "API configurata (con ripiego locale)" : "regole locali"}`),
        ...rec.texts.map((t) => suggestionRow(t, rec)));
    } catch (e) { toast("Suggerimenti non generati", e.message, "error"); }
    gen.disabled = false;
  } }, icon("sparkles", 16), "Genera suggerimenti");

  return h("div", { class: "grid" },
    h("div", { class: "page-head" }, h("div", { class: "grow" }, h("h1", {}, "Domande al venditore"), h("p", {}, "Domande pertinenti all'annuncio, da modificare e copiare."))),
    h("div", { class: "callout info small" }, "Domande pertinenti all'annuncio. Le copi, oppure le salvi come modello e le usi nei messaggi privati delle campagne (solo verso i destinatari autorizzati)."),
    h("div", { class: "card" }, h("div", { class: "toolbar" }, h("label", { class: "field", style: { flex: 1, minWidth: "260px" } }, "Annuncio", q), h("label", { class: "field", style: { minWidth: "260px" } }, "Risultati", pick)),
      h("div", { class: "toolbar", style: { marginTop: "10px" } }, h("label", { class: "field" }, "Lingua", lang), h("label", { class: "field" }, "Tono", tone), h("label", { class: "field" }, "Quante", count), gen),
      h("div", { style: { marginTop: "12px" } }, results)),
    h("div", { class: "card" }, h("h3", {}, icon("history", 16), "Cronologia"),
      history.length ? h("div", { class: "grid" }, history.map((r) => h("details", {},
        h("summary", {}, h("b", {}, r.title || r.listingId), h("span", { class: "muted small" }, ` · ${fmtDate(r.at)} · ${r.source}`), r.used ? h("span", { class: "pill good", style: { marginLeft: "6px" } }, "usato") : null),
        h("div", { class: "grid", style: { marginTop: "8px" } }, r.texts.map((t) => suggestionRow(t, r)),
          h("div", { class: "row" }, r.url ? h("a", { class: "btn sm", href: r.url, target: "_blank", rel: "noopener" }, icon("external", 14), "Apri annuncio") : null,
            h("button", { class: "btn sm", onclick: async () => { await rpc("suggestions.update", { id: r.id, patch: { used: !r.used } }); ctx.refresh(); } }, r.used ? "Segna come non usato" : "Segna come usato")))))) : h("div", { class: "empty" }, "Ancora nessun suggerimento.")));
}

function suggestionRow(text, rec) {
  const ta = h("input", { class: "input", value: text, "aria-label": "Suggerimento modificabile" });
  return h("div", { class: "sugg" }, ta,
    h("button", { class: "btn sm", onclick: () => copyText(ta.value) }, icon("copy", 14), "Copia"),
    h("button", { class: "btn sm", title: "Salva come modello di messaggio (Impostazioni › Messaggi)", onclick: async () => {
      const s = await rpc("settings.get");
      const templates = s.messages?.templates || [];
      if (templates.some((t) => t.text.trim() === ta.value.trim())) return toast("Modello già presente", "", "info");
      await rpc("settings.save", { patch: { messages: { templates: [...templates, { id: `t${Date.now().toString(36)}`, name: ta.value.slice(0, 40), text: ta.value }] } } });
      toast("Salvato come modello", "Lo trovi in Impostazioni › Messaggi e nelle campagne.", "success");
    } }, icon("plus", 14), "Modello"),
    rec.url ? h("a", { class: "btn sm ghost", href: rec.url, target: "_blank", rel: "noopener", title: "Apri l'annuncio" }, icon("external", 14)) : null);
}
