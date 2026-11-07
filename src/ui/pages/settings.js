/** Impostazioni: generali, timer, limiti, notifiche, overlay, AI, Discord, backup, dati, avanzate. */

import { h, icon, rpc, toast, modal, downloadJson, confirmBox, term } from "../lib.js";
import { MODULES } from "../../shared/constants.js";
import { EXPORT_PARTS } from "../../shared/schema.js";
import { startOnboarding } from "./onboarding.js";

const TABS = { general: "Generali", messages: "Messaggi", timers: "Timer", limits: "Limiti", notifications: "Notifiche", overlay: "FAB e widget", ai: "AI", discord: "Discord", backup: "Backup", data: "Dati", advanced: "Avanzate" };

export async function render(ctx) {
  const tab = TABS[ctx.route.query.tab] ? ctx.route.query.tab : "general";
  const s = ctx.settings = await rpc("settings.get");
  const save = async (patch, msg = "Salvato") => { ctx.settings = await rpc("settings.save", { patch }); toast(msg, "", "success", 1500); };
  const num = (val, fn, attrs = {}) => { const i = h("input", { class: "input", type: "number", value: val, style: { width: "100px" }, ...attrs }); i.addEventListener("change", () => fn(Number(i.value))); return i; };
  const check = (val, fn, label) => h("label", { class: "check" }, h("input", { type: "checkbox", checked: val, onchange: (e) => fn(e.target.checked) }), label);
  const range = (r, fn) => h("div", { class: "row" }, num(r.min, (v) => fn({ min: v, max: r.max }), { min: 0 }), "–", num(r.max, (v) => fn({ min: r.min, max: v }), { min: 0 }), h("span", { class: "muted small" }, "secondi"));

  const panes = {
    general: () => h("div", { class: "grid" },
      h("div", { class: "row" }, h("label", { class: "field" }, "Tema", sel({ dark: "Scuro", light: "Chiaro" }, s.theme, (v) => save({ theme: v }).then(() => { document.documentElement.dataset.theme = v; }))),
        h("label", { class: "field" }, "Layout", sel({ full: "Completo", compact: "Compatto" }, s.layout, (v) => save({ layout: v }).then(() => ctx.refresh())))),
      check(s.openListingBeforeOp, (v) => save({ openListingBeforeOp: v }), "Apri la pagina dell'annuncio prima di ogni operazione (consigliato: si vede cosa succede)"),
      check(s.links?.autoRefresh !== false, (v) => save({ links: { autoRefresh: v } }), "Aggiorna i link del progetto (Discord, Ko-fi…) da GitHub ogni 12 ore"),
      h("h3", {}, "Funzionalità (feature flags)"),
      h("div", { class: "three" }, Object.entries(MODULES).map(([k, label]) => check(s.features?.[k] !== false, (v) => save({ features: { [k]: v } }), label))),
      h("div", { class: "row" }, h("button", { class: "btn", onclick: () => startOnboarding(ctx, true) }, icon("play", 14), "Riavvia la guida iniziale"),
        check(s.onboardingDone, (v) => save({ onboardingDone: v }), "Non mostrare la guida all'avvio"))),

    messages: () => {
      const text = h("textarea", { class: "input", rows: 4, maxlength: 1000, value: s.messages?.text || "", placeholder: "Scrivi il messaggio da inviare ai venditori" });
      return h("div", { class: "grid" },
        h("p", { class: "small muted" }, "I messaggi vengono inviati solo agli annunci che aggiungi esplicitamente a una campagna e per cui selezioni «Messaggio privato». Vintastic non invia messaggi a caso né aggira CAPTCHA o verifiche."),
        h("label", { class: "field" }, "Modalità di invio", sel({ auto: "A — Automatica (predefinita)", manual: "B — Conferma manuale su Vinted" }, s.messages?.mode || "auto", (v) => save({ messages: { mode: v } })),
        h("span", { class: "small muted" }, "Automatica: invia e verifica il messaggio. Manuale: compila la chat e attende che tu prema Invia su Vinted.")),
        h("label", { class: "field" }, "Testo del messaggio", text),
        h("div", { class: "row" }, h("span", { class: "small muted grow" }, `${(s.messages?.text || "").length}/1000 caratteri`), h("button", { class: "btn primary", onclick: () => save({ messages: { text: text.value.trim() } }, "Messaggio salvato") }, "Salva messaggio")),
        h("div", { class: "callout warn small" }, h("b", {}, "Controllo invii. "), "La modalità manuale attende fino a 4 minuti. Se l'invio non può essere verificato, l'operazione non viene ripetuta automaticamente."));
    },

    timers: () => h("div", { class: "grid" },
      h("p", { class: "small muted" }, "Gli intervalli regolano il ritmo per evitare richieste ravvicinate. Non servono a nascondere nulla: se Vinted segnala un limite (403, 429, CAPTCHA) tutto si ferma comunque."),
      h("label", { class: "field" }, "Tra operazioni dello stesso annuncio", range(s.timers.betweenOps, (r) => save({ timers: { betweenOps: r } }))),
      h("label", { class: "field" }, "Tra annunci diversi", range(s.timers.betweenItems, (r) => save({ timers: { betweenItems: r } }))),
      ...Object.entries(s.timers.transitions).map(([k, r]) => h("label", { class: "field" }, `Tra ${k.replace(">", " → ")}`, range(r, (v) => save({ timers: { transitions: { [k]: v } } })))),
      h("label", { class: "field" }, "Intervallo minimo assoluto", h("div", { class: "row" }, num(s.timers.minFloor, (v) => save({ timers: { minFloor: Math.max(1, v) } }), { min: 1 }), h("span", { class: "muted small" }, "secondi"))),
      h("p", { class: "small muted" }, "Ogni campagna può avere timer propri (dettaglio campagna › Impostazioni).")),

    limits: () => h("div", { class: "grid" },
      h("div", { class: "callout warn small" }, h("b", {}, "Soglie scelte da te. "), "Non sono limiti ufficiali di Vinted e non garantiscono nulla: servono a te per tenere il ritmo sotto controllo. Si azzerano a mezzanotte."),
      h("label", { class: "field" }, "Like al giorno", num(s.limits.perDay.like, (v) => save({ limits: { perDay: { like: v } } }), { min: 0 })),
      h("label", { class: "field" }, "Offerte al giorno", num(s.limits.perDay.offer, (v) => save({ limits: { perDay: { offer: v } } }), { min: 0 })),
      h("label", { class: "field" }, "Messaggi privati al giorno", num(s.limits.perDay.message ?? 10, (v) => save({ limits: { perDay: { message: v } } }), { min: 0 })),
      h("label", { class: "field" }, "Commenti (suggerimenti) al giorno", num(s.limits.perDay.comment, (v) => save({ limits: { perDay: { comment: v } } }), { min: 0 })),
      h("label", { class: "field" }, "Totale per account al giorno", num(s.limits.perAccountDay, (v) => save({ limits: { perAccountDay: v } }), { min: 0 })),
      h("label", { class: "field" }, "Totale complessivo al giorno", num(s.limits.globalDay, (v) => save({ limits: { globalDay: v } }), { min: 0 })),
      h("label", { class: "field" }, "Errori di fila prima della pausa", num(s.maxConsecutiveFailures, (v) => save({ maxConsecutiveFailures: Math.max(1, v) }), { min: 1 })),
      h("label", { class: "field" }, "Pause dopo un 403/429 (minuti, poi stop)", (() => { const i = h("input", { class: "input", value: s.backoffMinutes.join(", ") }); i.addEventListener("change", () => save({ backoffMinutes: i.value.split(",").map((x) => Number(x.trim())).filter((x) => x > 0).slice(0, 5) })); return i; })()),
      h("p", { class: "small muted" }, "Per cambiare una soglia mentre è raggiunta devi modificarla qui di proposito: non esistono scorciatoie per superarla.")),

    notifications: () => h("div", { class: "grid" },
      check(s.notifications.enabled, (v) => save({ notifications: { enabled: v } }), "Notifiche attive"),
      check(s.notifications.system, (v) => save({ notifications: { system: v } }), "Notifiche del sistema operativo"),
      h("label", { class: "field" }, "Durata degli avvisi (secondi)", num(s.notifications.durationSec, (v) => save({ notifications: { durationSec: Math.max(2, v) } }), { min: 2, max: 60 })),
      h("h3", {}, "Categorie"),
      h("div", { class: "three" }, Object.entries({ campaignStart: "Campagna iniziata", campaignDone: "Campagna completata", campaignPaused: "Campagna in pausa", error: "Errori", sessionExpired: "Sessione scaduta", newVersion: "Nuova versione", limitReached: "Limite raggiunto", connection: "Connessione", verify: "Da verificare" })
        .map(([k, label]) => check(s.notifications.categories[k] !== false, (v) => save({ notifications: { categories: { [k]: v } } }), label))),
      h("p", { class: "small muted" }, "Errori ed esiti incerti restano finché non li leggi: non spariscono da soli.")),

    overlay: () => h("div", { class: "grid" },
      check(s.overlay.fab, (v) => save({ overlay: { fab: v } }), "Floating Action Button sulle pagine Vinted"),
      check(s.overlay.widget, (v) => save({ overlay: { widget: v } }), "Mini-widget di avanzamento delle campagne"),
      h("label", { class: "field" }, "Dimensione", sel({ "0.85": "Piccola", "1": "Normale", "1.15": "Grande" }, String(s.overlay.scale || 1), (v) => save({ overlay: { scale: Number(v) } }))),
      h("button", { class: "btn", onclick: () => save({ overlay: { position: { right: 20, bottom: 20 } } }, "Posizione ripristinata") }, "Riporta in basso a destra"),
      h("p", { class: "small muted" }, "Il pulsante e il widget si trascinano con il mouse; il widget si ridimensiona dall'angolo. Scorciatoia per mostrarlo/nasconderlo: configurabile in chrome://extensions/shortcuts.")),

    ai: () => {
      const endpoint = h("input", { class: "input", value: s.ai.endpoint || "", placeholder: "http://localhost:11434/v1/chat/completions" });
      const model = h("input", { class: "input", value: s.ai.model || "", placeholder: "es. llama3.1 / gpt-4o-mini" });
      const key = h("input", { class: "input", type: "password", value: s.ai.apiKey || "", placeholder: "Facoltativa (non serve per un LLM locale)", autocomplete: "off" });
      return h("div", { class: "grid" },
        h("label", { class: "field" }, "Motore", sel({ local: "Regole locali (privato, gratuito, istantaneo)", api: "Endpoint compatibile OpenAI (locale o esterno)" }, s.ai.provider, (v) => save({ ai: { provider: v }, features: { ai: v === "api" } }).then(() => ctx.refresh()))),
        h("div", { class: "row" }, h("label", { class: "field" }, "Lingua", sel({ it: "Italiano", en: "English" }, s.ai.language, (v) => save({ ai: { language: v } }))),
          h("label", { class: "field" }, "Tono", sel({ cordiale: "Cordiale", formale: "Formale", diretto: "Diretto" }, s.ai.tone, (v) => save({ ai: { tone: v } }))),
          h("label", { class: "field" }, "Alternative", num(s.ai.count, (v) => save({ ai: { count: v } }), { min: 1, max: 8 }))),
        s.ai.provider === "api" ? h("div", { class: "grid" },
          h("label", { class: "field" }, "Endpoint", endpoint), h("label", { class: "field" }, "Modello", model), h("label", { class: "field" }, "Chiave API", key),
          h("button", { class: "btn primary", onclick: async () => {
            let origin;
            try { origin = new URL(endpoint.value).origin; } catch { return toast("Endpoint non valido", "", "error"); }
            const ok = await chrome.permissions.request({ origins: [`${origin}/*`] });
            if (!ok) return toast("Permesso negato", `Senza il permesso per ${origin} si usano le regole locali.`, "warning");
            await save({ ai: { endpoint: endpoint.value.trim(), model: model.value.trim(), apiKey: key.value.trim() } }, "Configurazione AI salvata");
          } }, "Salva e concedi il permesso"),
          h("div", { class: "callout info small" }, h("b", {}, "Privacy, costi, latenza. "), "Locale (Ollama, LM Studio): nessun dato esce dal computer, costo zero, latenza dipende dal PC. Esterno: si inviano titolo, descrizione, categoria, marca, taglia e prezzo dell'annuncio (mai dati tuoi); costo a consumo; la chiave resta solo in questo browser e non finisce negli export.")) : null);
    },

    discord: () => {
      const url = h("input", { class: "input", type: "password", value: s.discord.webhookUrl || "", placeholder: "https://discord.com/api/webhooks/…", autocomplete: "off" });
      return h("div", { class: "grid" },
        h("div", { class: "callout info small" }, "Facoltativo. Il webhook è TUO e resta solo in questo browser: non è nel codice, non è nel repository e non viene esportato. Le notifiche delle release partono invece da GitHub Actions con il secret DISCORD_WEBHOOK_URL nel repository."),
        h("label", { class: "field" }, "URL del webhook", url),
        h("div", { class: "row" },
          h("button", { class: "btn primary", onclick: async () => {
            if (url.value && !/^https:\/\/(?:ptb\.|canary\.)?discord(?:app)?\.com\/api\/webhooks\/\d+\/[\w-]+$/.test(url.value.trim())) return toast("URL non valido", "Deve essere un webhook di Discord.", "error");
            const ok = !url.value || await chrome.permissions.request({ origins: ["https://discord.com/*"] });
            if (!ok) return toast("Permesso negato", "Senza il permesso per discord.com non posso inviare.", "warning");
            await save({ discord: { webhookUrl: url.value.trim() }, features: { discord: Boolean(url.value.trim()) } }, "Webhook salvato");
          } }, "Salva"),
          h("button", { class: "btn", onclick: async () => { const r = await rpc("discord.test"); toast(r.sent ? "Messaggio inviato" : "Invio non riuscito", r.reason || "", r.sent ? "success" : "error"); } }, "Invia prova")),
        h("h3", {}, "Cosa inviare"),
        h("div", { class: "three" }, Object.entries({ campaignDone: "Campagna completata", error: "Errori importanti", system: "Problemi di sistema", update: "Aggiornamento disponibile" }).map(([k, l]) => check(s.discord.events[k], (v) => save({ discord: { events: { [k]: v } } }), l))),
        h("details", {}, h("summary", {}, "Come creare un webhook"), h("ol", { class: "small" },
          h("li", {}, "Apri il tuo server Discord."), h("li", {}, "Impostazioni del canale desiderato (ingranaggio)."), h("li", {}, "Integrazioni › Webhook."),
          h("li", {}, "Nuovo webhook: scegli nome e canale."), h("li", {}, "Copia l'URL del webhook."), h("li", {}, "Incollalo qui sopra e premi Salva, poi «Invia prova»."))));
    },

    backup: () => {
      const parts = Object.fromEntries(Object.keys(EXPORT_PARTS).map((k) => [k, h("input", { type: "checkbox", checked: !["listings", "history"].includes(k) })]));
      const file = h("input", { type: "file", accept: "application/json,.json", class: "input" });
      file.addEventListener("change", () => importFlow(file.files[0], ctx));
      return h("div", { class: "grid" },
        h("h3", {}, icon("download", 16), "Esporta"),
        h("div", { class: "three" }, Object.entries(EXPORT_PARTS).map(([k, l]) => h("label", { class: "check" }, parts[k], l))),
        h("p", { class: "small muted" }, "Mai inclusi: cookie, token, password, chiave API, webhook."),
        h("button", { class: "btn primary", onclick: async () => {
          const sel = Object.keys(parts).filter((k) => parts[k].checked);
          downloadJson(await rpc("backup.export", { parts: sel }), `vintastic-backup-${new Date().toISOString().slice(0, 10)}.json`);
        } }, icon("download", 14), "Esporta JSON"),
        h("h3", {}, icon("upload", 16), "Importa"),
        h("p", { class: "small muted" }, "Validazione, anteprima, scelta delle parti, unione senza doppioni e backup automatico prima di scrivere. Le campagne importate arrivano come bozze: niente parte da solo."),
        file,
        h("button", { class: "btn", onclick: async () => {
          try { downloadJson(await rpc("backup.preImport"), "vintastic-backup-prima-import.json"); } catch (e) { toast("Nessun backup", e.message, "warning"); }
        } }, "Scarica il backup fatto prima dell'ultima importazione"));
    },

    data: () => h("div", { class: "grid" },
      h("p", { class: "small muted" }, "Quanto a lungo conservare i dati storici. Il registro delle interazioni (anti-duplicazione) non viene mai cancellato automaticamente."),
      h("label", { class: "field" }, "Log (giorni)", num(s.retention.logsDays, (v) => save({ retention: { logsDays: v } }), { min: 1 })),
      h("label", { class: "field" }, "Numero massimo di log", num(s.retention.maxLogs, (v) => save({ retention: { maxLogs: v } }), { min: 100 })),
      h("label", { class: "field" }, "Notifiche (giorni)", num(s.retention.notificationsDays, (v) => save({ retention: { notificationsDays: v } }), { min: 1 })),
      h("label", { class: "field" }, "Attività e journal (giorni)", num(s.retention.activityDays, (v) => save({ retention: { activityDays: v } }), { min: 7 })),
      h("button", { class: "btn", onclick: async () => { const r = await rpc("retention.apply"); toast("Pulizia eseguita", Object.entries(r).map(([k, v]) => `${k}: ${v}`).join(" · "), "success"); } }, icon("trash", 14), "Applica ora")),

    advanced: () => {
      const repo = h("input", { class: "input", value: s.updates.repo });
      return h("div", { class: "grid" },
        h("label", { class: "field" }, "Repository per gli aggiornamenti (proprietario/nome)", repo),
        h("button", { class: "btn", onclick: () => /^[\w.-]+\/[\w.-]+$/.test(repo.value.trim()) ? save({ updates: { repo: repo.value.trim() } }) : toast("Formato non valido", "Usa proprietario/nome", "error") }, "Salva repository"),
        check(s.updates.autoCheck, (v) => save({ updates: { autoCheck: v } }), "Controlla gli aggiornamenti in automatico"),
        h("label", { class: "field" }, "Ogni quante ore", num(s.updates.everyHours, (v) => save({ updates: { everyHours: Math.max(1, v) } }), { min: 1 })),
        h("button", { class: "btn", onclick: () => chrome.tabs.create({ url: "chrome://extensions/shortcuts" }) }, icon("external", 14), "Scorciatoie da tastiera del browser"),
        h("button", { class: "btn", onclick: async () => downloadJson(await rpc("settings.backups"), "vintastic-impostazioni-pre-migrazione.json") }, "Scarica i backup delle impostazioni fatti prima delle migrazioni"),
        h("p", { class: "small muted" }, "Glossario: ", term("Service Worker"), " · ", term("Circuit Breaker"), " · ", term("Rate Limit"), " · ", term("Cron"), " · ", term("Retry")));
    },
  };

  return h("div", { class: "grid" },
    h("div", { class: "page-head" }, h("div", { class: "grow" }, h("h1", {}, "Impostazioni"), h("p", {}, "Tutto si salva subito, solo in questo browser."))),
    h("div", { class: "seg", role: "tablist" }, Object.entries(TABS).map(([k, l]) => h("button", { role: "tab", class: tab === k ? "on" : "", "aria-selected": String(tab === k), onclick: () => ctx.navigate(`#settings?tab=${k}`) }, l))),
    h("div", { class: "card", role: "tabpanel" }, panes[tab]()));
}

