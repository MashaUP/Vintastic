import test from "node:test";
import assert from "node:assert/strict";
import { canInteract, ledgerKey, ledgerUpdate, findRelistMatch } from "../../src/shared/ledger.js";
import { validateCampaign, makeSnapshot, diffSnapshot } from "../../src/shared/policy.js";
import * as Q from "../../src/shared/queue.js";
import { DEFAULT_SETTINGS } from "../../src/shared/constants.js";

test("No Repeat: separato per tipo e per account", () => {
  const ledger = new Map();
  ledger.set(ledgerKey("1@x", "50", "like"), { status: "completed", at: Date.now() });
  assert.equal(canInteract(ledger.get(ledgerKey("1@x", "50", "like"))).allowed, false);
  assert.equal(canInteract(ledger.get(ledgerKey("1@x", "50", "offer"))).allowed, true, "il like non blocca l'offerta");
  assert.equal(canInteract(ledger.get(ledgerKey("2@x", "50", "like"))).allowed, true, "altro account");
});

test("No Repeat: in esecuzione o da verificare bloccano; fallito no; simulato non conta", () => {
  assert.equal(canInteract({ status: "running" }).allowed, false);
  assert.equal(canInteract({ status: "verify" }).allowed, false);
  assert.equal(canInteract({ status: "failed" }).allowed, true);
  assert.equal(canInteract({ status: "completed", simulated: true }).allowed, true);
});

test("ledgerUpdate conserva lo storico", () => {
  let e = ledgerUpdate(null, { status: "running", campaignId: "c" });
  e = ledgerUpdate(e, { status: "completed", campaignId: "c" });
  assert.deepEqual(e.history.map((x) => x.status), ["running", "completed"]);
});

test("annuncio ripubblicato: collegamento solo se affidabile", () => {
  const known = [{ id: "1", sellerId: "9", title: "Giacca di pelle nera", price: 50, photoKey: "a/b" }];
  assert.equal(findRelistMatch({ id: "2", sellerId: "9", title: "Giacca di Pelle Nera!", price: 48 }, known), "1");
  assert.equal(findRelistMatch({ id: "2", sellerId: "8", title: "Giacca di pelle nera", price: 50 }, known), null);
  assert.equal(findRelistMatch({ id: "2", sellerId: "9", title: "Giacca di pelle nera", price: 90 }, known), null);
  const ambiguous = [...known, { id: "3", sellerId: "9", title: "Giacca di pelle nera", price: 51 }];
  assert.equal(findRelistMatch({ id: "4", sellerId: "9", title: "Giacca di pelle nera", price: 50 }, ambiguous), null);
});

function camp(items, extra = {}) {
  return { accountId: "1@https://www.vinted.it", dryRun: false, snapshot: makeSnapshot(items), ...extra };
}
const session = { loggedIn: true, accountId: "1@https://www.vinted.it" };
const L = (n) => ({ id: String(n), title: `T${n}`, price: 10, sellerId: "5", status: "active" });

test("Policy Validator: sessione, account, kill switch, snapshot", () => {
  let { items } = Q.addItems([], [L(1)], { types: ["like"] }, "c");
  const s = DEFAULT_SETTINGS;
  assert.equal(validateCampaign({ campaign: camp(items), items, session, settings: s }).ok, true);
  assert.equal(validateCampaign({ campaign: camp(items), items, session: { loggedIn: false }, settings: s }).ok, false);
  assert.match(validateCampaign({ campaign: camp(items), items, session: { loggedIn: true, accountId: "2@x" }, settings: s }).errors.join(), /non è quello della campagna/);
  assert.match(validateCampaign({ campaign: camp(items), items, session, settings: { ...s, killSwitch: true } }).errors.join(), /Kill Switch/);
  assert.match(validateCampaign({ campaign: camp(items, { snapshot: null }), items, session, settings: s }).errors.join(), /approvazione/);
  assert.equal(validateCampaign({ campaign: camp(items, { dryRun: true }), items, session: { loggedIn: false }, settings: s }).ok, true, "la simulazione non richiede la sessione");
});

test("Policy Validator: soglie e operazioni già fatte", () => {
  let { items } = Q.addItems([], [L(1), L(2)], { types: ["like"] }, "c");
  const ledger = new Map([[ledgerKey(session.accountId, "1", "like"), { status: "completed", at: 1 }]]);
  const v = validateCampaign({ campaign: camp(items), items, session, ledger, settings: DEFAULT_SETTINGS });
  assert.match(v.warnings.join(), /già state eseguite/);
  const day = new Date(); const p = (n) => String(n).padStart(2, "0");
  const counters = { day: `${day.getFullYear()}-${p(day.getMonth() + 1)}-${p(day.getDate())}`, accounts: { [session.accountId]: { like: 60, total: 60 } }, global: 60 };
  assert.equal(validateCampaign({ campaign: camp(items), items, session, counters, settings: DEFAULT_SETTINGS }).ok, false);
});

test("Snapshot: prezzo cambiato o operazione nuova richiedono riapprovazione", () => {
  let { items } = Q.addItems([], [L(1)], { types: ["offer"] }, "c");
  items[0].ops[0].amount = 8;
  const snap = makeSnapshot(items);
  assert.deepEqual(diffSnapshot(snap, items), []);
  const changed = items.map((i) => ({ ...i, listing: { ...i.listing, price: 12 } }));
  assert.match(diffSnapshot(snap, changed).join(), /Prezzo cambiato/);
  const done = items.map((i) => ({ ...i, ops: i.ops.map((o) => ({ ...o, status: "completed" })) }));
  assert.deepEqual(diffSnapshot(snap, done), [], "operazioni eseguite non sono differenze");
});

test("dopo una simulazione: messaggio che spiega come eseguire davvero", () => {
  let { items } = Q.addItems([], [L(1)], { types: ["like"] }, "c");
  items[0].ops[0].status = "completed";
  items[0].ops[0].result = { simulated: true };
  const v = validateCampaign({ campaign: camp(items, { dryRun: true }), items, session, settings: DEFAULT_SETTINGS });
  assert.equal(v.ok, false);
  assert.match(v.errors.join(), /Esegui davvero su Vinted/);
  items[0].ops[0].result = { outcome: "done" };
  assert.match(validateCampaign({ campaign: camp(items), items, session, settings: DEFAULT_SETTINGS }).errors.join(), /Non ci sono operazioni/);
});
