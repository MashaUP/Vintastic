/**
 * «Azzera storico»: toglie dal registro No Repeat le operazioni scelte (like, offerte, messaggi
 * privati o un mix) per gli annunci indicati, così le campagne le rifanno. Le voci «in corso» o
 * «da verificare» restano: un esito incerto si risolve prima in Recupero.
 */
import { h, rpc, toast, modal } from "./lib.js";
import { OP_LABEL, OP_TYPES } from "../shared/constants.js";

/**
 * @param scope { listingIds?: string[], campaignId?: string, label: string, types?: string[] }
 * @returns {Promise<object|null>} esito di ledger.clear, o null se annullato
 */
export async function clearHistoryDialog(scope) {
  const preset = new Set(scope.types || OP_TYPES);
  const boxes = OP_TYPES.map((t) => ({ t, cb: h("input", { type: "checkbox", checked: preset.has(t) }) }));
  const quick = (types) => h("button", { class: "btn ghost sm", type: "button", onclick: () => boxes.forEach((b) => { b.cb.checked = types.includes(b.t); }) }, types.map((t) => OP_LABEL[t]).join(" + "));
  const ok = await modal("Azzera storico", h("div", { class: "grid" },
    h("p", {}, `Per ${scope.label}: le operazioni scelte vengono tolte dallo storico di Vintastic. Le campagne le rifaranno invece di saltarle (No Repeat). Su Vinted non cambia niente.`),
    h("div", {}, h("div", { class: "small muted" }, "Operazioni da azzerare"), h("div", { class: "row" }, boxes.map(({ t, cb }) => h("label", { class: "check" }, cb, OP_LABEL[t])))),
    h("div", { class: "row" }, h("span", { class: "small muted" }, "Rapido:"), quick(["like"]), quick(["offer"]), quick(["message"]), quick(["like", "offer"]), quick(OP_TYPES)),
    h("p", { class: "small muted" }, "Le operazioni «in corso» o «da verificare» restano bloccate: un esito incerto va controllato prima (Recupero). Nelle campagne aperte quelle saltate perché «già fatte» tornano in attesa.")),
  [{ label: "Annulla", value: false }, { label: "Azzera", value: true, cls: "danger" }]);
  if (!ok) return null;
  const types = boxes.filter((b) => b.cb.checked).map((b) => b.t);
  if (!types.length) { toast("Scegli almeno un tipo", "", "warning"); return null; }
  try {
    const r = await rpc("ledger.clear", { listingIds: scope.listingIds || null, campaignId: scope.campaignId || null, types });
    toast("Storico azzerato", `${r.removed} voci tolte${r.reset ? ` · ${r.reset} operazioni di nuovo in attesa` : ""}${r.kept ? ` · ${r.kept} in corso o da verificare lasciate` : ""}`, "success", 7000);
    return r;
  } catch (e) {
    toast("Storico non azzerato", e.message, "error");
    return null;
  }
}
