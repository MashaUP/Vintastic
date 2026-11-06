/**
 * Filtri sugli annunci: recenza, Top N, ricerca, prezzo, stato, ordinamenti.
 * Le date sono tenute separate (pubblicazione, aggiornamento, ripubblicazione,
 * data della foto) e un annuncio senza la data scelta NON viene inventato:
 * esce dal filtro temporale e viene contato a parte.
 */

import { seededRng } from "./util.js";

export const DATE_FIELDS = {
  auto: "Pubblicazione (se manca: data della foto, stima)",
  publishedAt: "Data di pubblicazione",
  updatedAt: "Data di aggiornamento",
  repostedAt: "Data di ripubblicazione",
  photoAt: "Data della foto principale (stima)",
};

export const RANGES = {
  all: { label: "Qualsiasi data", ms: null },
  "24h": { label: "Ultime 24 ore", ms: 24 * 3600e3 },
  "2d": { label: "Ultimi 2 giorni", ms: 2 * 86400e3 },
  "3d": { label: "Ultimi 3 giorni", ms: 3 * 86400e3 },
  "7d": { label: "Ultimi 7 giorni", ms: 7 * 86400e3 },
  "14d": { label: "Ultimi 14 giorni", ms: 14 * 86400e3 },
  "30d": { label: "Ultimi 30 giorni", ms: 30 * 86400e3 },
  custom: { label: "Intervallo personalizzato", ms: null },
};

export const TOP_N = [5, 10, 20, 50, 100];

export const SORTS = {
  manual: "Ordine manuale",
  newest: "Più recenti prima",
  oldest: "Meno recenti prima",
  priceAsc: "Prezzo crescente",
  priceDesc: "Prezzo decrescente",
  random: "Casuale",
};

export function dateOf(listing, field = "auto") {
  if (field === "auto") return dateOf(listing, "publishedAt") ?? dateOf(listing, "photoAt");
  const v = listing?.[field];
  return Number.isFinite(v) && v > 0 ? v : null;
}

/**
 * Dal più recente: per data (campo scelto); a parità o senza data, l'ordine in cui
 * Vinted ha restituito l'armadio («più recenti prima», scanRank).
 */
export function newestFirst(field = "auto") {
  return (a, b) => {
    const da = dateOf(a, field);
    const db = dateOf(b, field);
    if (da != null && db != null && da !== db) return db - da;
    if (da != null && db == null) return -1;
    if (da == null && db != null) return 1;
    return (a.scanRank ?? Infinity) - (b.scanRank ?? Infinity);
  };
}

/**
 * Applica i filtri combinati. Ordine: stato/ricerca/prezzo → intervallo → Top N.
 * @returns {{items:Array, noDate:number, total:number}}
 */
export function applyFilters(listings, f = {}, now = Date.now()) {
  const field = DATE_FIELDS[f.dateField] ? f.dateField : "auto";
  let out = listings.slice();
  const total = out.length;

  if (f.sellerId) out = out.filter((l) => String(l.sellerId) === String(f.sellerId));
  if (f.status && f.status !== "all") out = out.filter((l) => (l.status || "active") === f.status);
  if (f.search) {
    const q = f.search.toLowerCase();
    out = out.filter((l) => [l.title, l.brand, l.sellerLogin, l.id].some((x) => String(x ?? "").toLowerCase().includes(q)));
  }
  if (f.priceMin != null && f.priceMin !== "") out = out.filter((l) => Number(l.price) >= Number(f.priceMin));
  if (f.priceMax != null && f.priceMax !== "") out = out.filter((l) => Number(l.price) <= Number(f.priceMax));
  if (f.excludeKeys instanceof Set) out = out.filter((l) => !f.excludeKeys.has(String(l.id)));

  let noDate = 0;
  const range = f.range || "all";
  if (range !== "all") {
    let from = null;
    let to = null;
    if (range === "custom") {
      from = f.from ? Number(f.from) : null;
      to = f.to ? Number(f.to) : null;
    } else if (RANGES[range]?.ms) {
      from = now - RANGES[range].ms;
    }
    out = out.filter((l) => {
      const d = dateOf(l, field);
      if (d == null) { noDate++; return false; }
      return (from == null || d >= from) && (to == null || d <= to);
    });
  }

  const n = Number(f.topN);
  if (Number.isFinite(n) && n > 0) {
    // I più recenti: per data, poi nell'ordine di Vinted per gli annunci senza data (mai date inventate).
    const sorted = out.slice().sort(newestFirst(field));
    const usable = sorted.filter((l) => dateOf(l, field) != null || l.scanRank != null);
    if (range === "all") noDate += sorted.length - usable.length;
    out = usable.slice(0, Math.floor(n));
  }
  return { items: out, noDate, total };
}

/** Ordina elementi (annunci o elementi di coda con .listing). Il casuale è riproducibile col seme. */
export function sortItems(items, mode = "manual", seed = 1, pick = (x) => x.listing || x) {
  const arr = items.slice();
  switch (mode) {
    case "newest": { const cmp = newestFirst("auto"); return arr.sort((a, b) => cmp(pick(a), pick(b))); }
    case "oldest": { const cmp = newestFirst("auto"); return arr.sort((a, b) => cmp(pick(b), pick(a))); }
    case "priceAsc": return arr.sort((a, b) => Number(pick(a).price ?? 0) - Number(pick(b).price ?? 0));
    case "priceDesc": return arr.sort((a, b) => Number(pick(b).price ?? 0) - Number(pick(a).price ?? 0));
    case "random": {
      const rng = seededRng(seed);
      for (let i = arr.length - 1; i > 0; i--) {
        const j = Math.floor(rng() * (i + 1));
        [arr[i], arr[j]] = [arr[j], arr[i]];
      }
      return arr;
    }
    default: return arr;
  }
}
