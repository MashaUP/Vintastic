/**
 * Scanner degli armadi (lato service worker): avvia la lettura nella scheda,
 * riceve gli annunci a blocchi, li normalizza e li salva senza doppioni.
 */

import * as db from "./db.js";
import * as tabs from "./tabs.js";
import * as health from "./health.js";
import * as session from "./session.js";
import { log, activity } from "./logger.js";
import { broadcast } from "./bus.js";
import { notify } from "./notify.js";
import { normalizeListing, mergeListing } from "../shared/listing.js";
import { findRelistMatch } from "../shared/ledger.js";
import { uid, memberIdFrom, originFrom } from "../shared/util.js";
import { isVintedOrigin } from "../shared/constants.js";

const cancelled = new Set();

export async function startScan({ url, tabId = null, maxItems = 5000 }) {
  const avail = await health.moduleAvailable("scanner");
  if (!avail.ok) throw new Error(`Scanner non disponibile: ${avail.reason}`);
  const sellerId = memberIdFrom(url);
  const origin = originFrom(url) || (await session.current()).origin || "https://www.vinted.it";
  if (!sellerId) throw new Error("URL dell'armadio non valido: deve contenere /member/<numero>.");
  if (!isVintedOrigin(origin)) throw new Error("L'URL non è un dominio Vinted supportato.");
  const sess = await session.current();
  const scan = { id: uid("s_"), sellerId, origin, url, startedAt: Date.now(), status: "running", found: 0, added: 0, updated: 0, pages: 0, totalPages: null, errors: [], accountId: sess.accountId || null };
  await db.put("scans", scan);
  broadcast("vt:scan", { scan });
  await activity("scan", `Scansione iniziata: armadio ${sellerId}`, { scanId: scan.id });

  // La scheda dell'utente si usa solo se la scansione parte da lì (sola lettura);
  // altrimenti Vintastic apre/riusa la sua scheda di lavoro.
  run(scan, tabId, maxItems).catch(async (e) => {
    await finish(scan.id, "failed", e.message);
  });
  return scan;
}

async function run(scan, userTabId, maxItems) {
  let tabId = userTabId;
  if (!tabId) {
    ({ tabId } = await tabs.ensureAt(scan.origin, `${scan.origin}/member/${scan.sellerId}`));
  }
  const res = await tabs.sendToTab(tabId, { type: "vt:scan", scanId: scan.id, sellerId: scan.sellerId, maxItems }, 15 * 60_000);
  if (res?.capability) await health.recordCapability(res.capability.name, res.capability.value, res.capability.detail);
  if (res?.outcome === "blocked" || res?.outcome === "captcha") {
    await health.recordFailure("scanner", res.message);
    return finish(scan.id, "failed", res.message || "Vinted ha bloccato la lettura");
  }
  if (res?.outcome === "changed") {
    await health.recordFailure("scanner", res.message, { hard: true });
    return finish(scan.id, "failed", res.message);
  }
  if (res?.outcome === "cancelled") return finish(scan.id, "cancelled");
  if (res?.outcome !== "done") return finish(scan.id, "failed", res?.message || "Scansione non completata");
  await health.recordSuccess("scanner");
  return finish(scan.id, "done", null, res);
}

async function finish(scanId, status, error = null, res = null) {
  const scan = await db.get("scans", scanId);
  if (!scan) return;
  Object.assign(scan, { status, finishedAt: Date.now() });
  if (error) scan.errors = [...(scan.errors || []), error].slice(-20);
  if (res?.method) scan.method = res.method;
  if (res?.inaccessible) scan.inaccessible = res.inaccessible;
  await db.put("scans", scan);
  broadcast("vt:scan", { scan });
  cancelled.delete(scanId);
  if (status === "done") {
    await activity("scan", `Scansione completata: ${scan.found} annunci (${scan.added} nuovi)`, { scanId });
    await notify({ category: "info", level: "success", title: "Scansione completata", body: `Armadio ${scan.sellerId}: ${scan.found} annunci, ${scan.added} nuovi, ${scan.updated} aggiornati.`, link: `#listings?seller=${scan.sellerId}` });
  } else if (status === "failed") {
    await log({ level: "error", category: "scan", message: `Scansione non riuscita: ${error}`, code: /403|429|bloccat/i.test(error) ? "blocked403" : null });
    await notify({ category: "error", level: "error", title: "Scansione non riuscita", body: error || "", link: "#scanner" });
  }
}

/** Blocco di annunci dal content script. */
export async function receiveBatch({ scanId, items, page, totalPages, sellerLogin }) {
  const scan = await db.get("scans", scanId);
  if (!scan || scan.status !== "running") return { cancel: true };
  if (cancelled.has(scanId)) return { cancel: true };
  const known = await db.byIndex("listings", "sellerId", scan.sellerId);
  const byId = new Map(known.map((l) => [l.id, l]));
  const out = [];
  let added = 0;
  let updated = 0;
  for (const [idx, raw] of items.entries()) {
    const n = normalizeListing(raw, scan.origin, { sellerId: scan.sellerId, sellerLogin, scannedBy: scan.accountId });
    if (!n) continue;
    n.scanRank = (Math.max(1, page) - 1) * 96 + idx;     // posizione in «più recenti prima» di Vinted
    const prev = byId.get(n.id);
    const merged = mergeListing(prev, n);
    merged.scanIds = [...new Set([...(prev?.scanIds || []), scanId])].slice(-20);
    if (!prev) {
      const rel = findRelistMatch(merged, known);
      if (rel) merged.relistOf = rel;              // collegamento storico con l'annuncio precedente
      added++;
    } else updated++;
    byId.set(n.id, merged);
    out.push(merged);
  }
  await db.putMany("listings", out);
  Object.assign(scan, { found: scan.found + out.length, added: scan.added + added, updated: scan.updated + updated, pages: page, totalPages: totalPages ?? scan.totalPages });
  await db.put("scans", scan);
  broadcast("vt:scan", { scan });
  for (const l of out.slice(0, 3)) await activity("listing", `Annuncio acquisito: «${l.title.slice(0, 50)}»`, { listingId: l.id, scanId });
  return { cancel: false };
}

export async function cancelScan(scanId) {
  cancelled.add(scanId);
  const scan = await db.get("scans", scanId);
  if (scan?.status === "running") await finish(scanId, "cancelled");
}
