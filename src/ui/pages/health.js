/** Health Center: controllo completo, moduli, kill switch, circuit breaker, aggiornamenti. */

import { h, icon, rpc, toast, fmtDate, confirmBox, term } from "../lib.js";
import { MODULES, VERSION } from "../../shared/constants.js";

let lastCheck = null;

export async function render(ctx) {
  if (ctx.route.query.run || !lastCheck) lastCheck = await rpc("health.check");
  const [upd, breakers] = await Promise.all([rpc("updates.status"), rpc("health.breakers")]);
  const s = ctx.settings;
  const runBtn = h("button", { class: "btn primary", onclick: async () => { runBtn.disabled = true; lastCheck = await rpc("health.check"); toast("Controllo completo eseguito", "", "success"); ctx.refresh(); } }, icon("pulse", 16), "Esegui controllo completo");
  const statusCls = { ok: "ok", warn: "warn", error: "error", off: "off", unknown: "" };
  const counts = lastCheck.checks.reduce((a, c) => ({ ...a, [c.status]: (a[c.status] || 0) + 1 }), {});

  const actionFor = (c) => {
    if (!c.action) return null;
    if (c.action === "openRecovery") return h("a", { class: "btn sm", href: "#recovery" }, "Recupero");
    if (c.action === "repairDb") return h("button", { class: "btn sm", onclick: async () => { const r = await rpc("health.repairDb"); toast("Riparazione eseguita", `${r.removedOrphans} elementi orfani rimossi`, "success"); ctx.refresh(); } }, "Ripara");
    if (c.action.startsWith("reset:")) return h("button", { class: "btn sm", onclick: async () => { await rpc("health.resetBreaker", { module: c.action.slice(6) }); lastCheck = await rpc("health.check"); ctx.refresh(); } }, "Riattiva");
    return null;
  };

  const checks = h("div", { class: "card" },
    h("div", { class: "panel-head" }, h("h2", {}, icon("pulse"), "Controllo dell'estensione"), h("span", { class: "muted small" }, `Ultimo: ${fmtDate(lastCheck.at)}`), h("span", { class: "grow" }), runBtn),
    h("div", { class: "row small", style: { marginBottom: "10px" } }, h("span", { class: "pill good" }, `${counts.ok || 0} OK`), h("span", { class: "pill warn" }, `${counts.warn || 0} avvisi`), h("span", { class: "pill bad" }, `${counts.error || 0} problemi`), h("span", { class: "pill" }, `${counts.unknown || 0} da provare`)),
    h("ul", { class: "check-list" }, lastCheck.checks.map((c) => h("li", {}, h("span", { class: `dot ${statusCls[c.status]}` }), h("div", {}, h("b", {}, c.name), h("div", { class: "small muted" }, c.detail)), actionFor(c)))),
    h("p", { class: "small muted" }, "I controlli non toccano Vinted: leggono solo lo stato salvato. La compatibilità con Vinted si aggiorna quando un modulo lavora davvero."));

  const killCard = h("div", { class: "card" },
    h("h3", {}, icon("power", 16), "Kill switch"),
    h("div", { class: `callout ${s.killSwitch ? "bad" : "good"}` }, h("div", { class: "row" }, h("b", { class: "grow" }, s.killSwitch ? "Kill Switch globale ATTIVO" : "Kill Switch globale spento"),
      h("button", { class: `btn ${s.killSwitch ? "" : "danger"}`, onclick: async () => {
        if (!s.killSwitch && !(await confirmBox("Attivare il Kill Switch?", "Tutte le campagne si fermano subito.", "Ferma tutto", true))) return;
        await rpc("health.killSwitch", { on: !s.killSwitch }); ctx.settings = await rpc("settings.get"); ctx.refresh();
      } }, s.killSwitch ? "Spegni" : "Ferma tutto"))),
    h("p", { class: "small muted" }, "Per modulo: spegne solo quella parte, il resto continua. Un modulo spento dal ", term("Circuit Breaker"), " si riattiva da solo dopo 30 minuti (se l'errore era temporaneo) o con «Riattiva»."),
    h("table", { class: "table" }, h("thead", {}, h("tr", {}, h("th", {}, "Modulo"), h("th", {}, "Circuit breaker"), h("th", {}, "Kill switch"))),
      h("tbody", {}, Object.entries(MODULES).map(([m, label]) => {
        const b = breakers[m];
        return h("tr", {}, h("td", {}, label),
          h("td", {}, b?.state === "open" ? h("span", { class: "pill bad", title: b.reason }, "Sospeso") : b?.state === "half-open" ? h("span", { class: "pill warn" }, "In prova") : h("span", { class: "pill good" }, "OK"), b?.failures ? h("span", { class: "muted small" }, ` ${b.failures} errori`) : null),
          h("td", {}, h("label", { class: "check" }, h("input", { type: "checkbox", checked: Boolean(s.moduleKill?.[m]), onchange: async (e) => { await rpc("health.moduleKill", { module: m, on: e.target.checked }); ctx.settings = await rpc("settings.get"); } }), "Spento")));
      }))));

  const rel = upd?.release;
  const updCard = h("div", { class: "card" },
    h("div", { class: "panel-head" }, h("h2", {}, icon("refresh"), "Aggiornamenti"), h("span", { class: "grow" }),
      h("button", { class: "btn primary", onclick: async () => { const r = await rpc("updates.check"); toast(r.ok ? (r.available ? `Disponibile la ${r.latest}` : "Sei all'ultima versione") : "Controllo non riuscito", r.error || "", r.ok ? "success" : "warning"); ctx.refresh(); } }, icon("refresh", 16), "Cerca aggiornamento")),
    h("dl", { class: "kv" }, h("dt", {}, "Installata"), h("dd", {}, `v${VERSION}`), h("dt", {}, "Ultima su GitHub"), h("dd", {}, upd?.latest ? `v${upd.latest}${upd.available ? " · nuova!" : ""}` : upd?.error || "non controllata"),
      h("dt", {}, "Ultimo controllo"), h("dd", {}, fmtDate(upd?.checkedAt))),
    rel ? h("div", { style: { marginTop: "12px" } }, h("h3", {}, rel.name), h("pre", { class: "mono", style: { whiteSpace: "pre-wrap", maxHeight: "220px", overflow: "auto", background: "var(--bg-2)", padding: "10px", borderRadius: "10px" } }, rel.notes || "Nessuna nota."),
      h("div", { class: "row" }, rel.url ? h("a", { class: "btn", href: rel.url, target: "_blank", rel: "noopener" }, icon("external", 14), "Pagina della release") : null,
        upd.available && rel.zip ? h("button", { class: "btn primary", onclick: async (e) => {
          e.target.disabled = true;
          try { const r = await rpc("updates.download"); toast("Zip scaricato", `${r.name} in Download/Vintastic · SHA-256 ${r.verified ? "verificato" : "non disponibile per il confronto"}`, "success", 9000); }
          catch (err) { toast("Download non riuscito", err.message, "error", 9000); }
          e.target.disabled = false;
        } }, icon("download", 14), "Scarica e verifica") : null,
        upd.available ? h("button", { class: "btn", onclick: async () => { if (await confirmBox("Installare l'aggiornamento?", "Prima estrai lo zip SOPRA la cartella di Vintastic, sostituendo i file. Poi conferma: l'estensione si ricarica.", "Ho estratto i file, ricarica")) rpc("updates.install"); } }, icon("play", 14), "Installa") : null)) : null,
    h("details", { style: { marginTop: "10px" } }, h("summary", {}, "Come funziona l'aggiornamento"),
      h("ol", { class: "small" },
        h("li", {}, h("b", {}, "Verifica: "), "legge l'ultima release pubblica su GitHub (API senza credenziali, con gestione del rate limit)."),
        h("li", {}, h("b", {}, "Download: "), "scarica lo zip, ne calcola lo SHA-256 e lo confronta con il file .sha256 della release. Se non coincide non viene salvato."),
        h("li", {}, h("b", {}, "Installazione: "), "estrai lo zip sopra la cartella dell'estensione, poi «Installa» ricarica Vintastic. Le campagne in corso vanno in pausa e si recuperano."),
        h("li", {}, h("b", {}, "Aggiornamento automatico: "), "non possibile per un'estensione caricata da cartella: il browser non permette a un'estensione di sostituire i propri file."))));

  return h("div", { class: "grid" },
    h("div", { class: "page-head" }, h("div", { class: "grow" }, h("h1", {}, "Salute"), h("p", {}, "Lo stato di ogni parte di Vintastic, con i rimedi."))),
    checks, h("div", { class: "two" }, killCard, updCard));
}
