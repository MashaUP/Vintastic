/** Libreria UI condivisa da dashboard, popup e side panel (niente dipendenze esterne). */

import { GLOSSARY } from "../shared/constants.js";

// Gli slot vuoti (null/false/undefined) non devono diventare il testo "null".
for (const name of ["replaceChildren", "append", "prepend", "after", "before"]) {
  for (const proto of [Element.prototype, DocumentFragment.prototype]) {
    const orig = proto[name];
    if (!orig || orig.__vt) continue;
    const safe = function (...nodes) { return orig.apply(this, nodes.flat(Infinity).filter((n) => n != null && n !== false)); };
    safe.__vt = true;
    proto[name] = safe;
  }
}

export function h(tag, attrs = {}, ...kids) {
  const svgTags = new Set(["svg", "path", "line", "polyline", "circle", "rect", "g", "text", "polygon", "defs", "linearGradient", "stop", "title"]);
  const n = svgTags.has(tag) ? document.createElementNS("http://www.w3.org/2000/svg", tag) : document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === "class") n.setAttribute("class", v);
    else if (k === "style" && typeof v === "object") Object.assign(n.style, v);
    else if (k.startsWith("on") && typeof v === "function") n.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === "html") n.innerHTML = v;              // solo per SVG statici del codice, mai per dati
    else if (k === "value" && "value" in n) n.value = v;
    else if (k === "checked") n.checked = Boolean(v);
    else n.setAttribute(k, v === true ? "" : v);
  }
  for (const k of kids.flat(Infinity)) if (k != null && k !== false) n.append(k instanceof Node ? k : document.createTextNode(String(k)));
  return n;
}

export const $ = (sel, root = document) => root.querySelector(sel);

export async function rpc(method, params = {}) {
  const r = await chrome.runtime.sendMessage({ type: "vt:rpc", method, params });
  if (r && r.ok === false && r.error) throw new Error(r.error);
  return r;
}

/** Canale in tempo reale con il service worker; si riconnette da solo. */
export function live(onMessage) {
  let port = null;
  let alive = true;
  const connect = () => {
    if (!alive) return;
    port = chrome.runtime.connect({ name: "vt-ui" });
    port.onMessage.addListener(onMessage);
    port.onDisconnect.addListener(() => { port = null; setTimeout(connect, 1000); });
  };
  connect();
  const ping = setInterval(() => { try { port?.postMessage({ type: "ping" }); } catch { /* riconnessione */ } }, 20_000);
  return () => { alive = false; clearInterval(ping); port?.disconnect(); };
}

// ------------------------------------------------------------------ icone (tratti semplici, 24x24)

