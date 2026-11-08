/**
 * Importazione/esportazione JSON, backup preventivo, retention, Support Bundle.
 */

import * as db from "./db.js";
import { migrateCampaignV4, migrateItemV4, stripCommentSettings } from "../shared/migrations.js";
import { redactMessages } from "../shared/messages.js";
import { getSettings, replaceSettings, getState } from "./store.js";
import { log } from "./logger.js";
import { buildExport, validateImport, dedupeMerge, EXPORT_PARTS } from "../shared/schema.js";
import { redact } from "../shared/redact.js";
import { VERSION } from "../shared/constants.js";
import { deepMerge } from "../shared/util.js";

async function collect(parts) {
  const data = {};
  if (parts.includes("settings")) data.settings = await getSettings();
  if (parts.includes("accounts")) data.accounts = await db.getAll("accounts");
  if (parts.includes("campaigns")) {
    const items = await db.getAll("items");
    data.campaigns = (await db.getAll("campaigns")).map((c) => ({ ...c, items: items.filter((i) => i.campaignId === c.id) }));
  }
  if (parts.includes("filters")) data.filters = (await db.get("meta", "savedFilters"))?.value || [];
  if (parts.includes("dashboard")) { const s = await getSettings(); data.dashboard = { widgets: s.dashboardWidgets, layout: s.layout, theme: s.theme }; }
  if (parts.includes("listings")) data.listings = await db.getAll("listings");
  if (parts.includes("history")) data.history = await db.getAll("ledger");
  return data;
}

export async function exportData(parts = Object.keys(EXPORT_PARTS)) {
  return buildExport(await collect(parts), parts);
}

export function previewImport(json) {
  return validateImport(json);
}

export async function importData(json, parts) {
  const v = validateImport(json);
  if (!v.ok) return { ok: false, errors: v.errors };
  // Backup preventivo di tutto ciò che verrà toccato.
  const backup = await exportData(Object.keys(EXPORT_PARTS));
  await db.put("meta", { key: "preImportBackup", at: Date.now(), value: backup });
  const report = {};
  try {
    const sel = parts?.length ? parts : Object.keys(v.data);
    if (sel.includes("settings") && v.data.settings) {
      const cur = await getSettings();
      // Segreti locali conservati: il file non li contiene.
      const merged = deepMerge(cur, stripCommentSettings(v.data.settings));   // file vecchi: niente chiavi dei commenti
      merged.discord = { ...merged.discord, webhookUrl: cur.discord?.webhookUrl || "" };
      merged.ai = { ...merged.ai, apiKey: cur.ai?.apiKey || "" };
      merged.killSwitch = cur.killSwitch;
      await replaceSettings(merged);
      report.settings = "unite";
    }
    if (sel.includes("dashboard") && v.data.dashboard) {
      const cur = await getSettings();
      await replaceSettings({ ...cur, dashboardWidgets: v.data.dashboard.widgets || cur.dashboardWidgets, layout: v.data.dashboard.layout || cur.layout, theme: v.data.dashboard.theme || cur.theme });
      report.dashboard = "applicate";
    }
    if (sel.includes("accounts") && v.data.accounts) {
      const r = dedupeMerge(await db.getAll("accounts"), v.data.accounts);
      await db.putMany("accounts", r.items);
      report.accounts = `${r.added} nuovi, ${r.updated} aggiornati`;
    }
    if (sel.includes("campaigns") && v.data.campaigns) {
      const existing = new Set((await db.getAll("campaigns")).map((c) => c.id));
      let added = 0;
      for (const c of v.data.campaigns) {
        const { items, ...camp } = c;
        const id = existing.has(camp.id) ? `${camp.id}_imp${Date.now() % 10000}` : camp.id;
        // Backup delle versioni 1.x: stesse regole della migrazione db_v4 (via i commenti, ciclo 1).
        await db.put("campaigns", migrateCampaignV4({ ...camp, id, name: existing.has(camp.id) ? `${camp.name} (importata)` : camp.name }));
        await db.putMany("items", items.map((i) => migrateItemV4({ ...i, id: existing.has(camp.id) ? `${i.id}_imp` : i.id, campaignId: id })));
        added++;
      }
      report.campaigns = `${added} importate come bozze`;
    }
    if (sel.includes("filters") && v.data.filters) {
      const cur = (await db.get("meta", "savedFilters"))?.value || [];
      const r = dedupeMerge(cur, v.data.filters, "name");
      await db.put("meta", { key: "savedFilters", value: r.items });
      report.filters = `${r.added} nuovi`;
    }
    if (sel.includes("listings") && v.data.listings) {
      const r = dedupeMerge(await db.getAll("listings"), v.data.listings.filter((l) => l?.id));
      await db.putMany("listings", r.items);
      report.listings = `${r.added} nuovi, ${r.updated} aggiornati`;
    }
    if (sel.includes("history") && v.data.history) {
      // Il ledger importato può solo AGGIUNGERE blocchi anti-duplicato, mai toglierli.
      const cur = new Map((await db.getAll("ledger")).map((e) => [e.key, e]));
      let added = 0;
      for (const e of v.data.history) {
        if (!e?.key || e.type === "comment") continue;
        const prev = cur.get(e.key);
        if (!prev || (prev.status !== "completed" && e.status === "completed")) { await db.put("ledger", e); added++; }
      }
      report.history = `${added} voci aggiunte`;
    }
    await log({ level: "info", category: "persistence", message: `Importazione completata: ${JSON.stringify(report)}` });
    return { ok: true, report, warnings: v.warnings };
  } catch (e) {
    await log({ level: "error", category: "persistence", message: `Importazione fallita: ${e.message}`, stack: e.stack, solution: "Il backup preventivo è in meta/preImportBackup: puoi reimportarlo." });
    return { ok: false, errors: [e.message], backupSaved: true };
  }
}

