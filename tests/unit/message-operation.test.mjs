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
