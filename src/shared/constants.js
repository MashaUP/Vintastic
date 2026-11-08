/**
 * Vintastic — costanti condivise (service worker, dashboard, popup, test).
 * Nessun accesso a chrome.* qui: il file deve poter girare anche in Node.
 */

export const APP_NAME = "Vintastic";
export const VERSION = "2.2.0";
export const REPO = "MashaUP/Vintastic";
export const DB_NAME = "vintastic";
export const DB_VERSION = 5;            // vedi migrations.js
export const EXPORT_SCHEMA = 1;          // formato dei file di backup

/** Domini Vinted supportati (devono coincidere con manifest.json: lo controlla scripts/check.mjs). */
export const VINTED_DOMAINS = [
  "vinted.it", "vinted.fr", "vinted.es", "vinted.de", "vinted.co.uk", "vinted.com",
  "vinted.be", "vinted.nl", "vinted.at", "vinted.pt", "vinted.pl", "vinted.cz",
  "vinted.sk", "vinted.lt", "vinted.lu", "vinted.ro", "vinted.hu",
];

export const isVintedOrigin = (origin) => {
  try {
    const u = new URL(origin);
    if (u.protocol !== "https:") return false;
    return VINTED_DOMAINS.some((d) => u.hostname === `www.${d}`);
  } catch {
    return false;
  }
};

/** Tipi di interazione. L'ordine è quello predefinito di esecuzione. (I «commenti» sono stati tolti nella 2.0.0: Vinted non li ha.) */
export const OP_TYPES = ["like", "offer", "message"];
export const OP_LABEL = { like: "Like", offer: "Offerta", message: "Messaggio privato" };

/** Moduli con circuit breaker, feature flag e kill switch dedicati. */
export const MODULES = {
  scanner: "Scanner armadi",
  like: "Like",
  offer: "Offerte",
  message: "Messaggi privati",
  notifCleaner: "Pulitore notifiche",
  overlay: "FAB e mini-widget",
  updates: "Aggiornamenti",
  discord: "Discord",
  ai: "AI esterna",
};

/** Etichette iniziali degli account (modificabili; non cambiano il comportamento). */
export const ACCOUNT_LABELS = [
  "Principale", "Secondario", "Personale", "Bot/Automazione autorizzata",
  "Test", "Backup", "Business", "Archivio", "Personalizzato",
];

export const GLOSSARY = {
  "Rate Limit": "Limite al numero di richieste in un certo tempo. Se Vinted lo segnala (errore 429), Vintastic si ferma.",
  "Scarto": "Elemento escluso da una campagna, per esempio perché già elaborato o venduto.",
  "Cron": "Controllo programmato che il browser ripete a intervalli (in Vintastic: chrome.alarms).",
  "Service Worker": "La parte dell'estensione che lavora in background. Chrome la sospende quando non serve: lo stato è sempre salvato su disco.",
  "Campaign": "Campagna: un elenco di annunci con le operazioni da fare su ognuno, i timer e le regole.",
  "Dry Run": "Simulazione: la campagna gira per intero ma non invia niente a Vinted.",
  "Retry": "Nuovo tentativo. Vintastic ripete solo operazioni fallite con esito certo, mai quelle dall'esito incerto.",
  "Circuit Breaker": "Interruttore automatico: dopo errori ripetuti un modulo si spegne da solo e lascia funzionare il resto.",
  "Ledger": "Registro globale delle interazioni: impedisce di ripetere lo stesso like, la stessa offerta o lo stesso messaggio.",
  "Snapshot": "Fotografia delle operazioni approvate. Se l'annuncio cambia, Vintastic chiede una nuova approvazione.",
};