const ICONS = {
  home: "M3 11 12 3l9 8M5 9.5V21h5v-6h4v6h5V9.5",
  user: "M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8Zm-8 9a8 8 0 0 1 16 0",
  users: "M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8Zm-7 10a7 7 0 0 1 14 0M17 3.5a4 4 0 0 1 0 7.5M22 21a7 7 0 0 0-4-6.3",
  scan: "M3 7V4h3M21 7V4h-3M3 17v3h3M21 17v3h-3M7 12h10",
  search: "M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16Zm10 2-4.3-4.3",
  list: "M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01",
  zap: "M13 2 3 14h9l-1 8 10-12h-9l1-8Z",
  tag: "M20.6 13.4 13.4 20.6a2 2 0 0 1-2.8 0L2 12V2h10l8.6 8.6a2 2 0 0 1 0 2.8ZM7 7h.01",
  sparkles: "M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5 18 18M6 18l2.5-2.5M15.5 8.5 18 6",
  message: "M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2Z",
  bell: "M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9M10.3 21a1.9 1.9 0 0 0 3.4 0",
  chart: "M3 3v18h18M7 15l4-4 3 3 5-6",
  file: "M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Zm0 0v6h6M8 13h8M8 17h5",
  heart: "M19 14c1.5-1.5 3-3.2 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.8 0-3 .5-4.5 2-1.5-1.5-2.7-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4 3 5.5l7 7Z",
  pulse: "M22 12h-4l-3 9L9 3l-3 9H2",
  lifebuoy: "M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20Zm0-6a4 4 0 1 0 0-8 4 4 0 0 0 0 8ZM4.9 4.9l4.3 4.3M14.8 14.8l4.3 4.3M14.8 9.2l4.3-4.3M4.9 19.1l4.3-4.3",
  settings: "M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Zm7.4-3a7.4 7.4 0 0 0-.1-1.3l2-1.6-2-3.4-2.4.9a7.5 7.5 0 0 0-2.2-1.3L14.3 2h-4l-.4 2.6a7.5 7.5 0 0 0-2.2 1.3l-2.4-.9-2 3.4 2 1.6a7.4 7.4 0 0 0 0 2.6l-2 1.6 2 3.4 2.4-.9c.7.6 1.4 1 2.2 1.3l.4 2.6h4l.4-2.6c.8-.3 1.5-.7 2.2-1.3l2.4.9 2-3.4-2-1.6c.1-.4.1-.9.1-1.3Z",
  help: "M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20Zm-3-13a3 3 0 1 1 4 2.8c-.6.3-1 .9-1 1.6V14m0 3h.01",
  play: "M6 4v16l14-8Z",
  pause: "M7 4h3v16H7zM14 4h3v16h-3z",
  stop: "M6 6h12v12H6z",
  check: "M20 6 9 17l-5-5",
  x: "M18 6 6 18M6 6l12 12",
  refresh: "M21 12a9 9 0 0 1-15.5 6.3L3 16m0 5v-5h5M3 12A9 9 0 0 1 18.5 5.7L21 8m0-5v5h-5",
  download: "M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3",
  upload: "M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M17 8l-5-5-5 5M12 3v12",
  shield: "M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z",
  power: "M18.4 6.6a9 9 0 1 1-12.8 0M12 2v10",
  plus: "M12 5v14M5 12h14",
  trash: "M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14",
  edit: "M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z",
  up: "M18 15l-6-6-6 6",
  down: "M6 9l6 6 6-6",
  copy: "M8 8h12v12H8zM4 16V4h12",
  external: "M15 3h6v6M10 14 21 3M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6",
  moon: "M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8Z",
  sun: "M12 17a5 5 0 1 0 0-10 5 5 0 0 0 0 10ZM12 1v2M12 21v2M4.2 4.2l1.4 1.4M18.4 18.4l1.4 1.4M1 12h2M21 12h2M4.2 19.8l1.4-1.4M18.4 5.6l1.4-1.4",
  github: "M9 19c-5 1.5-5-2.5-7-3m14 6v-3.9a3.4 3.4 0 0 0-.9-2.6c3.1-.4 6.4-1.5 6.4-7a5.4 5.4 0 0 0-1.5-3.8 5 5 0 0 0-.1-3.8s-1.2-.4-3.9 1.5a13.4 13.4 0 0 0-7 0C6.3 1.5 5.1 1.9 5.1 1.9a5 5 0 0 0-.1 3.8A5.4 5.4 0 0 0 3.5 9.5c0 5.4 3.3 6.6 6.4 7a3.4 3.4 0 0 0-.9 2.6V23",
  discord: "M8 12a1 1 0 1 0 0 .01M16 12a1 1 0 1 0 0 .01M7.5 7.5c3-1 6-1 9 0M7 16.5c3 1.5 7 1.5 10 0M15.5 17.5 17 20c2-.7 3.6-1.8 5-3.3.4-4.6-.7-8.6-3-12.2A16 16 0 0 0 15 3l-.6 1.3M8.5 17.5 7 20c-2-.7-3.6-1.8-5-3.3-.4-4.6.7-8.6 3-12.2A16 16 0 0 1 9 3l.6 1.3",
  coffee: "M17 8h1a4 4 0 1 1 0 8h-1M3 8h14v9a4 4 0 0 1-4 4H7a4 4 0 0 1-4-4ZM6 1v3M10 1v3M14 1v3",
  history: "M3 12a9 9 0 1 0 3-6.7L3 8M3 3v5h5M12 7v5l4 2",
  layers: "M12 2 2 7l10 5 10-5ZM2 17l10 5 10-5M2 12l10 5 10-5",
  shuffle: "M16 3h5v5M4 20 21 3M21 16v5h-5M15 15l6 6M4 4l5 5",
  wifi: "M5 12.6a10 10 0 0 1 14 0M8.5 16.1a5 5 0 0 1 7 0M12 20h.01M2 8.8a15 15 0 0 1 20 0",
  key: "M21 2l-2 2m-7.6 7.6a5.5 5.5 0 1 1-7.8 7.8 5.5 5.5 0 0 1 7.8-7.8Zm0 0L15.5 7.5m0 0 3 3L22 7l-3-3m-3.5 3.5L19 4",
};

