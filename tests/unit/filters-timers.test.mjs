import test from "node:test";
import assert from "node:assert/strict";
import { applyFilters, sortItems } from "../../src/shared/filters.js";
import { delayBefore, checkLimit, countOp, freshCounters } from "../../src/shared/timers.js";
import { DEFAULT_SETTINGS } from "../../src/shared/constants.js";

const now = Date.UTC(2026, 10, 6, 12);
const day = 86400e3;
const listings = Array.from({ length: 40 }, (_, i) => ({ id: String(i), title: `Item ${i}`, price: i + 1, publishedAt: i % 10 === 9 ? null : now - i * day / 2, updatedAt: now - i * 1000, status: i % 7 === 0 ? "sold" : "active" }));

test("Top N + periodo combinati: i 20 più recenti degli ultimi 7 giorni", () => {
  const r = applyFilters(listings, { range: "7d", topN: 20 }, now);
  assert.ok(r.items.length <= 20);
  assert.ok(r.items.every((l) => l.publishedAt >= now - 7 * day));
  for (let i = 1; i < r.items.length; i++) assert.ok(r.items[i - 1].publishedAt >= r.items[i].publishedAt);
  assert.ok(r.noDate > 0, "gli annunci senza data sono contati, non inventati");
});

test("periodi predefiniti e intervallo personalizzato", () => {
  assert.ok(applyFilters(listings, { range: "24h" }, now).items.every((l) => l.publishedAt >= now - day));
  const r = applyFilters(listings, { range: "custom", from: now - 3 * day, to: now - 2 * day }, now);
  assert.ok(r.items.every((l) => l.publishedAt >= now - 3 * day && l.publishedAt <= now - 2 * day));
});

test("date distinte: il filtro usa il campo scelto", () => {
  const r = applyFilters(listings, { range: "24h", dateField: "updatedAt" }, now);
  assert.equal(r.items.length, 40);
  assert.equal(applyFilters(listings, { range: "24h", dateField: "repostedAt" }, now).items.length, 0);
});

test("ricerca, stato, prezzo, venditore", () => {
  assert.equal(applyFilters(listings, { search: "item 1" }).items.length, 11);
  assert.ok(applyFilters(listings, { status: "sold" }).items.every((l) => l.status === "sold"));
  assert.ok(applyFilters(listings, { priceMin: 10, priceMax: 12 }).items.every((l) => l.price >= 10 && l.price <= 12));
});

test("ordinamenti, casuale riproducibile", () => {
  const a = sortItems(listings, "random", 42, (x) => x).map((x) => x.id);
  const b = sortItems(listings, "random", 42, (x) => x).map((x) => x.id);
  assert.deepEqual(a, b);
  assert.notDeepEqual(a, listings.map((x) => x.id));
  const p = sortItems(listings, "priceDesc", 1, (x) => x);
  assert.equal(p[0].price, 40);
});

test("timer: transizione, per tipo, tra annunci, minimo assoluto", () => {
  const t = DEFAULT_SETTINGS.timers;
  const r1 = delayBefore({ type: "offer" }, { type: "like" }, true, {}, t, () => 0);
  assert.equal(r1.kind, "transition");
  assert.equal(r1.seconds, t.transitions["like>offer"].min);
  const r2 = delayBefore({ type: "like" }, { type: "offer" }, false, {}, t, () => 0.999);
  assert.equal(r2.kind, "betweenItems");
  assert.equal(r2.seconds, t.betweenItems.max);
  const r3 = delayBefore({ type: "like" }, { type: "like" }, false, { betweenItems: { min: 0, max: 0 } }, t, () => 0);
  assert.equal(r3.seconds, t.minFloor);
  assert.equal(delayBefore({ type: "like" }, null, false, {}, t).seconds, 0);
});

test("soglie giornaliere: per tipo, per account, globale; azzeramento a nuovo giorno", () => {
  const limits = { perDay: { like: 2 }, perAccountDay: 3, globalDay: 4 };
  let c = null;
  const t0 = new Date(2026, 10, 6, 10).getTime();
  c = countOp(c, "a", "like", t0); c = countOp(c, "a", "like", t0);
  assert.equal(checkLimit(c, "a", "like", limits, t0).allowed, false);
  assert.equal(checkLimit(c, "a", "offer", limits, t0).allowed, true);
  c = countOp(c, "a", "offer", t0);
  assert.equal(checkLimit(c, "a", "offer", limits, t0).scope, "account");
  c = countOp(c, "b", "offer", t0);
  assert.equal(checkLimit(c, "b", "offer", limits, t0).scope, "global");
  const tomorrow = new Date(2026, 10, 7, 0, 1).getTime();
  assert.equal(checkLimit(c, "a", "like", limits, tomorrow).allowed, true);
  assert.equal(freshCounters(c, tomorrow).global, 0);
  assert.ok(checkLimit(c, "a", "like", limits, t0).resetAt > t0);
});

test("data automatica: pubblicazione, poi foto (stima), poi ordine di Vinted", () => {
  const L2 = [
    { id: "a", publishedAt: null, photoAt: now - 3 * day, scanRank: 2 },
    { id: "b", publishedAt: now - 1 * day, photoAt: now - 9 * day, scanRank: 5 },
    { id: "c", publishedAt: null, photoAt: null, scanRank: 0 },
    { id: "d", publishedAt: null, photoAt: null, scanRank: 1 },
    { id: "e", publishedAt: null, photoAt: null },
  ];
  const r = applyFilters(L2, { topN: 4 }, now);
  assert.deepEqual(r.items.map((x) => x.id), ["b", "a", "c", "d"], "date prima, poi ordine di Vinted; senza niente escluso");
  assert.equal(r.noDate, 1);
  assert.deepEqual(applyFilters(L2, { range: "7d" }, now).items.map((x) => x.id).sort(), ["a", "b"]);
  assert.deepEqual(applyFilters(L2, { range: "7d", dateField: "publishedAt" }, now).items.map((x) => x.id), ["b"], "campo esplicito: niente ripieghi");
  assert.deepEqual(sortItems(L2.slice(0, 4), "oldest", 1, (x) => x).map((x) => x.id), ["d", "c", "a", "b"]);
});
