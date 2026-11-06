/**
 * Content script — punto d'ingresso sulle pagine Vinted.
 * Riceve i comandi del service worker (scansione, like, offerta, sessione,
 * notifiche) e annuncia lo stato della pagina. Nessun clic su elementi della
 * pagina: le operazioni passano dalle API ammesse da guard-core.js.
 */
(() => {
  "use strict";
  if (window.top !== window || window.__vintasticLoaded) return;
  window.__vintasticLoaded = true;
  const VT = window.VT;

  const report = (error, category = "js") => {
    try { chrome.runtime.sendMessage({ type: "vt:clientError", category, message: String(error?.message || error).slice(0, 500), stack: error?.stack?.slice(0, 2000) }); } catch { /* estensione ricaricata */ }
  };

  const HANDLERS = {
    "vt:ping": async () => ({ ok: true, page: VT.pageState() }),
    "vt:exec": async (msg) => {
      if (VT.pageState().challenge) return { outcome: "captcha", sent: false, message: "Vinted chiede una verifica" };
      if (msg.op.type === "like") return VT.like(msg);
      if (msg.op.type === "offer") return VT.offer({ ...msg, op: msg.op });
      return { outcome: "unsupported", sent: false, message: `Operazione non supportata: ${msg.op.type}` };
    },
    "vt:verifyLike": (msg) => VT.verifyLike(msg),
    "vt:listingInfo": async (msg) => VT.listingFromPage(String(msg.id)),
    "vt:scan": (msg) => VT.scan(msg),
    "vt:session": (msg) => VT.session(msg),
    "vt:notifList": (msg) => VT.notifList(msg),
    "vt:notifRead": (msg) => VT.notifRead(msg),
  };

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (sender.id !== chrome.runtime.id || !HANDLERS[msg?.type]) return false;
    Promise.resolve()
      .then(() => HANDLERS[msg.type](msg))
      .then(sendResponse, (e) => {
        if (e?.guard) { report(e, "policy"); return sendResponse({ outcome: "failed", sent: false, retryable: false, message: e.message, guard: true }); }
        report(e);
        // Un errore nel nostro codice durante una scrittura: esito incerto, mai "riuscito".
        sendResponse({ outcome: msg.type === "vt:exec" ? "uncertain" : "failed", sent: msg.type === "vt:exec", message: `Errore interno: ${e?.message || e}` });
      });
    return true;
  });

  async function announce() {
    try {
      await chrome.runtime.sendMessage({ type: "vt:ready", page: VT.pageState() });
    } catch { /* service worker in avvio: riprova */
      setTimeout(announce, 1500);
    }
  }

  // Una verifica (CAPTCHA) può comparire dopo il caricamento: osserva per qualche secondo.
  let lastChallenge = false;
  let pending = null;
  const watch = new MutationObserver(() => {
    if (pending) return;
    pending = setTimeout(() => {
      pending = null;
      const page = VT.pageState();
      if (page.challenge !== lastChallenge) {
        lastChallenge = page.challenge;
        chrome.runtime.sendMessage({ type: "vt:pageState", page }).catch(() => {});
      }
    }, 600);
  });
  watch.observe(document.documentElement, { childList: true, subtree: true });
  setTimeout(() => watch.disconnect(), 30_000);

  announce();
  try { VT.startOverlay(); } catch (e) { report(e, "dom"); }
})();
