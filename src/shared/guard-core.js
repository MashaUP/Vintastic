/**
 * Vintastic — DIVIETO ASSOLUTO DI ACQUISTO e lista delle chiamate consentite.
 *
 * Script classico (niente import/export): lo caricano il content script (manifest),
 * il service worker e i test (tramite guard.js). Espone globalThis.VTGuard.
 *
 * Regola: Vintastic parla con Vinted SOLO con le richieste elencate in ALLOWED.
 * Tutto il resto viene rifiutato prima di partire. Nessuna voce porta a carrello,
 * checkout, pagamento, spedizione o conferma d'ordine. Un'offerta è una proposta
 * di trattativa: se il venditore accetta, l'acquisto resta una scelta che fai tu,
 * a mano, su Vinted.
 */
(function (root) {
  "use strict";

  /** Percorsi e parole che indicano un acquisto: vietati ovunque. */
  const FORBIDDEN_PATH = [
    /checkout/i, /purchase/i, /payment/i, /\/pay(\b|_|\/)/i, /\/buy(\b|_|\/)/i, /\/orders?(\b|\/)/i,
    /shipping/i, /wallet/i, /\/cart(\b|\/)/i, /basket/i, /bundle\/.*\/(buy|checkout)/i,
    /\/transactions\/\d+\/(?!offer_requests\b)/i, /\/transactions\/\d+$/i, /instant_buy/i,
  ];

  /** Testi di pulsanti che non vanno MAI premuti (tutte le lingue di Vinted principali). */
  const FORBIDDEN_TEXT = [
    /acquista/i, /compra/i, /\bbuy\b/i, /checkout/i, /\bpaga\b/i, /\bpay\b/i, /acheter/i, /\bpayer\b/i,
    /kaufen/i, /bezahlen/i, /comprar/i, /\bpagar\b/i, /kopen/i, /betalen/i, /kup(uj|ić)/i, /zaplać/i,
    /koupit/i, /zaplatit/i, /cumpără/i, /vásárl/i, /pirkti/i, /carrello/i, /panier/i, /warenkorb/i,
  ];

  /**
   * Richieste consentite verso le API interne di Vinted (percorso dopo /api/v2).
   * method + regex + scopo. Nient'altro passa.
   */
  const ALLOWED = [
    { method: "GET", path: /^\/wardrobe\/\d+\/items\?[\w=&%.-]*$/, purpose: "lettura armadio" },
    { method: "GET", path: /^\/users\/\d+(\?[\w=&%.-]*)?$/, purpose: "profilo pubblico" },
    { method: "GET", path: /^\/users\/\d+\/followed_users\?[\w=&%.-]*$/, purpose: "elenco account seguiti" },
    { method: "GET", path: /^\/items\/\d+(\/details)?$/, purpose: "lettura annuncio" },
    { method: "GET", path: /^\/notifications\?[\w=&%.-]*$/, purpose: "elenco notifiche" },
    { method: "PUT", path: /^\/notifications\/\d+$/, purpose: "segna notifica come letta" },
    { method: "POST", path: /^\/user_favourites\/toggle$/, purpose: "like (preferito)" },
    { method: "POST", path: /^\/conversations$/, purpose: "apertura modulo offerta", body: (b) => b && b.initiator === "buyer_enters_offer_form" },
    { method: "POST", path: /^\/transactions\/\d+\/offer_requests$/, purpose: "invio offerta" },
  ];

  class PurchaseGuardError extends Error {
    constructor(message) {
      super(message);
      this.name = "PurchaseGuardError";
      this.guard = true;
    }
  }

  function isForbiddenPath(path) {
    return FORBIDDEN_PATH.some((re) => re.test(String(path)));
  }

  /** Lancia un errore se la richiesta non è nella lista o tocca un acquisto. */
  function assertRequestAllowed(method, path, body) {
    const m = String(method || "GET").toUpperCase();
    const p = String(path || "");
    if (isForbiddenPath(p) && !/\/transactions\/\d+\/offer_requests$/.test(p)) {
      throw new PurchaseGuardError(`Richiesta bloccata (divieto di acquisto): ${m} ${p}`);
    }
    const rule = ALLOWED.find((r) => r.method === m && r.path.test(p));
    if (!rule) throw new PurchaseGuardError(`Richiesta non consentita da Vintastic: ${m} ${p}`);
    if (rule.body && !rule.body(body)) throw new PurchaseGuardError(`Contenuto non consentito per ${m} ${p}`);
    return rule.purpose;
  }

  /** Un elemento della pagina che sembra un pulsante d'acquisto: mai cliccabile da Vintastic. */
  function isForbiddenElement(el) {
    if (!el) return false;
    const text = [el.textContent, el.getAttribute && el.getAttribute("aria-label"),
      el.getAttribute && el.getAttribute("data-testid"), el.getAttribute && el.getAttribute("href")]
      .filter(Boolean).join(" ");
    return FORBIDDEN_TEXT.some((re) => re.test(text)) || FORBIDDEN_PATH.some((re) => re.test(text));
  }

  /** Clic protetto: l'unico modo in cui Vintastic preme qualcosa su Vinted. */
  function safeClick(el) {
    if (isForbiddenElement(el)) throw new PurchaseGuardError("Clic bloccato: l'elemento riguarda un acquisto.");
    el.click();
  }

  root.VTGuard = Object.freeze({
    FORBIDDEN_PATH, FORBIDDEN_TEXT, ALLOWED, PurchaseGuardError,
    isForbiddenPath, assertRequestAllowed, isForbiddenElement, safeClick,
  });
})(typeof globalThis !== "undefined" ? globalThis : self);
