/**
 * Campaign Manager: elenco, creazione, dettaglio con coda dinamica modificabile
 * anche durante l'esecuzione, anteprima (Policy Validator + Snapshot), storico.
 */

import { h, icon, rpc, toast, modal, confirmBox, fmtEuro, fmtDate, ago, countdown, statusPill, term, revealInModal } from "../lib.js";
import { clearHistoryDialog } from "../history-dialog.js";
import { OP_LABEL, OP_TYPES } from "../../shared/constants.js";
import { SORTS } from "../../shared/filters.js";
import { computeOffer, describeOffer, DEFAULT_OFFER } from "../../shared/offer.js";
import { offerEditor } from "./offers.js";
import { messageEditor } from "../message-editor.js";
import { cycleSummary } from "../../shared/queue.js";
import { sellerOptionLabel } from "../../shared/sellers.js";

let detailTimer = null;
let liveNodes = {};

export async function render(ctx) {
  clearInterval(detailTimer);
  liveNodes = {};
  if (ctx.route.params[0]) return detail(ctx, ctx.route.params[0]);
  if (ctx.route.query.new) setTimeout(() => createDialog(ctx), 50);
  const list = (await rpc("campaigns.list")).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  const selected = new Set();
  const delSel = h("button", { class: "btn danger", disabled: true, onclick: () => removeCampaigns(ctx, [...selected], list) }, icon("trash", 16), "Elimina selezionate");
  const refreshSel = () => { delSel.disabled = !selected.size; delSel.lastChild.textContent = selected.size ? `Elimina selezionate (${selected.size})` : "Elimina selezionate"; };
  const allBox = h("input", { type: "checkbox", "aria-label": "Seleziona tutte", onchange: (e) => {
    document.querySelectorAll("input[data-camp]").forEach((cb) => { cb.checked = e.target.checked; e.target.checked ? selected.add(cb.dataset.camp) : selected.delete(cb.dataset.camp); });
    refreshSel();
  } });
  return h("div", { class: "grid" },
    h("div", { class: "page-head" }, h("div", { class: "grow" }, h("h1", {}, "Campagne"), h("p", {}, "Code di like, offerte e messaggi privati sugli annunci che scegli tu, con il tuo account. Modificabili anche mentre girano.")),
      h("button", { class: "btn", onclick: () => rpc("campaigns.pauseAll").then(() => toast("Tutte in pausa")) }, icon("pause", 16), "Pausa tutte"),
      h("button", { class: "btn primary", onclick: () => createDialog(ctx) }, icon("plus", 16), "Nuova campagna")),
    list.length ? h("div", { class: "row" }, delSel, h("button", { class: "btn ghost", onclick: () => removeCampaigns(ctx, list.map((c) => c.id), list) }, icon("trash", 16), `Elimina tutte (${list.length})`)) : null,
    list.length ? h("div", { class: "table-wrap" }, h("table", { class: "table" },
      h("thead", {}, h("tr", {}, h("th", {}, allBox), ["Nome", "Stato", "Modalità", "Operazioni", "Progresso", "Account", "Creata", ""].map((x) => h("th", {}, x)))),
      h("tbody", {}, list.map((c) => h("tr", {},
        h("td", {}, h("input", { type: "checkbox", "data-camp": c.id, "aria-label": `Seleziona ${c.name}`, onchange: (e) => { e.target.checked ? selected.add(c.id) : selected.delete(c.id); refreshSel(); } })),
        h("td", {}, h("a", { href: `#campaigns/${c.id}`, style: { fontWeight: 650 } }, c.name), c.pauseReason && c.status === "paused" ? h("div", { class: "muted small" }, c.pauseDetail?.slice(0, 90)) : null),
        h("td", {}, statusPill(c.status)),
        h("td", {}, h("span", { class: `pill ${c.dryRun ? "" : "warn"}` }, c.dryRun ? "Simulazione" : "Reale")),
        h("td", { class: "small" }, (c.opsDefaults?.types || []).map((t) => OP_LABEL[t]).join(" + ")),
        h("td", { style: { minWidth: "150px" } }, h("div", { class: "progress" }, h("i", { style: { width: `${c.progress?.percent || 0}%` } })), h("div", { class: "muted small" }, `${c.progress?.completed || 0} ok · ${c.progress?.failed || 0} fallite · ${c.progress?.verify || 0} da verificare · ${c.progress?.pending || 0} in attesa`)),
        h("td", { class: "small" }, c.accountId?.split("@")[0] || "—"),
        h("td", { class: "small" }, ago(c.createdAt)),
        h("td", {}, h("a", { class: "btn sm", href: `#campaigns/${c.id}` }, "Apri"))))))) : h("div", { class: "empty" }, "Nessuna campagna. Scansiona un armadio, seleziona gli annunci e crea la prima campagna."));
}

