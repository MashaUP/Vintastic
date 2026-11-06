# Audit di Vinted_Relist

Repository analizzato: `MashaUP/Vinted_Relist` (versione 2.4.0, licenza MIT, stesso autore di Vintastic: il riuso è consentito). Codice letto: `background.js`, `src/api.js`, `src/page-bridge.js`, `src/content.js`, `src/versione.js`, `links.json`, `docs/SVILUPPO.md`, `README.md`.

Classificazione: **GIÀ PRESENTE** (ripresa in Vintastic) · **MIGLIORATA** · **DA IMPLEMENTARE** (fatta in questa versione) · **NON COMPATIBILE** (non ha senso per Vintastic) · **DA VERIFICARE**.

| Funzione di Vinted_Relist | In Vintastic | Note |
|---|---|---|
| Token CSRF e `X-Anon-Id` letti dalle richieste di Vinted (`webRequest.onSendHeaders`), tenuti in `storage.session` | GIÀ PRESENTE | `session.js`; mai su disco |
| Id utente dal cookie `v_uid` / `access_token_web` | MIGLIORATA | Aggiunto `chrome.cookies` (solo `v_uid`) come fonte principale; webRequest solo per rilevamenti positivi |
| Client API: intestazioni del sito, niente `X-Requested-With`, un solo retry sul 403 con token nuovo, 429 = blocco | GIÀ PRESENTE | `vinted-api.js`, più la lista chiusa del guard |
| Errori di rete = esito **incerto**, non fallito | GIÀ PRESENTE | Base dello stato «da verificare» |
| Endpoint armadio `/wardrobe/:id/items?…order=newest_first` | GIÀ PRESENTE | Scanner (con paginazione completa) |
| Coda con una sola fonte di verità scritta dal service worker, lock a catena di promesse | MIGLIORATA | IndexedDB invece di `storage.local`, `withLock` + `claimOp` + `patchCampaign` |
| Stati `pending/working/done/error/verify/interrupted/skipped/cancelled/removed` | MIGLIORATA | Macchina a stati esplicita per operazioni e campagne |
| Coda dinamica: aggiungi in cima/in fondo, rimuovi, sposta, riordina con controllo «insieme cambiato» | GIÀ PRESENTE | `queue.js` |
| Batch con regole proprie e intervallo per batch | MIGLIORATA | Regole e timer per campagna, timer per tipo e per transizione |
| «Ripubblica ora» (porta in cima) | GIÀ PRESENTE | «⤒ Prossimo» e priorità Alta |
| Annullamento cooperativo dell'elemento in corso fino al punto di non ritorno | MIGLIORATA | Journal `intent`/`sending`: prima di `sending` l'operazione torna in attesa |
| Recupero all'avvio: fase `preparazione` → interrotto, `invio` → da verificare; mai ripetuto alla cieca | GIÀ PRESENTE | `engine.recover` |
| Tre esiti negativi di fila → pausa prudente; 403/429 → pausa 5/15/45 min poi stop | GIÀ PRESENTE | Configurabile (`maxConsecutiveFailures`, `backoffMinutes`) |
| Sessioni precedenti: riprendi o riprova i falliti, mai i completati | GIÀ PRESENTE | Campagne riapribili, «Ripeti falliti» |
| Cronologia filtrabile, esportazione CSV/JSON, resoconto da copiare senza dati sensibili | MIGLIORATA | Log con soluzione, Support Bundle redatto |
| Modelli di opzioni con nome | MIGLIORATA | Filtri salvati, regole d'offerta predefinite |
| Registro eventi unico, avvisi sulla pagina con durate per tipo, badge, notifica di sistema con clic | MIGLIORATA | Centro notifiche con priorità, raggruppamento, persistenza, categorie, Discord |
| Version checker su `version.json` del repo, semver con prerelease, notifica una volta per versione | MIGLIORATA | GitHub Releases API, verifica SHA-256 dello zip, rate limit |
| «Installa l'aggiornamento» = `runtime.reload()` dopo estrazione manuale | GIÀ PRESENTE | |
| `links.json` centralizzato (Discord modificabile senza nuova versione), aggiornato ogni 12 h | GIÀ PRESENTE | `updates.refreshLinks` |
| Popup Home / Notifiche / Salute / Impostazioni con backup | MIGLIORATA | Dashboard completa + popup + side panel |
| Scorciatoie da tastiera sulla pagina della coda | MIGLIORATA | Comandi del browser + scorciatoie della dashboard + comando rapido |
| Strumenti di diagnostica in console (`VR.diagnosi`, `VR.canary`) | NON COMPATIBILE | Sostituiti da Health Center e Support Bundle |
| Fasce orarie di picco, ritmo irregolare, «passi solo quando sei al computer» | NON COMPATIBILE | Il brief vieta di usare il ritmo per sembrare umani; i timer servono solo a regolare il flusso |
| Ripubblicazione, editor, upload foto, formati appresi, campi per categoria | NON COMPATIBILE | Funzioni specifiche della ripubblicazione |
| Statistiche di visite a 48 ore per giorno e fascia | DA VERIFICARE | Utile per i propri annunci; non è nello scopo di questa versione (vedi ROADMAP) |
| Avvisi sulla pagina con «stessa chiave = stesso avviso aggiornato» | GIÀ PRESENTE | Raggruppamento per `groupKey` entro 60 s |
| Test in Chromium con Vinted finto via `context.route` (fuori dal repo) | MIGLIORATA | Nel repository: `tests/e2e`, 18 scenari |

Codice riusato direttamente (adattato): rilevamento dei token, lettura dell'id utente dal cookie, intestazioni e retry del client API, confronto semver, struttura di `links.json`. Tutto il resto è stato riscritto per l'architettura a moduli di Vintastic.