function sel(opts, val, fn) {
  const s = h("select", { class: "input" }, Object.entries(opts).map(([k, v]) => h("option", { value: k }, v)));
  s.value = val;
  s.addEventListener("change", () => fn(s.value));
  return s;
}

/** Importazione: parsing in un Web Worker, anteprima, scelta delle parti. */
async function importFlow(fileObj, ctx) {
  if (!fileObj) return;
  const text = await fileObj.text();
  const worker = new Worker(new URL("../workers/data-worker.js", import.meta.url), { type: "module" });
  const parsed = await new Promise((resolve) => { worker.onmessage = (e) => { resolve(e.data); worker.terminate(); }; worker.postMessage({ type: "parse", text }); });
  if (!parsed.ok) return toast("File non leggibile", parsed.error, "error");
  const pv = await rpc("backup.preview", { json: parsed.json });
  if (!pv.ok) return modal("Importazione non possibile", h("div", { class: "callout bad" }, h("ul", {}, pv.errors.map((e) => h("li", {}, e)))), [{ label: "Chiudi", value: false }]);
  const boxes = Object.fromEntries(Object.keys(pv.preview).map((k) => [k, h("input", { type: "checkbox", checked: true })]));
  const ok = await modal("Anteprima dell'importazione", h("div", { class: "grid" },
    h("p", { class: "small muted" }, `File di ${(parsed.size / 1024).toFixed(0)} KB letto in ${parsed.ms} ms.`),
    h("ul", { class: "check-list" }, Object.entries(pv.preview).map(([k, v]) => h("li", {}, boxes[k], h("div", {}, h("b", {}, EXPORT_PARTS[k] || k), h("div", { class: "small muted" }, String(v)))))),
    pv.warnings.length ? h("div", { class: "callout warn small" }, pv.warnings.join(" ")) : null),
  [{ label: "Annulla", value: false }, { label: "Importa", value: true, cls: "primary" }]);
  if (!ok) return;
  const r = await rpc("backup.import", { json: parsed.json, parts: Object.keys(boxes).filter((k) => boxes[k].checked) });
  if (r.ok) { toast("Importazione completata", Object.entries(r.report).map(([k, v]) => `${k}: ${v}`).join(" · "), "success", 9000); ctx.settings = await rpc("settings.get"); }
  else toast("Importazione non riuscita", `${r.errors.join(" ")} — il backup preventivo è stato salvato.`, "error", 9000);
}
