/**
 * Health Center: circuit breaker per modulo, feature health, capability
 * detection, kill switch e "Esegui controllo completo".
 * Se un modulo si rompe (Vinted cambia una pagina o un'API) si spegne solo lui.
 */

import * as db from "./db.js";
import { getState, setState, getSettings, saveSettings } from "./store.js";
import { log } from "./logger.js";
import { broadcast, portCount } from "./bus.js";
import { MODULES, VERSION } from "../shared/constants.js";
import * as session from "./session.js";

const COOLDOWN_MS = 30 * 60_000;
const THRESHOLD = 3;

export async function breakers() {
  const b = await getState("breakers", {});
  const now = Date.now();
  let changed = false;
  for (const [m, s] of Object.entries(b)) {
    if (s.state === "open" && !s.hard && now - s.openedAt > COOLDOWN_MS) { b[m] = { ...s, state: "half-open" }; changed = true; }
  }
  if (changed) await setState("breakers", b);
  return b;
}

export async function recordFailure(module, reason, { hard = false } = {}) {
  const b = await breakers();
  const cur = b[module] || { state: "closed", failures: 0 };
  const failures = (cur.failures || 0) + 1;
  const open = hard || cur.state === "half-open" || failures >= THRESHOLD;
  b[module] = { ...cur, failures, lastFailure: Date.now(), reason, ...(open ? { state: "open", openedAt: Date.now(), hard } : {}) };
  await setState("breakers", b);
  if (open && cur.state !== "open") {
    await log({ level: "error", category: hard ? "compat" : "system", message: `Modulo «${MODULES[module] || module}» sospeso: ${reason}`, code: hard ? "dom" : null });
    broadcast("vt:health", { breakers: b });
  }
  return b[module];
}

export async function recordSuccess(module) {
  const b = await getState("breakers", {});
  if (!b[module] || (b[module].state === "closed" && !b[module].failures)) return;
  b[module] = { state: "closed", failures: 0, lastOk: Date.now() };
  await setState("breakers", b);
  broadcast("vt:health", { breakers: b });
}

export async function resetBreaker(module) {
  const b = await getState("breakers", {});
  delete b[module];
  await setState("breakers", b);
  broadcast("vt:health", { breakers: b });
}

/** Il modulo può lavorare? (feature flag, kill switch, circuit breaker) */
export async function moduleAvailable(module) {
  const s = await getSettings();
  if (s.killSwitch) return { ok: false, reason: "Kill Switch globale attivo" };
  if (s.moduleKill?.[module]) return { ok: false, reason: "Modulo spento (kill switch del modulo)" };
  if (s.features?.[module] === false) return { ok: false, reason: "Funzionalità disattivata" };
  const b = (await breakers())[module];
  if (b?.state === "open") return { ok: false, reason: `Sospeso dal circuit breaker: ${b.reason}` };
  return { ok: true, halfOpen: b?.state === "half-open" };
}

export async function setKillSwitch(on) {
  await saveSettings({ killSwitch: Boolean(on) });
  await log({ level: on ? "warn" : "info", category: "system", message: on ? "Kill Switch globale ATTIVATO" : "Kill Switch globale disattivato" });
  broadcast("vt:health", {});
}

/** Capacità rilevate sulla pagina vera di Vinted (cosa funziona e cosa no). */
export async function recordCapability(name, value, detail = "") {
  const caps = await getState("capabilities", {});
  caps[name] = { value, detail, at: Date.now() };
  await setState("capabilities", caps);
}

