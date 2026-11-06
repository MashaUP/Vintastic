/** Smart Offer Engine: editor delle regole (riusato nelle campagne) e anteprima dal vivo. */

import { h, icon, rpc, toast, fmtEuro } from "../lib.js";
import { OFFER_MODES, RULE_KINDS, ROUNDING, DIRECTIONS, DEFAULT_OFFER, normalizeOffer, computeOffer } from "../../shared/offer.js";

/** Editor riutilizzabile. value() restituisce la configurazione corrente. */
export function offerEditor(initial = DEFAULT_OFFER, onChange = () => {}) {
  let cfg = normalizeOffer(structuredClone(initial));
  const node = h("div", { class: "grid" });
  const sel = (opts, val, fn, label) => {
    const s = h("select", { class: "input", "aria-label": label }, Object.entries(opts).map(([k, v]) => h("option", { value: k }, v)));
    s.value = val;
    s.addEventListener("change", () => { fn(s.value); draw(); onChange(cfg); });
    return s;
  };
  const num = (val, fn, attrs = {}) => {
    const i = h("input", { class: "input", type: "number", step: "0.01", value: val ?? "", ...attrs });
    i.addEventListener("input", () => { fn(i.value === "" ? null : Number(i.value)); onChange(cfg); });
    return i;
  };
  function ruleFields(rule, set) {
    const out = [h("label", { class: "field" }, "Regola", sel(RULE_KINDS, rule.kind, (v) => set({ kind: v, value: rule.value ?? 10, from: rule.from ?? 80, to: rule.to ?? 95, unit: rule.unit || "percent" }), "Regola"))];
    if (rule.kind === "random") {
      out.push(h("label", { class: "field" }, "Unità", sel({ percent: "% del prezzo", amount: "Euro" }, rule.unit || "percent", (v) => set({ ...rule, unit: v }), "Unità")));
      out.push(h("label", { class: "field" }, "Da", num(rule.from, (v) => { rule.from = v; }, { style: { width: "100px" } })));
      out.push(h("label", { class: "field" }, "A", num(rule.to, (v) => { rule.to = v; }, { style: { width: "100px" } })));
    } else {
      out.push(h("label", { class: "field" }, rule.kind === "percent" ? "Percentuale (− sconto, + aumento)" : /percent/.test(rule.kind) ? "Percentuale" : "Euro", num(rule.value, (v) => { rule.value = v; }, { style: { width: "110px" }, step: rule.kind === "percent" ? "1" : "0.01" })));
    }
    return out;
  }
  function draw() {
    node.replaceChildren(
      h("div", { class: "row" }, h("label", { class: "field grow" }, "Modalità", sel(OFFER_MODES, cfg.mode, (v) => {
        cfg.mode = v;
        if (v === "saving" && (/Up$/.test(cfg.rule.kind) || (cfg.rule.kind === "percent" && cfg.rule.value >= 0))) cfg.rule = { kind: "percent", value: -10 };
        if (v === "interaction" && /Off$/.test(cfg.rule.kind)) cfg.rule = { kind: "percent", value: 5 };
      }, "Modalità"))),
      h("p", { class: "small muted", style: { margin: 0 } }, {
        saving: "Risparmio: l'offerta resta sempre sotto il prezzo.",
        interaction: "Interazione: l'offerta può essere sotto o sopra il prezzo (es. +5% o −10%). Se Vinted rifiuta l'importo lo dice all'invio, con il suo messaggio.",
        custom: "Personalizzata: decidi tu regole, fasce e limiti.",
      }[cfg.mode]),
      h("div", { class: "row" }, ruleFields(cfg.rule, (r) => { cfg.rule = r; draw(); })),
      h("div", { class: "row" },
        h("label", { class: "field" }, "Importo minimo €", num(cfg.min, (v) => { cfg.min = v; }, { style: { width: "110px" } })),
        h("label", { class: "field" }, "Importo massimo €", num(cfg.max, (v) => { cfg.max = v; }, { style: { width: "110px" } })),
        h("label", { class: "field" }, "Arrotondamento", sel(ROUNDING, cfg.rounding.style, (v) => { cfg.rounding.style = v; }, "Arrotondamento")),
        h("label", { class: "field" }, "Direzione", sel(DIRECTIONS, cfg.rounding.direction, (v) => { cfg.rounding.direction = v; }, "Direzione"))),
      h("div", {}, h("div", { class: "row" }, h("b", { class: "small" }, "Regole per fascia di prezzo"), h("span", { class: "muted small" }, "(la prima fascia che contiene il prezzo vince)"), h("span", { class: "grow" }),
        h("button", { class: "btn sm", onclick: () => { cfg.bands.push({ upTo: 20, rule: { kind: "percentOff", value: 10 } }); draw(); onChange(cfg); } }, icon("plus", 14), "Fascia")),
      cfg.bands.map((b, i) => h("div", { class: "row", style: { marginTop: "6px" } },
        h("label", { class: "field" }, "Fino a €", num(b.upTo, (v) => { b.upTo = v; }, { style: { width: "90px" } })),
        ...ruleFields(b.rule, (r) => { b.rule = r; draw(); }),
        h("button", { class: "btn ghost sm", "aria-label": "Rimuovi fascia", onclick: () => { cfg.bands.splice(i, 1); draw(); onChange(cfg); } }, icon("trash", 14))))));
  }
  draw();
  return { node, value: () => normalizeOffer(structuredClone(cfg)) };
}

