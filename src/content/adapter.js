/**
 * Adapter Vinted: stato della pagina, scansione, like, offerta, messaggi privati, sessione,
 * notifiche. Ogni funzione restituisce un esito classificato:
 *   done | already | failed | blocked | captcha | auth | notFound | unavailable |
 *   priceChanged | changed | unsupported | uncertain
 * e "sent": true quando una scrittura potrebbe essere arrivata a Vinted.
 *
 * Endpoint usati (tutti nella lista di guard-core.js):
 *   GET  /wardrobe/:id/items     lettura armadio (stesso endpoint di Vinted_Relist)
 *   GET  /users/:id              profilo (sessione)
 *   GET  /users/:id/followed_users  account seguiti (menu Venditore)
 *   GET  /items/:id              lettura annuncio (se Vinted la consente)
 *   POST /user_favourites/toggle like
 *   POST /conversations + POST /transactions/:id/offer_requests   offerta
 *   GET  /notifications, PUT /notifications/:id                   notifiche
 * Il messaggio privato interagisce con la UI visibile e verifica il bubble prima
 * di dichiarare il successo. Nessun endpoint di messaggistica non documentato.
 */
(() => {
  "use strict";
  const VT = (window.VT = window.VT || {});
  const api = () => VT.api;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // ---------------------------------------------------------------- pagina

  const CHALLENGE_SELECTORS = [
    'iframe[src*="captcha-delivery.com"]', 'iframe[src*="hcaptcha.com"]', 'iframe[src*="recaptcha"]',
    "#challenge-form", '[data-testid*="captcha" i]', 'iframe[title*="captcha" i]',
  ];

  function challengePresent() {
    if (CHALLENGE_SELECTORS.some((s) => document.querySelector(s))) return true;
    return /^(\s*)(verifica|verification|vérification|überprüfung)/i.test(document.title || "") && document.body?.innerText?.length < 3000;
  }

  /** Accesso visibile sulla pagina? true / false / null (non si capisce). */
  function loggedInFromDom() {
    const loginBtn = document.querySelector('[data-testid="header--login-button"], a[href*="/member/signup"], a[href*="/member/login"], [data-testid*="login-button" i]');
    const userMenu = document.querySelector('[data-testid="header-user-menu"], [data-testid*="user-menu" i], [data-testid="header-avatar"], a[href*="/member/notifications"], a[href*="/inbox"]');
    if (userMenu) return true;
    if (loginBtn) return false;
    return null;
  }

  VT.pageState = () => ({
    origin: location.origin,
    path: location.pathname,
    url: location.href.split("?")[0],
    challenge: challengePresent(),
    loggedIn: loggedInFromDom(),
    authPage: /\/member\/(signup|login)|verification|two_factor|2fa|\/session/i.test(location.pathname),
    kind: /^\/items\/\d+/.test(location.pathname) ? "item" : /^\/member\/\d+/.test(location.pathname) ? "wardrobe" : "other",
  });

  const asOutcome = (r, fallback = "failed") => {
    if (r.kind === "captcha") return { outcome: "captcha", sent: false, message: "Vinted chiede una verifica (CAPTCHA)" };
    if (r.kind === "blocked") return { outcome: "blocked", sent: false, message: `Vinted ha rifiutato la richiesta (403): ${r.message}` };
    if (r.kind === "rate") return { outcome: "blocked", sent: false, message: "Vinted sta limitando le richieste (429)" };
    if (r.kind === "auth") return { outcome: "auth", sent: false, message: "Sessione Vinted non valida (401)" };
    if (r.kind === "notFound") return { outcome: "notFound", sent: false, message: "Annuncio non trovato (404)" };
    return { outcome: fallback, sent: false, message: r.message, status: r.status };
  };

  // ---------------------------------------------------------------- lettura annuncio

  /** Dati dell'annuncio: API se disponibile, altrimenti dati incorporati nella pagina. */
  async function readItem(id, { apiOnly = false } = {}) {
    const r = await api().request("GET", `/items/${id}`, { timeoutMs: 20_000 });
    if (r.ok && r.data?.item) {
      const it = r.data.item;
      return { source: "api", price: priceOf(it), isFavourite: typeof it.is_favourite === "boolean" ? it.is_favourite : null, status: statusOf(it), sellerId: it.user?.id ?? it.user_id ?? null };
    }
    if (r.kind && ["captcha", "blocked", "rate", "auth"].includes(r.kind)) return { error: r };
    if (r.kind === "notFound" && !onItemPage(id)) return { notFound: true };
    if (apiOnly) return { source: "none", isFavourite: null };
    return readItemFromPage(id);
  }

  const onItemPage = (id) => new RegExp(`^/items/${id}(?:$|[-/])`).test(location.pathname);

  function priceOf(it) {
    const p = it.price?.amount ?? it.price_numeric ?? it.price;
    const n = Number(String(p ?? "").replace(",", "."));
    return Number.isFinite(n) && n > 0 ? n : null;
  }
  function statusOf(it) {
    if (it.is_closed || it.item_closing_action === "sold") return "sold";
    if (it.is_reserved) return "reserved";
    if (it.is_hidden) return "hidden";
    return "active";
  }

  /** Cerca i dati dell'annuncio nel JSON incorporato della pagina (Next.js). */
  function readItemFromPage(id) {
    if (!onItemPage(id)) return { source: "none" };
    const html = [...document.querySelectorAll("script")].map((s) => s.textContent || "").join("\n");
    const out = { source: "page", price: null, isFavourite: null, status: "active" };
    const around = (() => {
      const i = html.search(new RegExp(`"id"\\s*:\\s*${id}\\b`));
      return i >= 0 ? html.slice(Math.max(0, i - 4000), i + 8000).replace(/\\"/g, '"') : "";
    })();
    const fav = around.match(/"is_favourite"\s*:\s*(true|false)/);
    if (fav) out.isFavourite = fav[1] === "true";
    const price = around.match(/"price"\s*:\s*\{\s*"amount"\s*:\s*"?([\d.,]+)"?/) || around.match(/"price_numeric"\s*:\s*"?([\d.,]+)/);
    if (price) out.price = Number(price[1].replace(",", "."));
    const seller = around.match(/"user_id"\s*:\s*(\d+)/) || around.match(/"user"\s*:\s*\{\s*"id"\s*:\s*(\d+)/);
    if (seller) out.sellerId = seller[1];
    if (/"is_closed"\s*:\s*true/.test(around)) out.status = "sold";
    else if (/"is_reserved"\s*:\s*true/.test(around)) out.status = "reserved";
    // Pulsante dei preferiti: stato da aria-pressed / aria-label (lettura, nessun clic).
    if (out.isFavourite == null) {
      const btn = document.querySelector('[data-testid*="favourite" i][aria-pressed], button[aria-label*="preferit" i], button[aria-label*="favourite" i], button[aria-label*="favori" i]');
      const pressed = btn?.getAttribute("aria-pressed");
      if (pressed === "true" || pressed === "false") out.isFavourite = pressed === "true";
      else if (btn && /rimuovi|remove|retirer|entfernen/i.test(btn.getAttribute("aria-label") || "")) out.isFavourite = true;
      else if (btn && /aggiungi|add|ajouter|hinzuf/i.test(btn.getAttribute("aria-label") || "")) out.isFavourite = false;
    }
    return out;
  }

  VT.readItemSync = readItemFromPage;

  // ---------------------------------------------------------------- like

  VT.like = async ({ listing, op }) => {
    const id = String(listing.id);
    const before = await readItem(id);
    if (before.error) return asOutcome(before.error);
    if (before.notFound) return { outcome: "notFound", sent: false, message: "Annuncio non più disponibile" };
    if (before.status && before.status !== "active") return { outcome: "unavailable", sent: false, message: `Annuncio ${before.status}`, listing: { status: before.status } };
    let relaid = false;
    if (before.isFavourite === true) {
      if (!op?.relike) {
        return { outcome: "already", sent: false, message: "Like già presente su Vinted", capability: { name: "favourite", value: true, detail: `stato letto da ${before.source}` } };
      }
      // Like già presente e campagna con «toglilo e rimettilo»: prima si toglie e si controlla che sia tolto.
      // Ogni tentativo riparte da una pagina ricaricata e rilegge lo stato: ripetere non inverte mai un like a caso.
      const off = await api().request("POST", "/user_favourites/toggle", { body: { type: "item", user_favourites: [Number(id)] }, referrer: location.href });
      if (!off.ok) {
        if (off.kind === "network" || off.kind === "server") return { outcome: "failed", sent: false, retryable: true, message: `Like da rimettere: non tolto (${off.message}). Al prossimo tentativo lo stato si rilegge.` };
        return asOutcome(off);
      }
      await sleep(1200);
      const mid = await readItem(id, { apiOnly: true });
      if (mid.isFavourite === true) return { outcome: "failed", sent: false, retryable: true, message: "Like da rimettere: Vinted non l'ha tolto. Si riprova." };
      if (mid.isFavourite !== false) return { outcome: "failed", sent: false, retryable: true, message: "Like tolto ma stato non rileggibile: non rimesso per non sbagliare. Al prossimo tentativo si rilegge e si rimette." };
      await sleep(1500);
      relaid = true;
    } else if (before.isFavourite !== false) {
      // Il toggle di Vinted inverte lo stato: senza conoscerlo rischieremmo di TOGLIERE un like.
      return { outcome: "failed", sent: false, retryable: true, message: "Stato del preferito non leggibile: like non inviato per non rischiare di toglierlo", capability: { name: "favourite", value: null, detail: "stato iniziale non leggibile" } };
    }
    const r = await api().request("POST", "/user_favourites/toggle", { body: { type: "item", user_favourites: [Number(id)] }, referrer: location.href });
    if (!r.ok) {
      if (r.kind === "network" || r.kind === "server") return { outcome: "uncertain", sent: true, network: r.kind === "network", message: r.message };
      return asOutcome(r);
    }
    // Verifica dopo l'invio, se lo stato si può rileggere.
    await sleep(800);
    // Solo l'API dice lo stato attuale: i dati incorporati nella pagina sono quelli del
    // caricamento (prima del like) e direbbero sempre «non piace».
    const after = await readItem(id, { apiOnly: true });
    if (after.isFavourite === true) return { outcome: "done", sent: true, message: relaid ? "Like tolto e rimesso: confermato" : "Like confermato", relaid, capability: { name: "favourite", value: true, detail: "toggle + rilettura" } };
    if (after.isFavourite === false && after.source === "api") return { outcome: "uncertain", sent: true, message: "Vinted ha risposto OK ma il like non risulta: da verificare" };
    return { outcome: "done", sent: true, message: "Vinted ha confermato la richiesta (stato non rileggibile)", capability: { name: "favourite", value: true, detail: "toggle OK, rilettura non disponibile" } };
  };

  VT.verifyLike = async ({ listing }) => {
    const r = await readItem(String(listing.id));
    return { liked: r.isFavourite, source: r.source, message: r.isFavourite == null ? "stato non leggibile" : null };
  };

  // ---------------------------------------------------------------- offerta

  VT.offer = async ({ listing, op, snapshotPrice }) => {
    const id = String(listing.id);
    const amount = Number(op.amount);
    if (!(amount > 0)) return { outcome: "failed", sent: false, retryable: false, message: "Importo non valido" };
    const cur = await readItem(id);
    if (cur.error) return asOutcome(cur.error);
    if (cur.notFound) return { outcome: "notFound", sent: false, message: "Annuncio non più disponibile" };
    if (cur.status && cur.status !== "active") return { outcome: "unavailable", sent: false, message: `Annuncio ${cur.status}`, listing: { status: cur.status } };
    if (cur.price != null && snapshotPrice != null && Math.abs(cur.price - Number(snapshotPrice)) > 0.009) {
      return { outcome: "priceChanged", sent: false, message: "Prezzo cambiato rispetto all'anteprima approvata", listing: { price: cur.price } };
    }
    const sellerId = listing.sellerId || cur.sellerId;
    if (!sellerId) return { outcome: "failed", sent: false, retryable: true, message: "Venditore dell'annuncio sconosciuto: scansiona di nuovo l'armadio" };

    // 1) Apertura del modulo offerta: crea (o riapre) la conversazione con il venditore. Nessun messaggio, nessun acquisto.
    const conv = await api().request("POST", "/conversations", { body: { initiator: "buyer_enters_offer_form", item_id: id, opposite_user_id: String(sellerId) }, referrer: location.href });
    if (!conv.ok) {
      if (conv.kind === "network" || conv.kind === "server") return { outcome: "failed", sent: false, retryable: true, message: `Modulo offerta non aperto: ${conv.message}` };
      if (conv.status === 400 || conv.status === 422) return { outcome: "failed", sent: false, retryable: false, message: `Vinted non consente l'offerta: ${conv.message}` };
      return asOutcome(conv);
    }
    const c = conv.data?.conversation || conv.data;
    const tid = c?.transaction?.id ?? c?.transaction_id ?? conv.data?.transaction?.id;
    if (!tid) return { outcome: "changed", sent: false, message: "Risposta di Vinted senza transazione per l'offerta: formato cambiato", capability: { name: "offer", value: false, detail: "conversations senza transaction.id" } };

    // 2) Invio della proposta di prezzo. Solo offer_requests: mai checkout o pagamento.
    const body = { offer_request: { price: amount.toFixed(2), currency: listing.currency || "EUR" } };
    const r = await api().request("POST", `/transactions/${tid}/offer_requests`, { body, referrer: location.href });
    if (r.ok) return { outcome: "done", sent: true, message: `Offerta di ${amount.toFixed(2)} € inviata`, capability: { name: "offer", value: true, detail: "conversations + offer_requests" } };
    if (r.kind === "network" || r.kind === "server") return { outcome: "uncertain", sent: true, network: r.kind === "network", message: r.message };
    if (r.status === 400 || r.status === 422) return { outcome: "failed", sent: false, retryable: false, message: `Vinted ha rifiutato l'importo: ${r.message}` };
    return asOutcome(r);
  };

  // ---------------------------------------------------------------- messaggio privato
  //
  // Solo controlli visibili della pagina, con i selettori presi dall'HTML reale di
  // Vinted (vinted.it): pulsante «Chiedi info», textarea#composerInput, pulsante con
  // [data-testid="arrow-right"]. Nessun endpoint di messaggistica.
  // Il motore guida le fasi (msgOpen → msgComposer → msgFill → msgStatus) così la
  // chat può aprirsi nella stessa pagina o in una pagina nuova.

  const ASK_INFO_LABEL = "Chiedi info";
  // Verificato su vinted.it il 07/11/2026: <button data-testid="ask-seller-button"> con l'etichetta «Chiedi info».
  const ASK_INFO_BUTTON = 'button[data-testid="ask-seller-button"]';
  const COMPOSER = 'textarea#composerInput, textarea[data-testid="composer--input"]';
  const SEND_ICON = '[data-testid="arrow-right"]';
  const MSG = { session: null };
  const normText = (s) => String(s ?? "").replace(/\s+/g, " ").trim();
  // Per riconoscere il messaggio si ignorano gli spazi: un a-capo può diventare <br> o un nuovo elemento.
  const squash = (s) => String(s ?? "").replace(/\s+/g, "");
  const isDisabled = (el) => !el || el.disabled || el.getAttribute("aria-disabled") === "true";

  const composer = () => document.querySelector(COMPOSER);

  function sendButton() {
    const ta = composer();
    const bar = ta?.closest(".web_ui__InputBar__input")?.parentElement;
    const icon = bar?.querySelector(`.web_ui__InputBar__suffix ${SEND_ICON}`) || document.querySelector(SEND_ICON);
    return icon?.closest("button") || null;
  }

  /**
   * Il pulsante interattivo di «Chiedi info» (non lo span dell'etichetta).
   * 1. data-testid="ask-seller-button" (funziona in tutte le lingue);
   * 2. altrimenti l'etichetta esatta «Chiedi info», risalendo al pulsante.
   * undefined = nessuno dei due sulla pagina.
   */
  function askInfoButton() {
    const byId = document.querySelector(ASK_INFO_BUTTON);
    if (byId) return byId;
    const label = [...document.querySelectorAll("span.web_ui__Button__label")].find((el) => normText(el.textContent) === ASK_INFO_LABEL);
    return label ? (label.closest('button, a, [role="button"]') || null) : undefined;
  }

  /**
   * Quante volte il testo compare nella pagina come messaggio (elementi "foglia",
   * fuori dalla barra di scrittura). Serve a riconoscere un messaggio NUOVO anche se
   * nella conversazione c'è già un messaggio identico.
   */
  function countMessages(text) {
    const t = squash(text);
    if (!t) return 0;
    let n = 0;
    for (const el of document.body?.querySelectorAll("*") || []) {
      if (el.closest(".web_ui__InputBar, textarea, input, script, style, noscript, template")) continue;
      if (!squash(el.textContent).includes(t)) continue;
      if ([...el.children].some((ch) => squash(ch.textContent).includes(t))) continue;
      n++;
    }
    return n;
  }

  function setComposerValue(ta, value) {
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
    if (setter) setter.call(ta, value); else ta.value = value;
    ta.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: value }));
    ta.dispatchEvent(new Event("change", { bubbles: true }));
  }

  function waitFor(fn, timeoutMs) {
    return new Promise((resolve) => {
      const end = Date.now() + timeoutMs;
      const loop = () => {
        let v = null;
        try { v = fn(); } catch { /* DOM in transizione */ }
        if (v || Date.now() > end) return resolve(v || null);
        setTimeout(loop, 150);
      };
      loop();
    });
  }

  // Un invio fatto dall'utente (modalità B) o da Vintastic (A): clic sul pulsante o Invio nel campo.
  function markAttempt() {
    const ses = MSG.session;
    if (!ses || ses.attempted) return;
    ses.attempted = true;
    ses.attemptAt = Date.now();
    ses.sentText = normText(composer()?.value) || ses.text;
    ses.baseline = countMessages(ses.sentText);
  }
  document.addEventListener("click", (e) => { if (e.target?.closest?.(SEND_ICON) || e.target?.closest?.("button") === sendButton()) markAttempt(); }, true);
  document.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey && e.target?.matches?.(COMPOSER)) markAttempt(); }, true);

  /** Fase 1: sulla pagina dell'annuncio, controlli e clic su «Chiedi info». Nessun messaggio inviato. */
  VT.msgOpen = async ({ listing, allowed = [], self = null }) => {
    const id = String(listing?.id || "");
    if (!/^\d+$/.test(id)) return { outcome: "failed", sent: false, retryable: false, message: "Id annuncio non valido" };
    if (!onItemPage(id)) return { outcome: "failed", sent: false, retryable: true, message: "La scheda di lavoro non è sull'annuncio previsto" };
    if (challengePresent()) return { outcome: "captcha", sent: false, message: "Vinted chiede una verifica prima di aprire la chat" };
    const page = readItemFromPage(id);
    if (page.sellerId && listing.sellerId && String(page.sellerId) !== String(listing.sellerId)) {
      return { outcome: "failed", sent: false, retryable: false, message: "Il venditore dell'annuncio non è quello dell'anteprima: messaggio non inviato" };
    }
    const seller = String(page.sellerId || listing.sellerId || "");
    if (!seller || !allowed.map(String).includes(seller)) return { outcome: "failed", sent: false, retryable: false, message: "Venditore non tra i destinatari autorizzati: messaggio non inviato" };
    if (self && seller === String(self)) return { outcome: "failed", sent: false, retryable: false, message: "È un tuo annuncio: non si può scrivere a se stessi" };
    if (page.status && page.status !== "active") return { outcome: "unavailable", sent: false, message: `Annuncio ${page.status}`, listing: { status: page.status } };
    const btn = askInfoButton();
    if (btn === undefined) return { outcome: "changed", sent: false, message: "Pulsante «Chiedi info» non trovato sulla pagina (né data-testid=\"ask-seller-button\" né l'etichetta): struttura di Vinted cambiata", capability: { name: "askInfo", value: false, detail: "pulsante assente" } };
    if (!btn || isDisabled(btn)) return { outcome: "failed", sent: false, retryable: false, message: "«Chiedi info» non disponibile per questo annuncio" };
    // Pagina non ancora caricata del tutto: Vinted non ha ancora collegato i suoi pulsanti.
    if (document.readyState !== "complete") await waitFor(() => document.readyState === "complete", 10_000);
    globalThis.VTGuard.safeClick(btn);   // clic protetto dal divieto di acquisto
    return { outcome: "opened", sent: false, capability: { name: "askInfo", value: true, detail: "pulsante trovato" } };
  };

  /** Fase 2: la chat è pronta? */
  VT.msgComposer = () => ({
    ready: Boolean(composer()), challenge: challengePresent(), loggedIn: loggedInFromDom(), path: location.pathname,
    // Diagnostica (senza contenuti): scheda visibile, pulsante ancora presente, quanti campi di testo.
    visible: document.visibilityState === "visible", askButton: Boolean(askInfoButton()), textareas: document.querySelectorAll("textarea").length,
  });

  /** Fase 3: compila il campo; in modalità A preme Invia. */
  VT.msgFill = async ({ text, mode }) => {
    const t = normText(text);
    const ta = composer();
    if (!ta) return { outcome: "failed", sent: false, retryable: true, message: "Campo del messaggio (#composerInput) non trovato" };
    if (challengePresent()) return { outcome: "captcha", sent: false, message: "Vinted chiede una verifica nella chat" };
    if (!t || t.length > 1000) return { outcome: "failed", sent: false, retryable: false, message: "Testo del messaggio non valido" };
    MSG.session = { text: String(text).trim(), mode, attempted: false, sentText: null, baseline: countMessages(t), startedAt: Date.now() };
    setComposerValue(ta, String(text).trim());
    const btn = await waitFor(() => { const b = sendButton(); return b && !isDisabled(b) ? b : null; }, 8000);
    if (!btn) {
      MSG.session = null;
      return { outcome: "failed", sent: false, retryable: true, message: "Il pulsante di invio non si è abilitato dopo aver scritto il messaggio" };
    }
    if (mode === "auto") {
      markAttempt();
      globalThis.VTGuard.safeClick(btn);   // clic protetto dal divieto di acquisto
      return { outcome: "filled", sent: true, clicked: true };
    }
    ta.focus();
    return { outcome: "filled", sent: false, clicked: false };
  };

  /** Fase 4: il messaggio è comparso nella conversazione? */
  VT.msgStatus = () => {
    const ses = MSG.session;
    if (!ses) return { state: "unknown" };
    if (challengePresent()) return { state: "challenge", attempted: ses.attempted };
    const ta = composer();
    const cleared = !ta || !normText(ta.value);
    const t = ses.sentText || normText(ses.text);
    const count = countMessages(t);
    if (cleared && count > (ses.attempted ? ses.baseline : countBaseline(ses, t))) {
      MSG.session = null;
      return { state: "sent", attempted: true };
    }
    return { state: "pending", attempted: ses.attempted, cleared };
  };
  const countBaseline = (ses, t) => (t === normText(ses.text) ? ses.baseline : Infinity);

  // ---------------------------------------------------------------- scansione

  VT.scan = async ({ scanId, sellerId, maxItems = 5000 }) => {
    let page = 1;
    let totalPages = null;
    let found = 0;
    let method = "api";
    const inaccessible = [];
    for (;;) {
      const r = await api().request("GET", `/wardrobe/${sellerId}/items?page=${page}&per_page=96&order=newest_first`, { timeoutMs: 30_000 });
      if (!r.ok) {
        if (["captcha", "blocked", "rate", "auth"].includes(r.kind)) return { ...asOutcome(r), found };
        if (page === 1 && (r.kind === "notFound" || r.kind === "http")) {
          // API non disponibile: si legge la griglia della pagina (solo ciò che è visibile).
          if (/^\/member\/\d+/.test(location.pathname)) return scanDom(scanId, sellerId);
          return { outcome: "changed", sent: false, message: `Lettura armadio non disponibile (${r.message}). Apri l'armadio su Vinted e avvia da lì la scansione.`, capability: { name: "wardrobeApi", value: false, detail: r.message } };
        }
        inaccessible.push(`pagina ${page}: ${r.message}`);
        break;
      }
      const items = r.data?.items;
      if (!Array.isArray(items)) return { outcome: "changed", sent: false, message: "Risposta dell'armadio senza elenco di annunci: formato cambiato", capability: { name: "wardrobeApi", value: false, detail: "items mancante" } };
      totalPages = r.data?.pagination?.total_pages ?? totalPages;
      const sellerLogin = items[0]?.user?.login || null;
      const ack = await chrome.runtime.sendMessage({ type: "vt:scanBatch", scanId, items, page, totalPages, sellerLogin });
      found += items.length;
      if (ack?.cancel) return { outcome: "cancelled", found, method };
      if (!items.length || found >= maxItems || (totalPages && page >= totalPages)) break;
      page++;
      await sleep(900 + Math.random() * 600);   // ritmo tranquillo tra le pagine
    }
    return { outcome: "done", found, pages: page, method, inaccessible, capability: { name: "wardrobeApi", value: true, detail: `${found} annunci in ${page} pagine` } };
  };

  /** Ripiego: annunci visibili nella griglia della pagina dell'armadio. */
  async function scanDom(scanId, sellerId) {
    const seen = new Map();
    for (const a of document.querySelectorAll('main a[href*="/items/"], [role="main"] a[href*="/items/"]')) {
      const m = a.getAttribute("href").match(/\/items\/(\d+)/);
      if (!m || seen.has(m[1])) continue;
      const card = a.closest('[data-testid*="item" i], [class*="item" i], div') || a;
      if (card.closest('[data-testid*="notification" i], header, nav')) continue;
      const img = card.querySelector("img");
      const priceText = [...card.querySelectorAll("p, span, h3, div")].map((x) => x.textContent.trim()).find((t) => /\d[\d.,]*\s?€|€\s?\d/.test(t) && t.length < 20);
      seen.set(m[1], {
        id: m[1],
        title: img?.getAttribute("alt")?.split(",")[0] || a.getAttribute("title") || a.textContent.trim().slice(0, 120) || `Annuncio ${m[1]}`,
        url: new URL(a.getAttribute("href"), location.origin).href,
        price: priceText ? priceText.replace(/[^\d,.]/g, "").replace(",", ".") : null,
        photo: img ? { url: img.currentSrc || img.src } : null,
        user_id: sellerId,
      });
    }
    const items = [...seen.values()];
    if (!items.length) return { outcome: "changed", sent: false, message: "Nessun annuncio riconosciuto nella pagina: la struttura di Vinted è cambiata", capability: { name: "pageSelectors", value: false, detail: "griglia armadio vuota" } };
    await chrome.runtime.sendMessage({ type: "vt:scanBatch", scanId, items, page: 1, totalPages: 1 });
    return { outcome: "done", found: items.length, pages: 1, method: "dom", inaccessible: ["Lettura dalla pagina: solo gli annunci visibili, senza date. Scorri l'armadio e ripeti per caricarne altri."], capability: { name: "pageSelectors", value: true, detail: `griglia: ${items.length}` } };
  }

  // ---------------------------------------------------------------- sessione

  VT.session = async ({ userId }) => {
    const page = VT.pageState();
    if (page.challenge) return { challenge: true, loggedIn: null };
    if (!userId) return { loggedIn: page.loggedIn, login: null };
    const r = await api().request("GET", `/users/${userId}`, { timeoutMs: 15_000 });
    if (r.ok) {
      const u = r.data?.user || r.data;
      return { loggedIn: true, login: u?.login || null, itemCount: u?.item_count ?? null };
    }
    if (r.kind === "auth") return { loggedIn: false };
    if (r.kind === "captcha") return { challenge: true };
    return { loggedIn: page.loggedIn, error: r.message };
  };

  // ---------------------------------------------------------------- account seguiti

  /** Account che l'utente segue su Vinted (sola lettura, a pagine). */
  VT.following = async ({ userId, perPage = 100, maxPages = 20 }) => {
    if (!/^\d+$/.test(String(userId || ""))) return { outcome: "failed", message: "Account non valido" };
    const users = [];
    for (let page = 1; page <= maxPages; page++) {
      const r = await api().request("GET", `/users/${userId}/followed_users?page=${page}&per_page=${perPage}`, { timeoutMs: 20_000 });
      if (!r.ok) {
        if (page > 1) break;
        if (r.kind === "notFound" || r.kind === "http") return { outcome: "changed", message: `Elenco dei seguiti non disponibile (${r.message})` };
        return asOutcome(r);
      }
      const list = r.data?.users;
      if (!Array.isArray(list)) return { outcome: "changed", message: "Elenco dei seguiti in un formato sconosciuto" };
      for (const u of list) if (u?.id != null) users.push({ id: String(u.id), login: u.login || null });
      const total = Number(r.data?.pagination?.total_pages) || 1;
      if (page >= total || list.length < perPage) break;
      await sleep(500);
    }
    return { outcome: "done", users };
  };

  // ---------------------------------------------------------------- notifiche Vinted

  VT.notifList = async ({ pages = 3 }) => {
    const out = [];
    for (let page = 1; page <= pages; page++) {
      const r = await api().request("GET", `/notifications?page=${page}&per_page=20`, { timeoutMs: 20_000 });
      if (!r.ok) {
        if (page > 1) break;
        if (r.kind === "notFound" || r.kind === "http") return { outcome: "changed", message: `Elenco notifiche non disponibile (${r.message})`, capability: { value: false, detail: r.message } };
        return asOutcome(r);
      }
      const list = r.data?.notifications;
      if (!Array.isArray(list)) return { outcome: "changed", message: "Risposta delle notifiche in un formato sconosciuto", capability: { value: false, detail: "notifications mancante" } };
      for (const n of list) {
        if (n?.id == null) continue;
        out.push({ id: String(n.id), body: String(n.body || n.title || n.message || "").replace(/<[^>]+>/g, "").slice(0, 300), isRead: Boolean(n.is_read), at: n.updated_at ? Date.parse(n.updated_at) : null, type: n.entry_type || n.type || null, link: typeof n.link === "string" ? n.link : null });
      }
      if (list.length < 20) break;
      await sleep(600);
    }
    return { outcome: "done", items: out, capability: { value: true, detail: `${out.length} notifiche lette` } };
  };

  VT.notifRead = async ({ id }) => {
    if (!/^\d+$/.test(String(id))) return { outcome: "failed", message: "id non valido" };
    let r = await api().request("PUT", `/notifications/${id}`, { body: { is_read: true } });
    if (!r.ok && (r.status === 400 || r.status === 422)) r = await api().request("PUT", `/notifications/${id}`, { body: { notification: { is_read: true } } });
    if (r.ok) return { outcome: "done" };
    if (r.kind === "notFound") return { outcome: "changed", message: "Segna come letta non disponibile su Vinted" };
    return asOutcome(r);
  };
})();
