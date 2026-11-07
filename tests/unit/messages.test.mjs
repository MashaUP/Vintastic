/**
 * Messaggi privati: destinatari autorizzati, fonti del testo, segnaposto,
 * anteprima/snapshot, Policy Validator, No Repeat, soglia giornaliera, privacy.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { OP_TYPES, OP_LABEL, DEFAULT_SETTINGS } from "../../src/shared/constants.js";
import {
  parseRecipientId, cleanRecipients, recipientCheck, validateText, fillPlaceholders, resolveMessage,
  messageConfig, effectiveMode, fillMessageOps, sanitizeMessagesPatch, redactMessages, MESSAGE_MAX,
} from "../../src/shared/messages.js";
import { validateCampaign, makeSnapshot, diffSnapshot, snapshotEntries } from "../../src/shared/policy.js";
import { canInteract } from "../../src/shared/ledger.js";
import { checkLimit, countOp } from "../../src/shared/timers.js";
import { computeStats } from "../../src/shared/stats.js";
import { stableStringify } from "../../src/shared/util.js";
import * as Q from "../../src/shared/queue.js";
import "../../src/shared/guard-core.js";

const ROOT = path.resolve(import.meta.dirname, "..", "..");
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");
const ACC = "4242@https://www.vinted.it";
const session = { loggedIn: true, accountId: ACC };
const listing = (id = "123456", sellerId = "77", extra = {}) => ({ id, title: "Giacca di jeans", price: 12, currency: "EUR", sellerId, sellerLogin: "venditrice", brand: "Levi's", size: "M", status: "active", ...extra });
const settingsWith = (patch = {}) => {
  const s = structuredClone(DEFAULT_SETTINGS);
  s.messages = { ...s.messages, recipients: [{ id: "77", label: "Account principale" }], ...patch };
  return s;
};
const campaign = (message = { source: "default" }, extra = {}) => ({ id: "c1", accountId: ACC, dryRun: false, opsDefaults: { types: ["message"], message }, sort: { seed: 7 }, ...extra });
const messageItems = (listings = [listing()]) => Q.addItems([], listings, { types: ["message"] }, "c1").items;

test("operazione distinta dal commento, nessun testo finché non c'è l'anteprima", () => {
  assert.ok(OP_TYPES.includes("message") && OP_TYPES.includes("comment"));
  assert.equal(OP_LABEL.message, "Messaggio privato");
  const op = Q.makeOp("message");
  assert.equal(op.type, "message");
  assert.equal(op.text, null);
  assert.equal(op.comment, undefined);
});

test("predefiniti: modalità A, soglia 10 al giorno, nessun destinatario, transizioni complete", () => {
  assert.equal(DEFAULT_SETTINGS.messages.mode, "auto");
  assert.equal(DEFAULT_SETTINGS.limits.perDay.message, 10);
  assert.deepEqual(DEFAULT_SETTINGS.messages.recipients, []);
  assert.equal(DEFAULT_SETTINGS.messages.manualWaitSeconds, 240);
  assert.ok(DEFAULT_SETTINGS.messages.text.length > 0);
  for (const t of ["like", "comment", "offer"]) {
    assert.ok(DEFAULT_SETTINGS.timers.transitions[`${t}>message`], `${t}>message`);
    assert.ok(DEFAULT_SETTINGS.timers.transitions[`message>${t}`], `message>${t}`);
  }
});

test("le nuove campagne non scelgono i messaggi da sole (dialoghi e FAB)", () => {
  assert.match(read("src/ui/pages/campaigns.js"), /new Set\(preset\.types \|\| \["like"\]\)/);
  assert.match(read("src/ui/pages/listings.js"), /checked: t === "like"/);
  assert.match(read("src/content/overlay.js"), /checked: t === "like"/);
  assert.match(read("src/background/engine.js"), /types: \(input\.types \|\| \["like"\]\)/);
});

test("destinatari: id da numero, link del profilo o etichetta; niente doppioni", () => {
  assert.equal(parseRecipientId("12345"), "12345");
  assert.equal(parseRecipientId("https://www.vinted.it/member/987654-nome_utente"), "987654");
  assert.equal(parseRecipientId("@nome (555)"), "555");
  assert.equal(parseRecipientId("nome"), null);
  assert.deepEqual(cleanRecipients([{ id: "1", label: " A " }, "https://www.vinted.it/member/1-a", { id: "x" }, { id: "2" }]), [{ id: "1", label: "A" }, { id: "2", label: "" }]);
  const many = Array.from({ length: 40 }, (_, i) => ({ id: String(100 + i) }));
  assert.equal(cleanRecipients(many).length, 40, "nessun limite di numero");
});

test("solo i destinatari autorizzati: elenco vuoto, venditore ignoto, se stessi, estraneo", () => {
  const s = settingsWith();
  assert.equal(recipientCheck({ messages: { recipients: [] } }, "77").code, "noRecipients");
  assert.equal(recipientCheck(s, null).code, "unknownSeller");
  assert.equal(recipientCheck(settingsWith({ recipients: [{ id: "4242" }] }), "4242", "4242").code, "self");
  assert.equal(recipientCheck(s, "88").code, "notAllowed");
  assert.equal(recipientCheck(s, "77").ok, true);
  assert.equal(recipientCheck(s, 77).ok, true);
});

test("testo: non vuoto, al massimo 1000 caratteri", () => {
  assert.equal(validateText("   ").ok, false);
  assert.equal(validateText("x".repeat(MESSAGE_MAX)).ok, true);
  assert.match(validateText("x".repeat(MESSAGE_MAX + 1)).reason, /massimo 1000/);
});

test("segnaposto: titolo, prezzo, marca, taglia, venditore; quelli vuoti spariscono", () => {
  assert.equal(fillPlaceholders("Ciao {venditore}! {titolo} ({marca}, {taglia}) a {prezzo}?", listing()), "Ciao venditrice! Giacca di jeans (Levi's, M) a 12,00 €?");
  assert.equal(fillPlaceholders("Ciao! {marca} disponibile?", listing("1", "77", { brand: null })), "Ciao! disponibile?");
});

test("fonti del testo: predefinito, modello, scritto ora, rotazione, casuale, suggerimento", () => {
  const templates = [{ id: "a", name: "A", text: "Primo {titolo}" }, { id: "b", name: "B", text: "Secondo" }, { id: "c", name: "C", text: "Terzo" }];
  const s = settingsWith({ text: "Predefinito", templates });
  const L = listing();
  assert.equal(resolveMessage(messageConfig(campaign()), L, s).text, "Predefinito");
  assert.equal(resolveMessage(messageConfig(campaign({ source: "template", templateId: "a" })), L, s).text, "Primo Giacca di jeans");
  assert.match(resolveMessage(messageConfig(campaign({ source: "template", templateId: "zzz" })), L, s).reason, /non esiste più/);
  assert.equal(resolveMessage(messageConfig(campaign({ source: "custom", text: "Scritto ora" })), L, s).text, "Scritto ora");
  assert.equal(resolveMessage(messageConfig(campaign({ source: "custom", text: "" })), L, s).ok, false);
  const rot = messageConfig(campaign({ source: "rotate", templateIds: ["b", "c"] }));
  assert.deepEqual([0, 1, 2, 3].map((index) => resolveMessage(rot, L, s, { index }).text), ["Secondo", "Terzo", "Secondo", "Terzo"]);
  const rnd = messageConfig(campaign({ source: "random" }));
  const pick = (id, seed = 7) => resolveMessage(rnd, listing(id), s, { seed }).text;
  assert.equal(pick("900001"), pick("900001"), "casuale ma riproducibile");
  assert.ok(new Set(Array.from({ length: 30 }, (_, i) => pick(String(900000 + i)))).size > 1, "usa più modelli");
  assert.equal(resolveMessage(messageConfig(campaign({ source: "rotate" })), L, settingsWith()).ok, false, "rotazione senza modelli");
  const sug = resolveMessage(messageConfig(campaign({ source: "suggested" })), L, s);
  assert.ok(sug.ok && sug.text.length > 5 && sug.text.length <= MESSAGE_MAX);
  assert.equal(resolveMessage(messageConfig(campaign({ source: "custom", text: "x".repeat(1001) })), L, s).ok, false);
});

test("modalità: quella della campagna vince su quella delle impostazioni", () => {
  assert.equal(effectiveMode(messageConfig(campaign()), settingsWith({ mode: "manual" })), "manual");
  assert.equal(effectiveMode(messageConfig(campaign({ mode: "auto" })), settingsWith({ mode: "manual" })), "auto");
  assert.equal(effectiveMode(messageConfig(campaign({ mode: "strana" })), settingsWith()), "auto");
});

test("anteprima: testo calcolato per annuncio, venditore estraneo saltato senza chat", () => {
  const s = settingsWith({ text: "Ciao! {titolo}?" });
  const items = fillMessageOps(campaign(), messageItems([listing("1", "77"), listing("2", "88"), listing("3", null)]), s);
  const [a, b, c] = items.map((i) => i.ops[0]);
  assert.equal(a.status, "waiting");
  assert.equal(a.text, "Ciao! Giacca di jeans?");
  assert.equal(a.mode, "auto");
  assert.equal(b.status, "skipped");
  assert.match(b.reason, /non è tra i destinatari/);
  assert.equal(c.status, "skipped");
  // Elenco vuoto: niente viene saltato (si sistema aggiungendo i destinatari), ma la campagna non parte.
  const none = fillMessageOps(campaign(), messageItems(), settingsWith({ recipients: [] }));
  assert.equal(none[0].ops[0].status, "waiting");
});

test("anteprima: testo scritto a mano per un annuncio resta; le operazioni concluse non cambiano", () => {
  const s = settingsWith({ text: "Predefinito" });
  let items = fillMessageOps(campaign(), messageItems(), s);
  const op = items[0].ops[0];
  items = [Q.editItemOps(items[0], { [op.id]: { text: "Solo per questo annuncio" } }).item];
  items = fillMessageOps(campaign({ source: "custom", text: "Nuovo testo" }), items, s);
  assert.equal(items[0].ops[0].text, "Solo per questo annuncio");
  assert.equal(items[0].ops[0].textLocked, true);
  items = [Q.editItemOps(items[0], { [op.id]: { text: "" } }).item];
  items = fillMessageOps(campaign({ source: "custom", text: "Nuovo testo" }), items, s);
  assert.equal(items[0].ops[0].text, "Nuovo testo", "testo vuoto = torna a quello della campagna");
  const done = { ...items[0], ops: [{ ...items[0].ops[0], status: "completed" }] };
  assert.equal(fillMessageOps(campaign({ source: "custom", text: "Altro" }), [done], s)[0].ops[0].text, "Nuovo testo");
  assert.equal(Q.editItemOps(done, { [op.id]: { text: "x" } }).rejected != null, true);
});

test("snapshot: cambiare testo o modalità richiede una nuova approvazione", () => {
  const s = settingsWith({ text: "Primo testo" });
  const items = fillMessageOps(campaign(), messageItems(), s);
  const snap = makeSnapshot(items);
  assert.deepEqual(diffSnapshot(snap, items), []);
  const text = fillMessageOps(campaign(), items, settingsWith({ text: "Testo cambiato" }));
  assert.match(diffSnapshot(snap, text).join(" "), /modificata.*messaggio/);
  const mode = fillMessageOps(campaign({ mode: "manual" }), items, s);
  assert.match(diffSnapshot(snap, mode).join(" "), /messaggio \(B\)/);
});

test("snapshot: like e offerte approvati con le versioni precedenti restano validi", () => {
  const { items } = Q.addItems([], [listing()], { types: ["like", "offer"] }, "c1");
  const withAmount = items.map((i) => ({ ...i, ops: i.ops.map((o) => (o.type === "offer" ? { ...o, amount: 9.6 } : o)) }));
  const old = snapshotEntries(withAmount).map((e) => ({ ...e, ops: e.ops.map((o) => o.slice(0, 3)) }));
  assert.deepEqual(diffSnapshot({ at: 1, hash: stableStringify(old) }, withAmount), [], "formato 1.2.0");
  assert.deepEqual(diffSnapshot({ at: 1, hash: stableStringify({ entries: old, messages: null }) }, withAmount), [], "formato 1.3.1");
});

test("Policy Validator: destinatari, testo, avvisi e modalità", () => {
  const s = settingsWith();
  const ok = fillMessageOps(campaign(), messageItems(), s);
  const c = { ...campaign(), snapshot: makeSnapshot(ok) };
  const v = validateCampaign({ campaign: c, items: ok, session, settings: s });
  assert.equal(v.ok, true, v.errors.join(" "));
  assert.match(v.infos.join(" "), /modalità A/);
  const noRec = validateCampaign({ campaign: c, items: ok, session, settings: settingsWith({ recipients: [] }) });
  assert.match(noRec.errors.join(" "), /Nessun destinatario autorizzato/);
  const removed = validateCampaign({ campaign: c, items: ok, session, settings: settingsWith({ recipients: [{ id: "99" }] }) });
  assert.match(removed.warnings.join(" "), /verranno saltati/);
  const missing = fillMessageOps(campaign({ source: "template", templateId: "via" }), messageItems(), s);
  const vm = validateCampaign({ campaign: { ...c, snapshot: makeSnapshot(missing) }, items: missing, session, settings: s });
  assert.match(vm.errors.join(" "), /senza testo valido: Il modello scelto non esiste più/);
  const manual = fillMessageOps(campaign({ mode: "manual" }), messageItems(), s);
  assert.match(validateCampaign({ campaign: { ...c, snapshot: makeSnapshot(manual) }, items: manual, session, settings: s }).infos.join(" "), /modalità B/);
});

test("soglia giornaliera dei messaggi: 10, poi pausa fino a mezzanotte", () => {
  const limits = DEFAULT_SETTINGS.limits;
  let counters = null;
  for (let i = 0; i < 10; i++) {
    assert.equal(checkLimit(counters, ACC, "message", limits).allowed, true, `messaggio ${i + 1}`);
    counters = countOp(counters, ACC, "message");
  }
  const r = checkLimit(counters, ACC, "message", limits);
  assert.equal(r.allowed, false);
  assert.match(r.reason, /message raggiunta \(10\)/);
  assert.equal(checkLimit(counters, ACC, "like", limits).allowed, true, "la soglia dei messaggi non blocca i like");
});

test("No Repeat: un messaggio inviato o incerto non si ripete; il like non blocca il messaggio", () => {
  assert.equal(canInteract({ status: "completed", at: Date.now() }).allowed, false);
  assert.equal(canInteract({ status: "verify" }).code, "verify");
  assert.equal(canInteract({ status: "running" }).code, "running");
  assert.equal(canInteract({ status: "failed" }).allowed, true);
  const s = settingsWith();
  const items = fillMessageOps(campaign(), messageItems(), s);
  const ledger = new Map([[`${ACC}|123456|message`, { status: "completed", at: 1 }], [`${ACC}|123456|like`, { status: "completed", at: 1 }]]);
  const v = validateCampaign({ campaign: { ...campaign(), snapshot: makeSnapshot(items) }, items, session, settings: s, ledger });
  assert.match(v.warnings.join(" "), /1 operazioni sono già state eseguite/);
});

test("impostazioni: pulizia di modalità, testo, attesa manuale, modelli e destinatari", () => {
  const p = sanitizeMessagesPatch({ mode: "x", text: `  ${"a".repeat(1200)} `, manualWaitSeconds: 9999, recipients: ["https://www.vinted.it/member/5-a", "5", "no"], templates: [{ id: "a", name: "", text: " Ciao " }, { id: "a", text: "doppio" }, { id: "b", text: "  " }] });
  assert.equal(p.mode, "auto");
  assert.equal(p.text.length, 1000);
  assert.equal(p.manualWaitSeconds, 240);
  assert.deepEqual(p.recipients, [{ id: "5", label: "" }]);
  assert.deepEqual(p.templates, [{ id: "a", name: "Modello 1", text: "Ciao" }]);
  assert.equal(sanitizeMessagesPatch({ manualWaitSeconds: 1 }).manualWaitSeconds, 5);
  assert.deepEqual(Object.keys(sanitizeMessagesPatch({ mode: "manual" })), ["mode"], "si cambia solo ciò che arriva");
});

test("privacy: Support Bundle e log senza testi dei messaggi", () => {
  const r = JSON.stringify(redactMessages({ mode: "auto", text: "TESTO-SEGRETO", templates: [{ id: "a", text: "MODELLO-SEGRETO" }], recipients: [{ id: "77", label: "Fidanzato" }] }));
  for (const leak of ["TESTO-SEGRETO", "MODELLO-SEGRETO", "Fidanzato", "\"77\""]) assert.ok(!r.includes(leak), leak);
  const backup = read("src/background/backup.js");
  assert.match(backup, /messages: redactMessages\(s\.messages\)/);
  // Il motore non mette mai il testo nei log, nel journal o nel ledger.
  const engine = read("src/background/engine.js");
  for (const line of engine.split("\n").filter((l) => /\b(log|journal|setLedger|activity|notify)\(/.test(l))) assert.ok(!/op\.text|\.text\b/.test(line.replace(/res\.message|\.textContent/g, "")), `testo in: ${line.trim()}`);
});

test("statistiche: messaggi contati, simulazioni escluse", () => {
  const now = Date.now();
  const st = computeStats({ opsLog: [{ at: now, type: "message", status: "completed" }, { at: now, type: "message", status: "completed", simulated: true }, { at: now, type: "message", status: "verify" }] }, "7d", now);
  assert.equal(st.totals.messages, 1);
  assert.equal(st.totals.verify, 1);
});

test("divieto d'acquisto e niente API di messaggistica: solo clic protetti sui controlli visibili", () => {
  const adapter = read("src/content/adapter.js");
  assert.doesNotMatch(adapter, /new MouseEvent\(\s*["']click/, "nessun clic sintetico che aggira il guard");
  assert.equal((adapter.match(/VTGuard\.safeClick\(/g) || []).length, 2, "«Chiedi info» e Invia passano dal guard");
  assert.doesNotMatch(adapter, /\/conversations\/\d*.*\/(replies|messages)|\/messages\b.*request\(/, "nessun endpoint di messaggistica");
  for (const r of globalThis.VTGuard.ALLOWED) assert.doesNotMatch(String(r.path), /replies|messages|inbox/);
  assert.equal(globalThis.VTGuard.isForbiddenElement({ textContent: "Chiedi info", getAttribute: () => null }), false);
});
