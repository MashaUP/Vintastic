/** Account Manager: account rilevati, etichette, stato della sessione, cambio account assistito. */

import { h, icon, rpc, toast, fmtNum, ago, modal, confirmBox } from "../lib.js";
import { ACCOUNT_LABELS } from "../../shared/constants.js";

export async function render(ctx) {
  const accounts = await rpc("accounts.list");
  const sess = ctx.overview?.session || {};

  const head = h("div", { class: "page-head" }, h("div", { class: "grow" }, h("h1", {}, "Account"),
    h("p", {}, "Gli account Vinted rilevati in questo browser. Le interazioni partono sempre e solo dall'account con cui sei collegato a Vinted.")),
    h("button", { class: "btn", onclick: async (e) => {
      e.target.disabled = true;
      try { const r = await rpc("session.check"); toast(r.session.loggedIn ? "Sessione attiva" : "Sessione non attiva", r.session.loggedIn ? `${r.session.login || r.session.userId} su ${r.session.origin}` : "Accedi a Vinted nella scheda aperta da Vintastic.", r.session.loggedIn ? "success" : "warning"); }
      catch (err) { toast("Verifica non riuscita", err.message, "error"); }
      e.target.disabled = false;
      ctx.refresh();
    } }, icon("refresh", 16), "Verifica sessione"),
    h("button", { class: "btn primary", onclick: () => switchAccount() }, icon("key", 16), "Accedi / cambia account"));

  const current = h("div", { class: `callout ${sess.loggedIn ? (sess.challenge ? "warn" : "good") : "warn"}` },
    h("b", {}, sess.loggedIn ? `Sessione attiva: ${ctx.overview?.account?.login ? "@" + ctx.overview.account.login : `utente ${sess.userId}`} su ${sess.origin}` : "Nessuna sessione Vinted rilevata"),
    h("div", { class: "small" }, sess.challenge ? "Vinted chiede una verifica: completala tu nella scheda di Vinted." : sess.loggedIn ? `Ultimo controllo ${ago(sess.checkedAt)}.` : "Apri vinted.it da loggato: Vintastic riconosce l'account da solo."));

  const favorites = accounts.filter((a) => a.favorite);
  const quick = favorites.length ? h("div", { class: "card" }, h("h3", {}, icon("heart", 16), "Preferiti"),
    h("div", { class: "row" }, favorites.map((a) => h("span", { class: `pill ${a.current ? "good" : ""}` }, a.current ? "● " : "", a.login || a.userId, " · ", a.customLabel || a.label)))) : null;

  const table = accounts.length ? h("div", { class: "table-wrap" }, h("table", { class: "table" },
    h("thead", {}, h("tr", {}, ["", "Account", "Etichetta", "Sessione", "Ultima attività", "Annunci scansionati", "Interazioni", "Campagne attive", "Problemi", ""].map((x) => h("th", {}, x)))),
    h("tbody", {}, accounts.map((a) => h("tr", {},
      h("td", {}, h("span", { class: "avatar" }, (a.login || "?").slice(0, 1).toUpperCase())),
      h("td", {}, h("b", {}, a.login ? `@${a.login}` : `Utente ${a.userId}`), h("div", { class: "muted small" }, `${a.origin} · id ${a.userId}`), a.current ? h("span", { class: "pill good" }, "Attuale") : null),
      h("td", {}, labelEditor(a, ctx)),
      h("td", {}, h("span", { class: `pill ${a.current ? (a.sessionStatus === "attiva" ? "good" : "warn") : ""}` }, a.sessionStatus)),
      h("td", { class: "small" }, ago(a.lastSeenAt)),
      h("td", {}, fmtNum(a.scanned)),
      h("td", {}, fmtNum(a.interactions)),
      h("td", {}, fmtNum(a.activeCampaigns)),
      h("td", { class: "small" }, a.authProblem || "—"),
      h("td", {}, h("div", { class: "row" },
        h("button", { class: "btn ghost sm", title: a.favorite ? "Togli dai preferiti" : "Aggiungi ai preferiti", "aria-pressed": String(Boolean(a.favorite)), onclick: async () => { await rpc("accounts.update", { id: a.id, patch: { favorite: !a.favorite } }); ctx.refresh(); } }, icon("heart", 14)),
        h("button", { class: "btn ghost sm", title: "Note", onclick: () => editNotes(a, ctx) }, icon("edit", 14)),
        h("button", { class: "btn ghost sm", title: "Rimuovi dall'elenco", onclick: async () => {
          if (!(await confirmBox("Rimuovere l'account dall'elenco?", "Resta tutto su Vinted; si cancella solo la scheda in Vintastic. Lo storico delle interazioni resta.", "Rimuovi", true))) return;
          try { await rpc("accounts.delete", { id: a.id }); ctx.refresh(); } catch (e) { toast("Non rimosso", e.message, "error"); }
        } }, icon("trash", 14))))))))) : h("div", { class: "empty" }, "Nessun account rilevato. Apri Vinted da loggato in una scheda: comparirà qui.");

  const howto = h("div", { class: "card" }, h("h3", {}, icon("shield", 16), "Cambio account e verifiche"),
    h("ol", { class: "small", style: { margin: 0, paddingLeft: "18px" } },
      h("li", {}, "Un'estensione non può cambiare da sola una sessione autenticata: il cambio si fa su Vinted (esci e accedi con l'altro account)."),
      h("li", {}, "«Accedi / cambia account» mette in pausa le campagne che usano l'account attuale e apre Vinted nella scheda di Vintastic."),
      h("li", {}, "Codici di verifica, conferme e 2FA li inserisci tu: Vintastic non li legge, non li intercetta e non li salva."),
      h("li", {}, "Quando la sessione torna valida e coincide con l'account della campagna, Vintastic te lo segnala e puoi riprendere dal punto esatto in cui eri."),
      h("li", {}, "Se l'account della sessione non è quello della campagna, la campagna resta in pausa con il motivo scritto.")));

  return h("div", { class: "grid" }, head, current, quick, table, howto);

  async function switchAccount() {
    const running = (ctx.overview?.campaigns || []).filter((c) => c.status === "running" && !c.dryRun);
    if (running.length && !(await confirmBox("Ci sono campagne in esecuzione", `${running.length} campagne verranno messe in pausa prima del cambio. Riprendono quando la sessione è di nuovo valida.`, "Metti in pausa e continua"))) return;
    for (const c of running) await rpc("campaigns.pause", { id: c.id });
    const r = await rpc("session.openLogin", {});
    toast("Vinted aperto", r.hint, "info", 9000);
  }
}

