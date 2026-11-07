import test from "node:test";
import assert from "node:assert/strict";
import { OP_TYPES, OP_LABEL, DEFAULT_SETTINGS } from "../../src/shared/constants.js";
import { checkLimit } from "../../src/shared/timers.js";
import { makeOp } from "../../src/shared/queue.js";

test("messaggio privato è un'operazione di campagna distinta", () => {
  assert.ok(OP_TYPES.includes("message"));
  assert.equal(OP_LABEL.message, "Messaggio privato");
  assert.equal(makeOp("message").type, "message");
});

test("modalità automatica predefinita e testo configurabile", () => {
  assert.equal(DEFAULT_SETTINGS.messages.mode, "auto");
  assert.ok(DEFAULT_SETTINGS.messages.text.length > 0);
  assert.equal(DEFAULT_SETTINGS.features.message, true);
});

test("messaggi con soglia giornaliera dedicata", () => {
  const limits = DEFAULT_SETTINGS.limits;
  assert.equal(limits.perDay.message, 10);
  assert.equal(checkLimit(null, "account", "message", limits).allowed, true);
  const counters = { day: new Date().toISOString().slice(0, 10), accounts: { account: { message: 10 } }, global: 10 };
  assert.equal(checkLimit(counters, "account", "message", limits).allowed, false);
});

import { validateCampaign, makeSnapshot, diffSnapshot } from "../../src/shared/policy.js";
import * as Q from "../../src/shared/queue.js";

const accountId = "4242@https://www.vinted.it";
const listing = { id: "123456", title: "Articolo test", price: 12, sellerId: "77", status: "active" };
const session = { loggedIn: true, accountId };

function messageCampaign(settings = DEFAULT_SETTINGS) {
  const { items } = Q.addItems([], [listing], { types: ["message"] }, "campaign-message-test");
  const snapshot = makeSnapshot(items, Date.now(), settings);
  return { items, campaign: { accountId, dryRun: false, snapshot } };
}

test("anteprima messaggio: testo e modalità fanno parte dello snapshot approvato", () => {
  const settings = structuredClone(DEFAULT_SETTINGS);
  const { items, campaign } = messageCampaign(settings);
  assert.deepEqual(diffSnapshot(campaign.snapshot, items, settings), []);

  const changedText = structuredClone(settings);
  changedText.messages.text = "Testo diverso dopo l'approvazione";
  assert.match(diffSnapshot(campaign.snapshot, items, changedText).join(" "), /Impostazioni del messaggio cambiate/);

  const changedMode = structuredClone(settings);
  changedMode.messages.mode = "manual";
  assert.match(diffSnapshot(campaign.snapshot, items, changedMode).join(" "), /Impostazioni del messaggio cambiate/);
});

test("Policy Validator blocca messaggi vuoti o troppo lunghi prima della campagna", () => {
  const { items, campaign } = messageCampaign();
  const empty = structuredClone(DEFAULT_SETTINGS);
  empty.messages.text = "   ";
  assert.match(validateCampaign({ campaign, items, session, settings: empty }).errors.join(" "), /Testo del messaggio privato vuoto/);

  const tooLong = structuredClone(DEFAULT_SETTINGS);
  tooLong.messages.text = "x".repeat(1001);
  assert.match(validateCampaign({ campaign, items, session, settings: tooLong }).errors.join(" "), /massimo 1000 caratteri/);
});

test("Policy Validator accetta un messaggio configurato e una modalità valida", () => {
  const { items, campaign } = messageCampaign();
  assert.equal(validateCampaign({ campaign, items, session, settings: DEFAULT_SETTINGS }).ok, true);
});