export async function restorePreImport() {
  const b = await db.get("meta", "preImportBackup");
  if (!b) throw new Error("Nessun backup preventivo");
  return b.value;
}

/** Pulizia secondo la retention scelta. */
export async function applyRetention() {
  const s = await getSettings();
  const r = s.retention || {};
  const now = Date.now();
  const out = {};
  out.logs = await db.pruneBefore("logs", now - (r.logsDays || 30) * 86400e3);
  out.logsTrim = await db.trimTo("logs", r.maxLogs || 5000);
  out.notifications = await db.pruneBefore("notifications", now - (r.notificationsDays || 60) * 86400e3);
  out.activity = await db.pruneBefore("activity", now - (r.activityDays || 90) * 86400e3);
  out.journal = await db.pruneBefore("journal", now - Math.max(r.activityDays || 90, 30) * 86400e3);
  return out;
}

/** Support Bundle: diagnostica senza cookie, token, password, webhook, testi dei messaggi o dati personali. */
export async function supportBundle(extra = {}) {
  const s = await getSettings();
  const logs = (await db.getAll("logs")).slice(-300);
  const campaigns = (await db.getAll("campaigns")).map((c) => ({ id: c.id, status: c.status, dryRun: c.dryRun, progress: c.progress, pauseReason: c.pauseReason, history: (c.history || []).slice(-20) }));
  const bundle = {
    app: "Vintastic", version: VERSION, at: new Date().toISOString(),
    browser: typeof navigator !== "undefined" ? navigator.userAgent : null,
    // Il contenuto dei messaggi privati (testi, modelli, destinatari) non esce mai: solo conteggi.
    settings: { ...s, discord: { ...s.discord, webhookUrl: s.discord?.webhookUrl ? "[impostato]" : "" }, ai: { ...s.ai, apiKey: s.ai?.apiKey ? "[impostata]" : "" }, messages: redactMessages(s.messages) },
    health: await getState("lastHealth", null),
    breakers: await getState("breakers", {}),
    capabilities: await getState("capabilities", {}),
    connectivity: await getState("connectivity", null),
    lastRecovery: await getState("lastRecovery", null),
    session: (({ loggedIn, origin, challenge, checkedAt }) => ({ loggedIn, origin, challenge, checkedAt }))(await getState("session", {})),
    counts: { listings: await db.count("listings"), campaigns: campaigns.length, ledger: await db.count("ledger"), logs: await db.count("logs") },
    campaigns,
    logs,
    ...extra,
  };
  return redact(bundle);
}
