/**
 * 2.0.0 — errori isolati per operazione e per tipo, cicli di esecuzione (riprocessare),
 * diagnostica della chat, rimozione dei commenti, «Posizione» predefinita, notifiche.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import * as Q from "../../src/shared/queue.js";
import { canInteract, cycleKey } from "../../src/shared/ledger.js";
import { validateCampaign, makeSnapshot, diffSnapshot } from "../../src/shared/policy.js";
import { chatDiagnosis } from "../../src/shared/messages.js";
import { DEFAULT_SETTINGS } from "../../src/shared/constants.js";

const ROOT = path.resolve(import.meta.dirname, "..", "..");
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");
const L = (id) => ({ id: String(id), title: `Annuncio ${id}`, price: 10, sellerId: "77", status: "active" });
const queue = (n, types = ["like", "offer", "message"]) => Q.addItems([], Array.from({ length: n }, (_, i) => L(900 + i)), { types }, "c1").items;
const setOp = (items, itemIdx, type, patch) => items.map((it, i) => (i !== itemIdx ? it : { ...it, ops: it.ops.map((o) => (o.type === type ? { ...o, ...patch } : o)) }));

test("il messaggio rinviato non blocca like e offerte (causa del blocco delle campagne)", () => {
  let items = queue(3);
  items = setOp(items, 0, "like", { status: "skipped", result: { ledger: "done" } });
  items = setOp(items, 0, "offer", { status: "skipped", result: { ledger: "done" } });
  // 1.4.0: il messaggio dell'annuncio 1 tornava «in attesa» in testa alla coda e veniva ripreso 3 volte.
  assert.equal(Q.nextOp(items).op.type, "message", "senza rinvio si ripete sempre lo stesso messaggio");
  const later = setOp(items, 0, "message", { retryAfter: Date.now() + 60_000 });
  const n = Q.nextOp(later);
  assert.equal(n.item.listingId, "901");
  assert.equal(n.op.type, "like", "si passa al like dell'annuncio successivo");
});

test("tipo sospeso o modulo isolato: si eseguono gli altri tipi, anche sullo stesso annuncio", () => {
  const items = queue(2);
  const blocked = new Set(["like"]);
  const n = Q.nextOp(items, { blocked });
  assert.equal(n.item.listingId, "900");
  assert.equal(n.op.type, "offer");
  const onlyMsg = queue(2, ["message"]);
  assert.equal(Q.nextOp(onlyMsg, { blocked: new Set(["message"]) }), null);
  assert.equal(Q.hasPending(onlyMsg), true);
  assert.deepEqual(Q.waitingState(onlyMsg, { blocked: new Set(["message"]) }), { pending: 2, retryAt: null, blockedTypes: ["message"] });
});

test("nuovo tentativo programmato: il motore sa quando ripassare", () => {
  const t = Date.now();
  let items = queue(1, ["message"]);
  items = setOp(items, 0, "message", { retryAfter: t + 60_000 });
  assert.equal(Q.nextOp(items, { now: t }), null);
  assert.equal(Q.waitingState(items, { now: t }).retryAt, t + 60_000);
  assert.equal(Q.nextOp(items, { now: t + 61_000 }).op.type, "message");
  assert.equal(Q.nextOp([{ ...items[0], ops: [{ ...items[0].ops[0], status: "running" }] }], { now: t + 61_000 }), null, "mai due operazioni insieme");
});

test("No Repeat con i cicli: duplicati accidentali bloccati, nuovo ciclo voluto ammesso, incerti mai", () => {
  const done1 = { status: "completed", at: 1, cycleKey: cycleKey("c1", 1) };
  assert.equal(canInteract(done1, { cycleKey: cycleKey("c1", 1) }).code, "sameCycle", "stesso ciclo");
  assert.equal(canInteract(done1, { cycleKey: cycleKey("c2", 1) }).code, "done", "altra campagna senza nuovo ciclo");
  assert.equal(canInteract({ status: "completed", at: 1 }, {}).code, "done", "voci vecchie senza ciclo");
  assert.equal(canInteract(done1, { cycleKey: cycleKey("c1", "c1-2-x"), newCycle: true }).allowed, true, "nuovo ciclo scelto dall'utente");
  assert.equal(canInteract({ ...done1, cycleKey: cycleKey("c1", "c1-2-x") }, { cycleKey: cycleKey("c1", "c1-2-x"), newCycle: true }).code, "sameCycle", "due volte nello stesso nuovo ciclo: no");
  assert.equal(canInteract({ status: "verify" }, { newCycle: true }).allowed, false, "esito incerto: mai ripetuto, nemmeno in un nuovo ciclo");
  assert.equal(canInteract({ status: "running" }, { newCycle: true }).allowed, false);
});

test("piano del nuovo ciclo: si ripete solo ciò che è concluso con certezza", () => {
  let items = queue(3);
  items = setOp(items, 0, "like", { status: "completed", finishedAt: 5 });
  items = setOp(items, 0, "offer", { status: "verify", amount: 9 });
  items = setOp(items, 0, "message", { status: "failed" });
  items = setOp(items, 1, "like", { status: "skipped", result: { ledger: "done" } });
  items = setOp(items, 1, "offer", { status: "skipped", reason: "Annuncio non attivo" });
  const plan = Q.refreshPlan(items);
  assert.deepEqual(plan.repeat.map((r) => [r.listingId, r.type]), [["900", "like"], ["901", "like"]]);
  assert.equal(plan.repeat[1].noRepeat, true);
  const why = Object.fromEntries(plan.excluded.filter((e) => e.listingId === "900").map((e) => [e.type, e.why]));
  assert.match(why.offer, /da verificare/);
  assert.match(why.message, /Ripeti falliti/);
  assert.equal(plan.items, 2);
  assert.deepEqual(Q.refreshPlan(items, { itemIds: [items[1].id] }).repeat.map((r) => r.listingId), ["901"], "un solo annuncio");
  assert.equal(Q.refreshPlan(items, { types: ["offer"] }).repeat.length, 0, "solo il tipo scelto");
});

test("nuovo ciclo: cronologia intatta, id del ciclo, gli altri annunci non cambiano", () => {
  let items = queue(2);
  items = setOp(items, 0, "like", { status: "completed", finishedAt: 111, result: { outcome: "done" } });
  items = setOp(items, 0, "offer", { status: "failed", error: "rifiutata", amount: 8 });
  items = setOp(items, 0, "message", { status: "completed", finishedAt: 222, text: "Testo mio", textLocked: true, requireConfirm: true });
  const before = structuredClone(items[1]);
  const plan = Q.refreshPlan(items, { itemIds: [items[0].id] });
  const r = Q.applyRefresh(items, plan, { cycle: 2, cycleId: "c1-2-abc", spec: {} });
  assert.deepEqual(r.changed, [items[0].id]);
  assert.deepEqual(r.items[1], before, "l'altro annuncio è identico");
  const it = r.items[0];
  assert.deepEqual(it.ops.map((o) => [o.type, o.status, o.cycle]), [["like", "waiting", 2], ["offer", "failed", 1], ["message", "waiting", 2]]);
  assert.ok(it.ops[0].newCycle && it.ops[0].cycleId === "c1-2-abc" && it.ops[0].prevOpId);
  assert.equal(it.ops[2].text, "Testo mio", "testo scritto a mano conservato");
  assert.equal(it.ops[2].requireConfirm, true);
  assert.equal(it.pastCycles.length, 1);
  assert.deepEqual(it.pastCycles[0].ops.map((o) => [o.type, o.status, o.finishedAt]), [["like", "completed", 111], ["message", "completed", 222]]);
  assert.match(it.history.at(-1).action, /nuovo ciclo 2/);
  // Terzo ciclo: la cronologia si accumula.
  const done2 = { ...it, ops: it.ops.map((o) => (o.cycle === 2 ? { ...o, status: "completed", finishedAt: 333 } : o)) };
  const r3 = Q.applyRefresh([done2], Q.refreshPlan([done2], { types: ["like"] }), { cycle: 3, cycleId: "c1-3" });
  assert.deepEqual(r3.items[0].pastCycles.map((p) => [p.cycle, p.ops.length]), [[1, 2], [2, 1]]);
  const sum = Q.cycleSummary(r3.items);
  assert.deepEqual(sum.map((c) => [c.cycle, c.completed, c.failed, c.pending]), [[1, 2, 1, 0], [2, 2, 0, 0], [3, 0, 0, 1]]);
});

test("nuovo ciclo: l'anteprima va riapprovata", () => {
  let items = queue(1, ["like"]);
  items = setOp(items, 0, "like", { status: "completed" });
  const snap = makeSnapshot(items);
  const r = Q.applyRefresh(items, Q.refreshPlan(items), { cycle: 2, cycleId: "x" });
  assert.equal(diffSnapshot(snap, r.items).length, 1);
});

test("Policy Validator: un modulo isolato non impedisce di avviare gli altri tipi", () => {
  const items = queue(1, ["like", "offer"]).map((i) => ({ ...i, ops: i.ops.map((o) => (o.type === "offer" ? { ...o, amount: 9 } : o)) }));
  const ctx = { campaign: { id: "c1", accountId: "1@x", snapshot: makeSnapshot(items) }, items, session: { loggedIn: true, accountId: "1@x" }, settings: DEFAULT_SETTINGS, breakers: { offer: { state: "open", reason: "pulsante assente" } } };
  const v = validateCampaign(ctx);
  assert.equal(v.ok, true, v.errors.join(" "));
  assert.match(v.warnings.join(" "), /Offerta: sospeso dal circuit breaker.*le altre partono/);
  const all = validateCampaign({ ...ctx, breakers: { like: { state: "open" }, offer: { state: "open" } } });
  assert.match(all.errors.join(" "), /Nessun modulo disponibile/);
});

test("diagnostica della chat: distingue i casi", () => {
  assert.match(chatDiagnosis({ url: "https://www.vinted.it/items/1-x", askButton: true, waitedMs: 25000 }), /clic su «Chiedi info» non ha aperto la chat.*25 s/);
  assert.match(chatDiagnosis({ url: "https://www.vinted.it/inbox/abc", noContent: 6, textareas: null }), /Vintastic non risponde sulla pagina della chat/);
  assert.match(chatDiagnosis({ url: "https://www.vinted.it/inbox/abc", noContent: 6, reinjected: true }), /nemmeno dopo averlo reinserito/);
  assert.match(chatDiagnosis({ url: "https://www.vinted.it/inbox/abc", textareas: 1, composer: false }), /chat aperta \(\/inbox\/abc\) ma il campo #composerInput non c'è \(1 campi/);
  assert.match(chatDiagnosis({ url: "https://www.vinted.it/inbox/abc", textareas: 0, visible: false, focusAsked: false }), /in background: attiva «Scheda in primo piano/);
  assert.match(chatDiagnosis({ url: "https://www.vinted.it/inbox/abc", textareas: 0, visible: false, focusAsked: true }), /non era visibile anche se Vintastic l'aveva portata in primo piano/);
  assert.match(chatDiagnosis({ url: "https://www.vinted.it/items/1-x", askButton: true, clicks: 3, clickable: { hydrated: false, waitedMs: 20000 }, waitedMs: 30000 }), /\(3 clic\).*non è diventato cliccabile in 20 s/);
  assert.match(chatDiagnosis({ url: "https://www.vinted.it/inbox/abc", textareas: 0, newTab: true, status: "loading" }), /ancora in caricamento.*scheda nuova/);
});

test("selettori di «Chiedi info» e della chat: quelli verificati su Vinted", () => {
  const a = read("src/content/adapter.js");
  assert.match(a, /button\[data-testid="ask-seller-button"\]/);
  assert.match(a, /"Chiedi info"/);
  assert.match(a, /textarea#composerInput, textarea\[data-testid="composer--input"\]/);
  assert.match(a, /\[data-testid="arrow-right"\]/);
  assert.ok(JSON.parse(read("manifest.json")).permissions.includes("scripting"), "reinserimento del content script nella chat");
});

test("commenti pubblici tolti dal codice (restano solo le migrazioni dei dati vecchi)", () => {
  const allowed = new Set(["src/shared/migrations.js", "src/background/backup.js", "src/shared/constants.js", "src/shared/policy.js", "src/ui/pages/help.js"]);
  const walk = (d) => fs.readdirSync(path.join(ROOT, d), { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(`${d}/${e.name}`) : [`${d}/${e.name}`]));
  const hits = walk("src").filter((f) => /\.(js|css|html)$/.test(f) && !allowed.has(f) && /\bcomment(i|o)?\b|s-comment|Commenta\b/i.test(read(f).replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "")));
  assert.deepEqual(hits, []);
  assert.ok(!("comment" in DEFAULT_SETTINGS.limits.perDay));
  assert.ok(!Object.keys(DEFAULT_SETTINGS.timers.transitions).some((k) => k.includes("comment")));
});

test("«Posizione»: In cima predefinita, salvata nella campagna", () => {
  assert.equal(DEFAULT_SETTINGS.campaignDefaults.addPosition, "start");
  const camp = read("src/ui/pages/campaigns.js");
  assert.match(camp, /where\.value = c\.addPosition \|\| ctx\.settings\.campaignDefaults\?\.addPosition \|\| "start"/);
  assert.match(read("src/ui/pages/listings.js"), /addPosition \|\| ctx\.settings\.campaignDefaults\?\.addPosition \|\| "start"/);
  const engine = read("src/background/engine.js");
  assert.match(engine, /if \(where === "start" \|\| where === "end"\) c\.addPosition = where;/);
});

test("centro notifiche: la pastiglia della gravità ha la sua colonna", () => {
  assert.match(read("src/ui/pages/notifications.js"), /class: "feed notes"/);
  assert.match(read("src/ui/dashboard.css"), /\.feed\.notes li \{ grid-template-columns: max-content minmax\(0, 1fr\) auto;/);
});

test("«In cima»: il gruppo va sopra la coda e conserva il suo ordine", () => {
  const base = Q.addItems([], [L(1), L(2)], { types: ["like"] }, "c1").items;
  const r = Q.addItems(base, [L(10), L(11), L(12)], { types: ["like"] }, "c1", "start");
  assert.deepEqual(Q.executionOrder(r.items).map((i) => i.listingId), ["10", "11", "12", "1", "2"]);
  const again = Q.addItems(r.items, [L(20), L(21)], { types: ["like"] }, "c1", "start");
  assert.deepEqual(Q.executionOrder(again.items).map((i) => i.listingId).slice(0, 3), ["20", "21", "10"]);
  const end = Q.addItems(base, [L(30), L(31)], { types: ["like"] }, "c1", "end");
  assert.deepEqual(Q.executionOrder(end.items).map((i) => i.listingId), ["1", "2", "30", "31"]);
});

test("azzera storico: le operazioni saltate perché già fatte tornano in attesa, solo i tipi scelti", async () => {
  const { resetLedgerSkipped } = await import("../../src/shared/queue.js");
  const items = [
    { id: "a", listingId: "1", ops: [
      { id: "l", type: "like", status: "skipped", result: { ledger: "done" } },
      { id: "o", type: "offer", status: "skipped", result: { ledger: "done" } },
      { id: "m", type: "message", status: "skipped", result: { ledger: "verify" } },
    ] },
    { id: "b", listingId: "2", ops: [{ id: "l2", type: "like", status: "skipped", result: { ledger: "done" } }] },
    { id: "c", listingId: "3", ops: [{ id: "l3", type: "like", status: "skipped", reason: "venduto", result: null }] },
  ];
  const r = resetLedgerSkipped(items, { listingIds: new Set(["1", "3"]), types: ["like", "message"] });
  assert.equal(r.count, 1);
  assert.equal(r.items[0].ops[0].status, "waiting");
  assert.equal(r.items[0].ops[1].status, "skipped", "offerta non scelta");
  assert.equal(r.items[0].ops[2].status, "skipped", "un esito da verificare non si sblocca");
  assert.equal(r.items[1].ops[0].status, "skipped", "annuncio non scelto");
  assert.equal(r.items[2].ops[0].status, "skipped", "saltata per un altro motivo");
  assert.equal(resetLedgerSkipped(items, { listingIds: null, types: ["like"] }).count, 2, "tutti gli annunci");
});