export function icon(name, size = 18) {
  return h("svg", { viewBox: "0 0 24 24", width: size, height: size, fill: "none", stroke: "currentColor", "stroke-width": "1.8", "stroke-linecap": "round", "stroke-linejoin": "round", "aria-hidden": "true" }, h("path", { d: ICONS[name] || ICONS.help }));
}

export function logo(size = 40) {
  return h("img", { src: chrome.runtime.getURL("assets/logo.svg"), width: size, height: size, alt: "", class: "logo" });
}

// ------------------------------------------------------------------ formattazione

export const fmtEuro = (n, cur = "EUR") => (n == null ? "—" : new Intl.NumberFormat("it-IT", { style: "currency", currency: cur || "EUR" }).format(Number(n)));
export const fmtNum = (n) => (n == null ? "—" : new Intl.NumberFormat("it-IT").format(n));
export const fmtDate = (t) => (t ? new Date(t).toLocaleString("it-IT", { dateStyle: "short", timeStyle: "short" }) : "—");
export const fmtDay = (t) => (t ? new Date(t).toLocaleDateString("it-IT") : "—");
export function ago(t) {
  if (!t) return "mai";
  const s = Math.round((Date.now() - t) / 1000);
  if (s < 0) return `tra ${countdown(-s * 1000)}`;
  if (s < 45) return "ora";
  if (s < 3600) return `${Math.round(s / 60)} min fa`;
  if (s < 86400) return `${Math.round(s / 3600)} h fa`;
  return `${Math.round(s / 86400)} g fa`;
}
export function countdown(ms) {
  if (ms == null) return "—";
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s} s`;
  if (s < 3600) return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
  return `${Math.floor(s / 3600)} h ${Math.floor((s % 3600) / 60)} min`;
}
export function duration(ms) {
  if (!ms) return "0 min";
  const m = Math.round(ms / 60000);
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`;
}

export const STATUS = {
  draft: ["Bozza", ""], ready: ["Pronta", "info"], running: ["In esecuzione", "good"], paused: ["In pausa", "warn"],
  stopped: ["Interrotta", "bad"], completed: ["Completata", "info"],
  never: ["Mai elaborato", ""], prepared: ["Preparato", ""], waiting: ["In attesa", ""], completedOp: ["Completato", "good"],
  simulatedOp: ["Simulato", "info"], failed: ["Fallito", "bad"], verify: ["Da verificare", "warn"], cancelled: ["Annullato", ""], skipped: ["Saltato", ""],
};
export function statusPill(status, kind = "campaign", simulated = false) {
  const key = kind === "op" && status === "completed" ? (simulated ? "simulatedOp" : "completedOp") : kind === "op" && status === "running" ? "running" : status;
  const [label, cls] = STATUS[key] || [status, ""];
  return h("span", { class: `pill ${cls}` }, label);
}

// ------------------------------------------------------------------ avvisi, finestre, glossario

let toastHost = null;
export function toast(title, body = "", level = "info", ms = 5000) {
  if (!toastHost) {
    toastHost = h("div", { class: "toasts", role: "status", "aria-live": "polite" });
    document.body.append(toastHost);
  }
  const t = h("div", { class: `toast ${level}` }, h("b", {}, title), body ? h("div", { class: "muted small" }, body) : null,
    h("button", { class: "btn ghost sm toast-x", "aria-label": "Chiudi", onclick: () => t.remove() }, icon("x", 14)));
  toastHost.append(t);
  if (level !== "critical") setTimeout(() => t.remove(), ms);
  while (toastHost.children.length > 5) toastHost.firstChild.remove();
}

