import test from "node:test";
import assert from "node:assert/strict";
import { redact } from "../../src/shared/redact.js";
import { validateImport, buildExport, dedupeMerge } from "../../src/shared/schema.js";
import { compareVersions, parseRelease, parseShaFile } from "../../src/shared/version.js";
import { migrateSettings } from "../../src/shared/migrations.js";
import { normalizeListing, mergeListing } from "../../src/shared/listing.js";
import { suggestLocal, parseSuggestions } from "../../src/shared/suggest.js";
import { computeStats } from "../../src/shared/stats.js";
import { DEFAULT_SETTINGS } from "../../src/shared/constants.js";

test("redazione: cookie, token, webhook, email, chiavi", () => {
  const r = redact({ cookie: "a=b", token: "x", nested: { webhookUrl: "https://discord.com/api/webhooks/1/abc", msg: "Bearer abc.def.ghi e mail me@x.it access_token_web=eyJhbGciOi.eyJzdWIiOiIxIn0.sig sk-abcdefghijklmnop" }, accountId: "1@x" });
  const s = JSON.stringify(r);
  for (const leak of ["a=b", "abc.def", "me@x.it", "eyJzdWIi", "api/webhooks/1", "sk-abcdefghijklmnop"]) assert.ok(!s.includes(leak), leak);
  assert.equal(r.accountId, "1@x");
});

test("export: mai webhook o chiavi API; import: validazione, bozze, running → verify", () => {
  const ex = buildExport({ settings: { ...DEFAULT_SETTINGS, discord: { webhookUrl: "https://discord.com/api/webhooks/1/x" }, ai: { apiKey: "sk-secretsecret" } }, campaigns: [{ id: "c1", status: "running", items: [{ id: "i", ops: [{ status: "running" }, { status: "completed" }] }] }] }, ["settings", "campaigns"]);
  assert.ok(!JSON.stringify(ex).includes("webhooks/1"));
  assert.ok(!JSON.stringify(ex).includes("sk-secret"));
  const v = validateImport(JSON.stringify(ex));
  assert.equal(v.ok, true);
  assert.equal(v.data.campaigns[0].status, "draft");
  assert.equal(v.data.campaigns[0].items[0].ops[0].status, "verify");
  assert.equal(v.data.campaigns[0].items[0].ops[1].status, "completed");
  assert.equal(validateImport("{").ok, false);
  assert.equal(validateImport({ app: "Altro" }).ok, false);
  assert.match(validateImport({ app: "Vintastic", schema: 99, parts: { settings: {} } }).errors.join(), /più recente/);
});

test("deduplicazione: vince la voce più recente", () => {
  const r = dedupeMerge([{ id: 1, v: "a", updatedAt: 1 }], [{ id: 1, v: "b", updatedAt: 2 }, { id: 2, v: "c" }]);
  assert.equal(r.added, 1);
  assert.equal(r.updated, 1);
  assert.equal(r.items.find((x) => x.id === 1).v, "b");
});

test("versioni e release GitHub", () => {
  assert.equal(compareVersions("1.10.0", "1.9.0"), 1);
  assert.equal(compareVersions("v2.0.0", "2.0.0"), 0);
  assert.equal(compareVersions("2.0.0-beta.2", "2.0.0"), -1);
  assert.equal(compareVersions("x", "1.0.0"), null);
  const rel = parseRelease({ tag_name: "v1.2.0", body: "note", html_url: "https://github.com/MashaUP/Vintastic/releases/tag/v1.2.0",
    assets: [{ name: "vintastic-1.2.0.zip", browser_download_url: "https://github.com/MashaUP/Vintastic/releases/download/v1.2.0/vintastic-1.2.0.zip" }, { name: "vintastic-1.2.0.zip.sha256", browser_download_url: "https://github.com/MashaUP/Vintastic/releases/download/v1.2.0/vintastic-1.2.0.zip.sha256" }, { name: "evil.zip", browser_download_url: "https://evil.example/x.zip" }] });
  assert.equal(rel.version, "1.2.0");
  assert.equal(rel.zip.name, "vintastic-1.2.0.zip");
  assert.ok(rel.sha);
  assert.equal(parseRelease({ tag_name: "latest" }).ok, false);
  assert.equal(parseShaFile(`${"a".repeat(64)}  vintastic-1.2.0.zip\n`, "vintastic-1.2.0.zip"), "a".repeat(64));
});

test("migrazione impostazioni: v1 → v4 conservando i valori dell'utente", () => {
  const { settings, applied, from } = migrateSettings({ timers: { minDelay: 30, maxDelay: 60 }, limits: { daily: 25 }, notifications: false, overlay: true, theme: "light" });
  assert.equal(from, 1);
  assert.deepEqual(applied, ["settings_v1 → settings_v2", "settings_v2 → settings_v3", "settings_v3 → settings_v4", "settings_v4 → settings_v5"]);
  assert.equal(settings.limits.perDay.comment, undefined, "niente chiavi dei commenti");
  assert.deepEqual(settings.timers.betweenItems, { min: 30, max: 60 });
  assert.equal(settings.limits.perDay.offer, 25);
  assert.equal(settings.notifications.enabled, false);
  assert.equal(settings.theme, "light");
  assert.equal(settings.schema, DEFAULT_SETTINGS.schema);
  assert.ok(settings.timers.transitions, "chiavi nuove con i predefiniti");
});

