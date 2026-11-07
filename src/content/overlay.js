/**
 * Floating Action Button e Mini-Mode Widget sulle pagine Vinted.
 * Overlay del content script in uno Shadow DOM (stili isolati da Vinted e
 * viceversa). Aggiornamento in tempo reale tramite una porta verso il service
 * worker: la dashboard può restare chiusa.
 * Scelta tecnica: l'overlay è visibile mentre lavori su Vinted; il side panel
 * (sempre disponibile dal popup) mostra lo stesso stato su qualsiasi sito.
 */
(() => {
  "use strict";
  if (window.top !== window) return;
  const VT = (window.VT = window.VT || {});

  const rpc = (method, params = {}) => chrome.runtime.sendMessage({ type: "vt:rpc", method, params }).then((r) => {
    if (r && r.__vtError) throw new Error(r.error);
    return r;
  });

  let host;
  let root;
  let state = { overview: null, open: false, panel: null, hiddenWidget: false };
  let port = null;
  let tickTimer = null;
  let lastPath = location.pathname;

  const CSS = `
  :host{all:initial}
  *{box-sizing:border-box;font-family:Inter,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
  .wrap{position:fixed;z-index:2147483600;display:flex;flex-direction:column;align-items:flex-end;gap:10px;color:#f4f1fb;font-size:13px;line-height:1.35}
  .fab{width:52px;height:52px;border-radius:16px;border:1px solid #3b2f5c;background:linear-gradient(145deg,#1d1730,#120e1d);box-shadow:0 10px 30px rgba(0,0,0,.45),0 0 0 1px rgba(143,110,242,.25);cursor:grab;display:grid;place-items:center;position:relative}
  .fab:active{cursor:grabbing}
  .fab img{width:34px;height:34px;pointer-events:none}
  .dot{position:absolute;top:-3px;right:-3px;width:12px;height:12px;border-radius:50%;background:#22c55e;border:2px solid #120e1d}
  .dot.paused{background:#f59e0b}.dot.err{background:#ef4444}.dot.off{display:none}
  .menu,.widget,.toast{background:#17131f;border:1px solid #2e2645;border-radius:14px;box-shadow:0 14px 40px rgba(0,0,0,.5)}
  .menu{width:270px;padding:8px}
  .menu button,.menu a{all:unset;display:flex;gap:10px;align-items:center;width:100%;box-sizing:border-box;padding:9px 10px;border-radius:9px;cursor:pointer;color:#f4f1fb}
  .menu button:hover,.menu a:hover,.menu button:focus-visible{background:#241d36;outline:none}
  .menu .sep{height:1px;background:#2e2645;margin:6px 4px}
  .menu small{color:#a59cc0;display:block}
  .ic{width:18px;text-align:center;color:#b69cff}
  .widget{width:300px;min-width:240px;min-height:120px;resize:both;overflow:auto;padding:12px}
  .wh{display:flex;align-items:center;gap:8px;cursor:grab;margin:-4px -4px 8px;padding:4px;border-radius:8px}
  .wh b{flex:1;font-size:13.5px;line-height:1.25;overflow-wrap:anywhere}
  .wb{display:flex;gap:6px;flex-wrap:wrap;margin:-2px 0 4px}
  .badge{font-size:11px;padding:2px 8px;border-radius:999px;background:#2a2142;color:#cdbcff}
  .badge.running{background:#14361f;color:#7ee2a0}.badge.paused{background:#3a2a0e;color:#ffd27a}.badge.dry{background:#22314a;color:#9cc8ff}
  .bar{height:7px;background:#2a2340;border-radius:99px;overflow:hidden;margin:8px 0}
  .bar i{display:block;height:100%;background:linear-gradient(90deg,#8f6ef2,#d94f8c);border-radius:99px;transition:width .4s}
  .row{display:flex;justify-content:space-between;gap:8px;color:#c9c0e0;margin:3px 0}
  .row span:last-child{color:#f4f1fb;text-align:right}
  .muted{color:#a59cc0}
  .btns{display:flex;gap:6px;margin-top:10px;flex-wrap:wrap}
  .b{all:unset;cursor:pointer;padding:6px 10px;border-radius:8px;background:#241d36;color:#f4f1fb;font-size:12px;border:1px solid #33294d}
  .b:hover,.b:focus-visible{background:#2f2547;outline:none}
  .b.primary{background:#7c5cf0;border-color:#7c5cf0}.b.danger{background:#4a1626;border-color:#6b1f37;color:#ffc0cf}
  .x{all:unset;cursor:pointer;color:#a59cc0;padding:2px 6px;border-radius:6px}.x:hover{background:#241d36;color:#fff}
  .toasts{position:fixed;z-index:2147483601;right:20px;top:20px;display:flex;flex-direction:column;gap:8px;max-width:340px}
  .toast{padding:10px 12px;border-left:4px solid #8f6ef2}
  .toast.warning{border-left-color:#f59e0b}.toast.error,.toast.critical{border-left-color:#ef4444}.toast.success{border-left-color:#22c55e}
  .toast b{display:block;margin-bottom:2px}
  .form{padding:6px 8px}
  .form label{display:flex;gap:6px;align-items:center;margin:4px 0;color:#d8d0ee}
  select{width:100%;background:#0f0c18;color:#f4f1fb;border:1px solid #33294d;border-radius:8px;padding:6px;margin:4px 0}
  @media (prefers-reduced-motion: reduce){.bar i{transition:none}}
  `;

  /** append senza slot vuoti (null/false diventerebbero il testo "null"). */
  const put = (parent, ...kids) => { parent.append(...kids.flat().filter((k) => k != null && k !== false)); return parent; };

  function el(tag, attrs = {}, ...kids) {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === "class") n.className = v;
      else if (k.startsWith("on")) n.addEventListener(k.slice(2), v);
      else if (v != null && v !== false) n.setAttribute(k, v === true ? "" : v);
    }
    for (const k of kids.flat()) if (k != null && k !== false) n.append(k.nodeType ? k : document.createTextNode(String(k)));
    return n;
  }

  const fmt = (ms) => {
    if (ms == null) return "—";
    const s = Math.max(0, Math.round(ms / 1000));
    return s >= 60 ? `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}` : `${s} s`;
  };
  const statusLabel = { running: "In esecuzione", paused: "In pausa", ready: "Pronta", draft: "Bozza", completed: "Completata", stopped: "Interrotta" };

  function activeCampaign() {
    const list = state.overview?.campaigns || [];
    return list.find((c) => c.status === "running") || list.filter((c) => c.status === "paused").sort((a, b) => b.updatedAt - a.updatedAt)[0] || null;
  }

  function mount() {
    if (host) return;
    host = document.createElement("vintastic-overlay");
    root = host.attachShadow({ mode: "open" });
    root.append(el("style", {}, CSS));
    document.documentElement.append(host);
    render();
  }

  function unmount() { host?.remove(); host = null; root = null; }

  function savePosition(right, bottom) {
    rpc("settings.save", { patch: { overlay: { position: { right, bottom } } } }).catch(() => {});
  }

  function draggable(handle, box) {
    let start = null;
    handle.addEventListener("pointerdown", (e) => {
      if (e.button !== 0 || e.target.closest("button:not(.fab)")) return;
      const r = box.getBoundingClientRect();
      start = { x: e.clientX, y: e.clientY, right: innerWidth - r.right, bottom: innerHeight - r.bottom, moved: false };
      handle.setPointerCapture(e.pointerId);
    });
    handle.addEventListener("pointermove", (e) => {
      if (!start) return;
      const dx = e.clientX - start.x;
      const dy = e.clientY - start.y;
      if (Math.abs(dx) + Math.abs(dy) > 4) start.moved = true;
      box.style.right = `${Math.min(innerWidth - 60, Math.max(4, start.right - dx))}px`;
      box.style.bottom = `${Math.min(innerHeight - 60, Math.max(4, start.bottom - dy))}px`;
    });
    handle.addEventListener("pointerup", () => {
      if (!start) return;
      if (start.moved) { handle.dataset.dragged = "1"; savePosition(parseInt(box.style.right, 10), parseInt(box.style.bottom, 10)); }
      start = null;
    });
  }

  function render() {
    if (!root) return;
    const o = state.overview;
    const ov = o?.overlay || {};
    [...root.children].forEach((c) => { if (c.tagName !== "STYLE") c.remove(); });
    const pos = ov.position || { right: 20, bottom: 20 };
    // Nella chat il pulsante Invia è in basso a destra: lì il FAB si sposta in alto per non coprirlo.
    const chat = /^\/inbox(\/|$)/.test(location.pathname);
    lastPath = location.pathname;
    const wrap = el("div", { class: "wrap", style: chat
      ? `right:${pos.right}px;top:84px;bottom:auto;transform:scale(${ov.scale || 1});transform-origin:top right`
      : `right:${pos.right}px;bottom:${pos.bottom}px;transform:scale(${ov.scale || 1});transform-origin:bottom right` });
    const c = activeCampaign();

    if (ov.widget !== false && c && !state.hiddenWidget) put(wrap, widget(c, wrap));
    if (state.open) put(wrap, menu());
    if (ov.fab !== false) {
      const dotCls = !c ? "off" : c.status === "running" ? "" : c.pauseReason && c.pauseReason !== "user" ? "err" : "paused";
      const fab = el("button", { class: "fab", title: "Vintastic", "aria-label": "Apri il menu di Vintastic", "aria-expanded": String(state.open) },
        el("img", { src: chrome.runtime.getURL("icons/icon48.png"), alt: "" }), el("span", { class: `dot ${dotCls}` }));
      fab.addEventListener("click", () => {
        if (fab.dataset.dragged) { delete fab.dataset.dragged; return; }
        state.open = !state.open;
        state.panel = null;
        render();
      });
      draggable(fab, wrap);
      put(wrap, fab);
    }
    put(root, wrap, toastBox);
  }

  function widget(c, wrap) {
    const p = c.progress || {};
    const remaining = c.nextAt ? c.nextAt - Date.now() : null;
    const head = el("div", { class: "wh" },
      el("b", { title: c.name }, c.name),
      el("button", { class: "x", title: "Chiudi (riapri dal pulsante Vintastic)", "aria-label": "Chiudi il widget", onclick: () => { state.hiddenWidget = true; render(); } }, "✕"));
    const badges = el("div", { class: "wb" }, el("span", { class: `badge ${c.status}` }, statusLabel[c.status] || c.status), c.dryRun ? el("span", { class: "badge dry" }, "Simulazione") : null);
    const w = el("div", { class: "widget", role: "status", "aria-live": "polite" }, head, badges,
      el("div", { class: "bar", role: "progressbar", "aria-valuenow": p.percent || 0, "aria-valuemin": 0, "aria-valuemax": 100 }, el("i", { style: `width:${p.percent || 0}%` })),
      el("div", { class: "row" }, el("span", {}, "Progresso"), el("span", {}, `${p.percent || 0}% · ${p.itemsDone || 0}/${p.items || 0} annunci`)),
      el("div", { class: "row" }, el("span", {}, "Operazioni in attesa"), el("span", {}, String(p.pending ?? "—"))),
      el("div", { class: "row" }, el("span", {}, "Account"), el("span", {}, state.overview?.account?.login ? `@${state.overview.account.login}` : c.accountId ? `utente ${c.accountId.split("@")[0]}` : "—")),
      el("div", { class: "row" }, el("span", {}, "Operazione corrente"), el("span", {}, c.current ? `${c.current.type} · ${String(c.current.title || "").slice(0, 26)}` : "—")),
      el("div", { class: "row" }, el("span", {}, "Timer"), el("span", { "data-timer": "1" }, c.status === "running" && remaining != null ? fmt(remaining) : "—")),
      c.status === "paused" && c.pauseDetail ? el("div", { class: "muted", style: "margin-top:6px" }, c.pauseDetail) : null,
      el("div", { class: "btns" },
        c.status === "running" ? el("button", { class: "b", onclick: () => act("campaigns.pause", { id: c.id }) }, "⏸ Pausa") : null,
        c.status === "paused" ? el("button", { class: "b primary", onclick: () => act("campaigns.resume", { id: c.id }) }, "▶ Riprendi") : null,
        c.pendingConfirm ? el("button", { class: "b primary", onclick: () => act("campaigns.confirmOp", { id: c.id, opId: c.pendingConfirm.opId }) }, "✓ Conferma") : null,
        el("button", { class: "b danger", onclick: () => { if (confirm(`Interrompere «${c.name}»? Le operazioni in attesa verranno annullate.`)) act("campaigns.stop", { id: c.id }); } }, "■ Stop"),
        el("button", { class: "b", onclick: () => openDash(`#campaigns/${c.id}`) }, "⤢ Espandi")));
    draggable(head, wrap);
    return w;
  }

  function menu() {
    const path = location.pathname;
    const onWardrobe = /^\/member\/\d+/.test(path);
    const itemId = path.match(/^\/items\/(\d+)/)?.[1];
    const m = el("div", { class: "menu", role: "menu" });
    if (state.panel === "add" && itemId) return addPanel(m, itemId);
    if (state.panel === "campaigns") return campaignsPanel(m);
    const item = (ic, label, sub, fn, disabled = false) => el("button", { role: "menuitem", onclick: fn, disabled }, el("span", { class: "ic" }, ic), el("span", {}, label, sub ? el("small", {}, sub) : null));
    put(m,
      item("◆", "Apri Vintastic", "Dashboard completa", () => openDash("")),
      onWardrobe ? item("⌕", "Scansiona questo armadio", "Legge gli annunci del venditore", async () => {
        try { await rpc("scan.start", { url: location.href, useCurrentTab: true }); toast({ title: "Scansione avviata", body: "Segui l'avanzamento in Vintastic › Scanner.", level: "info" }); } catch (e) { toast({ title: "Scansione non avviata", body: e.message, level: "error" }); }
        state.open = false; render();
      }) : item("⌕", "Avvia una scansione", "Apri l'armadio di un venditore", () => openDash("#scanner")),
      itemId ? item("+", "Aggiungi a una campagna", "Questo annuncio", () => { state.panel = "add"; render(); }) : null,
      item("≡", "Campagne attive", `${(state.overview?.campaigns || []).filter((c) => c.status === "running").length} in esecuzione`, () => { state.panel = "campaigns"; render(); }),
      item("⚙", "Impostazioni", null, () => openDash("#settings")),
      el("div", { class: "sep" }),
      item("⏸", "Metti in pausa tutto", null, () => act("campaigns.pauseAll")),
      state.hiddenWidget ? item("▣", "Riapri il widget", null, () => { state.hiddenWidget = false; state.open = false; render(); }) : null,
      item("⛔", "Kill Switch", "Ferma tutto subito", () => { if (confirm("Attivare il Kill Switch? Tutte le campagne si fermano.")) act("health.killSwitch", { on: true }); }),
    );
    return m;
  }

  function campaignsPanel(m) {
    const list = (state.overview?.campaigns || []).filter((c) => ["running", "paused", "ready"].includes(c.status));
    put(m, el("button", { onclick: () => { state.panel = null; render(); } }, el("span", { class: "ic" }, "←"), "Indietro"));
    if (!list.length) put(m, el("div", { class: "form muted" }, "Nessuna campagna attiva."));
    for (const c of list) {
      put(m, el("button", { onclick: () => openDash(`#campaigns/${c.id}`) }, el("span", { class: "ic" }, c.status === "running" ? "▶" : "⏸"),
        el("span", {}, c.name, el("small", {}, `${statusLabel[c.status]} · ${c.progress?.percent || 0}%${c.dryRun ? " · simulazione" : ""}`))));
    }
    return m;
  }

  function addPanel(m, itemId) {
    const camps = (state.overview?.campaigns || []).filter((c) => !["completed", "stopped"].includes(c.status));
    const sel = el("select", { "aria-label": "Campagna" }, ...camps.map((c) => el("option", { value: c.id }, c.name)), el("option", { value: "__new" }, "+ Nuova campagna (simulazione)"));
    const types = ["like", "offer", "comment", "message"].map((t) => {
      const cb = el("input", { type: "checkbox", value: t, checked: t === "like" });
      return { t, cb, label: el("label", {}, cb, { like: "Like", offer: "Offerta", comment: "Commento (suggerimento)", message: "Messaggio privato (solo destinatari autorizzati)" }[t]) };
    });
    put(m, el("button", { onclick: () => { state.panel = null; render(); } }, el("span", { class: "ic" }, "←"), "Indietro"),
      el("div", { class: "form" }, el("div", { class: "muted" }, `Annuncio ${itemId}`), sel, ...types.map((x) => x.label),
        el("div", { class: "btns" }, el("button", { class: "b primary", onclick: async () => {
          const chosen = types.filter((x) => x.cb.checked).map((x) => x.t);
          if (!chosen.length) return toast({ title: "Scegli almeno un'operazione", level: "warning" });
          const listing = VT.listingFromPage(itemId);
          try {
            let id = sel.value;
            if (id === "__new") id = (await rpc("campaigns.create", { name: `Da Vinted ${new Date().toLocaleDateString("it-IT")}`, types: chosen, dryRun: true })).id;
            const r = await rpc("campaigns.add", { id, listings: [listing], spec: { types: chosen } });
            toast({ title: r.added ? "Aggiunto alla campagna" : "Già in coda", body: r.rejected?.[0]?.reason || "", level: r.added ? "success" : "warning" });
          } catch (e) { toast({ title: "Non aggiunto", body: e.message, level: "error" }); }
          state.open = false; state.panel = null; render();
        } }, "Aggiungi"))));
    return m;
  }

  /** Dati essenziali dell'annuncio aperto (per aggiungerlo senza scansione). */
  VT.listingFromPage = (itemId) => {
    const info = (() => { try { return VT.readItemSync?.(itemId) || {}; } catch { return {}; } })();
    const h1 = document.querySelector("h1")?.textContent?.trim();
    const img = document.querySelector('main img[src*="images"], main img');
    return { id: itemId, url: location.href.split("?")[0], title: h1 || document.title.split("|")[0].trim(), price: info.price ?? null, sellerId: info.sellerId ?? null, photo: img?.currentSrc || img?.src || null, origin: location.origin, status: "active" };
  };

  async function act(method, params) {
    try { await rpc(method, params); } catch (e) { toast({ title: "Operazione non riuscita", body: e.message, level: "error" }); }
    state.open = false;
    render();
  }

  function openDash(hash) {
    rpc("overview").catch(() => {});
    window.open(chrome.runtime.getURL(`src/ui/dashboard.html${hash}`), "_blank", "noopener");
  }

  // ---------------------------------------------------------------- avvisi

  const toastBox = document.createElement("div");
  toastBox.className = "toasts";
  toastBox.setAttribute("aria-live", "polite");
  function toast({ title, body = "", level = "info" }, durationSec = 6) {
    if (!root) return;
    const t = el("div", { class: `toast ${level}`, role: level === "error" || level === "critical" ? "alert" : "status" }, el("b", {}, title), body ? el("span", { class: "muted" }, body) : null);
    toastBox.append(t);
    if (level !== "critical") setTimeout(() => t.remove(), Math.max(2, durationSec) * 1000);
    else put(t, el("div", { class: "btns" }, el("button", { class: "b", onclick: () => t.remove() }, "Chiudi")));
    while (toastBox.children.length > 4) toastBox.firstChild.remove();
  }
  VT.toast = toast;

  // ---------------------------------------------------------------- tempo reale

  function shouldShow(o) {
    return o && o.features?.overlay !== false && !o.moduleKill?.overlay && (o.overlay?.fab !== false || o.overlay?.widget !== false);
  }

  function connect() {
    if (!chrome.runtime?.id) return unmount();
    try { port = chrome.runtime.connect({ name: "vt-page" }); } catch { return unmount(); }
    port.onMessage.addListener((msg) => {
      if (msg.type === "vt:overview") {
        state.overview = msg.overview;
        if (shouldShow(state.overview)) mount(); else unmount();
        render();
      } else if (["vt:campaign", "vt:timer", "vt:settings", "vt:session"].includes(msg.type)) {
        refresh();
      } else if (msg.type === "vt:notification" && root) {
        const n = msg.note;
        if (["warning", "error", "critical", "success"].includes(n.level)) toast(n, msg.durationSec);
      }
    });
    port.onDisconnect.addListener(() => {
      port = null;
      if (!chrome.runtime?.id) return unmount();
      setTimeout(connect, 1500);          // il service worker è stato riavviato
    });
  }

  let refreshQueued = false;
  function refresh() {
    if (refreshQueued) return;
    refreshQueued = true;
    setTimeout(async () => {
      refreshQueued = false;
      try {
        state.overview = await rpc("overview");
        if (shouldShow(state.overview)) mount(); else unmount();
        render();
      } catch { /* worker non pronto */ }
    }, 250);
  }

  // Timer a vista: aggiorna solo il numero, senza ridisegnare tutto.
  tickTimer = setInterval(() => {
    if (!root) return;
    if (location.pathname !== lastPath) render();      // navigazione interna di Vinted (es. apertura della chat)
    const c = activeCampaign();
    const t = root.querySelector("[data-timer]");
    if (t && c?.status === "running" && c.nextAt) t.textContent = fmt(c.nextAt - Date.now());
    // Il ping (ogni 20 s) tiene vivo il service worker mentre una campagna è in corso.
    if (port && c?.status === "running" && Date.now() % 20000 < 1000) { try { port.postMessage({ type: "ping" }); } catch { /* riconnessione in corso */ } }
  }, 1000);

  VT.startOverlay = connect;
  VT.stopOverlay = () => { clearInterval(tickTimer); unmount(); };
})();
