/**
 * Normalizzazione degli annunci letti da Vinted (API dell'armadio o pagina).
 * Vinted ha cambiato forma alle risposte più volte: qui si accettano le varianti
 * note e si lascia null tutto ciò che non c'è. Nessuna data viene inventata.
 */

const num = (v) => {
  if (v == null || v === "") return null;
  if (typeof v === "object") return num(v.amount ?? v.value);
  const n = Number(String(v).replace(",", ".").replace(/[^\d.-]/g, ""));
  return Number.isFinite(n) ? n : null;
};

/** Timestamp in ms da secondi, millisecondi o stringa ISO. */
export const ts = (v) => {
  if (v == null || v === "") return null;
  if (typeof v === "number") return v > 1e12 ? v : v > 1e9 ? v * 1000 : null;
  if (/^\d+$/.test(String(v))) return ts(Number(v));
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : null;
};

function statusOf(raw) {
  if (raw.is_closed || raw.item_closing_action === "sold" || raw.status === "sold" || raw.is_sold) return "sold";
  if (raw.is_reserved || raw.reserved) return "reserved";
  if (raw.is_hidden || raw.is_draft || raw.is_visible === false || raw.is_visible === 0) return "hidden";
  return "active";
}

export function normalizeListing(raw, origin, extra = {}) {
  if (!raw || raw.id == null) return null;
  const id = String(raw.id);
  const photos = Array.isArray(raw.photos) ? raw.photos : raw.photo ? [raw.photo] : [];
  const mainPhoto = photos[0] || raw.photo || null;
  const photoUrl = mainPhoto?.url || mainPhoto?.full_size_url || mainPhoto?.thumbnails?.find?.((t) => t.type === "thumb310x430")?.url || raw.image || null;
  const path = raw.path || (raw.url && !/^https?:/.test(raw.url) ? raw.url : null);
  const url = raw.url && /^https?:/.test(raw.url) ? raw.url : path ? `${origin}${path}` : `${origin}/items/${id}`;
  const price = num(raw.price ?? raw.price_numeric ?? raw.total_item_price);
  const currency = raw.price?.currency_code || raw.currency || raw.price_currency || "EUR";
  const user = raw.user || {};
  return {
    id,
    url,
    origin,
    title: String(raw.title || "").slice(0, 300),
    description: raw.description != null ? String(raw.description).slice(0, 5000) : null,
    price,
    currency,
    photo: photoUrl,
    photos: photos.map((p) => p?.url).filter(Boolean).slice(0, 10),
    photoKey: mainPhoto?.id ? String(mainPhoto.id) : (photoUrl ? String(photoUrl).split("?")[0].split("/").slice(-2).join("/") : null),
    sellerId: user.id != null ? String(user.id) : raw.user_id != null ? String(raw.user_id) : extra.sellerId || null,
    sellerLogin: user.login || raw.user_login || extra.sellerLogin || null,
    brand: raw.brand_title || raw.brand?.title || raw.brand || null,
    size: raw.size_title || raw.size || null,
    category: raw.catalog_title || raw.category || (raw.catalog_id != null ? `cat ${raw.catalog_id}` : null),
    status: statusOf(raw),
    favouriteCount: num(raw.favourite_count ?? raw.favorite_count),
    viewCount: num(raw.view_count),
    isFavourite: typeof raw.is_favourite === "boolean" ? raw.is_favourite : null,
    // Date: separate, mai dedotte l'una dall'altra.
    publishedAt: ts(raw.created_at_ts ?? raw.created_at),
    updatedAt: ts(raw.updated_at_ts ?? raw.updated_at),
    repostedAt: ts(raw.last_push_up_at ?? raw.pushed_up_at ?? raw.push_up?.at),
    photoAt: ts(mainPhoto?.high_resolution?.timestamp),
    scannedBy: extra.scannedBy || null,
    scanRank: null,
  };
}

/** Unisce la lettura nuova con quella salvata: conserva firstSeenAt, storico prezzi e collegamenti. */
export function mergeListing(prev, next, now = Date.now()) {
  if (!prev) return { ...next, firstSeenAt: now, lastSeenAt: now, priceHistory: next.price != null ? [{ at: now, price: next.price }] : [] };
  const out = { ...prev };
  for (const [k, v] of Object.entries(next)) if (v != null && !(Array.isArray(v) && !v.length)) out[k] = v;
  out.lastSeenAt = now;
  out.firstSeenAt = prev.firstSeenAt || now;
  const hist = prev.priceHistory || [];
  if (next.price != null && hist[hist.length - 1]?.price !== next.price) out.priceHistory = [...hist, { at: now, price: next.price }].slice(-30);
  return out;
}