async function removeCampaigns(ctx, ids, list) {
  if (!ids.length) return;
  const running = list.filter((c) => ids.includes(c.id) && ["running", "paused"].includes(c.status)).length;
  const text = `${ids.length === 1 ? "La campagna verrà eliminata" : `${ids.length} campagne verranno eliminate`} con le loro code.${running ? ` ${running} in corso o in pausa: prima vengono fermate (l'operazione in invio finisce normalmente).` : ""} Il registro delle interazioni resta, così niente verrà ripetuto per sbaglio.`;
  if (!(await confirmBox(ids.length === 1 ? "Eliminare la campagna?" : `Eliminare ${ids.length} campagne?`, text, "Elimina", true))) return;
  toast("Eliminazione in corso…", "", "info", 2000);
  const r = await rpc("campaigns.deleteMany", { ids });
  toast(`${r.deleted} campagne eliminate`, r.failed.length ? `${r.failed.length} non eliminate: ${r.failed[0].error}` : "", r.failed.length ? "warning" : "success");
  if (ctx.route.params[0] && ids.includes(ctx.route.params[0])) ctx.navigate("#campaigns");
  else ctx.refresh();
}

// ------------------------------------------------------------------ creazione

export async function createDialog(ctx, preset = {}) {
  const name = h("input", { class: "input", value: preset.name || `Campagna ${new Date().toLocaleDateString("it-IT")}` });
  const order = [...OP_TYPES];
  const chosen = new Set(preset.types || ["like"]);
  const orderList = h("ul", { class: "widget-cfg", style: { listStyle: "none", padding: 0 } });
  const drawOrder = () => orderList.replaceChildren(...order.map((t, i) => h("li", {},
    h("label", { class: "check grow" }, h("input", { type: "checkbox", checked: chosen.has(t), onchange: (e) => { e.target.checked ? chosen.add(t) : chosen.delete(t); onPick(t, e.target.checked); } }), OP_LABEL[t], t === "message" ? h("span", { class: "muted small" }, " — «Chiedi info», solo ai destinatari autorizzati") : null),
    h("button", { class: "btn ghost sm", "aria-label": "Prima", disabled: i === 0, onclick: () => { [order[i - 1], order[i]] = [order[i], order[i - 1]]; drawOrder(); } }, icon("up", 14)),
    h("button", { class: "btn ghost sm", "aria-label": "Dopo", disabled: i === order.length - 1, onclick: () => { [order[i + 1], order[i]] = [order[i], order[i + 1]]; drawOrder(); } }, icon("down", 14)))));
  // Spuntando un'operazione si apre (e si mostra) la sezione con le sue opzioni.
  const sections = {};
  const onPick = (t, on) => {
    if (t === "like") likeRow.style.display = on ? "" : "none";
    const d = sections[t];
    if (on && d) { d.open = true; revealInModal(d); }
    if (on && t === "like") revealInModal(likeRow);
  };
  const likeExisting = h("select", { class: "input", style: { maxWidth: "260px" }, "aria-label": "Se il like c'è già" },
    h("option", { value: "relike" }, "Toglilo e rimettilo"), h("option", { value: "keep" }, "Lascialo (conta come fatto)"));
  likeExisting.value = preset.likeExisting || ctx.settings.campaignDefaults?.likeExisting || "relike";
  const likeRow = h("div", { class: "row", style: { display: chosen.has("like") ? "" : "none" } }, h("span", { class: "small grow" }, "Se il like c'è già su Vinted"), likeExisting);
  drawOrder();
  const dry = h("input", { type: "checkbox", checked: true });
  const confirmOffer = h("input", { type: "checkbox", checked: false });
  const skipNotActive = h("input", { type: "checkbox", checked: true });
  const sortMode = h("select", { class: "input" }, Object.entries(SORTS).map(([k, v]) => h("option", { value: k }, v)));
  const offerBox = offerEditor(preset.offerCfg || ctx.settings.offer?.defaultRules || DEFAULT_OFFER);
  const t = ctx.settings.timers;
  const num = (v) => h("input", { class: "input", type: "number", min: 0, value: v, style: { width: "90px" } });
  const tOpsMin = num(t.betweenOps.min); const tOpsMax = num(t.betweenOps.max);
  const tItMin = num(t.betweenItems.min); const tItMax = num(t.betweenItems.max);
  const msgBox = messageEditor(ctx.settings, preset.message ? { opsDefaults: { message: preset.message } } : null);

  const ok = await modal("Nuova campagna", h("div", { class: "grid" },
    h("label", { class: "field" }, "Nome", name),
    h("div", {}, h("div", { class: "small muted" }, "Operazioni e ordine (combinabili)"), orderList, likeRow),
    h("label", { class: "check" }, dry, h("span", {}, term("Dry Run", "Simulazione"), ": esegue tutto senza inviare niente a Vinted (consigliata per la prima prova)")),
    h("label", { class: "check" }, confirmOffer, "Chiedi conferma prima di ogni offerta"),
    h("label", { class: "check" }, skipNotActive, "Salta gli annunci venduti, riservati o nascosti"),
    h("label", { class: "field" }, "Ordine della coda", sortMode),
    h("details", {}, h("summary", {}, "Timer di questa campagna (secondi)"),
      h("div", { class: "row", style: { marginTop: "8px" } }, h("span", { class: "small grow" }, "Tra operazioni dello stesso annuncio"), tOpsMin, "–", tOpsMax),
      h("div", { class: "row", style: { marginTop: "8px" } }, h("span", { class: "small grow" }, "Tra annunci diversi"), tItMin, "–", tItMax)),
    sections.offer = h("details", { open: chosen.has("offer") }, h("summary", {}, "Regole delle offerte"), offerBox.node),
    sections.message = h("details", { open: chosen.has("message") }, h("summary", {}, "Messaggio privato"), msgBox.node)),
  [{ label: "Annulla", value: false }, { label: "Crea", value: true, cls: "primary" }], { wide: true });
  if (!ok) return null;
  if (!chosen.size) { toast("Scegli almeno un'operazione", "", "warning"); return null; }
  const c = await rpc("campaigns.create", {
    name: name.value,
    types: order.filter((x) => chosen.has(x)),
    order,
    dryRun: dry.checked,
    offerCfg: offerBox.value(),
    message: msgBox.value(),
    requireConfirm: { offer: confirmOffer.checked },
    skipRules: { notActive: skipNotActive.checked },
    sortMode: sortMode.value,
    likeExisting: likeExisting.value,
    timers: { betweenOps: { min: +tOpsMin.value, max: +tOpsMax.value }, betweenItems: { min: +tItMin.value, max: +tItMax.value } },
    listingIds: preset.listingIds || [],
  });
  toast("Campagna creata", c.dryRun ? "In simulazione." : "Modalità reale.", "success");
  ctx.navigate(`#campaigns/${c.id}`);
  return c;
}

// ------------------------------------------------------------------ dettaglio

/** "@login · vinted.it" se noto, altrimenti "utente 123 · vinted.it". */
function accountLabel(id, ctx) {
  if (!id) return "—";
  const [uid, origin] = id.split("@");
  const acc = ctx.overview?.account?.id === id ? ctx.overview.account : null;
  const host = (origin || "").replace(/^https:\/\/www\./, "");
  return `${acc?.login ? "@" + acc.login : `utente ${uid}`} · ${host}`;
}

const PAUSE_TEXT = { manual: "Invio manuale non arrivato", user: "Pausa manuale", offline: "Connessione assente", blocked: "Vinted ha limitato le richieste", captcha: "Verifica richiesta da Vinted", auth: "Sessione da verificare", limit: "Soglia giornaliera raggiunta", errors: "Troppi errori di fila", snapshot: "Serve una nuova approvazione", confirm: "Conferma richiesta", kill: "Kill Switch", tabClosed: "Scheda di lavoro chiusa", module: "Modulo non disponibile" };

async function detail(ctx, id) {
  const { campaign: c, items } = await rpc("campaigns.get", { id });
  if (!c) return h("div", { class: "empty" }, "Campagna non trovata. ", h("a", { href: "#campaigns" }, "Torna all'elenco"));
  const order = items.filter((i) => !i.removed).sort((a, b) => (b.priority || 0) - (a.priority || 0) || a.position - b.position);
  const removed = items.filter((i) => i.removed);
  const p = c.progress || {};
  const act = async (method, params = {}) => {
    try {
      const r = await rpc(method, { id, ...params });
      if (r?.ok === false && r.validation) return showValidation(r.validation, ctx, id);
      if (r?.rejected) toast("Non eseguito", typeof r.rejected === "string" ? r.rejected : r.rejected.map?.((x) => x.reason).join(", "), "warning");
    } catch (e) { toast("Errore", e.message, "error"); }
    ctx.refresh();
  };

  const timer = h("b", {}, c.status === "running" && c.nextAt ? countdown(c.nextAt - Date.now()) : "—");
  liveNodes.timer = timer;
  detailTimer = setInterval(() => { if (timer.isConnected && c.nextAt && c.status === "running") timer.textContent = countdown(c.nextAt - Date.now()); }, 1000);

  const controls = h("div", { class: "row" },
    ["draft", "ready", "stopped", "completed"].includes(c.status) || c.status === "paused" ? h("button", { class: "btn", onclick: () => previewDialog(ctx, id) }, icon("check", 16), "Anteprima e approvazione") : null,
    ["ready", "draft"].includes(c.status) ? h("button", { class: "btn primary", onclick: () => act("campaigns.start") }, icon("play", 16), c.dryRun ? "Avvia simulazione" : "Avvia") : null,
    c.status === "running" ? h("button", { class: "btn", onclick: () => act("campaigns.pause") }, icon("pause", 16), "Pausa") : null,
    c.status === "paused" ? h("button", { class: "btn primary", onclick: () => act("campaigns.resume") }, icon("play", 16), "Riprendi") : null,
    ["running", "paused", "ready"].includes(c.status) ? h("button", { class: "btn danger", onclick: async () => { if (await confirmBox("Interrompere la campagna?", "Le operazioni in attesa vengono annullate. Quelle già eseguite restano.", "Interrompi", true)) act("campaigns.stop"); } }, icon("stop", 16), "Interrompi") : null,
    c.dryRun && c.status !== "running" && (p.completed || 0) > 0 ? h("button", { class: "btn primary", onclick: async () => {
      if (!(await confirmBox("Eseguire davvero su Vinted?", "Le operazioni fatte in simulazione tornano in coda e la campagna passa in modalità reale: like, offerte e messaggi verranno eseguiti davvero dal tuo account. Prima rivedi e approvi l'anteprima.", "Passa alla modalità reale"))) return;
      try { await rpc("campaigns.goLive", { id }); } catch (e) { return toast("Non riuscito", e.message, "error"); }
      toast("Modalità reale", "Controlla l'anteprima, approvala e premi Avvia.", "success");
      await ctx.refresh();
      previewDialog(ctx, id);
    } }, icon("zap", 16), "Esegui davvero su Vinted") : null,
    ["stopped", "completed"].includes(c.status) ? h("button", { class: "btn", onclick: () => act("campaigns.reopen") }, icon("refresh", 16), "Riapri") : null,
    h("button", { class: "btn ghost", title: "Elimina la campagna", "aria-label": "Elimina la campagna", onclick: () => removeCampaigns(ctx, [id], [c]) }, icon("trash", 16)));

  const pauseBox = c.status === "paused" ? h("div", { class: `callout ${["user", "confirm"].includes(c.pauseReason) ? "info" : "warn"}` },
    h("b", {}, PAUSE_TEXT[c.pauseReason] || "In pausa"), c.pauseDetail ? h("div", { class: "small" }, c.pauseDetail) : null,
    c.resumeAt ? h("div", { class: "small muted" }, `Ripresa automatica dopo le ${new Date(c.resumeAt).toLocaleTimeString("it-IT")}, se le condizioni sono valide.`) : null,
    h("div", { class: "row", style: { marginTop: "8px" } },
      c.pendingConfirm ? h("button", { class: "btn primary sm", onclick: () => act("campaigns.confirmOp", { opId: c.pendingConfirm.opId }) }, icon("check", 14), `Conferma ${OP_LABEL[c.pendingConfirm.type]}${c.pendingConfirm.amount ? ` da ${fmtEuro(c.pendingConfirm.amount)}` : ""}`) : null,
      c.pendingConfirm ? h("button", { class: "btn sm", onclick: () => act("campaigns.mutate", { action: "skip", args: { id: c.pendingConfirm.itemId } }) }, "Salta questo annuncio") : null,
      ["auth", "captcha"].includes(c.pauseReason) ? h("button", { class: "btn sm", onclick: () => rpc("session.openLogin", { origin: c.origin }) }, icon("external", 14), "Apri Vinted") : null,
      c.pauseReason === "snapshot" ? h("button", { class: "btn sm primary", onclick: () => previewDialog(ctx, id) }, "Rivedi e approva") : null)) : null;

  const suspended = Object.entries(c.suspended || {});
  const suspendBox = suspended.length ? h("div", { class: "callout warn" },
    h("b", {}, "Operazioni sospese in questa campagna. "), "Gli altri tipi continuano normalmente.",
    h("ul", { class: "small", style: { margin: "6px 0 0" } }, suspended.map(([t, v]) => h("li", {}, h("b", {}, OP_LABEL[t] || t), `: ${v.reason}`))),
    c.status !== "paused" ? h("div", { class: "small muted" }, "Per riprovarle: Pausa e poi Riprendi.") : null) : null;
  const cyc = cycleSummary(items);
  const cyclesCard = cyc.length > 1 || (c.cycle?.n || 1) > 1 ? h("div", { class: "card" },
    h("h3", {}, icon("refresh", 16), `Cicli (attuale: ${c.cycle?.n || 1})`),
    h("div", { class: "table-wrap" }, h("table", { class: "table" },
      h("thead", {}, h("tr", {}, ["Ciclo", "Annunci", "Completate", "Fallite", "Da verificare", "Saltate", "In attesa", "Prima", "Ultima"].map((x) => h("th", {}, x)))),
      h("tbody", {}, cyc.map((r) => h("tr", {}, h("td", {}, h("b", {}, String(r.cycle))), h("td", {}, String(r.items)), h("td", {}, String(r.completed)), h("td", {}, String(r.failed)), h("td", {}, String(r.verify)), h("td", {}, String(r.skipped)), h("td", {}, String(r.pending)), h("td", { class: "small" }, r.first ? fmtDate(r.first) : "—"), h("td", { class: "small" }, r.last ? fmtDate(r.last) : "—")))))),
    h("p", { class: "small muted" }, "Ogni ciclo ripete le operazioni scelte. La cronologia dei cicli precedenti (date, esiti, errori) resta in ogni annuncio e nel registro.")) : null;
  const simInfo = c.dryRun && c.status === "completed" ? h("div", { class: "callout info" }, h("b", {}, "Simulazione completata: niente è stato inviato a Vinted. "),
    "Le operazioni segnate «Simulato» mostrano cosa sarebbe successo. Per farle davvero premi «Esegui davvero su Vinted».") : null;
  const info = h("div", { class: "card" }, h("div", { class: "three" },
    h("dl", { class: "kv" }, h("dt", {}, "Stato"), h("dd", {}, statusPill(c.status)), h("dt", {}, "Modalità"), h("dd", {}, h("span", { class: `pill ${c.dryRun ? "" : "warn"}` }, c.dryRun ? "Simulazione" : "Reale")),
      h("dt", {}, "Creata"), h("dd", {}, fmtDate(c.createdAt)), h("dt", {}, "Anteprima"), h("dd", {}, c.snapshot ? `approvata ${ago(c.snapshot.at)}` : "da approvare")),
    h("dl", { class: "kv" }, h("dt", {}, "Account scansione"), h("dd", {}, accountLabel(c.scanAccountId, ctx)), h("dt", {}, "Account interazioni"), h("dd", {}, accountLabel(c.accountId, ctx)),
      h("dt", {}, "Account in uso"), h("dd", {}, c.current ? accountLabel(c.accountId, ctx) : "—"), h("dt", {}, "Sessione"), h("dd", {}, ctx.overview?.session?.accountId === c.accountId ? h("span", { class: "pill good" }, "corrisponde") : h("span", { class: "pill warn" }, "non corrisponde"))),
    h("dl", { class: "kv" }, h("dt", {}, "Progresso"), h("dd", {}, `${p.percent || 0}% · ${p.itemsDone || 0}/${p.items || 0} annunci`), h("dt", {}, "Operazione corrente"), h("dd", {}, c.current ? `${OP_LABEL[c.current.type]} · ${c.current.title?.slice(0, 40)}` : "—", c.current?.awaitingUser ? h("div", {}, h("span", { class: "pill warn" }, "Premi Invia nella scheda di Vinted")) : null),
      h("dt", {}, "Prossima"), h("dd", { class: "small" }, c.status === "running" ? (c.nextLabel || "—") : "—"), h("dt", {}, "Timer"), h("dd", {}, timer))),
    h("div", { class: "progress", style: { marginTop: "12px" } }, h("i", { style: { width: `${p.percent || 0}%` } })),
    h("div", { class: "row small muted", style: { marginTop: "6px" } }, `${p.completed || 0} ${c.dryRun ? "simulate" : "completate"}`, "·", `${p.failed || 0} fallite`, "·", `${p.verify || 0} da verificare`, "·", `${p.skipped || 0} saltate`, "·", `${p.pending || 0} in attesa`));

  const queue = h("div", { class: "card" },
    h("div", { class: "panel-head" }, h("h2", {}, icon("layers"), "Coda"), h("span", { class: "muted small" }, "Modificabile anche durante l'esecuzione: le operazioni completate restano invariate."), h("span", { class: "grow" }),
      h("button", { class: "btn sm", onclick: () => addListingsDialog(ctx, c) }, icon("plus", 14), "Aggiungi annunci"),
      h("button", { class: "btn sm", onclick: () => sortDialog(ctx, c) }, icon("shuffle", 14), "Ordina"),
      h("button", { class: "btn sm", disabled: !p.failed, onclick: () => act("campaigns.mutate", { action: "retry", args: {} }) }, icon("refresh", 14), "Ripeti falliti"),
      h("button", { class: "btn sm", title: "Rielabora gli annunci già completati in un nuovo ciclo", onclick: () => cycleDialog(ctx, c, items, null) }, icon("history", 14), "Nuovo ciclo…"),
      h("button", { class: "btn sm", title: "Togli dallo storico like, offerte o messaggi degli annunci di questa campagna: invece di saltarli li rifà", onclick: async () => {
        if (await clearHistoryDialog({ campaignId: c.id, label: `gli annunci di «${c.name}»` })) ctx.refresh();
      } }, icon("trash", 14), "Azzera storico…")),
    order.length ? h("div", { class: "table-wrap" }, h("table", { class: "table" },
      h("thead", {}, h("tr", {}, ["#", "", "Annuncio", "Prezzo", "Operazioni", "Priorità", ""].map((x) => h("th", {}, x)))),
      h("tbody", {}, order.map((it, idx) => queueRow(ctx, c, it, idx, act))))) : h("div", { class: "empty" }, "Coda vuota: aggiungi annunci."),
    removed.length ? h("details", { style: { marginTop: "10px" } }, h("summary", { class: "small muted" }, `${removed.length} elementi rimossi`), h("ul", { class: "small" }, removed.map((r) => h("li", {}, r.listing?.title || r.listingId)))) : null);

  const settingsCard = campaignSettings(ctx, c);
  const history = h("div", { class: "card" }, h("h3", {}, icon("history", 16), "Storico delle modifiche"),
    h("ul", { class: "feed" }, [...(c.history || [])].reverse().slice(0, 80).map((e) => h("li", {}, h("span", { class: "fi" }, icon("edit", 12)), h("span", { class: "small" }, e.action, e.detail ? h("span", { class: "muted" }, ` — ${e.detail}`) : null), h("span", { class: "muted small" }, fmtDate(e.at))))));

  return h("div", { class: "grid" },
    h("div", { class: "page-head" }, h("a", { href: "#campaigns", class: "btn ghost sm" }, "← Campagne"), h("div", { class: "grow" }, h("h1", {}, c.name)), controls),
    simInfo, pauseBox, suspendBox, info, queue, cyclesCard, h("div", { class: "two" }, settingsCard, history));
}

function queueRow(ctx, c, it, idx, act) {
  const L = it.listing || {};
  const editable = it.ops.some((o) => ["waiting", "prepared"].includes(o.status));
  const running = it.ops.some((o) => o.status === "running");
  const prio = h("select", { class: "input", style: { width: "110px" }, "aria-label": "Priorità", disabled: !editable }, h("option", { value: "1" }, "Alta"), h("option", { value: "0" }, "Normale"), h("option", { value: "-1" }, "Bassa"));
  prio.value = String(it.priority || 0);
  prio.addEventListener("change", () => act("campaigns.mutate", { action: "priority", args: { id: it.id, priority: Number(prio.value) } }));
  const cycleN = Math.max(1, ...it.ops.map((o) => o.cycle || 1));
  const reprocessable = it.ops.some((o) => o.status === "completed" || (o.status === "skipped" && o.result?.ledger === "done"));
  return h("tr", {},
    h("td", { class: "muted small" }, String(idx + 1)),
    h("td", {}, L.photo ? h("img", { class: "thumb", src: L.photo, alt: "", loading: "lazy" }) : h("div", { class: "thumb" })),
    h("td", { style: { maxWidth: "300px" } }, h("a", { href: L.url, target: "_blank", rel: "noopener", style: { color: "var(--text)" } }, L.title || it.listingId), h("div", { class: "muted small" }, `${L.sellerLogin || L.sellerId || ""}${L.status && L.status !== "active" ? ` · ${L.status}` : ""}`),
      cycleN > 1 || it.pastCycles?.length ? h("div", { class: "row", style: { gap: "4px", marginTop: "2px" } },
        cycleN > 1 ? h("span", { class: "pill info", title: "Ciclo di esecuzione attuale di questo annuncio" }, `Ciclo ${cycleN}`) : null,
        it.pastCycles?.length ? h("button", { class: "btn ghost sm", onclick: () => pastCyclesDialog(it) }, `${it.pastCycles.length} cicli precedenti`) : null) : null),
    h("td", {}, fmtEuro(L.price, L.currency)),
    h("td", {}, h("div", { class: "ops" }, it.ops.map((o) => h("span", { class: `op-chip ${o.status}`, title: [o.error, o.reason, o.retryAfter > Date.now() ? `nuovo tentativo alle ${new Date(o.retryAfter).toLocaleTimeString("it-IT")} (tentativo ${(o.attempts || 0) + 1})` : null, c.suspended?.[o.type] && ["waiting", "prepared"].includes(o.status) ? `sospesa: ${c.suspended[o.type].reason}` : null].filter(Boolean).join(" · ") || o.status },
      OP_LABEL[o.type], o.type === "offer" && o.amount ? ` ${fmtEuro(o.amount)}` : "", o.type === "message" && o.mode ? ` ${o.mode === "manual" ? "B" : "A"}` : "", " ", statusPill(o.status, "op", o.result?.simulated),
      o.retryAfter > Date.now() && ["waiting", "prepared"].includes(o.status) ? h("span", { class: "pill warn", style: { marginLeft: "4px" } }, `riprova ${new Date(o.retryAfter).toLocaleTimeString("it-IT", { hour: "2-digit", minute: "2-digit" })}`) : null,
      c.suspended?.[o.type] && ["waiting", "prepared"].includes(o.status) ? h("span", { class: "pill warn", style: { marginLeft: "4px" } }, "sospesa") : null,
      o.status === "verify" ? h("button", { class: "btn ghost sm", title: "Risolvi", onclick: () => resolveDialog(ctx, c, it, o) }, "risolvi") : null)))),
    h("td", {}, prio),
    h("td", {}, h("div", { class: "row" },
      h("button", { class: "btn ghost sm", title: "Su", "aria-label": "Sposta su", disabled: !editable, onclick: () => act("campaigns.mutate", { action: "move", args: { id: it.id, where: "up" } }) }, icon("up", 14)),
      h("button", { class: "btn ghost sm", title: "Giù", "aria-label": "Sposta giù", disabled: !editable, onclick: () => act("campaigns.mutate", { action: "move", args: { id: it.id, where: "down" } }) }, icon("down", 14)),
      h("button", { class: "btn ghost sm", title: "Prossimo", disabled: !editable, onclick: () => act("campaigns.mutate", { action: "move", args: { id: it.id, where: "top" } }) }, "⤒"),
      h("button", { class: "btn ghost sm", title: "Modifica operazioni", disabled: running, onclick: () => editItemDialog(ctx, c, it) }, icon("edit", 14)),
      h("button", { class: "btn ghost sm", title: reprocessable ? "Riprocessa questo annuncio in un nuovo ciclo" : "Niente da riprocessare: nessuna operazione conclusa", "aria-label": "Riprocessa", disabled: !reprocessable || running, onclick: () => cycleDialog(ctx, c, [it], [it.id]) }, icon("history", 14)),
      h("button", { class: "btn ghost sm", title: "Salta", disabled: !editable || running, onclick: () => act("campaigns.mutate", { action: "skip", args: { id: it.id } }) }, "Salta"),
      h("button", { class: "btn ghost sm", title: "Rimuovi dalla coda", "aria-label": "Rimuovi", disabled: running, onclick: () => act("campaigns.mutate", { action: "remove", args: { ids: [it.id] } }) }, icon("trash", 14)))));
}

/** Cronologia dei cicli di un annuncio: niente si cancella quando lo si riprocessa. */
function pastCyclesDialog(it) {
  const rows = (it.pastCycles || []).flatMap((p) => p.ops.map((o) => h("tr", {},
    h("td", {}, String(p.cycle)), h("td", {}, OP_LABEL[o.type] || o.type), h("td", {}, statusPill(o.status, "op", o.result?.simulated)),
    h("td", { class: "small" }, o.finishedAt ? fmtDate(o.finishedAt) : "—"), h("td", { class: "small" }, o.amount ? fmtEuro(o.amount) : ""),
    h("td", { class: "small muted" }, [o.error, o.reason].filter(Boolean).join(" · ")))));
  modal(`Cicli precedenti — ${it.listing?.title || it.listingId}`, h("div", { class: "table-wrap" }, h("table", { class: "table" },
    h("thead", {}, h("tr", {}, ["Ciclo", "Operazione", "Esito", "Quando", "Importo", "Note"].map((x) => h("th", {}, x)))), h("tbody", {}, rows))),
  [{ label: "Chiudi", value: true }], { wide: true });
}

/**
 * Nuovo ciclo: mostra ESATTAMENTE cosa verrà ripetuto (e cosa no, con il motivo) prima di
 * chiedere la conferma. Poi l'anteprima della campagna va approvata di nuovo.
 */
async function cycleDialog(ctx, c, items, onlyIds) {
  const candidates = (items || []).filter((i) => !i.removed && i.ops.some((o) => o.status === "completed" || (o.status === "skipped" && o.result?.ledger === "done")));
  if (!candidates.length) return toast("Niente da riprocessare", "Nessun annuncio ha operazioni concluse.", "info");
  const types = OP_TYPES.map((t) => ({ t, cb: h("input", { type: "checkbox", checked: candidates.some((i) => i.ops.some((o) => o.type === t)) }) }));
  const picks = candidates.map((i) => ({ i, cb: h("input", { type: "checkbox", checked: !onlyIds || onlyIds.includes(i.id) }) }));
  const out = h("div", { class: "grid" });
  let last = null;
  const sel = () => ({ itemIds: picks.filter((p) => p.cb.checked).map((p) => p.i.id), types: types.filter((x) => x.cb.checked).map((x) => x.t) });
  const draw = async () => {
    const s = sel();
    last = await rpc("campaigns.cyclePreview", { id: c.id, ...s }).catch((e) => ({ error: e.message }));
    if (last.error) return out.replaceChildren(h("div", { class: "callout warn" }, last.error));
    const by = (list) => Object.entries(list.reduce((m, x) => ({ ...m, [x.type]: (m[x.type] || 0) + 1 }), {})).map(([t, k]) => `${k} ${OP_LABEL[t].toLowerCase()}`).join(", ") || "niente";
    out.replaceChildren(
      h("div", { class: `callout ${last.repeat.length ? "info" : "warn"}` }, h("b", {}, `Ciclo ${last.nextCycle}: si ripeteranno ${last.repeat.length} operazioni su ${last.items} annunci`), last.repeat.length ? ` (${by(last.repeat)}).` : "."),
      last.repeat.length ? h("div", { class: "table-wrap", style: { maxHeight: "260px", overflow: "auto" } }, h("table", { class: "table" },
        h("thead", {}, h("tr", {}, ["Annuncio", "Operazione", "Ultimo esito", "Quando"].map((x) => h("th", {}, x)))),
        h("tbody", {}, last.repeat.map((r) => h("tr", {}, h("td", {}, r.title.slice(0, 50)), h("td", {}, OP_LABEL[r.type], r.amount ? ` ${fmtEuro(r.amount)}` : ""),
          h("td", { class: "small" }, r.noRepeat ? "saltata perché già fatta prima" : r.simulated ? "simulata" : `completata (ciclo ${r.cycle})`), h("td", { class: "small" }, r.at ? fmtDate(r.at) : "—")))))) : null,
      last.excluded.length ? h("details", {}, h("summary", { class: "small" }, `${last.excluded.length} operazioni NON ripetute (${by(last.excluded)})`),
        h("ul", { class: "small" }, last.excluded.slice(0, 200).map((r) => h("li", {}, `${r.title.slice(0, 40)} · ${OP_LABEL[r.type]}: ${r.why}`)))) : null,
      h("ul", { class: "small muted", style: { margin: 0 } },
        h("li", {}, "Le operazioni da verificare non si ripetono mai da sole: prima risolvile in Recupero."),
        h("li", {}, "Le offerte si ricalcolano sul prezzo attuale; i messaggi partono solo verso i destinatari autorizzati."),
        h("li", {}, "Vinted tiene un solo like per annuncio: se il like c'è ancora, viene registrato come già presente."),
        h("li", {}, "Soglie giornaliere, pause per 403/429/CAPTCHA e timer valgono come sempre.")));
  };
  for (const x of [...types.map((t) => t.cb), ...picks.map((p) => p.cb)]) x.addEventListener("change", draw);
  await draw();
  const ok = await modal("Nuovo ciclo: riprocessare annunci già elaborati", h("div", { class: "grid" },
    h("div", {}, h("div", { class: "small muted" }, "Operazioni da ripetere"), h("div", { class: "row" }, types.map(({ t, cb }) => h("label", { class: "check" }, cb, OP_LABEL[t])))),
    candidates.length > 1 || !onlyIds ? h("details", { open: Boolean(onlyIds) }, h("summary", { class: "small" }, `Annunci (${candidates.length} con operazioni concluse)`),
      h("div", { class: "row", style: { margin: "6px 0" } },
        h("button", { class: "btn ghost sm", onclick: () => { picks.forEach((p) => { p.cb.checked = true; }); draw(); } }, "Tutti"),
        h("button", { class: "btn ghost sm", onclick: () => { picks.forEach((p) => { p.cb.checked = false; }); draw(); } }, "Nessuno")),
      h("div", { style: { maxHeight: "180px", overflow: "auto" } }, picks.map(({ i, cb }) => h("label", { class: "check", style: { display: "flex" } }, cb, i.listing?.title || i.listingId)))) : null,
    out), [{ label: "Annulla", value: false }, { label: "Avvia il nuovo ciclo", cls: "primary", handler: () => (last?.repeat?.length ? true : (toast("Niente da ripetere", "Scegli almeno un annuncio e un'operazione conclusi.", "warning"), false)) }], { wide: true });
  if (!ok) return;
  try {
    const r = await rpc("campaigns.newCycle", { id: c.id, ...sel(), confirm: true });
    if (r.ok === false) return toast("Nessun nuovo ciclo", r.rejected, "warning");
    toast(`Ciclo ${r.cycle} pronto`, `${r.repeated} operazioni su ${r.items} annunci. Rivedi e approva l'anteprima per partire.`, "success");
    await ctx.refresh();
    previewDialog(ctx, c.id);
  } catch (e) { toast("Nuovo ciclo non creato", e.message, "error"); }
}

async function editItemDialog(ctx, c, it) {
  const rows = [];
  const patch = {};
  for (const o of it.ops) {
    const editable = ["waiting", "prepared"].includes(o.status);
    const row = h("div", { class: "sugg" }, h("b", { style: { minWidth: "90px" } }, OP_LABEL[o.type]), statusPill(o.status, "op"));
    if (editable) {
      if (o.type === "offer") {
        const amt = h("input", { class: "input", type: "number", step: "0.01", min: "0.5", value: o.amount ?? "", style: { width: "110px" } });
        amt.addEventListener("change", () => { patch[o.id] = { ...(patch[o.id] || {}), amount: Number(amt.value) }; });
        row.append(h("span", { class: "grow" }), amt, "€");
      }
      if (o.type === "message") {
        const ta = h("textarea", { class: "input", rows: 2, maxlength: 1000, value: o.textLocked ? o.text || "" : "", placeholder: o.text ? `Della campagna: ${o.text.slice(0, 80)}${o.text.length > 80 ? "…" : ""}` : "Testo per questo annuncio (vuoto = quello della campagna)" });
        ta.addEventListener("change", () => { patch[o.id] = { ...(patch[o.id] || {}), text: ta.value }; });
        row.append(ta);
      }
      const conf = h("input", { type: "checkbox", checked: o.requireConfirm });
      conf.addEventListener("change", () => { patch[o.id] = { ...(patch[o.id] || {}), requireConfirm: conf.checked }; });
      row.append(h("label", { class: "check small" }, conf, "conferma"));
      row.append(h("button", { class: "btn ghost sm", onclick: () => { patch[o.id] = { remove: true }; row.style.opacity = ".4"; } }, "Togli"));
    } else row.append(h("span", { class: "muted small" }, "non modificabile"));
    rows.push(row);
  }
  const addable = OP_TYPES.filter((t) => !it.ops.some((o) => o.type === t && !["cancelled", "skipped", "failed"].includes(o.status)));
  const addBoxes = addable.map((t) => ({ t, cb: h("input", { type: "checkbox" }) }));
  const ok = await modal(`Operazioni: ${it.listing?.title?.slice(0, 50) || it.listingId}`, h("div", { class: "grid" }, rows,
    addable.length ? h("div", {}, h("div", { class: "small muted" }, "Aggiungi"), h("div", { class: "row" }, addBoxes.map(({ t, cb }) => h("label", { class: "check" }, cb, OP_LABEL[t])))) : null),
  [{ label: "Annulla", value: false }, { label: "Salva", value: true, cls: "primary" }]);
  if (!ok) return;
  if (Object.keys(patch).length) await rpc("campaigns.mutate", { id: c.id, action: "editOps", args: { id: it.id, patch } });
  const add = addBoxes.filter((x) => x.cb.checked).map((x) => x.t);
  if (add.length) await rpc("campaigns.mutate", { id: c.id, action: "addOps", args: { ids: [it.id], types: add } });
  ctx.refresh();
}

async function resolveDialog(ctx, c, it, o) {
  const body = h("div", { class: "grid" },
    h("p", {}, `Non è certo che «${OP_LABEL[o.type]}» su questo annuncio sia arrivato a Vinted (${o.error || "esito sconosciuto"}). Vintastic non lo ripete da solo.`),
    h("a", { class: "btn", href: it.listing?.url, target: "_blank", rel: "noopener" }, icon("external", 14), "Apri l'annuncio su Vinted"),
    o.type === "like" ? h("button", { class: "btn", onclick: async () => {
      const r = await rpc("campaigns.verifyOp", { id: c.id, itemId: it.id, opId: o.id }).catch((e) => ({ message: e.message }));
      toast(r.resolved ? (r.done ? "Like presente: completato" : "Like assente: segnato come non eseguito") : "Verifica automatica non riuscita", r.message || "", r.resolved ? "success" : "warning");
      document.querySelector(".modal-back")?.remove(); ctx.refresh();
    } }, icon("search", 14), "Verifica automatica (legge lo stato del like)") : h("p", { class: "muted small" }, o.type === "message"
      ? "Per i messaggi: apri la chat con il venditore (Vinted › Messaggi) e controlla se il messaggio c'è. Se c'è, premi «È stata eseguita»: non verrà mai rimandato."
      : "Per le offerte: apri la chat dell'annuncio e controlla se l'offerta compare."));
  const r = await modal("Operazione da verificare", body, [
    { label: "Non è arrivata", value: "no" }, { label: "È stata eseguita", value: "yes", cls: "primary" }]);
  if (!r) return;
  await rpc("campaigns.mutate", { id: c.id, action: "resolveVerify", args: { id: it.id, opId: o.id, done: r === "yes" } });
  toast("Esito registrato", r === "yes" ? "Segnata come completata." : "Segnata come fallita: puoi ripeterla con «Ripeti falliti».", "success");
  ctx.refresh();
}

async function sortDialog(ctx, c) {
  const mode = h("select", { class: "input" }, Object.entries(SORTS).map(([k, v]) => h("option", { value: k }, v)));
  mode.value = c.sort?.mode || "manual";
  let seed = Date.now() % 100000;
  const prev = h("ol", { class: "small", style: { maxHeight: "300px", overflow: "auto" } });
  const draw = async () => {
    const r = await rpc("campaigns.mutate", { id: c.id, action: "sort", args: { mode: mode.value, seed, preview: true } });
    prev.replaceChildren(...r.preview.slice(0, 50).map((i) => h("li", {}, `${i.listing?.title?.slice(0, 60) || i.listingId} · ${fmtEuro(i.listing?.price)}`)));
  };
  mode.addEventListener("change", draw);
  const reshuffle = h("button", { class: "btn sm", onclick: () => { seed = Math.floor(Math.random() * 100000); draw(); } }, icon("shuffle", 14), "Rimescola");
  await draw();
  const ok = await modal("Ordine della coda", h("div", { class: "grid" }, h("label", { class: "field" }, "Criterio", mode), reshuffle,
    h("div", { class: "small muted" }, "Anteprima (primi 50):"), prev,
    h("p", { class: "small muted" }, "L'ordine casuale è una scelta organizzativa: non serve a nascondere nulla. Salvato, resta fisso.")),
  [{ label: "Annulla", value: false }, { label: "Salva l'ordine", value: true, cls: "primary" }]);
  if (!ok) return;
  await rpc("campaigns.mutate", { id: c.id, action: "sort", args: { mode: mode.value, seed } });
  toast("Ordine salvato");
  ctx.refresh();
}

/**
 * Menu Venditore: account che segui su Vinted, poi i destinatari dei messaggi che non segui,
 * poi gli altri venditori con annunci scansionati. Un venditore mai scansionato si può scegliere:
 * con «Aggiungi» Vintastic legge prima il suo armadio (sola lettura).
 */
function sellerPicker(initial) {
  let menu = initial;
  const seller = h("select", { class: "input", "aria-label": "Venditore" });
  const hint = h("div", { class: "small muted", style: { marginTop: "4px" } });
  const rescan = h("input", { type: "checkbox" });
  const rescanRow = h("label", { class: "check", style: { display: "none" } }, rescan, "Rileggi prima il suo armadio su Vinted (annunci nuovi)");
  const entry = () => menu?.all?.find((e) => e.sellerId === seller.value) || null;
  const groups = [["following", "Account che segui"], ["recipients", "Destinatari dei messaggi (non seguiti)"], ["scanned", "Altri venditori scansionati"]];
  const update = () => {
    const e = entry();
    rescanRow.style.display = e && e.count ? "" : "none";
    if (e) hint.textContent = e.count ? `${e.count} annunci scansionati${e.following ? " · lo segui" : ""}${e.recipient ? " · destinatario dei messaggi" : ""}` : "Annunci non ancora scansionati: con «Aggiungi» Vintastic legge prima il suo armadio (solo lettura).";
    else hint.textContent = menu?.followingError ? `Account seguiti non letti: ${menu.followingError}` : menu?.followingAt ? `Account seguiti aggiornati ${ago(menu.followingAt)}.` : "";
  };
  const fill = () => {
    const cur = seller.value;
    seller.replaceChildren(h("option", { value: "" }, "Tutti i venditori (annunci già scansionati)"),
      ...groups.filter(([k]) => menu?.[k]?.length).map(([k, label]) => h("optgroup", { label }, menu[k].map((e) => h("option", { value: e.sellerId }, sellerOptionLabel(e))))));
    seller.value = [...seller.options].some((o) => o.value === cur) ? cur : "";
    update();
  };
  seller.addEventListener("change", update);
  const refresh = h("button", { class: "btn ghost sm", type: "button", title: "Rilegge da Vinted gli account che segui" }, icon("refresh", 14), "Aggiorna seguiti");
  refresh.addEventListener("click", async () => {
    refresh.disabled = true;
    try { menu = await rpc("sellers.menu", { refresh: true }); fill(); toast(menu.followingError ? "Seguiti non aggiornati" : "Account seguiti aggiornati", menu.followingError || "", menu.followingError ? "warning" : "success"); } catch (e) { toast("Seguiti non aggiornati", e.message, "error"); } finally { refresh.disabled = false; }
  });
  fill();
  return { seller, hint, rescan, rescanRow, refresh, entry };
}

/** Scansiona l'armadio di un venditore e aspetta la fine (con l'avanzamento in un avviso). */
async function scanSeller(origin, e) {
  const name = e.login ? `@${e.login}` : e.label || e.sellerId;
  let scan;
  try { scan = await rpc("scan.start", { url: `${origin}/member/${e.sellerId}` }); } catch (err) { toast("Scansione non avviata", err.message, "error", 9000); return false; }
  toast(`Leggo l'armadio di ${name}…`, "Solo lettura. Poi aggiungo gli annunci alla coda.", "info", 6000);
  const end = Date.now() + 10 * 60_000;
  while (Date.now() < end) {
    await new Promise((r) => setTimeout(r, 1500));
    scan = await rpc("scan.get", { id: scan.id }).catch(() => scan);
    if (scan && scan.status !== "running") break;
  }
  if (scan?.status !== "done") { toast(`Armadio di ${name} non letto`, (scan?.errors || []).slice(-1)[0] || "Scansione non completata", "error", 9000); return false; }
  return true;
}

async function addListingsDialog(ctx, c) {
  const menu = await rpc("sellers.menu").catch(async () => ({ all: [], following: [], recipients: [], scanned: (await rpc("listings.sellers")).filter((x) => x.sellerId && x.sellerId !== "?").map((x) => ({ ...x, label: "", following: false, recipient: false })) }));
  if (!menu.all?.length) menu.all = [...(menu.following || []), ...(menu.recipients || []), ...(menu.scanned || [])];
  const picker = sellerPicker(menu);
  const seller = picker.seller;
  const topN = h("select", { class: "input" }, [5, 10, 20, 50, 100].map((n) => h("option", { value: n }, `Ultimi ${n}`)), h("option", { value: "custom" }, "Numero personalizzato…"), h("option", { value: "" }, "Tutti"));
  topN.value = "20";
  const customN = h("input", { class: "input", type: "number", min: 1, max: 5000, value: 15, "aria-label": "Quanti annunci", style: { display: "none", marginTop: "6px" } });
  topN.addEventListener("change", () => { customN.style.display = topN.value === "custom" ? "" : "none"; if (topN.value === "custom") customN.focus(); });
  const range = h("select", { class: "input" }, h("option", { value: "all" }, "Qualsiasi data"), h("option", { value: "24h" }, "Ultime 24 ore"), h("option", { value: "3d" }, "Ultimi 3 giorni"), h("option", { value: "7d" }, "Ultimi 7 giorni"), h("option", { value: "30d" }, "Ultimi 30 giorni"));
  const types = OP_TYPES.map((t) => ({ t, cb: h("input", { type: "checkbox", checked: (c.opsDefaults?.types || []).includes(t) }) }));
  // «Posizione»: quella salvata nella campagna; se non c'è, la predefinita (In cima).
  const where = h("select", { class: "input", "aria-label": "Posizione" }, h("option", { value: "start" }, "In cima"), h("option", { value: "end" }, "In fondo"));
  where.value = c.addPosition || ctx.settings.campaignDefaults?.addPosition || "start";
  const excl = h("input", { type: "checkbox", checked: true });
  const ok = await modal("Aggiungi annunci alla coda", h("div", { class: "grid" },
    h("div", { class: "field" }, h("div", { class: "row", style: { justifyContent: "space-between", alignItems: "center" } }, h("span", {}, "Venditore"), picker.refresh), seller, picker.hint, picker.rescanRow), h("div", { class: "row", style: { alignItems: "flex-start" } }, h("label", { class: "field grow" }, "Quanti (i più recenti)", topN, customN), h("label", { class: "field grow" }, "Periodo", range)),
    h("p", { class: "small muted", style: { margin: 0 } }, "«Più recenti»: per data di pubblicazione; se Vinted non la dà, per data della foto e poi nell'ordine dell'armadio su Vinted."),
    h("label", { class: "check" }, excl, "Escludi annunci su cui le operazioni scelte sono già state fatte"),
    h("div", {}, h("div", { class: "small muted" }, "Operazioni"), h("div", { class: "row" }, types.map(({ t, cb }) => h("label", { class: "check" }, cb, OP_LABEL[t])))),
    h("label", { class: "field" }, "Posizione", where),
    h("p", { class: "small muted" }, "Per scegliere uno per uno usa la pagina Annunci.")),
  [{ label: "Annulla", value: false }, { label: "Aggiungi", value: true, cls: "primary" }]);
  if (!ok) return;
  const chosen = types.filter((x) => x.cb.checked).map((x) => x.t);
  const n = topN.value === "custom" ? Math.max(1, Math.floor(Number(customN.value) || 0)) : topN.value;
  if (topN.value === "custom" && !(n > 0)) return toast("Scrivi quanti annunci", "", "warning");
  // Venditore mai scansionato (o «Rileggi»): prima la lettura del suo armadio.
  const chosenSeller = picker.entry();
  if (chosenSeller && (!chosenSeller.count || picker.rescan.checked)) {
    if (!(await scanSeller(c.origin || "https://www.vinted.it", chosenSeller))) return;
  }
  const base = { sellerId: seller.value || undefined, topN: n, range: range.value, dateField: "auto", status: "active" };
  const res = await rpc("listings.query", { filters: { ...base, excludeDone: excl.checked ? chosen : undefined }, limit: 5000, withIds: true });
  if (!res.ids.length) {
    // Perché è vuoto: si spiega invece di dire solo «nessun annuncio».
    const noExcl = excl.checked ? await rpc("listings.query", { filters: base, limit: 1 }) : res;
    const why = [];
    if (res.noDate) why.push(`${res.noDate} annunci esclusi perché senza data nel periodo scelto`);
    if (excl.checked && noExcl.total > 0) why.push(`${noExcl.total} annunci esclusi perché le operazioni scelte sono già state fatte`);
    if (!why.length) why.push(range.value !== "all" ? "nessun annuncio attivo in questo periodo: prova «Qualsiasi data»" : "nessun annuncio attivo per questo venditore: rifai la scansione");
    return toast("Nessun annuncio con questi criteri", why.join(" · "), "warning", 9000);
  }
  const r = await rpc("campaigns.add", { id: c.id, listingIds: res.ids, spec: { types: chosen }, where: where.value });
  toast(`${r.added} annunci aggiunti`, r.rejected.length ? `${r.rejected.length} già presenti` : "", "success");
  ctx.refresh();
}

function campaignSettings(ctx, c) {
  const t = c.timers || {};
  const st = ctx.settings.timers;
  const num = (v) => h("input", { class: "input", type: "number", min: 0, value: v, style: { width: "80px" } });
  const f = {
    name: h("input", { class: "input", value: c.name }),
    opsMin: num(t.betweenOps?.min ?? st.betweenOps.min), opsMax: num(t.betweenOps?.max ?? st.betweenOps.max),
    itMin: num(t.betweenItems?.min ?? st.betweenItems.min), itMax: num(t.betweenItems?.max ?? st.betweenItems.max),
    lo: num(t.transitions?.["like>offer"]?.min ?? st.transitions["like>offer"].min), loMax: num(t.transitions?.["like>offer"]?.max ?? st.transitions["like>offer"].max),
    dry: h("input", { type: "checkbox", checked: c.dryRun, disabled: c.status === "running" }),
    confirm: h("input", { type: "checkbox", checked: Boolean(c.opsDefaults?.requireConfirm?.offer) }),
    likeExisting: h("select", { class: "input", style: { maxWidth: "260px" }, "aria-label": "Se il like c'è già" }, h("option", { value: "relike" }, "Toglilo e rimettilo"), h("option", { value: "keep" }, "Lascialo (conta come fatto)")),
  };
  f.likeExisting.value = c.likeExisting || ctx.settings.campaignDefaults?.likeExisting || "relike";
  const offer = offerEditor(c.opsDefaults?.offerCfg || DEFAULT_OFFER);
  const msg = messageEditor(ctx.settings, c);
  return h("div", { class: "card" }, h("h3", {}, icon("settings", 16), "Impostazioni della campagna"),
    h("div", { class: "grid" },
      h("label", { class: "field" }, "Nome", f.name),
      h("label", { class: "check" }, f.dry, "Simulazione (", term("Dry Run"), ")", c.status === "running" ? h("span", { class: "muted small" }, " — metti in pausa per cambiarla") : null),
      h("label", { class: "check" }, f.confirm, "Chiedi conferma prima di ogni nuova offerta"),
      h("div", { class: "row" }, h("span", { class: "small grow" }, "Se il like c'è già su Vinted"), f.likeExisting),
      h("div", { class: "row" }, h("span", { class: "small grow" }, "Secondi tra operazioni dello stesso annuncio"), f.opsMin, "–", f.opsMax),
      h("div", { class: "row" }, h("span", { class: "small grow" }, "Secondi tra annunci diversi"), f.itMin, "–", f.itMax),
      h("div", { class: "row" }, h("span", { class: "small grow" }, "Secondi tra like → offerta"), f.lo, "–", f.loMax),
      h("details", {}, h("summary", {}, `Regole offerte: ${describeOffer(c.opsDefaults?.offerCfg || DEFAULT_OFFER)}`), offer.node,
        h("p", { class: "small muted" }, "Valgono per le offerte aggiunte da ora e per quelle in attesa senza importo. Le offerte già approvate mantengono il loro importo.")),
      h("details", { open: (c.opsDefaults?.types || []).includes("message") }, h("summary", {}, "Messaggio privato"), msg.node,
        h("p", { class: "small muted" }, "Cambiando testo o modalità, i messaggi in attesa si ricalcolano e l'anteprima va approvata di nuovo. I testi scritti a mano per un annuncio restano.")),
      h("button", { class: "btn primary", onclick: async () => {
        try {
          await rpc("campaigns.update", { id: c.id, patch: {
            name: f.name.value, dryRun: f.dry.checked, likeExisting: f.likeExisting.value,
            timers: { ...c.timers, betweenOps: { min: +f.opsMin.value, max: +f.opsMax.value }, betweenItems: { min: +f.itMin.value, max: +f.itMax.value }, transitions: { ...(c.timers?.transitions || {}), "like>offer": { min: +f.lo.value, max: +f.loMax.value } } },
            opsDefaults: { ...c.opsDefaults, offerCfg: offer.value(), message: msg.value(), requireConfirm: { ...(c.opsDefaults?.requireConfirm || {}), offer: f.confirm.checked } },
          } });
          toast("Impostazioni salvate", f.dry.checked !== c.dryRun ? "Hai cambiato modalità: approva di nuovo l'anteprima." : "", "success");
          ctx.refresh();
        } catch (e) { toast("Non salvate", e.message, "error"); }
      } }, "Salva")));
}

// ------------------------------------------------------------------ anteprima

export async function previewDialog(ctx, id) {
  const pv = await rpc("campaigns.preview", { id });
  const v = pv.validation;
  const ops = pv.items.flatMap((i) => i.ops.filter((o) => ["waiting", "prepared"].includes(o.status)).map((o) => ({ i, o })));
  const refused = pv.items.filter((i) => i.ops.some((o) => o.type === "message" && o.status === "skipped" && o.result?.recipient == null && /destinatari|venditore|se stessi/i.test(o.reason || "")));
  const body = h("div", { class: "grid" },
    v.errors.length ? h("div", { class: "callout bad" }, h("b", {}, "Da sistemare prima di avviare"), h("ul", {}, v.errors.map((e) => h("li", {}, e)))) : h("div", { class: "callout good" }, h("b", {}, "Controlli superati")),
    v.warnings.length ? h("div", { class: "callout warn" }, h("b", {}, "Avvisi"), h("ul", {}, v.warnings.map((e) => h("li", {}, e)))) : null,
    h("div", { class: "small muted" }, v.infos.join(" · ")),
    refused.length ? h("div", { class: "callout info small" }, h("b", {}, `${refused.length} messaggi saltati: `), "il venditore non è tra i destinatari autorizzati (Impostazioni › Messaggi). Gli altri tipi di operazione su quegli annunci restano.") : null,
    pv.snapshotDiff?.length && pv.campaign.snapshot ? h("div", { class: "callout warn" }, h("b", {}, "Differenze rispetto all'ultima approvazione"), h("ul", {}, pv.snapshotDiff.slice(0, 10).map((d) => h("li", {}, d)))) : null,
    h("div", { class: "table-wrap", style: { maxHeight: "45vh", overflow: "auto" } }, h("table", { class: "table" },
      h("thead", {}, h("tr", {}, ["#", "Annuncio", "Prezzo", "Operazione", "Dettaglio"].map((x) => h("th", {}, x)))),
      h("tbody", {}, ops.slice(0, 300).map(({ i, o }, n) => h("tr", {},
        h("td", { class: "muted small" }, String(n + 1)),
        h("td", { class: "small" }, i.listing?.title?.slice(0, 50) || i.listingId),
        h("td", {}, fmtEuro(i.listing?.price)),
        h("td", {}, OP_LABEL[o.type], o.requireConfirm ? h("span", { class: "pill info", style: { marginLeft: "6px" } }, "con conferma") : null),
        h("td", { class: "small" }, o.type === "offer" ? (o.amount ? h("span", {}, h("b", {}, fmtEuro(o.amount)), " ", h("span", { class: "muted", title: (o.offerPreview?.steps || []).join("\n") }, (o.offerPreview?.warnings || []).join(" "))) : h("span", { class: "pill bad" }, "importo mancante"))
          : o.type === "message" ? (o.text ? h("span", {}, h("span", { class: "pill", style: { marginRight: "6px" } }, o.mode === "manual" ? "B · premi tu Invia" : "A · automatico"), h("span", { style: { whiteSpace: "pre-wrap" } }, o.text)) : h("span", { class: "pill bad" }, o.msgError || "testo mancante"))
              : "Preferito")))))));
  const actions = [{ label: "Chiudi", value: false }];
  actions.push({ label: "Approva anteprima", value: "approve", cls: v.errors.filter((e) => !/anteprima/.test(e)).length ? "" : "primary" });
  const r = await modal(`Anteprima: ${pv.campaign.name}`, body, actions, { wide: true });
  if (r === "approve") {
    await rpc("campaigns.approve", { id });
    toast("Anteprima approvata", "Lo snapshot è salvato: se cambiano prezzi o operazioni ti verrà chiesta una nuova verifica.", "success");
    ctx.refresh();
  }
}

function showValidation(v, ctx, id) {
  modal("Non posso avviare la campagna", h("div", { class: "grid" },
    h("div", { class: "callout bad" }, h("ul", {}, v.errors.map((e) => h("li", {}, e)))),
    v.warnings.length ? h("div", { class: "callout warn" }, h("ul", {}, v.warnings.map((e) => h("li", {}, e)))) : null),
  [{ label: "Chiudi", value: false }, { label: "Apri l'anteprima", value: true, cls: "primary", handler: () => { setTimeout(() => previewDialog(ctx, id), 50); return true; } }]);
}

export function onEvent(msg, ctx) {
  if (!["vt:campaign", "vt:timer"].includes(msg.type)) return;
  const id = ctx.route.params[0];
  if (id && msg.campaign && msg.campaign.id !== id) return;
  clearTimeout(onEvent.t);
  onEvent.t = setTimeout(() => { if (!document.querySelector(".modal-back")) ctx.refresh(); }, 700);
}

// usato dall'onboarding
export { computeOffer };
