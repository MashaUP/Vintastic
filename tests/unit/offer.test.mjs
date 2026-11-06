import test from "node:test";
import assert from "node:assert/strict";
import { computeOffer, roundAmount, normalizeOffer } from "../../src/shared/offer.js";
import { seededRng } from "../../src/shared/util.js";

test("arrotondamenti: ,99 ,00 multipli e direzioni", () => {
  assert.equal(roundAmount(12.3, "99", "nearest"), 11.99);
  assert.equal(roundAmount(12.7, "99", "nearest"), 12.99);
  assert.equal(roundAmount(12.99, "99"), 12.99);
  assert.equal(roundAmount(13.5, "99", "up"), 13.99);
  assert.equal(roundAmount(13.5, "99", "down"), 12.99);
  assert.equal(roundAmount(12.5, "00", "up"), 13);
  assert.equal(roundAmount(12.5, "00", "down"), 12);
  assert.equal(roundAmount(12.3, "5", "up"), 15);
  assert.equal(roundAmount(12.3, "5", "nearest"), 10);
  assert.equal(roundAmount(17, "10", "nearest"), 20);
  assert.equal(roundAmount(12.345, "none"), 12.35);
});

test("Risparmio: sconto percentuale e mai sopra il prezzo", () => {
  const r = computeOffer(25, { mode: "saving", rule: { kind: "percentOff", value: 20 }, rounding: { style: "none" } });
  assert.equal(r.ok, true);
  assert.equal(r.amount, 20);
  const up = computeOffer(25, { mode: "saving", rule: { kind: "percentUp", value: 10 }, rounding: { style: "00", direction: "up" } });
  assert.ok(up.amount < 25, `in Risparmio ${up.amount} deve restare sotto 25`);
  assert.ok(up.warnings.length > 0);
});

test("Interazione: importi sopra il prezzo con avviso", () => {
  const r = computeOffer(25, { mode: "interaction", rule: { kind: "percentUp", value: 10 }, rounding: { style: "none" } });
  assert.equal(r.amount, 27.5);
  assert.ok(r.warnings.some((w) => /superiore al prezzo/.test(w)));
});

test("sconto fisso, incremento fisso, importo fisso, minimo e massimo", () => {
  assert.equal(computeOffer(30, { mode: "custom", rule: { kind: "fixedOff", value: 5 }, rounding: { style: "none" } }).amount, 25);
  assert.equal(computeOffer(30, { mode: "custom", rule: { kind: "fixedUp", value: 5 }, rounding: { style: "none" } }).amount, 35);
  assert.equal(computeOffer(30, { mode: "custom", rule: { kind: "exact", value: 18 }, rounding: { style: "none" } }).amount, 18);
  assert.equal(computeOffer(30, { mode: "custom", rule: { kind: "percentOff", value: 90 }, min: 20, rounding: { style: "none" } }).amount, 20);
  assert.equal(computeOffer(30, { mode: "custom", rule: { kind: "percentUp", value: 90 }, max: 40, rounding: { style: "none" } }).amount, 40);
});

test("fasce di prezzo: vince la prima fascia che contiene il prezzo", () => {
  const cfg = { mode: "custom", rule: { kind: "percentOff", value: 5 }, bands: [{ upTo: 50, rule: { kind: "percentOff", value: 20 } }, { upTo: 10, rule: { kind: "fixedOff", value: 1 } }], rounding: { style: "none" } };
  assert.equal(computeOffer(8, cfg).amount, 7);
  assert.equal(computeOffer(40, cfg).amount, 32);
  assert.equal(computeOffer(100, cfg).amount, 95);
});

test("importo casuale: dentro l'intervallo e riproducibile col seme", () => {
  const cfg = { mode: "custom", rule: { kind: "random", unit: "amount", from: 10, to: 12 }, rounding: { style: "none" } };
  for (let i = 0; i < 200; i++) {
    const r = computeOffer(20, cfg);
    assert.ok(r.amount >= 10 && r.amount <= 12, String(r.amount));
    assert.equal(r.random, true);
  }
  assert.equal(computeOffer(20, cfg, seededRng(7)).amount, computeOffer(20, cfg, seededRng(7)).amount);
});

test("prezzo mancante o regola che azzera: errore, mai un importo inventato", () => {
  assert.equal(computeOffer(null, {}).ok, false);
  assert.equal(computeOffer(10, { mode: "custom", rule: { kind: "fixedOff", value: 20 }, rounding: { style: "none" } }).ok, false);
  assert.equal(normalizeOffer({ mode: "boh" }).mode, "saving");
});

test("percentuale ±: predefinito +5%, anche negativa; in Risparmio resta sotto il prezzo", () => {
  const d = computeOffer(2, {});
  assert.equal(d.ok, true);
  assert.equal(d.amount, 2.1, "predefinito: +5% sul prezzo, centesimi esatti");
  assert.equal(computeOffer(20, { rule: { kind: "percent", value: -10 } }).amount, 18);
  assert.equal(computeOffer(20, { mode: "interaction", rule: { kind: "percent", value: 12 }, rounding: { style: "none" } }).amount, 22.4);
  assert.ok(computeOffer(20, { mode: "saving", rule: { kind: "percent", value: 5 }, rounding: { style: "none" } }).amount < 20);
});
