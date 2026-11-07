/**
 * Editor dei messaggi di una campagna: fonte del testo, modello, testo scritto ora,
 * modalità A/B e anteprima con un annuncio d'esempio. Usato in «Nuova campagna»
 * e nelle impostazioni della campagna.
 */

import { h } from "./lib.js";
import { MESSAGE_SOURCES, MESSAGE_MAX, PLACEHOLDERS, messageConfig, resolveMessage, cleanRecipients } from "../shared/messages.js";

const SAMPLE = { id: "1", title: "Giacca di jeans vintage", price: 25, currency: "EUR", brand: "Levi's", size: "M", sellerLogin: "venditrice" };

export function messageEditor(settings, campaign = null, sampleListing = null) {
  const cfg = messageConfig(campaign || { opsDefaults: { message: { source: "default" } } });
  const templates = settings.messages?.templates || [];
  const recipients = cleanRecipients(settings.messages?.recipients);

  const source = h("select", { class: "input", "aria-label": "Testo del messaggio" }, Object.entries(MESSAGE_SOURCES).map(([k, v]) => h("option", { value: k, disabled: ["template", "rotate", "random"].includes(k) && !templates.length }, v)));
  source.value = cfg.source;
  const template = h("select", { class: "input", "aria-label": "Modello" }, templates.map((t) => h("option", { value: t.id }, t.name)));
  if (cfg.templateId) template.value = cfg.templateId;
  const picks = templates.map((t) => ({ t, cb: h("input", { type: "checkbox", checked: cfg.templateIds.includes(t.id) }) }));
  const custom = h("textarea", { class: "input", rows: 3, maxlength: MESSAGE_MAX, value: cfg.text, placeholder: "Scrivi qui il messaggio per questa campagna" });
  const mode = h("select", { class: "input", "aria-label": "Modalità di invio" },
    h("option", { value: "" }, `Come nelle Impostazioni (${settings.messages?.mode === "manual" ? "B — manuale" : "A — automatica"})`),
    h("option", { value: "auto" }, "A — Automatica: Vintastic preme Invia e verifica"),
    h("option", { value: "manual" }, "B — Manuale: Vintastic compila, premi tu Invia"));
  mode.value = cfg.mode || "";
  const count = h("span", { class: "small muted" });
  const preview = h("div", { class: "sugg small", style: { whiteSpace: "pre-wrap" } });

  const boxTemplate = h("label", { class: "field" }, "Modello", template);
  const boxPicks = h("div", {}, h("div", { class: "small muted" }, "Modelli da usare (nessuno selezionato = tutti)"), h("div", { class: "row" }, picks.map(({ t, cb }) => h("label", { class: "check" }, cb, t.name))));
  const boxCustom = h("label", { class: "field" }, "Testo", custom, count);

  const value = () => ({
    source: source.value,
    templateId: source.value === "template" ? template.value || null : null,
    templateIds: ["rotate", "random"].includes(source.value) ? picks.filter((p) => p.cb.checked).map((p) => p.t.id) : [],
    text: source.value === "custom" ? custom.value.trim() : "",
    mode: mode.value || null,
  });

  const draw = () => {
    const v = value();
    boxTemplate.style.display = v.source === "template" ? "" : "none";
    boxPicks.style.display = ["rotate", "random"].includes(v.source) ? "" : "none";
    boxCustom.style.display = v.source === "custom" ? "" : "none";
    count.textContent = `${custom.value.trim().length}/${MESSAGE_MAX}`;
    const r = resolveMessage(v, sampleListing || SAMPLE, settings, { index: 0, seed: campaign?.sort?.seed ?? 0 });
    preview.replaceChildren(h("b", {}, "Anteprima: "), r.ok ? r.text : h("span", { style: { color: "var(--bad)" } }, r.reason));
  };
  for (const el of [source, template, custom, mode, ...picks.map((p) => p.cb)]) { el.addEventListener("input", draw); el.addEventListener("change", draw); }
  draw();

  const node = h("div", { class: "grid" },
    recipients.length
      ? h("p", { class: "small muted", style: { margin: 0 } }, `Destinatari autorizzati: ${recipients.map((r) => r.label || r.id).join(", ")}. Gli annunci di altri venditori non ricevono messaggi.`)
      : h("div", { class: "callout warn small" }, h("b", {}, "Nessun destinatario autorizzato. "), "Aggiungi gli account in Impostazioni › Messaggi, altrimenti la campagna non parte."),
    h("label", { class: "field" }, "Testo del messaggio", source),
    boxTemplate, boxPicks, boxCustom,
    h("label", { class: "field" }, "Modalità di invio", mode),
    preview,
    h("p", { class: "small muted", style: { margin: 0 } }, "Segnaposto: ", Object.keys(PLACEHOLDERS).join(" "), ". Il testo di ogni annuncio si vede nell'anteprima della campagna e si può cambiare annuncio per annuncio."));
  return { node, value };
}