export function modal(title, content, actions = [], { wide = false } = {}) {
  return new Promise((resolve) => {
    const prevFocus = document.activeElement;
    const close = (v) => { back.remove(); document.removeEventListener("keydown", onKey); prevFocus?.focus?.(); resolve(v); };
    const onKey = (e) => { if (e.key === "Escape") close(null); };
    const box = h("div", { class: `modal ${wide ? "wide" : ""}`, role: "dialog", "aria-modal": "true", "aria-label": title },
      h("div", { class: "modal-head" }, h("h2", {}, title), h("button", { class: "btn ghost sm", "aria-label": "Chiudi", onclick: () => close(null) }, icon("x"))),
      h("div", { class: "modal-body" }, content),
      actions.length ? h("div", { class: "modal-foot" }, actions.map((a) => h("button", { class: `btn ${a.cls || ""}`, onclick: async () => {
        if (a.handler) { const r = await a.handler(); if (r === false) return; close(r ?? a.value); } else close(a.value);
      } }, a.label))) : null);
    const back = h("div", { class: "modal-back", onclick: (e) => { if (e.target === back) close(null); } }, box);
    document.body.append(back);
    document.addEventListener("keydown", onKey);
    setTimeout(() => (box.querySelector("input, select, textarea, .modal-foot .btn.primary") || box.querySelector("button"))?.focus(), 30);
  });
}

export const confirmBox = (title, text, okLabel = "Conferma", danger = false) =>
  modal(title, h("p", {}, text), [{ label: "Annulla", value: false }, { label: okLabel, value: true, cls: danger ? "danger" : "primary" }]);

/** Termine con spiegazione al passaggio del mouse o al focus. */
export function term(word, label = word) {
  return h("abbr", { "data-tip": GLOSSARY[word] || word, tabindex: "0" }, label);
}

export function installTooltips() {
  let tip = null;
  const show = (e) => {
    const t = e.target.closest?.("[data-tip]");
    if (!t) return;
    tip?.remove();
    tip = h("div", { class: "tip", role: "tooltip" }, t.getAttribute("data-tip"));
    document.body.append(tip);
    const r = t.getBoundingClientRect();
    tip.style.left = `${Math.min(innerWidth - tip.offsetWidth - 8, Math.max(8, r.left))}px`;
    tip.style.top = `${r.bottom + 8 + tip.offsetHeight > innerHeight ? r.top - tip.offsetHeight - 8 : r.bottom + 8}px`;
  };
  const hide = (e) => { if (e.target.closest?.("[data-tip]")) { tip?.remove(); tip = null; } };
  document.addEventListener("mouseover", show);
  document.addEventListener("focusin", show);
  document.addEventListener("mouseout", hide);
  document.addEventListener("focusout", hide);
}

export async function copyText(text) {
  try { await navigator.clipboard.writeText(text); toast("Copiato negli appunti", "", "success", 2000); }
  catch { toast("Copia non riuscita", "Seleziona il testo e copialo a mano.", "warning"); }
}