test("migrazione impostazioni 3 → 4: via i commenti, Posizione In cima solo se non scelta", () => {
  const old = { schema: 3, limits: { perDay: { like: 5, comment: 9, offer: 3 } }, timers: { transitions: { "like>comment": { min: 1, max: 2 }, "comment>offer": { min: 1, max: 2 }, "like>offer": { min: 7, max: 8 } } }, features: { comment: true, like: false }, moduleKill: { comment: true } };
  const { settings, applied } = migrateSettings(old);
  assert.deepEqual(applied, ["settings_v3 → settings_v4", "settings_v4 → settings_v5"]);
  assert.equal(settings.limits.perDay.comment, undefined);
  assert.equal(settings.limits.perDay.like, 5, "valori dell'utente conservati");
  assert.deepEqual(settings.timers.transitions["like>offer"], { min: 7, max: 8 });
  assert.ok(!Object.keys(settings.timers.transitions).some((k) => k.includes("comment")));
  assert.equal(settings.features.comment, undefined);
  assert.equal(settings.features.like, false);
  assert.equal(settings.moduleKill.comment, undefined);
  assert.equal(settings.campaignDefaults.addPosition, "start");
  assert.equal(migrateSettings({ ...old, campaignDefaults: { addPosition: "end" } }).settings.campaignDefaults.addPosition, "end", "preferenza salvata non sovrascritta");
});

test("normalizzazione annunci: varianti di Vinted, date separate, niente invenzioni", () => {
  const n = normalizeListing({ id: 5, title: "Giacca", price: { amount: "12.5", currency_code: "EUR" }, path: "/items/5-giacca", user: { id: 9, login: "ann" }, photo: { url: "https://img/x.jpg", high_resolution: { timestamp: 1700000000 } }, is_reserved: true }, "https://www.vinted.it");
  assert.equal(n.price, 12.5);
  assert.equal(n.url, "https://www.vinted.it/items/5-giacca");
  assert.equal(n.sellerLogin, "ann");
  assert.equal(n.status, "reserved");
  assert.equal(n.publishedAt, null, "nessuna data di pubblicazione inventata");
  assert.equal(n.photoAt, 1700000000000);
  const m = mergeListing({ ...n, firstSeenAt: 1, priceHistory: [{ at: 1, price: 12.5 }] }, { ...n, price: 10 }, 5);
  assert.equal(m.firstSeenAt, 1);
  assert.equal(m.priceHistory.length, 2);
});

test("suggerimenti: pertinenti, senza ripetizioni, parser robusto", () => {
  const s = suggestLocal({ id: "1", title: "Giacca vintage", description: "bella" }, { count: 3 });
  assert.equal(s.length, 3);
  assert.ok(s.some((x) => /spalle/.test(x)));
  const again = suggestLocal({ id: "1", title: "Giacca vintage", description: "bella" }, { count: 3, history: s });
  assert.ok(again.every((x) => !s.includes(x)));
  assert.deepEqual(parseSuggestions('Ecco: ["Domanda uno?", "Domanda due? http://spam.example"]'), ["Domanda uno?", "Domanda due?"]);
  assert.deepEqual(parseSuggestions("1. Prima domanda?\n2) Seconda domanda?"), ["Prima domanda?", "Seconda domanda?"]);
});

test("statistiche: le simulazioni non contano", () => {
  const now = Date.now();
  const st = computeStats({ opsLog: [{ at: now, type: "like", status: "completed" }, { at: now, type: "like", status: "completed", simulated: true }, { at: now, type: "offer", status: "failed" }] }, "7d", now);
  assert.equal(st.totals.likes, 1);
  assert.equal(st.totals.failed, 1);
});

test("migrazione impostazioni 4 → 5: timer più bassi, valori scelti a mano conservati", () => {
  const old = { schema: 4, timers: { betweenOps: { min: 8, max: 20 }, betweenItems: { min: 60, max: 90 }, transitions: { "like>offer": { min: 10, max: 25 }, "offer>message": { min: 4, max: 9 } }, minFloor: 3 }, opRetry: { attempts: 3, delaysSec: [60, 300] } };
  const { settings, applied } = migrateSettings(old);
  assert.deepEqual(applied, ["settings_v4 → settings_v5"]);
  assert.deepEqual(settings.timers.betweenOps, { min: 3, max: 8 });
  assert.deepEqual(settings.timers.betweenItems, { min: 60, max: 90 }, "scelto a mano");
  assert.deepEqual(settings.timers.transitions["like>offer"], { min: 3, max: 8 });
  assert.deepEqual(settings.timers.transitions["offer>message"], { min: 4, max: 9 }, "scelto a mano");
  assert.equal(settings.timers.minFloor, 2);
  assert.deepEqual(settings.opRetry.delaysSec, [30, 120]);
  assert.deepEqual(migrateSettings({ ...old, opRetry: { attempts: 2, delaysSec: [10, 20] } }).settings.opRetry.delaysSec, [10, 20], "ritardi scelti a mano");
  assert.deepEqual(DEFAULT_SETTINGS.timers.betweenItems, { min: 10, max: 25 }, "installazione nuova: predefiniti bassi");
});
