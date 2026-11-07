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

  VT.like = async ({ listing }) => {
    const id = String(listing.id);
    const before = await readItem(id);
    if (before.error) return asOutcome(before.error);
    if (before.notFound) return { outcome: "notFound", sent: false, message: "Annuncio non più disponibile" };
    if (before.status && before.status !== "active") return { outcome: "unavailable", sent: false, message: `Annuncio ${before.status}`, listing: { status: before.status } };
    if (before.isFavourite === true) {
      return { outcome: "already", sent: false, message: "Like già presente su Vinted", capability: { name: "favourite", value: true, detail: `stato letto da ${before.source}` } };
    }
    if (before.isFavourite !== false) {
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
    if (after.isFavourite === true) return { outcome: "done", sent: true, message: "Like confermato", capability: { name: "favourite", value: true, detail: "toggle + rilettura" } };
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

  // ---------------------------------------------------------------- messaggio privato (solo interazione DOM visibile)

  const MESSAGE_TIMEOUT_MS = 45_000;
  const CHAT_INPUT = '#composerInput[data-testid="composer--input"], textarea#composerInput';
  const ASK_INFO_LABEL = 'Chiedi info';
  const MESSAGE_MAX_LENGTH = 1000;

  function waitForDom(predicate, timeoutMs = MESSAGE_TIMEOUT_MS) {
    return new Promise((resolve) => {
      let done = false;
      const finish = (value) => {
        if (done) return;
        done = true;
        observer.disconnect();
        clearTimeout(timer);
        resolve(value || null);
      };
      const check = () => {
        try { const value = predicate(); if (value) finish(value); } catch { /* DOM transitorio */ }
      };
      const observer = new MutationObserver(check);
      observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true });
      const timer = setTimeout(() => finish(null), timeoutMs);
      check();
    });
  }

  function safeClick(element) {
    if (!element || typeof element.dispatchEvent !== "function") return false;
    return element.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));
  }

  function askInfoButton() {
    const labels = [...document.querySelectorAll('span.web_ui__Button__label')];
    const label = labels.find((el) => (el.textContent || '').trim() === ASK_INFO_LABEL);
    const button = label?.closest('button');
    return button && !button.disabled && button.getAttribute('aria-disabled') !== 'true' ? button : null;
  }

  function setTextareaValue(textarea, value) {
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
    if (setter) setter.call(textarea, value);
    else textarea.value = value;
    textarea.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: value }));
    textarea.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function sendButton(textarea) {
    const suffix = textarea.closest('.web_ui__InputBar__input')?.parentElement?.querySelector('.web_ui__InputBar__suffix');
    const button = suffix?.querySelector('button') || [...document.querySelectorAll('button')].find((b) => b.querySelector('[data-testid="arrow-right"]'));
    return button && !button.disabled && button.getAttribute('aria-disabled') !== 'true' ? button : null;
  }

  function matchingMessageNodes(text) {
    const candidates = document.querySelectorAll('[data-testid*="message" i], [class*="message" i], [class*="Message"]');
    return [...candidates].filter((el) => {
      if (el.matches('textarea, input')) return false;
      const content = (el.innerText || el.textContent || '').trim();
      return content === text || content.endsWith(text);
    });
  }

  async function waitForSent(text, textarea, previousNodes, timeoutMs = 45_000) {
    return waitForDom(() => {
      const current = document.querySelector(CHAT_INPUT) || textarea;
      const composerCleared = !current?.isConnected || current.value.trim() === '';
      // Un messaggio con lo stesso testo già presente nella chat non basta:
      // deve apparire un nuovo nodo dopo il tentativo di invio.
      const newBubble = matchingMessageNodes(text).some((el) => !previousNodes.has(el));
      return composerCleared && newBubble;
    }, timeoutMs);
  }

  async function returnToListing(listingId) {
    const expected = new RegExp(`^/items/${String(listingId).replace(/[^0-9]/g, '')}(?:$|[-/])`);
    if (expected.test(location.pathname)) return true;
    history.back();
    return Boolean(await waitForDom(() => expected.test(location.pathname), 8_000));
  }

  VT.message = async ({ listing, op }) => {
    const listingId = String(listing?.id || '');
    const text = String(op?.text || '').trim();
    const mode = op?.mode === 'manual' ? 'manual' : 'auto';
    if (!/^\d+$/.test(listingId)) return { outcome: 'failed', sent: false, retryable: false, message: 'ID annuncio non valido' };
    if (!text) return { outcome: 'failed', sent: false, retryable: false, message: 'Testo del messaggio vuoto: configurarlo nelle Impostazioni' };
    if (text.length > MESSAGE_MAX_LENGTH) return { outcome: 'failed', sent: false, retryable: false, message: `Messaggio troppo lungo (massimo ${MESSAGE_MAX_LENGTH} caratteri)` };
    if (!onItemPage(listingId)) return { outcome: 'failed', sent: false, retryable: true, message: 'La scheda di lavoro non è sull’annuncio previsto' };
    if (challengePresent()) return { outcome: 'captcha', sent: false, message: 'Vinted chiede una verifica prima di aprire la chat' };

    const ask = askInfoButton();
    if (!ask) return { outcome: 'changed', sent: false, message: 'Pulsante «Chiedi info» non trovato o non cliccabile: struttura Vinted cambiata' };
    safeClick(ask);

    const textarea = await waitForDom(() => document.querySelector(CHAT_INPUT), 30_000);
    if (!textarea) {
      if (challengePresent()) return { outcome: 'captcha', sent: false, message: 'Vinted richiede una verifica per aprire la conversazione' };
      return { outcome: 'failed', sent: false, retryable: true, message: 'La chat non si è aperta: campo #composerInput non trovato' };
    }
    if (challengePresent()) return { outcome: 'captcha', sent: false, message: 'Vinted chiede una verifica nella chat' };

    setTextareaValue(textarea, text);
    const enabledButton = await waitForDom(() => sendButton(textarea), 8_000);
    if (!enabledButton) return { outcome: 'failed', sent: false, retryable: true, message: 'Il pulsante di invio non si è abilitato dopo aver compilato il messaggio' };

    const previousNodes = new Set(matchingMessageNodes(text));
    let sendAttempted = false;
    // In modalità manuale riconosciamo sia il click sul pulsante sia Invio da tastiera.
    enabledButton.addEventListener('click', () => { sendAttempted = true; }, { capture: true });
    textarea.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && !event.shiftKey) sendAttempted = true;
    }, { capture: true });
    if (mode === 'auto') {
      sendAttempted = true; // dal click in poi l'esito può essere già arrivato a Vinted
      safeClick(enabledButton);
    }
    // In entrambe le modalità non si prosegue finché non compare un nuovo bubble.
    const sent = await waitForSent(text, textarea, previousNodes, mode === 'manual' ? 4 * 60_000 : 45_000);
    if (!sent) {
      if (challengePresent()) return { outcome: sendAttempted ? 'uncertain' : 'captcha', sent: sendAttempted, message: 'Verifica Vinted comparsa durante l’invio del messaggio' };
      if (sendAttempted) {
        return { outcome: 'uncertain', sent: true, message: 'È stato tentato l’invio ma non è comparso un nuovo messaggio nella cronologia: verifica prima di riprovare' };
      }
      return { outcome: 'failed', sent: false, retryable: false, message: 'Invio manuale non rilevato entro 4 minuti: il testo è rimasto nel campo e non è stato inviato' };
    }

    const returned = await returnToListing(listingId);
    if (!returned) return { outcome: 'uncertain', sent: true, message: 'Messaggio inviato e verificato, ma il ritorno all’annuncio non è stato confermato' };
    return { outcome: 'done', sent: true, message: `Messaggio privato inviato e verificato (${mode === 'manual' ? 'conferma manuale' : 'automatico'})` };
  };

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