export async function fullCheck({ engineState } = {}) {
  const checks = [];
  const add = (id, name, status, detail, action = null) => checks.push({ id, name, status, detail, action });

  add("sw", "Service Worker", "ok", `Attivo · v${VERSION} · ${portCount()} pagine collegate`);

  try {
    const probe = `probe_${Date.now()}`;
    await chrome.storage.local.set({ healthProbe: probe });
    const r = await chrome.storage.local.get("healthProbe");
    const bytes = await chrome.storage.local.getBytesInUse?.(null).catch(() => null);
    add("storage", "Storage locale", r.healthProbe === probe ? "ok" : "error", r.healthProbe === probe ? `Lettura e scrittura OK${bytes != null ? ` · ${(bytes / 1024).toFixed(0)} KB` : ""}` : "La scrittura non è stata riletta");
  } catch (e) {
    add("storage", "Storage locale", "error", e.message);
  }
  try {
    const sess = await chrome.storage.session.get(null);
    add("session-storage", "Storage di sessione", "ok", `${Object.keys(sess).length} chiavi in memoria`);
  } catch (e) {
    add("session-storage", "Storage di sessione", "warn", `Non disponibile: ${e.message}`);
  }

  try {
    const ic = await db.integrityCheck();
    add("db", "Database (IndexedDB)", ic.ok ? "ok" : "error", ic.ok ? `Versione ${ic.version} · ${Object.entries(ic.counts).map(([k, v]) => `${k} ${v}`).join(", ")}` : ic.problems.join("; "), ic.ok ? null : "repairDb");
    const running = ic.runningOps || 0;
    const active = engineState?.busy;
    add("queue", "Stato delle code", running && !active ? "warn" : "ok", running && !active ? `${running} operazioni risultano in esecuzione senza motore attivo: vai in Recupero` : "Coerente", running && !active ? "openRecovery" : null);
  } catch (e) {
    add("db", "Database (IndexedDB)", "error", e.message);
  }

  const s = await session.current();
  add("session", "Sessione Vinted", s.loggedIn ? (s.challenge ? "warn" : "ok") : "warn",
    s.loggedIn ? `Attiva: ${s.login || s.userId} su ${s.origin}${s.challenge ? " · verifica richiesta" : ""}` : "Nessuna sessione rilevata: apri Vinted da loggato");
  const accounts = await db.getAll("accounts");
  add("accounts", "Account", accounts.length ? "ok" : "warn", accounts.length ? `${accounts.length} account rilevati` : "Nessun account ancora rilevato");

  const caps = await getState("capabilities", {});
  const capNames = { wardrobeApi: "Lettura armadio", favourite: "Like", offer: "Offerta", notifications: "Notifiche Vinted", pageSelectors: "Selettori della pagina" };
  for (const [k, label] of Object.entries(capNames)) {
    const c = caps[k];
    add(`cap-${k}`, `Compatibilità: ${label}`, !c ? "unknown" : c.value === true ? "ok" : c.value === false ? "error" : "warn",
      !c ? "Non ancora provato su Vinted" : `${c.detail || c.value} · ${new Date(c.at).toLocaleString("it-IT")}`);
  }

  const b = await breakers();
  const settings = await getSettings();
  for (const [m, label] of Object.entries(MODULES)) {
    const st = b[m];
    const off = settings.moduleKill?.[m] || settings.features?.[m] === false;
    add(`mod-${m}`, `Modulo: ${label}`, off ? "off" : st?.state === "open" ? "error" : st?.state === "half-open" ? "warn" : "ok",
      off ? "Spento" : st?.state === "open" ? `Sospeso: ${st.reason}` : st?.state === "half-open" ? "In prova dopo una sospensione" : "Funzionante", st?.state === "open" ? `reset:${m}` : null);
  }
  add("kill", "Kill Switch globale", settings.killSwitch ? "error" : "ok", settings.killSwitch ? "ATTIVO: nessuna operazione può partire" : "Spento");

  const upd = await getState("updateStatus", null);
  add("version", "Versione", upd?.available ? "warn" : "ok", upd?.available ? `Installata ${VERSION} · disponibile ${upd.latest}` : `Installata ${VERSION}${upd?.checkedAt ? ` · ultimo controllo ${new Date(upd.checkedAt).toLocaleString("it-IT")}` : ""}`);

  const since = Date.now() - 24 * 3600e3;
  const logs = (await db.getAll("logs")).filter((l) => l.at >= since && (l.level === "error" || l.level === "critical"));
  const groups = {};
  for (const l of logs) groups[l.message.slice(0, 80)] = (groups[l.message.slice(0, 80)] || 0) + 1;
  const recurring = Object.entries(groups).filter(([, n]) => n >= 3).sort((a, b2) => b2[1] - a[1]);
  add("errors", "Errori ricorrenti (24 h)", recurring.length ? "warn" : "ok", recurring.length ? recurring.slice(0, 3).map(([m, n]) => `${n}× ${m}`).join(" · ") : `${logs.length} errori, nessuno ricorrente`);

  const online = await getState("connectivity", { online: true });
  add("net", "Connessione", online.online ? "ok" : "error", online.online ? `Raggiungibile${online.checkedAt ? ` · ${new Date(online.checkedAt).toLocaleTimeString("it-IT")}` : ""}` : `Offline dal ${new Date(online.since).toLocaleTimeString("it-IT")}`);

  await setState("lastHealth", { at: Date.now(), checks });
  return { at: Date.now(), checks };
}
