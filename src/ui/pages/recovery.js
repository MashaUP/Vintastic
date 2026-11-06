/** Campaign Recovery Center: operazioni da verificare, campagne interrotte, ripresa sicura. */

import { h, icon, rpc, toast, fmtDate, fmtEuro, statusPill } from "../lib.js";
import { OP_LABEL } from "../../shared/constants.js";

export async function render(ctx) {
  const r = await rpc("recovery.list");
  const resolve = async (v, done) => {
    await rpc("campaigns.mutate", { id: v.campaignId, action: "resolveVerify", args: { id: v.itemId, opId: v.op.id, done } });
    toast("Esito registrato", done ? "Segnata come completata." : "Segnata come non eseguita: puoi ripeterla.", "success");
    ctx.refresh();
  };
  return h("div", { class: "grid" },
    h("div", { class: "page-head" }, h("div", { class: "grow" }, h("h1", {}, "Recupero"), h("p", {}, "Dopo un crash, un riavvio o un esito incerto: qui niente viene ripetuto alla cieca."))),
    r.lastRecovery ? h("div", { class: "callout info small" }, h("b", {}, "Ultimo recupero automatico: "), `${fmtDate(r.lastRecovery.at)} · ${r.lastRecovery.reset} operazioni rimesse in coda (non erano partite) · ${r.lastRecovery.verify} da verificare (erano in invio).`) : null,
    r.authPending ? h("div", { class: "callout warn" }, h("b", {}, "Autenticazione in attesa"), h("div", { class: "small" }, r.authPending.message), h("div", { class: "row", style: { marginTop: "8px" } },
      h("button", { class: "btn sm", onclick: () => rpc("session.openLogin", { origin: r.authPending.origin }) }, icon("external", 14), "Apri Vinted"),
      h("button", { class: "btn sm", onclick: async () => { await rpc("session.check", { origin: r.authPending.origin }); ctx.refresh(); } }, icon("refresh", 14), "Ricontrolla la sessione"))) : null,
    h("div", { class: "card" }, h("h3", {}, icon("lifebuoy", 16), `Da verificare (${r.verify.length})`),
      h("p", { class: "small muted" }, "Operazioni il cui esito non è certo. Controlla su Vinted e dimmi com'è andata. Per i like c'è anche la verifica automatica."),
      r.verify.length ? h("div", { class: "table-wrap" }, h("table", { class: "table" },
        h("thead", {}, h("tr", {}, ["Campagna", "Annuncio", "Operazione", "Motivo", ""].map((x) => h("th", {}, x)))),
        h("tbody", {}, r.verify.map((v) => h("tr", {},
          h("td", {}, h("a", { href: `#campaigns/${v.campaignId}` }, v.campaign || v.campaignId)),
          h("td", {}, h("a", { href: v.listing?.url, target: "_blank", rel: "noopener" }, v.listing?.title?.slice(0, 50) || v.listing?.id)),
          h("td", {}, OP_LABEL[v.op.type], v.op.amount ? ` ${fmtEuro(v.op.amount)}` : ""),
          h("td", { class: "small muted" }, v.op.error || "—"),
          h("td", {}, h("div", { class: "row" },
            v.op.type === "like" ? h("button", { class: "btn sm", onclick: async () => {
              const x = await rpc("campaigns.verifyOp", { id: v.campaignId, itemId: v.itemId, opId: v.op.id }).catch((e) => ({ message: e.message }));
              toast(x.resolved ? "Verificato" : "Verifica non riuscita", x.message || (x.done ? "Like presente" : "Like assente"), x.resolved ? "success" : "warning");
              ctx.refresh();
            } }, "Verifica") : null,
            h("button", { class: "btn sm", onclick: () => resolve(v, true) }, icon("check", 14), "Eseguita"),
            h("button", { class: "btn sm ghost", onclick: () => resolve(v, false) }, "Non eseguita")))))))) : h("div", { class: "empty small" }, "Niente da verificare.")),
    h("div", { class: "card" }, h("h3", {}, icon("pause", 16), `Campagne interrotte o in pausa automatica (${r.interrupted.length})`),
      r.interrupted.length ? h("ul", { class: "check-list" }, r.interrupted.map((c) => h("li", {}, h("span", { class: "dot warn" }),
        h("div", {}, h("b", {}, c.name), " ", statusPill(c.status), h("div", { class: "small muted" }, c.pauseDetail || (c.recoveredAt ? `Ripristinata dopo un'interruzione il ${fmtDate(c.recoveredAt)}` : "")),
          h("div", { class: "small muted" }, `${c.progress?.completed || 0} completate · ${c.progress?.pending || 0} in attesa · ${c.progress?.verify || 0} da verificare`)),
        h("div", { class: "row" }, c.status === "paused" ? h("button", { class: "btn sm primary", onclick: async () => {
          const x = await rpc("campaigns.resume", { id: c.id });
          if (!x.ok) toast("Non riprende ancora", x.validation?.errors?.join(" · ") || "", "warning"); else toast("Campagna ripresa", "", "success");
          ctx.refresh();
        } }, icon("play", 14), "Riprendi") : null, h("a", { class: "btn sm", href: `#campaigns/${c.id}` }, "Apri"))))) : h("div", { class: "empty small" }, "Nessuna campagna interrotta.")),
    h("div", { class: "card" }, h("h3", {}, icon("x", 16), `Fallite (${r.failed.length})`),
      h("p", { class: "small muted" }, "Fallite con esito certo (niente è arrivato a Vinted): si possono ripetere dalla campagna con «Ripeti falliti»."),
      r.failed.length ? h("table", { class: "table" }, h("tbody", {}, r.failed.slice(0, 100).map((v) => h("tr", {},
        h("td", {}, h("a", { href: `#campaigns/${v.campaignId}` }, v.campaign)), h("td", { class: "small" }, v.listing?.title?.slice(0, 50)), h("td", {}, OP_LABEL[v.op.type]), h("td", { class: "small muted" }, v.op.error))))) : h("div", { class: "empty small" }, "Nessuna operazione fallita.")));
}
