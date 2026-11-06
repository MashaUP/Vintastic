import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { assertRequestAllowed, isForbiddenElement, PurchaseGuardError } from "../../src/shared/guard.js";

const ROOT = path.resolve(import.meta.dirname, "../..");

test("DIVIETO DI ACQUISTO: ogni percorso d'acquisto è bloccato", () => {
  const forbidden = [
    ["POST", "/transactions/123/checkout"], ["GET", "/transactions/123"], ["PUT", "/transactions/123/purchase"],
    ["POST", "/checkout"], ["POST", "/purchases"], ["POST", "/payments"], ["POST", "/orders"], ["POST", "/buy"],
    ["POST", "/items/5/buy"], ["POST", "/shipping_orders"], ["POST", "/wallet/pay"], ["POST", "/bundles/1/checkout"],
    ["POST", "/transactions/1/instant_buy"], ["POST", "/cart"],
  ];
  for (const [m, p] of forbidden) assert.throws(() => assertRequestAllowed(m, p), PurchaseGuardError, `${m} ${p}`);
});

test("solo le richieste in lista passano", () => {
  assert.equal(assertRequestAllowed("GET", "/wardrobe/1/items?page=1&per_page=96&order=newest_first"), "lettura armadio");
  assert.equal(assertRequestAllowed("POST", "/user_favourites/toggle"), "like (preferito)");
  assert.equal(assertRequestAllowed("POST", "/transactions/77/offer_requests"), "invio offerta");
  assert.equal(assertRequestAllowed("POST", "/conversations", { initiator: "buyer_enters_offer_form" }), "apertura modulo offerta");
  assert.throws(() => assertRequestAllowed("POST", "/conversations", { initiator: "buy" }), PurchaseGuardError);
  assert.throws(() => assertRequestAllowed("DELETE", "/items/5"), PurchaseGuardError, "niente eliminazioni");
  assert.throws(() => assertRequestAllowed("POST", "/conversations/5/replies"), PurchaseGuardError, "niente messaggi");
  assert.throws(() => assertRequestAllowed("DELETE", "/notifications/5"), PurchaseGuardError, "il pulitore non elimina");
});

test("clic su pulsanti d'acquisto bloccati (tutte le lingue principali)", () => {
  const el = (text, attrs = {}) => ({ textContent: text, getAttribute: (k) => attrs[k] ?? null });
  for (const t of ["Acquista", "Compra ora", "Buy now", "Acheter", "Kaufen", "Comprar", "Checkout", "Paga ora", "Aggiungi al carrello"]) assert.equal(isForbiddenElement(el(t)), true, t);
  assert.equal(isForbiddenElement(el("", { "data-testid": "item-buy-button" })), true);
  assert.equal(isForbiddenElement(el("Fai un'offerta")), false);
  assert.equal(isForbiddenElement(el("Aggiungi ai preferiti")), false);
});

function files(dir, out = []) {
  for (const f of fs.readdirSync(dir)) {
    const p = path.join(dir, f);
    if (fs.statSync(p).isDirectory()) files(p, out);
    else if (/\.(js|json|html)$/.test(f)) out.push(p);
  }
  return out;
}

test("analisi statica: nessun percorso d'acquisto nel codice dell'estensione", () => {
  const src = files(path.join(ROOT, "src")).filter((f) => !f.endsWith("guard-core.js"));
  const bad = [];
  for (const f of src) {
    const s = fs.readFileSync(f, "utf8");
    // fetch/request verso checkout, pagamenti, ordini, acquisti
    for (const m of s.matchAll(/(?:fetch|request)\s*\(\s*["'`][^"'`]*(checkout|purchase|payment|\/orders?\b|\/buy\b|instant_buy|wallet)[^"'`]*["'`]/gi)) bad.push(`${path.relative(ROOT, f)}: ${m[0]}`);
    // clic diretti su elementi della pagina Vinted dal content script (solo safeClick è ammesso)
    if (f.includes(`${path.sep}content${path.sep}`)) for (const m of s.matchAll(/\.click\(\)/g)) bad.push(`${path.relative(ROOT, f)}: .click() diretto`);
  }
  assert.deepEqual(bad, []);
});

test("tutte le richieste del content script passano dal guard", () => {
  const api = fs.readFileSync(path.join(ROOT, "src/content/vinted-api.js"), "utf8");
  assert.match(api, /VTGuard\.assertRequestAllowed\(method, path, body\)/);
  const adapter = fs.readFileSync(path.join(ROOT, "src/content/adapter.js"), "utf8");
  assert.doesNotMatch(adapter, /\bfetch\(/, "l'adapter non chiama fetch direttamente");
});

test("manifest: nessun permesso legato a pagamenti", () => {
  const m = JSON.parse(fs.readFileSync(path.join(ROOT, "manifest.json"), "utf8"));
  const all = JSON.stringify(m);
  assert.doesNotMatch(all, /payments|paymentHandler|identity/);
  assert.equal(m.content_scripts[0].js[0], "src/shared/guard-core.js", "il guard si carica per primo");
});