/** Impostazioni predefinite. Ogni chiave nuova va aggiunta qui e in migrations.js se cambia forma. */
export const DEFAULT_SETTINGS = {
  schema: 5,
  onboardingDone: false,
  theme: "dark",                    // dark | light
  layout: "full",                   // full | compact
  dashboardWidgets: ["stats", "campaigns", "activity", "chart", "system", "queue"],
  killSwitch: false,
  moduleKill: {},                   // { like: true } = modulo spento a mano
  features: {                       // feature flags
    scanner: true, like: true, offer: true, message: true, notifCleaner: true,
    overlay: true, updates: true, discord: false, ai: false,
  },
  timers: {
    betweenOps: { min: 3, max: 8 },           // secondi, stesso annuncio
    betweenItems: { min: 10, max: 25 },       // secondi, annunci diversi
    transitions: {                             // secondi, per coppia di tipi
      "like>offer": { min: 3, max: 8 },
      "like>message": { min: 3, max: 8 },
      "offer>message": { min: 3, max: 8 },
      "message>like": { min: 3, max: 8 },
      "message>offer": { min: 3, max: 8 },
    },
    minFloor: 2,                               // nessun intervallo sotto questo valore
  },
  limits: {                         // soglie scelte dall'utente: NON sono limiti ufficiali di Vinted
    perDay: { like: 60, offer: 15, message: 10 },
    perAccountDay: 80,
    globalDay: 100,
  },
  openListingBeforeOp: true,        // naviga sulla pagina dell'annuncio prima dell'operazione
  backoffMinutes: [5, 15, 45],      // pause dopo 403/429; poi stop
  maxConsecutiveFailures: 3,        // per tipo: 3 errori di fila sospendono SOLO quel tipo nella campagna
  maxConsecutiveFailuresAll: 6,     // errori di fila di qualsiasi tipo: pausa dell'intera campagna
  opRetry: { attempts: 3, delaysSec: [30, 120] },   // un'operazione non partita si riprova più tardi, senza bloccare le altre
  campaignDefaults: { addPosition: "start", likeExisting: "relike" },        // «Posizione» predefinita quando si aggiungono annunci: In cima
  notifications: {
    enabled: true,
    system: true,                   // notifiche del sistema operativo
    durationSec: 6,
    categories: {
      campaignStart: true, campaignDone: true, campaignPaused: true, error: true,
      sessionExpired: true, newVersion: true, limitReached: true, connection: true, verify: true,
    },
  },
  overlay: { fab: true, widget: true, position: { right: 20, bottom: 20 }, scale: 1, collapsed: false },
  retention: { logsDays: 30, notificationsDays: 60, activityDays: 90, maxLogs: 5000 },
  updates: { autoCheck: true, everyHours: 12, repo: REPO, lastNotified: null },
  links: { autoRefresh: true },
  discord: { webhookUrl: "", events: { campaignDone: true, error: true, system: false, update: true } },
  ai: { provider: "local", endpoint: "", model: "", apiKey: "", language: "it", tone: "cordiale", count: 3 },
  offer: { defaultMode: "saving", defaultRules: null },
  messages: {                       // messaggi privati (vedi shared/messages.js)
    mode: "auto",                   // auto = A (Vintastic preme Invia) | manual = B (premi tu Invia)
    text: "Ciao! L'articolo è ancora disponibile? Grazie!",   // messaggio predefinito
    templates: [],                  // [{ id, name, text }] modelli riutilizzabili
    recipients: [],                 // [{ id, label }] venditori a cui si può scrivere: nessun altro
    manualWaitSeconds: 240,         // attesa dell'invio manuale (modalità B)
    focusTab: true,                 // scheda di Vinted in primo piano durante il messaggio (in background la chat può non caricarsi)
  },
};

/** Link del progetto (fallback locale di links.json, aggiornabile da GitHub). */
export const DEFAULT_LINKS = {
  github: { url: `https://github.com/${REPO}`, label: "GitHub" },
  discord: { url: "https://discord.gg/EPsbQCuAkx", label: "Discord" },
  kofi: { url: "https://ko-fi.com/mashaup", label: "Ko-fi" },
  documentation: { url: `https://github.com/${REPO}#readme`, label: "Guida" },
  changelog: { url: `https://github.com/${REPO}/blob/main/CHANGELOG.md`, label: "Novità" },
  bugReport: { url: `https://github.com/${REPO}/issues/new`, label: "Segnala un problema" },
};
