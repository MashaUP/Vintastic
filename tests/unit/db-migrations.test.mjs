import test from "node:test";
import assert from "node:assert/strict";
import { IDBFactory } from "fake-indexeddb";
import "fake-indexeddb/auto";
import { runDbUpgrade } from "../../src/shared/migrations.js";

function open(idb, version, upgrade) {
  return new Promise((resolve, reject) => {
    const r = idb.open("t", version);
    r.onupgradeneeded = (e) => { try { upgrade(r.result, r.transaction, e.oldVersion); } catch (err) { r.transaction.abort(); reject(err); } };
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}
const put = (db, store, v) => new Promise((res, rej) => { const t = db.transaction(store, "readwrite"); t.objectStore(store).put(v); t.oncomplete = res; t.onerror = rej; });
const getAll = (db, store) => new Promise((res) => { const r = db.transaction(store).objectStore(store).getAll(); r.onsuccess = () => res(r.result); });

test("db_v1 → db_v2 → db_v3 conserva i dati e aggiunge store/indici", async () => {
  const idb = new IDBFactory();
  let db = await open(idb, 1, (d, t, old) => runDbUpgrade(d, t, old, 1));
  await put(db, "ledger", { key: "a|1|like", listingId: "1", accountId: "a", status: "completed" });
  await put(db, "listings", { id: "1", sellerId: "9", title: "x" });
  db.close();
  db = await open(idb, 2, (d, t, old) => runDbUpgrade(d, t, old, 2));
  assert.ok(db.objectStoreNames.contains("journal"));
  db.close();
  let steps;
  db = await open(idb, 3, (d, t, old) => { steps = runDbUpgrade(d, t, old, 3); });
  assert.deepEqual(steps, ["db_v2 → db_v3"]);
  for (const s of ["activity", "accounts", "suggestions", "scans"]) assert.ok(db.objectStoreNames.contains(s), s);
  const ledger = await getAll(db, "ledger");
  assert.equal(ledger.length, 1);
  assert.equal(ledger[0].simulated, false, "migrazione dei dati del v2");
  assert.equal((await getAll(db, "listings"))[0].title, "x");
  db.close();
});

test("installazione pulita: da 0 a 5 in un colpo", async () => {
  const idb = new IDBFactory();
  let steps;
  const db = await open(idb, 5, (d, t, old) => { steps = runDbUpgrade(d, t, old, 5); });
  assert.equal(steps.length, 5);
  assert.equal(db.version, 5);
  db.close();
});

test("db_v3 → db_v4: via i commenti senza corrompere campagne e code, ciclo 1, Posizione In cima", async () => {
  const idb = new IDBFactory();
  let db = await open(idb, 3, (d, t, old) => runDbUpgrade(d, t, old, 3));
  await put(db, "campaigns", { id: "c1", name: "Vecchia", opsDefaults: { types: ["like", "comment", "offer"], order: ["like", "comment", "offer", "message"], comment: "ciao" }, order: ["like", "comment"] });
  await put(db, "campaigns", { id: "c2", name: "Con posizione", addPosition: "end", opsDefaults: { types: ["comment"] } });
  await put(db, "items", { id: "i1", campaignId: "c1", listingId: "1", ops: [{ id: "a", type: "like", status: "completed" }, { id: "b", type: "comment", status: "skipped" }, { id: "c", type: "offer", status: "waiting" }] });
  await put(db, "items", { id: "i2", campaignId: "c1", listingId: "2", ops: [{ id: "d", type: "comment", status: "waiting" }] });
  await put(db, "ledger", { key: "a|1|comment", listingId: "1", accountId: "a", type: "comment", status: "completed" });
  await put(db, "ledger", { key: "a|1|like", listingId: "1", accountId: "a", type: "like", status: "completed" });
  db.close();
  let steps;
  db = await open(idb, 4, (d, t, old) => { steps = runDbUpgrade(d, t, old, 4); });
  assert.deepEqual(steps, ["db_v3 → db_v4"]);
  const items = Object.fromEntries((await getAll(db, "items")).map((i) => [i.id, i]));
  assert.deepEqual(items.i1.ops.map((o) => [o.type, o.status, o.cycle]), [["like", "completed", 1], ["offer", "waiting", 1]]);
  assert.match(items.i1.history.at(-1).detail, /1 commenti tolti/);
  assert.equal(items.i2.removed, true, "elemento con solo commenti: tolto, non cancellato");
  assert.equal(items.i2.ops.length, 0);
  const camps = Object.fromEntries((await getAll(db, "campaigns")).map((c) => [c.id, c]));
  assert.deepEqual(camps.c1.opsDefaults.types, ["like", "offer"]);
  assert.deepEqual(camps.c1.opsDefaults.order, ["like", "offer", "message"]);
  assert.equal(camps.c1.opsDefaults.comment, undefined);
  assert.deepEqual(camps.c1.order, ["like"]);
  assert.equal(camps.c1.addPosition, "start", "mai scelta: In cima");
  assert.equal(camps.c2.addPosition, "end", "scelta salvata: non sovrascritta");
  assert.deepEqual(camps.c2.opsDefaults.types, ["like"], "nessun tipo rimasto: like come ripiego");
  assert.equal(camps.c1.cycle.n, 1);
  const ledger = await getAll(db, "ledger");
  assert.deepEqual(ledger.map((e) => e.type), ["like"]);
  db.close();
});

test("db_v4 → db_v5: timer delle campagne aperte ai nuovi predefiniti, valori scelti a mano invariati", async () => {
  const idb = new IDBFactory();
  let db = await open(idb, 4, (d, t, old) => runDbUpgrade(d, t, old, 4));
  const oldT = { betweenOps: { min: 8, max: 20 }, betweenItems: { min: 45, max: 120 }, transitions: { "like>offer": { min: 10, max: 25 } } };
  await put(db, "campaigns", { id: "open", status: "running", timers: oldT });
  await put(db, "campaigns", { id: "mine", status: "ready", timers: { betweenOps: { min: 1, max: 2 }, betweenItems: { min: 45, max: 120 }, transitions: { "like>offer": { min: 5, max: 6 } } } });
  await put(db, "campaigns", { id: "done", status: "completed", timers: oldT });
  await put(db, "campaigns", { id: "empty", status: "draft", timers: {} });
  db.close();
  let steps;
  db = await open(idb, 5, (d, t, old) => { steps = runDbUpgrade(d, t, old, 5); });
  assert.deepEqual(steps, ["db_v4 → db_v5"]);
  const by = Object.fromEntries((await getAll(db, "campaigns")).map((c) => [c.id, c]));
  assert.deepEqual(by.open.timers, { betweenOps: { min: 3, max: 8 }, betweenItems: { min: 10, max: 25 }, transitions: { "like>offer": { min: 3, max: 8 } } });
  assert.deepEqual(by.mine.timers.betweenOps, { min: 1, max: 2 }, "scelta dell'utente");
  assert.deepEqual(by.mine.timers.transitions["like>offer"], { min: 5, max: 6 }, "scelta dell'utente");
  assert.deepEqual(by.mine.timers.betweenItems, { min: 10, max: 25 }, "rimasto al vecchio predefinito");
  assert.deepEqual(by.done.timers, oldT, "campagna conclusa: storico invariato");
  assert.deepEqual(by.empty.timers, {});
  db.close();
});

test("rollback: un passo che fallisce lascia il database alla versione precedente", async () => {
  const idb = new IDBFactory();
  let db = await open(idb, 1, (d, t, old) => runDbUpgrade(d, t, old, 1));
  await put(db, "listings", { id: "keep", sellerId: "1" });
  db.close();
  // db_v5 esiste dalla 2.1.0: il passo mancante ora è db_v6.
  await assert.rejects(open(idb, 6, (d, t, old) => runDbUpgrade(d, t, old, 6)), /db_v6 mancante/);
  db = await open(idb, 1, () => {});
  assert.equal(db.version, 1);
  assert.equal((await getAll(db, "listings"))[0].id, "keep");
  db.close();
});
