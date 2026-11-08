/**
 * AI Contextual Commenting — suggerimenti di domande pertinenti all'annuncio.
 *
 * Due motori:
 *  - "local": regole sul titolo, sulla descrizione e sulla categoria. Gira nel
 *    browser, gratis, senza mandare dati a nessuno.
 *  - "api": un endpoint compatibile OpenAI (servizio esterno o LLM locale come
 *    Ollama/LM Studio). Qui ci sono solo il prompt e la lettura della risposta.
 *
 * Domande al venditore: usate dalla fonte «Domanda sull'annuncio» dei messaggi privati,
 * oppure copiate a mano dalla pagina «Domande al venditore».
 */

const RULES = [
  { re: /giacc|giubbott|cappott|blazer|jacket|coat|veste|manteau|chaqueta|abrigo|jacke|mantel|parka|piumin/i,
    it: ["Potresti indicarmi la misura delle spalle?", "Quanto misura la lunghezza dal colletto all'orlo?", "Le maniche quanto sono lunghe?", "La fodera interna è in buone condizioni?"],
    en: ["Could you tell me the shoulder width?", "What's the length from collar to hem?", "How long are the sleeves?", "Is the inner lining in good condition?"] },
  { re: /scarp|sneaker|stival|sandal|shoe|boot|chaussure|basket|zapat|schuh|mocassin|décollet/i,
    it: ["Quanto misura la soletta interna in cm?", "La suola ha segni di usura?", "Calzano regolari o piccole?", "Hanno ancora la scatola originale?"],
    en: ["What's the insole length in cm?", "Does the sole show any wear?", "Do they fit true to size?", "Do they come with the original box?"] },
  { re: /jeans|pantalon|trouser|pants|vaquer|hose|shorts|gonna|skirt|jupe|falda|rock/i,
    it: ["Potresti dirmi la misura del giro vita da steso?", "Quanto è lunga la gamba interna?", "Il tessuto è elasticizzato?"],
    en: ["Could you give me the waist measurement laid flat?", "What's the inseam length?", "Is the fabric stretchy?"] },
  { re: /libr|manga|fumett|romanz|book|livre|libro|buch|volume|edizion/i,
    it: ["Di che edizione si tratta?", "Ci sono sottolineature o pagine rovinate?", "La copertina ha pieghe o segni?"],
    en: ["Which edition is it?", "Are there any underlined or damaged pages?", "Does the cover have creases or marks?"] },
  { re: /borsa|zaino|bag|backpack|sac|bolso|tasche|pochette|marsupio/i,
    it: ["Quali sono le dimensioni (larghezza, altezza, profondità)?", "L'interno è pulito e senza macchie?", "La tracolla è regolabile?"],
    en: ["What are the dimensions (width, height, depth)?", "Is the inside clean and stain-free?", "Is the strap adjustable?"] },
  { re: /maglion|maglia|felpa|t-shirt|camicia|shirt|pull|sweater|hoodie|jersey|top|cardigan/i,
    it: ["Potresti indicarmi la larghezza sotto le ascelle?", "Ci sono pallini o segni di usura sul tessuto?", "Veste regolare o abbondante?"],
    en: ["Could you tell me the pit-to-pit width?", "Is there any pilling or wear on the fabric?", "Does it fit true to size or oversized?"] },
  { re: /abito|vestit|dress|robe|kleid/i,
    it: ["Quanto misura la lunghezza totale?", "Ha la cerniera o si infila?", "Il tessuto è trasparente alla luce?"],
    en: ["What's the total length?", "Does it have a zip or is it pull-on?", "Is the fabric see-through?"] },
];

const GENERIC = {
  it: ["Ci sono difetti non visibili nelle foto?", "Potresti mandarmi una foto dell'etichetta?", "È stato usato molto o poco?", "Da casa con animali o fumatori?", "Potresti fare una foto con luce naturale?"],
  en: ["Are there any flaws not visible in the photos?", "Could you send a photo of the label?", "Has it been used a lot?", "Is it from a pet-free and smoke-free home?", "Could you take a photo in natural light?"],
};

const MISSING = {
  measures: { it: "Potresti indicarmi le misure principali in cm?", en: "Could you share the main measurements in cm?" },
  condition: { it: "In che condizioni è? Ci sono segni di usura?", en: "What condition is it in? Any signs of wear?" },
};