export function downloadJson(obj, name) {
  const blob = new Blob([JSON.stringify(obj, null, 2)], { type: "application/json" });
  const a = h("a", { href: URL.createObjectURL(blob), download: name });
  document.body.append(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}

export function downloadText(text, name, type = "text/csv;charset=utf-8") {
  const blob = new Blob(["﻿" + text], { type });
  const a = h("a", { href: URL.createObjectURL(blob), download: name });
  document.body.append(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}

// ------------------------------------------------------------------ grafici (SVG, tooltip al passaggio)

/**
 * Linee per serie giornaliere. Legenda sempre presente (>= 2 serie), etichetta
 * diretta sull'ultimo punto, crosshair con tooltip, tabella accessibile.
 */
export function lineChart(days, series, { height = 220 } = {}) {
  const W = 640;
  const H = height;
  const pad = { l: 34, r: 74, t: 12, b: 26 };
  const max = Math.max(1, ...series.flatMap((s) => s.values));
  const nice = max <= 5 ? 5 : Math.ceil(max / 5) * 5;
  const x = (i) => pad.l + (days.length <= 1 ? 0 : (i * (W - pad.l - pad.r)) / (days.length - 1));
  const y = (v) => pad.t + (1 - v / nice) * (H - pad.t - pad.b);
  const svg = h("svg", { viewBox: `0 0 ${W} ${H}`, class: "chart", role: "img", "aria-label": `Grafico: ${series.map((s) => s.name).join(", ")}` });
  for (let k = 0; k <= 4; k++) {
    const v = (nice / 4) * k;
    svg.append(h("line", { x1: pad.l, x2: W - pad.r, y1: y(v), y2: y(v), class: "grid-line" }), h("text", { x: pad.l - 6, y: y(v) + 4, class: "axis", "text-anchor": "end" }, String(Math.round(v))));
  }
  const step = Math.max(1, Math.ceil(days.length / 7));
  days.forEach((d, i) => { if (i % step === 0 || i === days.length - 1) svg.append(h("text", { x: x(i), y: H - 6, class: "axis", "text-anchor": "middle" }, d.slice(8, 10) + "/" + d.slice(5, 7))); });
  for (const s of series) {
    const pts = s.values.map((v, i) => `${x(i)},${y(v)}`).join(" ");
    svg.append(h("polyline", { points: pts, fill: "none", stroke: s.color, "stroke-width": 2, "stroke-linejoin": "round", "stroke-linecap": "round" }));
    const last = s.values.length - 1;
    if (last >= 0) {
      svg.append(h("circle", { cx: x(last), cy: y(s.values[last]), r: 4, fill: s.color, stroke: "var(--surface)", "stroke-width": 2 }));
      svg.append(h("text", { x: x(last) + 8, y: y(s.values[last]) + 4, class: "direct-label" }, `${s.name} ${s.values[last]}`));
    }
  }
  const cross = h("line", { y1: pad.t, y2: H - pad.b, class: "crosshair", style: { display: "none" } });
  svg.append(cross);
  const tipBox = h("div", { class: "chart-tip", style: { display: "none" } });
  const hit = h("rect", { x: pad.l, y: pad.t, width: W - pad.l - pad.r, height: H - pad.t - pad.b, fill: "transparent" });
  svg.append(hit);
  const wrap = h("div", { class: "chart-wrap" }, svg, tipBox);
  hit.addEventListener("mousemove", (e) => {
    const r = svg.getBoundingClientRect();
    const rel = ((e.clientX - r.left) / r.width) * W;
    const i = Math.max(0, Math.min(days.length - 1, Math.round(((rel - pad.l) / (W - pad.l - pad.r)) * (days.length - 1))));
    cross.setAttribute("x1", x(i)); cross.setAttribute("x2", x(i)); cross.style.display = "";
    tipBox.replaceChildren(h("b", {}, new Date(days[i]).toLocaleDateString("it-IT", { weekday: "short", day: "numeric", month: "short" })),
      ...series.map((s) => h("div", { class: "row small" }, h("span", { class: "swatch", style: { background: s.color } }), h("span", { class: "grow" }, s.name), h("b", {}, String(s.values[i])))));
    tipBox.style.display = "";
    tipBox.style.left = `${Math.min(r.width - 170, (x(i) / W) * r.width + 12)}px`;
  });
  hit.addEventListener("mouseleave", () => { cross.style.display = "none"; tipBox.style.display = "none"; });
  const legend = h("div", { class: "legend" }, series.map((s) => h("span", { class: "row small" }, h("span", { class: "swatch", style: { background: s.color } }), s.name)));
  const table = h("details", { class: "chart-table" }, h("summary", { class: "small muted" }, "Vedi i dati in tabella"),
    h("table", { class: "table" }, h("thead", {}, h("tr", {}, h("th", {}, "Giorno"), series.map((s) => h("th", {}, s.name)))),
      h("tbody", {}, days.map((d, i) => h("tr", {}, h("td", {}, d), series.map((s) => h("td", {}, String(s.values[i]))))))));
  return h("div", {}, legend, wrap, table);
}

/** Barre orizzontali (attività per account / campagna): un solo colore, valore scritto. */
export function barList(rows, color = "var(--s-offer)") {
  const max = Math.max(1, ...rows.map((r) => r.value));
  if (!rows.length) return h("div", { class: "empty small" }, "Nessun dato nel periodo.");
  return h("div", { class: "bars" }, rows.map((r) => h("div", { class: "bar-row", title: `${r.label}: ${r.value}` },
    h("span", { class: "bar-label" }, r.label),
    h("span", { class: "bar-track" }, h("i", { style: { width: `${(r.value / max) * 100}%`, background: color } })),
    h("b", { class: "bar-val" }, String(r.value)))));
}