export async function render(ctx) {
  const initial = ctx.settings.offer?.defaultRules || DEFAULT_OFFER;
  const price = h("input", { class: "input", type: "number", step: "0.5", min: "0.5", value: 25, style: { width: "120px" }, "aria-label": "Prezzo di prova" });
  const out = h("div", { class: "grid" });
  const editor = offerEditor(initial, () => preview());
  function preview() {
    const r = computeOffer(Number(price.value), editor.value());
    const p = Number(price.value);
    const samples = [5, 12, 25, 49.9, 120].map((x) => [x, computeOffer(x, editor.value())]);
    out.replaceChildren(
      r.ok ? h("div", { class: "stat offer" }, h("div", { class: "k" }, h("span", { class: "ic" }, icon("tag", 18)), "Offerta calcolata"), h("div", { class: "v" }, fmtEuro(r.amount)),
        h("div", { class: "d" }, p ? `${r.amount < p ? "-" : "+"}${Math.abs(Math.round((1 - r.amount / p) * 100))}% rispetto a ${fmtEuro(p)}` : "")) : h("div", { class: "callout bad" }, r.error),
      h("ol", { class: "small" }, r.steps.map((s) => h("li", {}, s))),
      r.warnings.length ? h("div", { class: "callout warn small" }, r.warnings.map((w) => h("div", {}, w))) : null,
      r.random ? h("button", { class: "btn sm", onclick: preview }, icon("shuffle", 14), "Rigenera importo casuale") : null,
      h("h3", {}, "Esempi"),
      h("table", { class: "table" }, h("thead", {}, h("tr", {}, h("th", {}, "Prezzo"), h("th", {}, "Offerta"), h("th", {}, "Note"))),
        h("tbody", {}, samples.map(([x, s]) => h("tr", {}, h("td", {}, fmtEuro(x)), h("td", {}, s.ok ? fmtEuro(s.amount) : "—"), h("td", { class: "small muted" }, s.error || s.warnings.join(" ")))))));
  }
  price.addEventListener("input", preview);
  preview();
  return h("div", { class: "grid" },
    h("div", { class: "page-head" }, h("div", { class: "grow" }, h("h1", {}, "Smart Offer Engine"), h("p", {}, "Regole per calcolare l'importo delle offerte. Prima di ogni invio vedi sempre l'anteprima."))),
    h("div", { class: "two" },
      h("div", { class: "card" }, h("h3", {}, icon("settings", 16), "Regole predefinite"), editor.node,
        h("div", { class: "row", style: { marginTop: "12px" } }, h("button", { class: "btn primary", onclick: async () => {
          ctx.settings = await rpc("settings.save", { patch: { offer: { defaultRules: editor.value() } } });
          toast("Regole salvate", "Le nuove campagne le useranno come punto di partenza.", "success");
        } }, "Salva come predefinite"))),
      h("div", { class: "card" }, h("h3", {}, icon("tag", 16), "Anteprima"), h("label", { class: "field" }, "Prezzo dell'annuncio (€)", price), out)),
    h("div", { class: "callout info small" }, h("b", {}, "Un'offerta non è un acquisto. "), "Vintastic invia solo la proposta di prezzo. Se il venditore accetta, comprare resta una tua scelta da fare a mano su Vinted: Vintastic non ha carrello, checkout o pagamenti."));
}
