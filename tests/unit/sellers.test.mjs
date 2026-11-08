import test from "node:test";
import assert from "node:assert/strict";
import { buildSellerMenu, sellerOptionLabel } from "../../src/shared/sellers.js";

test("menu Venditore: seguiti, poi destinatari non seguiti, poi altri venditori scansionati", () => {
  const m = buildSellerMenu({
    scanned: [{ sellerId: "282273362", login: "barbaramaccario27", count: 47 }, { sellerId: "185396964", login: "rngsus", count: 3 }, { sellerId: "555", login: "altro", count: 9 }, { sellerId: "?", count: 2 }],
    following: [{ id: "185396964", login: "rngsus" }, { id: "86131550", login: "ilariamasciarelli" }, { id: "282273362", login: "barbaramaccario27" }],
    recipients: [{ id: "185396964", label: "Ragazzo" }, { id: "777", label: "Amica" }],
  });
  assert.deepEqual(m.following.map((e) => e.login), ["barbaramaccario27", "ilariamasciarelli", "rngsus"]);
  assert.deepEqual(m.following.map((e) => e.count), [47, 0, 3], "annunci scansionati o da scansionare");
  assert.equal(m.following.find((e) => e.sellerId === "185396964").recipient, true);
  assert.deepEqual(m.recipients.map((e) => e.sellerId), ["777"], "solo i destinatari che non segui");
  assert.equal(m.recipients[0].label, "Amica");
  assert.deepEqual(m.scanned.map((e) => e.sellerId), ["555"], "gli altri restano, senza doppioni né id non validi");
  assert.equal(m.all.length, 5);
});

test("menu Venditore: senza seguiti (non letti) restano destinatari e scansionati", () => {
  const m = buildSellerMenu({ scanned: [{ sellerId: "1", login: "a", count: 2 }], recipients: [{ id: "1", label: "Io" }] });
  assert.equal(m.following.length, 0);
  assert.deepEqual(m.recipients.map((e) => [e.sellerId, e.count, e.login]), [["1", 2, "a"]]);
  assert.equal(m.scanned.length, 0);
});

test("testo delle opzioni", () => {
  assert.equal(sellerOptionLabel({ sellerId: "1", login: "rngsus", label: "Ragazzo", count: 3 }), "@rngsus · Ragazzo (3 annunci)");
  assert.equal(sellerOptionLabel({ sellerId: "777", login: null, label: "Amica", count: 0 }), "Amica (da scansionare)");
  assert.equal(sellerOptionLabel({ sellerId: "9", login: null, label: "", count: 0 }), "9 (da scansionare)");
});
