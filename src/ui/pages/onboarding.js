/**
 * First Campaign Wizard: introduzione → account → sessione → armadio → scansione
 * → selezione → interazioni → simulazione → anteprima. Nessuna interazione reale:
 * la campagna creata è sempre in Simulazione.
 */

import { h, icon, rpc, toast, logo, term, fmtEuro } from "../lib.js";
import { computeOffer } from "../../shared/offer.js";

const STEPS = ["Introduzione", "Account", "Sessione", "Armadio", "Scansione", "Selezione", "Interazioni", "Simulazione", "Anteprima"];

export function startOnboarding(ctx, force = false) {
  if (document.querySelector(".modal-back.onboarding")) return;
  const st = { step: 0, url: "", scanId: null, sellerId: null, topN: 10, listingIds: [], types: new Set(["like"]), offerPct: 15, campaignId: null, validation: null };
  const body = h("div", { class: "modal-body" });
  const foot = h("div", { class: "modal-foot" });
  const stepsBar = h("div", { class: "steps", "aria-label": "Passaggi" });
  const box = h("div", { class: "modal wide", role: "dialog", "aria-modal": "true", "aria-label": "Guida iniziale" },
    h("div", { class: "modal-head" }, logo(28), h("h2", {}, "Benvenuto in Vintastic"), h("button", { class: "btn ghost sm", "aria-label": "Chiudi la guida", onclick: () => close(false) }, icon("x"))),
    h("div", { style: { padding: "12px 18px 0" } }, stepsBar), body, foot);
  const back = h("div", { class: "modal-back onboarding" }, box);
  document.body.append(back);

  function close(done) {
    back.remove();
    if (done !== null) rpc("settings.save", { patch: { onboardingDone: true } }).then((s) => { ctx.settings = s; });
    if (location.hash === "#onboarding") location.hash = "";
  }

  const nav = (canNext = true, nextLabel = "Avanti", onNext = null) => {
    foot.replaceChildren(
      h("label", { class: "check small grow" }, h("input", { type: "checkbox", onchange: (e) => rpc("settings.save", { patch: { onboardingDone: e.target.checked } }) }), "Non mostrare più all'avvio"),
      st.step > 0 ? h("button", { class: "btn", onclick: () => go(st.step - 1) }, "Indietro") : null,
      h("button", { class: "btn ghost", onclick: () => close(true) }, "Salta la guida"),
      h("button", { class: "btn primary", disabled: !canNext, onclick: async () => { if (onNext && (await onNext()) === false) return; go(st.step + 1); } }, nextLabel));
  };

  async function go(n) {
    st.step = Math.max(0, Math.min(STEPS.length - 1, n));
    stepsBar.replaceChildren(...STEPS.map((s, i) => h("span", { class: i === st.step ? "on" : i < st.step ? "done" : "" }, `${i + 1}. ${s}`)));
    body.replaceChildren(h("div", { class: "muted" }, "…"));
    try { await STEP_FN[st.step](); } catch (e) { body.replaceChildren(h("div", { class: "callout bad" }, e.message)); nav(true); }
    body.querySelector("input, select, button")?.focus();
  }

  const STEP_FN = [
    async () => {
      body.replaceChildren(h("p", {}, "Vintastic ti aiuta a scansionare armadi Vinted, scegliere gli annunci e organizzare campagne di like e offerte con il tuo account, con code modificabili, statistiche e diagnostica."),
        h("ul", {}, h("li", {}, "Le prime campagne sono in ", term("Dry Run", "Simulazione"), ": niente viene inviato a Vinted."),
          h("li", {}, h("b", {}, "Vintastic non acquista mai nulla"), ": un'offerta è solo una proposta di prezzo."),
          h("li", {}, "Se Vinted chiede una verifica o limita le richieste, Vintastic si ferma e te lo dice. Non aggira niente."),
          h("li", {}, "Tutti i dati restano sul tuo computer.")),
        h("p", { class: "small muted" }, "La guida dura un paio di minuti e si può riavviare da Impostazioni o dal comando rapido (Ctrl+K)."));
      nav(true, "Iniziamo");
    },
    async () => {
      const o = await rpc("overview");
      body.replaceChildren(h("p", {}, "Vintastic usa l'account con cui sei collegato a Vinted in questo browser. Non chiede né salva password o codici."),
        o.session?.loggedIn ? h("div", { class: "callout good" }, `Account rilevato: ${o.account?.login ? "@" + o.account.login : "utente " + o.session.userId} su ${o.session.origin}`)
          : h("div", { class: "callout warn" }, "Nessun account rilevato. Apri Vinted e accedi: torna qui e premi Avanti.", h("div", { style: { marginTop: "8px" } }, h("button", { class: "btn sm", onclick: () => rpc("session.openLogin", {}) }, icon("external", 14), "Apri Vinted"))));
      nav(true);
    },
    async () => {
      body.replaceChildren(h("p", {}, "Controllo la sessione aprendo Vinted in una scheda di Vintastic (sola lettura)…"));
      nav(false);
      const r = await rpc("session.check").catch((e) => ({ error: e.message }));
      const ok = r.session?.loggedIn && !r.session?.challenge;
      body.replaceChildren(ok ? h("div", { class: "callout good" }, `Sessione valida: ${r.session.login || r.session.userId}`) : h("div", { class: "callout warn" }, r.error || (r.session?.challenge ? "Vinted chiede una verifica: completala tu nella scheda, poi riprova." : "Sessione non attiva: accedi a Vinted nella scheda aperta, poi riprova.")),
        h("button", { class: "btn", onclick: () => go(2) }, icon("refresh", 14), "Riprova"),
        h("p", { class: "small muted" }, "Puoi andare avanti lo stesso: la simulazione non ha bisogno della sessione."));
      nav(true);
    },
    async () => {
      const url = h("input", { class: "input", placeholder: "https://www.vinted.it/member/12345678-nomeutente", value: st.url });
      body.replaceChildren(h("p", {}, "Incolla l'indirizzo di un armadio Vinted (la pagina del profilo di un venditore)."), h("label", { class: "field" }, "URL dell'armadio", url),
        h("p", { class: "small muted" }, "Lo trovi aprendo il profilo del venditore: l'indirizzo contiene /member/ seguito da un numero."));
      nav(true, "Avanti", () => {
        if (!/\/member\/\d+/.test(url.value)) { toast("URL non valido", "Deve contenere /member/<numero>.", "warning"); return false; }
        st.url = url.value.trim();
        st.sellerId = url.value.match(/\/member\/(\d+)/)[1];
        return true;
      });
    },
    async () => {
      const status = h("div", {}, "Avvio della scansione…");
      body.replaceChildren(status);
      nav(false);
      try {
        const scan = st.scanId ? { id: st.scanId } : await rpc("scan.start", { url: st.url, maxItems: 300 });
        st.scanId = scan.id;
        for (let i = 0; i < 240; i++) {
          const s = (await rpc("scans.list", { limit: 20 })).find((x) => x.id === st.scanId);
          status.replaceChildren(h("div", { class: "row" }, h("b", {}, s?.status === "running" ? "Scansione in corso" : s?.status === "done" ? "Scansione completata" : `Stato: ${s?.status}`), h("span", { class: "muted" }, `${s?.found || 0} annunci · pagina ${s?.pages || 0}${s?.totalPages ? `/${s.totalPages}` : ""}`)),
            h("div", { class: "progress", style: { marginTop: "8px" } }, h("i", { style: { width: `${s?.totalPages ? Math.round((s.pages / s.totalPages) * 100) : s?.status === "done" ? 100 : 15}%` } })),
            s?.errors?.length ? h("div", { class: "callout warn small", style: { marginTop: "8px" } }, s.errors.join(" · ")) : null);
          if (s && s.status !== "running") break;
          await new Promise((r) => setTimeout(r, 1000));
        }
      } catch (e) { status.replaceChildren(h("div", { class: "callout bad" }, e.message)); }
      nav(true);
    },
    async () => {
      const top = h("select", { class: "input" }, [5, 10, 20, 50].map((n) => h("option", { value: n }, `I ${n} più recenti`)));
      top.value = String(st.topN);
      const list = h("ul", { class: "small", style: { maxHeight: "260px", overflow: "auto" } });
      const draw = async () => {
        st.topN = Number(top.value);
        const r = await rpc("listings.query", { filters: { sellerId: st.sellerId, topN: st.topN, status: "active" }, limit: 50, withIds: true });
        st.listingIds = r.ids;
        list.replaceChildren(...(r.items.length ? r.items.map((l) => h("li", {}, `${l.title} · ${fmtEuro(l.price)}`)) : [h("li", { class: "muted" }, r.noDate ? `${r.noDate} annunci senza data: scegli dalla pagina Annunci.` : "Nessun annuncio da questo armadio.")]));
      };
      top.addEventListener("change", draw);
      body.replaceChildren(h("p", {}, "Scegli quanti annunci recenti mettere nella campagna di prova."), top, list);
      await draw();
      nav(true);
    },
    async () => {
      const boxes = ["like", "offer"].map((t) => h("label", { class: "check" }, h("input", { type: "checkbox", checked: st.types.has(t), onchange: (e) => { e.target.checked ? st.types.add(t) : st.types.delete(t); } }), t === "like" ? "Like" : "Offerta"));
      const pct = h("input", { class: "input", type: "number", min: 1, max: 60, value: st.offerPct, style: { width: "90px" } });
      const ex = h("span", { class: "muted small" });
      const upd = () => { st.offerPct = Number(pct.value) || 15; const r = computeOffer(20, { mode: "saving", rule: { kind: "percentOff", value: st.offerPct } }); ex.textContent = `Esempio: annuncio a 20 € → offerta ${r.ok ? fmtEuro(r.amount) : "—"}`; };
      pct.addEventListener("input", upd);
      upd();
      body.replaceChildren(h("p", {}, "Quali operazioni? Si possono combinare. I messaggi privati si aggiungono dopo, quando hai scelto i destinatari autorizzati."),
        h("div", { class: "row" }, boxes), h("div", { class: "row" }, h("span", {}, "Sconto dell'offerta (%)"), pct, ex),
        h("p", { class: "small muted" }, "Regole avanzate (fasce, arrotondamenti, importi casuali) in Smart Offer."));
      nav(true, "Avanti", () => { if (!st.types.size) { toast("Scegli almeno un'operazione", "", "warning"); return false; } return true; });
    },
    async () => {
      body.replaceChildren(h("p", {}, "Creo la campagna in Simulazione…"));
      nav(false);
      if (!st.campaignId) {
        const c = await rpc("campaigns.create", { name: "Prima campagna (simulazione)", types: [...st.types], dryRun: true, offerCfg: { mode: "saving", rule: { kind: "percentOff", value: st.offerPct }, rounding: { style: "00", direction: "nearest" } }, listingIds: st.listingIds });
        st.campaignId = c.id;
      }
      const pv = await rpc("campaigns.preview", { id: st.campaignId });
      st.validation = pv.validation;
      body.replaceChildren(h("div", { class: "callout good" }, `Campagna creata con ${pv.items.length} annunci, in Simulazione.`),
        h("p", {}, "In simulazione Vintastic fa tutto il percorso (coda, timer, registro) ma non invia nulla a Vinted. È il modo sicuro per vedere come funziona."),
        pv.validation.warnings.length ? h("div", { class: "callout warn small" }, pv.validation.warnings.join(" ")) : null);
      nav(true);
    },
    async () => {
      const pv = await rpc("campaigns.preview", { id: st.campaignId });
      body.replaceChildren(h("p", {}, "Ultimo passo: l'anteprima. Approvandola salvi una fotografia di cosa verrà fatto; se poi cambiano prezzi o operazioni, Vintastic ti chiede di riapprovare."),
        h("table", { class: "table" }, h("tbody", {}, pv.items.slice(0, 12).flatMap((i) => i.ops.map((o) => h("tr", {}, h("td", { class: "small" }, i.listing.title?.slice(0, 50)), h("td", {}, o.type), h("td", {}, o.amount ? fmtEuro(o.amount) : "")))))),
        pv.items.length > 12 ? h("p", { class: "small muted" }, `… e altri ${pv.items.length - 12} annunci.`) : null);
      foot.replaceChildren(h("button", { class: "btn", onclick: () => go(st.step - 1) }, "Indietro"), h("span", { class: "grow" }),
        h("button", { class: "btn", onclick: async () => { await rpc("campaigns.approve", { id: st.campaignId }); close(true); ctx.navigate(`#campaigns/${st.campaignId}`); } }, "Approva e apri"),
        h("button", { class: "btn primary", onclick: async () => {
          await rpc("campaigns.approve", { id: st.campaignId });
          const r = await rpc("campaigns.start", { id: st.campaignId });
          if (!r.ok) toast("Non avviata", r.validation?.errors?.join(" ") || "", "warning");
          else toast("Simulazione avviata", "Guarda la coda avanzare: niente viene inviato a Vinted.", "success");
          close(true);
          ctx.navigate(`#campaigns/${st.campaignId}`);
        } }, icon("play", 14), "Approva e avvia la simulazione"));
    },
  ];

  if (force || !ctx.settings.onboardingDone) go(0);
}
