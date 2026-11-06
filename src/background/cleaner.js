/**
 * Pulitore notifiche dell'account Vinted.
 * Fa UNA cosa: segna come lette le notifiche che selezioni. Non elimina
 * conversazioni, messaggi, offerte o altro. Le notifiche non si "cancellano":
 * Vinted non espone un'eliminazione che Vintastic possa usare in modo affidabile.
 */

import * as tabs from "./tabs.js";
import * as health from "./health.js";
import * as session from "./session.js";
import { getState, setState } from "./store.js";
import { log, activity } from "./logger.js";
import { broadcast } from "./bus.js";
import { notify } from "./notify.js";
import { sleep } from "../shared/util.js";

let control = { paused: false, cancelled: false, running: false };

async function tabFor() {
  const s = await session.current();
  if (!s.loggedIn) throw new Error("Accedi a Vinted per leggere le notifiche.");
  const { tabId } = await tabs.ensureAt(s.origin, `${s.origin}/`);
  return tabId;
}

export async function preview(pages = 3) {
  const avail = await health.moduleAvailable("notifCleaner");
  if (!avail.ok) throw new Error(avail.reason);
  const tabId = await tabFor();
  const r = await tabs.sendToTab(tabId, { type: "vt:notifList", pages }, 60_000);
  if (r?.capability) await health.recordCapability("notifications", r.capability.value, r.capability.detail);
  if (r?.outcome !== "done") {
    if (r?.outcome === "changed") await health.recordFailure("notifCleaner", r.message, { hard: true });
    throw new Error(r?.message || "Notifiche non leggibili");
  }
  return r.items;
}

export function status() { return getState("cleanerStatus", null); }
export function pauseClean(p = true) { control.paused = p; return true; }
export function cancelClean() { control.cancelled = true; return true; }

export async function clean(ids) {
  if (control.running) throw new Error("Pulizia già in corso");
  const avail = await health.moduleAvailable("notifCleaner");
  if (!avail.ok) throw new Error(avail.reason);
  control = { paused: false, cancelled: false, running: true };
  const st = { startedAt: Date.now(), total: ids.length, done: 0, failed: 0, errors: [], status: "running" };
  const save = async () => { await setState("cleanerStatus", st); broadcast("vt:cleaner", { status: st }); };
  await save();
  await activity("notif", `Pulizia notifiche avviata (${ids.length})`);
  try {
    const tabId = await tabFor();
    for (const id of ids) {
      while (control.paused && !control.cancelled) { st.status = "paused"; await save(); await sleep(1000); }
      if (control.cancelled) { st.status = "cancelled"; break; }
      st.status = "running";
      const r = await tabs.sendToTab(tabId, { type: "vt:notifRead", id }, 30_000).catch((e) => ({ outcome: "failed", message: e.message }));
      if (r?.outcome === "done") st.done++;
      else {
        st.failed++;
        st.errors.push(`${id}: ${r?.message || "errore"}`);
        if (r?.outcome === "blocked" || r?.outcome === "captcha") { st.status = "stopped"; st.errors.push("Vinted ha limitato le richieste: pulizia fermata."); break; }
        if (r?.outcome === "changed") { await health.recordFailure("notifCleaner", r.message, { hard: true }); st.status = "stopped"; break; }
      }
      await save();
      await sleep(1200);
    }
    if (st.status === "running") st.status = "done";
  } catch (e) {
    st.status = "failed";
    st.errors.push(e.message);
    await log({ level: "error", category: "notif", message: `Pulizia notifiche: ${e.message}` });
  } finally {
    control.running = false;
    st.finishedAt = Date.now();
    await save();
  }
  await notify({ category: st.failed ? "error" : "info", level: st.failed ? "warning" : "success", title: "Pulizia notifiche terminata", body: `${st.done} segnate come lette · ${st.failed} errori · stato: ${st.status}`, link: "#notifications" });
  return st;
}
