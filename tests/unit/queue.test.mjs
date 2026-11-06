import test from "node:test";
import assert from "node:assert/strict";
import * as Q from "../../src/shared/queue.js";
import { itemStatus, transitionOp, transitionCampaign, TransitionError } from "../../src/shared/states.js";

const L = (n) => ({ id: String(1000 + n), title: `Annuncio ${n}`, price: 10 + n, sellerId: "77", url: `https://www.vinted.it/items/${1000 + n}` });

test("aggiunta: niente doppioni, operazioni mancanti aggiunte all'elemento esistente", () => {
  let r = Q.addItems([], [L(1), L(2)], { types: ["like", "offer"] }, "c1");
  assert.equal(r.items.length, 2);
  assert.deepEqual(r.items[0].ops.map((o) => o.type), ["like", "offer"]);
  r = Q.addItems(r.items, [L(1)], { types: ["like"] }, "c1");
  assert.equal(r.items.length, 2);
  assert.equal(r.rejected.length, 1);
  r = Q.addItems(r.items, [L(1)], { types: ["comment"] }, "c1");
  assert.equal(r.items.find((i) => i.listingId === "1001").ops.length, 3);
});

test("ordine di esecuzione: priorità, poi posizione; aggiunta in cima", () => {
  let { items } = Q.addItems([], [L(1), L(2), L(3)], { types: ["like"] }, "c1");
  items = Q.addItems(items, [L(4)], { types: ["like"] }, "c1", "start").items;
  assert.equal(Q.nextOp(items).item.listingId, "1004");
  items = Q.setPriority(items, items.find((i) => i.listingId === "1003").id, 1);
  assert.equal(Q.nextOp(items).item.listingId, "1003");
});

test("nessuna nuova operazione mentre un'altra è in esecuzione", () => {
  let { items } = Q.addItems([], [L(1), L(2)], { types: ["like"] }, "c1");
  items[0].ops[0].status = "running";
  assert.equal(Q.nextOp(items), null);
});

test("modifica: le operazioni completate non cambiano", () => {
  let { items } = Q.addItems([], [L(1)], { types: ["like", "offer"] }, "c1");
  const it = items[0];
  it.ops[0].status = "completed";
  const r = Q.editItemOps(it, { [it.ops[0].id]: { remove: true }, [it.ops[1].id]: { amount: 9.5 } });
  assert.equal(r.item.ops[0].status, "completed");
  assert.match(r.rejected, /non si può modificare/);
  assert.equal(r.item.ops[1].amount, 9.5);
});

test("rimozione: rifiutata se in esecuzione, altrimenti operazioni annullate", () => {
  let { items } = Q.addItems([], [L(1), L(2)], { types: ["like"] }, "c1");
  items[0].ops[0].status = "running";
  const r = Q.removeItems(items, items.map((i) => i.id));
  assert.equal(r.rejected.length, 1);
  assert.equal(r.items[1].removed, true);
  assert.equal(r.items[1].ops[0].status, "cancelled");
});

test("riordino: rifiutato se l'insieme è cambiato; move su/giù/cima/fondo", () => {
  let { items } = Q.addItems([], [L(1), L(2), L(3)], { types: ["like"] }, "c1");
  assert.ok(Q.reorder(items, [items[0].id]).rejected);
  const ids = items.map((i) => i.id).reverse();
  items = Q.reorder(items, ids).items;
  assert.equal(Q.executionOrder(items)[0].listingId, "1003");
  items = Q.move(items, items.find((i) => i.listingId === "1001").id, "top").items;
  assert.equal(Q.executionOrder(items)[0].listingId, "1001");
  items = Q.move(items, items.find((i) => i.listingId === "1001").id, "bottom").items;
  assert.equal(Q.executionOrder(items).at(-1).listingId, "1001");
});

test("retry: solo i falliti con esito certo, mai i da verificare", () => {
  let { items } = Q.addItems([], [L(1), L(2), L(3)], { types: ["like"] }, "c1");
  items[0].ops[0].status = "failed";
  items[1].ops[0].status = "verify";
  items[2].ops[0].status = "failed";
  items[2].ops[0].retryable = false;
  const r = Q.retryFailed(items);
  assert.equal(r.count, 1);
  assert.equal(r.items[0].ops[0].status, "waiting");
  assert.equal(r.items[1].ops[0].status, "verify");
  assert.equal(r.items[2].ops[0].status, "failed");
});

test("progresso e stati riassuntivi", () => {
  let { items } = Q.addItems([], [L(1), L(2)], { types: ["like", "offer"] }, "c1");
  items[0].ops[0].status = "completed";
  items[0].ops[1].status = "verify";
  const p = Q.progress(items);
  assert.equal(p.ops, 4);
  assert.equal(p.completed, 1);
  assert.equal(p.verify, 1);
  assert.equal(p.pending, 2);
  assert.equal(p.percent, 50);
  assert.equal(itemStatus(items[0]), "verify");
});

test("macchine a stati: transizioni non valide rifiutate", () => {
  const op = { status: "completed" };
  assert.throws(() => transitionOp(op, "waiting"), TransitionError);
  assert.equal(transitionOp({ status: "waiting" }, "running").status, "running");
  assert.throws(() => transitionOp({ status: "verify" }, "waiting"), TransitionError, "un da verificare non torna in coda da solo");
  assert.throws(() => transitionCampaign({ status: "completed" }, "running"), TransitionError);
  assert.equal(transitionCampaign({ status: "paused" }, "running").status, "running");
});