const TONE = {
  cordiale: { it: ["Ciao! ", "Ciao, ", ""], en: ["Hi! ", "Hello, ", ""], suffix: { it: [" Grazie!", " Grazie mille!", ""], en: [" Thanks!", " Thank you!", ""] } },
  formale: { it: ["Buongiorno, ", "Salve, "], en: ["Good morning, ", "Hello, "], suffix: { it: [" La ringrazio.", " Grazie."], en: [" Thank you.", " Many thanks."] } },
  diretto: { it: [""], en: [""], suffix: { it: [""], en: [""] } },
};

const lower1 = (s) => s.charAt(0).toLowerCase() + s.slice(1);

/** Suggerimenti locali. `history` = testi già suggeriti di recente, da non ripetere. */
export function suggestLocal(listing, opts = {}) {
  const lang = opts.language === "en" ? "en" : "it";
  const tone = TONE[opts.tone] ? opts.tone : "cordiale";
  const count = Math.max(1, Math.min(8, Number(opts.count) || 3));
  const recent = new Set((opts.history || []).map((t) => t.toLowerCase()));
  const text = `${listing?.title || ""} ${listing?.category || ""} ${listing?.description || ""}`;
  const desc = String(listing?.description || "");
  const pool = [];
  const rule = RULES.find((r) => r.re.test(text));
  if (rule) pool.push(...rule[lang]);
  if (desc && !/\d\s?cm\b|misur|measure/i.test(desc)) pool.push(MISSING.measures[lang]);
  if (desc.length < 60) pool.push(MISSING.condition[lang]);
  pool.push(...GENERIC[lang]);

  const seen = new Set();
  const out = [];
  const seed = String(listing?.id || "0").split("").reduce((a, c) => a + c.charCodeAt(0), 0);
  for (let i = 0; i < pool.length && out.length < count; i++) {
    const q = pool[i];
    if (seen.has(q)) continue;
    seen.add(q);
    const pre = TONE[tone][lang][(seed + i) % TONE[tone][lang].length];
    const suf = TONE[tone].suffix[lang][(seed + i) % TONE[tone].suffix[lang].length];
    const full = `${pre}${pre && pre.endsWith(", ") ? lower1(q) : q}${suf}`.trim();
    if (recent.has(full.toLowerCase())) continue;
    out.push(full);
  }
  return out;
}

/** Prompt per un LLM (endpoint compatibile OpenAI). Solo dati pubblici dell'annuncio. */
export function buildPrompt(listing, opts = {}) {
  const lang = opts.language === "en" ? "inglese" : "italiano";
  const count = Math.max(1, Math.min(8, Number(opts.count) || 3));
  return [
    { role: "system", content: `Sei un assistente che aiuta un acquirente su Vinted a fare domande utili e oneste al venditore. Scrivi in ${lang}, tono ${opts.tone || "cordiale"}. Ogni domanda massimo 140 caratteri. Niente spam, niente link, niente promesse, niente contenuti ingannevoli. Rispondi SOLO con un array JSON di ${count} stringhe.` },
    { role: "user", content: JSON.stringify({ titolo: listing?.title || "", descrizione: String(listing?.description || "").slice(0, 1200), categoria: listing?.category || "", marca: listing?.brand || "", taglia: listing?.size || "", prezzo: listing?.price ?? null }) },
  ];
}

/** Legge la risposta del modello: array JSON, oppure righe numerate come ripiego. */
export function parseSuggestions(text, count = 3) {
  const t = String(text || "").trim();
  let arr = null;
  const m = t.match(/\[[\s\S]*\]/);
  if (m) { try { arr = JSON.parse(m[0]); } catch { arr = null; } }
  if (!Array.isArray(arr)) arr = t.split(/\r?\n/).map((l) => l.replace(/^\s*(\d+[.)]|[-*•])\s*/, "").trim()).filter(Boolean);
  return arr
    .filter((s) => typeof s === "string")
    .map((s) => s.replace(/https?:\/\/\S+/g, "").trim())
    .filter((s) => s.length >= 5 && s.length <= 200)
    .slice(0, count);
}
