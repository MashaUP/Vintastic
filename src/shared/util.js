/** Utility pure condivise. */

export const uid = (prefix = "") =>
  prefix + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

export const clamp = (n, min, max) => Math.min(max, Math.max(min, n));

/** Intero casuale in [min, max] (estremi inclusi). rng opzionale per i test. */
export function randInt(min, max, rng = Math.random) {
  const lo = Math.ceil(Math.min(min, max));
  const hi = Math.floor(Math.max(min, max));
  return lo + Math.floor(rng() * (hi - lo + 1));
}

/** Generatore pseudo-casuale con seme (mulberry32): stessi semi, stesso ordine. */
export function seededRng(seed) {
  let a = (Number(seed) >>> 0) || 1;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Giorno locale YYYY-MM-DD (per i contatori giornalieri). */
export function dayKey(ts = Date.now()) {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** Prossima mezzanotte locale (quando si azzerano i contatori). */
export function nextMidnight(ts = Date.now()) {
  const d = new Date(ts);
  d.setHours(24, 0, 0, 0);
  return d.getTime();
}

export const euro = (n, currency = "EUR") => {
  if (n == null || Number.isNaN(Number(n))) return "—";
  try {
    return new Intl.NumberFormat("it-IT", { style: "currency", currency }).format(Number(n));
  } catch {
    return `${Number(n).toFixed(2)} ${currency}`;
  }
};

export function duration(ms) {
  if (ms == null || ms < 0) return "—";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min ${s % 60 ? `${s % 60} s` : ""}`.trim();
  const h = Math.floor(m / 60);
  if (h < 48) return `${h} h ${m % 60 ? `${m % 60} min` : ""}`.trim();
  return `${Math.floor(h / 24)} g`;
}

export function ago(ts, now = Date.now()) {
  if (!ts) return "mai";
  const s = Math.round((now - ts) / 1000);
  if (s < 0) return "tra " + duration(-s * 1000);
  if (s < 45) return "ora";
  if (s < 3600) return `${Math.round(s / 60)} min fa`;
  if (s < 86400) return `${Math.round(s / 3600)} h fa`;
  return `${Math.round(s / 86400)} g fa`;
}

export const fmtDate = (ts) => (ts ? new Date(ts).toLocaleString("it-IT", { dateStyle: "short", timeStyle: "short" }) : "—");

export async function sha256Hex(data) {
  const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Hash stabile (ordinamento delle chiavi) di un oggetto JSON. */
export function stableStringify(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(",")}}`;
}

export function isPlainObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/** Unione profonda: i valori di `patch` vincono, gli array vengono sostituiti. */
export function deepMerge(base, patch) {
  if (!isPlainObject(base)) return patch === undefined ? base : patch;
  if (!isPlainObject(patch)) return patch === undefined ? base : patch;
  const out = { ...base };
  for (const [k, v] of Object.entries(patch)) out[k] = isPlainObject(v) && isPlainObject(base[k]) ? deepMerge(base[k], v) : v;
  return out;
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Id numerico di un annuncio da URL o testo. */
export function listingIdFrom(value) {
  const m = String(value ?? "").match(/\/items\/(\d+)/) || String(value ?? "").match(/^(\d{4,})$/);
  return m ? m[1] : null;
}

/** Id del venditore da URL dell'armadio (/member/123-nome). */
export function memberIdFrom(value) {
  const m = String(value ?? "").match(/\/member\/(?:general\/)?(\d+)/) || String(value ?? "").match(/^(\d{2,})$/);
  return m ? m[1] : null;
}

export function originFrom(url) {
  try { return new URL(url).origin; } catch { return null; }
}
