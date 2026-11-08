/** Statistiche della dashboard, calcolate dai dati locali. Funzioni pure. */

import { dayKey } from "./util.js";

export const STAT_RANGES = {
  today: "Oggi",
  "7d": "Ultimi 7 giorni",
  "30d": "Ultimi 30 giorni",
  month: "Questo mese",
  all: "Tutto",
  custom: "Intervallo personalizzato",
};

export function rangeBounds(range, now = Date.now(), from = null, to = null) {
  const d = new Date(now);
  switch (range) {
    case "today": { const s = new Date(d); s.setHours(0, 0, 0, 0); return { from: s.getTime(), to: now }; }
    case "7d": return { from: now - 7 * 86400e3, to: now };
    case "30d": return { from: now - 30 * 86400e3, to: now };
    case "month": return { from: new Date(d.getFullYear(), d.getMonth(), 1).getTime(), to: now };
    case "custom": return { from: from ? Number(from) : 0, to: to ? Number(to) : now };
    default: return { from: 0, to: now };
  }
}

const inRange = (t, b) => t >= b.from && t <= b.to;

/**
 * @param data {ledger, listings, campaigns, scans, opsLog}
 *   opsLog: elenco di operazioni concluse {at, type, status, accountId, campaignId, simulated, durationMs}
 */
export function computeStats(data, range = "7d", now = Date.now(), from = null, to = null) {
  const b = rangeBounds(range, now, from, to);
  const ops = (data.opsLog || []).filter((o) => !o.simulated && inRange(o.at, b));
  const count = (type, status = "completed") => ops.filter((o) => (!type || o.type === type) && o.status === status).length;
  const campaigns = data.campaigns || [];
  const scans = (data.scans || []).filter((s) => inRange(s.startedAt, b));

  const totals = {
    accounts: (data.accounts || []).length,
    listings: (data.listings || []).filter((l) => inRange(l.firstSeenAt || 0, b)).length,
    listingsAll: (data.listings || []).length,
    likes: count("like"),
    offers: count("offer"),
    messages: count("message"),
    failed: ops.filter((o) => o.status === "failed").length,
    verify: ops.filter((o) => o.status === "verify").length,
    skipped: ops.filter((o) => o.status === "skipped").length,
    pending: campaigns.reduce((n, c) => n + (c.progress?.pending || 0), 0),
    campaignsDone: campaigns.filter((c) => c.status === "completed" && inRange(c.completedAt || 0, b)).length,
    campaignsRunning: campaigns.filter((c) => c.status === "running").length,
    activeMs: ops.reduce((n, o) => n + (o.durationMs || 0), 0) + scans.reduce((n, s) => n + Math.max(0, (s.finishedAt || s.startedAt) - s.startedAt), 0),
    scans: scans.length,
  };

  // Serie giornaliera (al massimo 60 giorni visualizzati).
  const days = [];
  const start = Math.max(b.from || (now - 30 * 86400e3), now - 60 * 86400e3);
  for (let t = new Date(start).setHours(12, 0, 0, 0); t <= now + 1; t += 86400e3) days.push(dayKey(t));
  const series = Object.fromEntries(["like", "offer", "message", "scan", "failed"].map((k) => [k, Object.fromEntries(days.map((d) => [d, 0]))]));
  for (const o of ops) {
    const d = dayKey(o.at);
    if (o.status === "completed" && series[o.type]?.[d] != null) series[o.type][d]++;
    if (o.status === "failed" && series.failed[d] != null) series.failed[d]++;
  }
  for (const s of scans) { const d = dayKey(s.startedAt); if (series.scan[d] != null) series.scan[d] += s.found || 0; }

  const byAccount = {};
  const byCampaign = {};
  for (const o of ops) {
    if (o.status !== "completed") continue;
    byAccount[o.accountId || "?"] = (byAccount[o.accountId || "?"] || 0) + 1;
    byCampaign[o.campaignId || "?"] = (byCampaign[o.campaignId || "?"] || 0) + 1;
  }
  return { range, bounds: b, totals, days, series, byAccount, byCampaign };
}
