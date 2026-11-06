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

test("installazione pulita: da 0 a 3 in un colpo", async () => {
  const idb = new IDBFactory();
  let steps;
  const db = await open(idb, 3, (d, t, old) => { steps = runDbUpgrade(d, t, old, 3); });
  assert.equal(steps.length, 3);
  assert.equal(db.version, 3);
  db.close();
});

test("rollback: un passo che fallisce lascia il database alla versione precedente", async () => {
  const idb = new IDBFactory();
  let db = await open(idb, 1, (d, t, old) => runDbUpgrade(d, t, old, 1));
  await put(db, "listings", { id: "keep", sellerId: "1" });
  db.close();
  await assert.rejects(open(idb, 4, (d, t, old) => runDbUpgrade(d, t, old, 4)), /db_v4 mancante/);
  db = await open(idb, 1, () => {});
  assert.equal(db.version, 1);
  assert.equal((await getAll(db, "listings"))[0].id, "keep");
  db.close();
});
