/**
 * Client delle API interne di Vinted (le stesse che usa il sito), dentro la pagina.
 * OGNI richiesta passa da VTGuard.assertRequestAllowed: ciò che non è in lista
 * (e qualsiasi cosa somigli a un acquisto) viene rifiutato prima di partire.
 * Intestazioni come in Vinted_Relist: niente X-Requested-With.
 */
(() => {
  "use strict";
  const VT = (window.VT = window.VT || {});
  const ORIGIN = location.origin;
  const BASE = `${ORIGIN}/api/v2`;
  let csrfCache = null;

  const cookie = (name) => document.cookie.split("; ").find((c) => c.startsWith(`${name}=`))?.split("=").slice(1).join("=") || null;

  function csrfFromDom() {
    const meta = document.querySelector('meta[name="csrf-token"]');
    if (meta?.content) return meta.content;
    const texts = [document.getElementById("__NEXT_DATA__")?.textContent, document.documentElement.innerHTML.slice(0, 2_000_000)];
    const patterns = [/"csrfToken"\s*:\s*"([^"]{16,})"/i, /"CSRF_TOKEN"\s*:\s*"([^"]{16,})"/i, /csrf[-_]?token["'\s:=\\]+([A-Za-z0-9_\-+/=]{16,})/i];
    for (const t of texts) {
      if (!t) continue;
      for (const re of patterns) { const m = t.match(re); if (m) return m[1]; }
    }
    return null;
  }

  async function tokens() {
    try { return (await chrome.runtime.sendMessage({ type: "vt:tokens", origin: ORIGIN })) || {}; } catch { return {}; }
  }

  async function csrf(force = false) {
    if (csrfCache && !force) return csrfCache;
    csrfCache = (await tokens()).csrf || csrfFromDom();
    return csrfCache;
  }

  async function headers(json) {
    const h = { Accept: "application/json, text/plain, */*", locale: cookie("user-iso-locale") || cookie("anonymous-iso-locale") || document.documentElement.lang || "it-IT" };
    const t = await csrf();
    if (t) h["X-CSRF-Token"] = t;
    const anon = (await tokens()).anonId || cookie("anon_id");
    if (anon) h["X-Anon-Id"] = anon;
    if (json) h["Content-Type"] = "application/json";
    return h;
  }

  /** Esito di una richiesta, classificato. Non lancia mai per errori HTTP. */
  async function request(method, path, { body, referrer, timeoutMs = 30_000, retry403 = true } = {}) {
    VTGuard.assertRequestAllowed(method, path, body);    // lancia PurchaseGuardError se vietata
    const init = { method, credentials: "include", cache: "no-store", headers: await headers(body !== undefined) };
    if (body !== undefined) init.body = JSON.stringify(body);
    if (referrer) init.referrer = referrer;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    init.signal = ctrl.signal;
    let res;
    try {
      res = await fetch(BASE + path, init);
    } catch (e) {
      // Nessuna risposta: per una scrittura NON sappiamo se Vinted l'ha eseguita.
      return { ok: false, kind: "network", status: 0, message: e?.name === "AbortError" ? `Vinted non ha risposto entro ${timeoutMs / 1000} s` : "Connessione a Vinted non riuscita" };
    } finally {
      clearTimeout(timer);
    }
    if (res.status === 403 && retry403) {
      // Il token può essere scaduto: uno e un solo nuovo tentativo con un token fresco.
      csrfCache = null;
      await csrf(true);
      return request(method, path, { body, referrer, timeoutMs, retry403: false });
    }
    const text = await res.text().catch(() => "");
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text.slice(0, 500) }; }
    const challenge = /captcha-delivery|datadome|hcaptcha|recaptcha|challenge/i.test(text.slice(0, 3000)) && res.status >= 400;
    if (res.ok) return { ok: true, status: res.status, data };
    const fieldErrors = Array.isArray(data?.errors) ? data.errors.map((e) => [e.field, e.value ?? e.message].filter(Boolean).join(": ")).filter(Boolean) : [];
    const message = fieldErrors.join(" · ") || data?.message || data?.error || data?.message_code || `HTTP ${res.status}`;
    let kind = "http";
    if (challenge) kind = "captcha";
    else if (res.status === 403) kind = "blocked";
    else if (res.status === 429) kind = "rate";
    else if (res.status === 401) kind = "auth";
    else if (res.status === 404) kind = "notFound";
    else if (res.status >= 500) kind = "server";
    return { ok: false, kind, status: res.status, message, data };
  }

  VT.api = { request, csrf, origin: ORIGIN, cookie };
})();