function labelEditor(a, ctx) {
  const sel = h("select", { class: "input", "aria-label": "Etichetta", style: { minWidth: "150px" } }, ACCOUNT_LABELS.map((l) => h("option", { value: l }, l)));
  sel.value = ACCOUNT_LABELS.includes(a.label) ? a.label : "Personalizzato";
  const custom = h("input", { class: "input", placeholder: "Etichetta personalizzata", value: a.customLabel || "", style: { marginTop: "4px", display: sel.value === "Personalizzato" ? "" : "none" } });
  const save = async () => { await rpc("accounts.update", { id: a.id, patch: { label: sel.value, customLabel: custom.value.trim().slice(0, 40) } }); toast("Etichetta salvata", "", "success", 1500); };
  sel.addEventListener("change", () => { custom.style.display = sel.value === "Personalizzato" ? "" : "none"; save(); });
  custom.addEventListener("change", save);
  return h("div", {}, sel, custom, h("div", { class: "muted small" }, "Solo descrittiva: non cambia il comportamento."));
}

async function editNotes(a, ctx) {
  const ta = h("textarea", { class: "input", value: a.notes || "", "aria-label": "Note" });
  ta.value = a.notes || "";
  const ok = await modal(`Note per ${a.login || a.userId}`, ta, [{ label: "Annulla", value: false }, { label: "Salva", value: true, cls: "primary" }]);
  if (ok) { await rpc("accounts.update", { id: a.id, patch: { notes: ta.value.slice(0, 500) } }); ctx.refresh(); }
}
