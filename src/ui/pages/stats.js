/** Statistiche: totali, grafici nel tempo, per account e per campagna, andamento code. */

import { h, icon, rpc, fmtNum, duration, lineChart, barList, downloadText } from "../lib.js";
import { STAT_RANGES } from "../../shared/stats.js";

const st = { range: "30d", from: "", to: "" };

export async function render(ctx) {
  const [s, camps] = await Promise.all([rpc("stats.get", { range: st.range, from: st.from || null, to: st.to || null }), rpc("campaigns.list")]);
  const t = s.totals;
  const names = new Map(camps.map((c) => [c.id, c.name]));
  const seg = h("div", { class: "seg", role: "group", "aria-label": "Periodo" }, Object.entries(STAT_RANGES).map(([k, v]) => h("button", { class: st.range === k ? "on" : "", "aria-pressed": String(st.range === k), onclick: () => { st.range = k; ctx.refresh(); } }, v)));
  const dateIn = (key) => {
    const i = h("input", { class: "input", type: "date", value: st[key] ? new Date(Number(st[key])).toISOString().slice(0, 10) : "" });
    i.addEventListener("change", () => { st[key] = i.value ? String(new Date(`${i.value}T${key === "to" ? "23:59:59" : "00:00:00"}`).getTime()) : ""; ctx.refresh(); });
    return i;
  };
  const values = (k) => s.days.map((d) => s.series[k][d] || 0);
  const kpi = (label, v) => h("div", { class: "stat neutral" }, h("div", { class: "k" }, label), h("div", { class: "v" }, typeof v === "number" ? fmtNum(v) : v));

  return h("div", { class: "grid" },
    h("div", { class: "page-head" }, h("div", { class: "grow" }, h("h1", {}, "Statistiche"), h("p", {}, "Calcolate dai dati salvati sul tuo computer. Le simulazioni non sono conteggiate.")),
      h("button", { class: "btn", onclick: () => downloadText(["giorno;like;commenti;offerte;annunci_scansionati;fallite", ...s.days.map((d) => [d, s.series.like[d], s.series.comment[d], s.series.offer[d], s.series.scan[d], s.series.failed[d]].join(";"))].join("\n"), `vintastic-statistiche-${st.range}.csv`) }, icon("download", 16), "CSV")),
    h("div", { class: "row" }, seg, st.range === "custom" ? h("label", { class: "field" }, "Dal", dateIn("from")) : null, st.range === "custom" ? h("label", { class: "field" }, "Al", dateIn("to")) : null),
    h("div", { class: "stats" },
      kpi("Account", t.accounts), kpi("Annunci scansionati", t.listings), kpi("Like", t.likes), kpi("Commenti suggeriti", t.comments), kpi("Offerte", t.offers),
      kpi("Campagne completate", t.campaignsDone), kpi("Campagne in corso", t.campaignsRunning), kpi("Fallite", t.failed), kpi("Da verificare", t.verify),
      kpi("In attesa", t.pending), kpi("Saltate", t.skipped), kpi("Tempo di attività", duration(t.activeMs))),
    h("div", { class: "panels" },
      h("div", { class: "card" }, h("h3", {}, icon("chart", 16), "Interazioni nel tempo"), lineChart(s.days, [
        { name: "Like", color: "var(--s-like)", values: values("like") },
        { name: "Commenti", color: "var(--s-comment)", values: values("comment") },
        { name: "Offerte", color: "var(--s-offer)", values: values("offer") }])),
      h("div", { class: "card" }, h("h3", {}, icon("scan", 16), "Annunci letti dalle scansioni"), lineChart(s.days, [{ name: "Annunci", color: "var(--s-scan)", values: values("scan") }])),
      h("div", { class: "card" }, h("h3", {}, icon("check", 16), "Riuscite e fallite"), lineChart(s.days, [
        { name: "Riuscite", color: "var(--s-offer)", values: s.days.map((d) => (s.series.like[d] || 0) + (s.series.offer[d] || 0)) },
        { name: "Fallite", color: "var(--s-like)", values: values("failed") }])),
      h("div", { class: "card" }, h("h3", {}, icon("user", 16), "Attività per account"), barList(Object.entries(s.byAccount).map(([k, v]) => ({ label: k.split("@")[0], value: v })))),
      h("div", { class: "card" }, h("h3", {}, icon("zap", 16), "Attività per campagna"), barList(Object.entries(s.byCampaign).map(([k, v]) => ({ label: names.get(k) || k, value: v })).sort((a, b) => b.value - a.value).slice(0, 12))),
      h("div", { class: "card" }, h("h3", {}, icon("layers", 16), "Andamento delle code"), barList(camps.filter((c) => c.progress?.ops).map((c) => ({ label: `${c.name} (${c.progress.percent}%)`, value: c.progress.pending })), "var(--s-comment)"),
        h("p", { class: "small muted" }, "Operazioni ancora in attesa per campagna."))));
}
