# Funzionalità

Stato di ogni richiesta del brief. Legenda: ✅ implementata e provata (Vinted finto) · 🟡 implementata con limiti (scritti accanto) · 🔁 alternativa al posto dell'originale (motivo accanto) · ⛔ non implementata (motivo accanto).

## 4. Account Manager

| Funzione | Stato | Dove |
|---|---|---|
| Elenco account con nome, username, etichetta, sessione, ultima attività, annunci scansionati, interazioni, campagne attive, problemi | ✅ | Account |
| Etichette predefinite (Principale … Personalizzato) modificabili, solo descrittive | ✅ | Account |
| Selettore account in popup e dashboard, preferiti, account attuale evidente | 🟡 | Popup › Account, chip in alto. Il «selettore» porta a Vinted: un'estensione non può cambiare da sola una sessione autenticata |
| Cambio con conferma se ci sono campagne in esecuzione | ✅ | Account › Accedi / cambia account |
| Controllo che la sessione corrisponda all'account della campagna | ✅ | Policy Validator, motore |
| Fallback 2FA / verifiche: pausa, apertura di Vinted, l'utente completa, nuova verifica, ripresa dal punto esatto | ✅ | `startAuthFlow`, `checkAuthPending`, Recupero |
| Codici non acquisiti, memorizzati o intercettati | ✅ | Nessun codice legge campi di login |

## 5. Account di destinazione

| Funzione | Stato | Motivo |
|---|---|---|
| Gruppi di account per le interazioni, principale/secondari | ⛔ | Scelta del progetto: le interazioni partono **solo dal tuo account** (quello collegato a Vinted). Niente account multipli per le interazioni |
| Ogni campagna mostra account di scansione, account delle interazioni, account in uso, errori di sessione | ✅ | Dettaglio campagna |
| Quali account hanno già interagito con un annuncio | ✅ | Annunci (colonna Account), ledger |

## 6. Scanner e annunci

| Funzione | Stato |
|---|---|
| Lettura armadio con paginazione, ID/URL/titolo/prezzo/immagini/marca/taglia/stato | ✅ |
| Descrizione | 🟡 non presente nella risposta dell'armadio; usata quando disponibile |
| Annunci già acquisiti, aggiornamento, niente doppioni, storico prezzi | ✅ |
| Progresso in tempo reale, errori e pagine non accessibili | ✅ |
| Ripiego sulla griglia della pagina se l'API non risponde | 🟡 solo annunci visibili, senza date |
| Tabella: immagine, titolo, prezzo, venditore, pubblicazione, aggiornamento, stato, interazioni, account, campagne | ✅ |
| Top N (5/10/20/50/100/personalizzato) + periodi (24h…30g, intervallo) combinabili | ✅ |
| Date distinte (pubblicazione, aggiornamento, ripubblicazione, foto) senza invenzioni | ✅ (gli annunci senza la data scelta sono esclusi e contati) |
| Navigazione annuncio → operazione → ritorno → successivo | ✅ scheda di lavoro di Vintastic |
| Interfaccia utilizzabile mentre lavori altrove; schede non di Vintastic intatte | ✅ |

## 7. Motore delle interazioni

| Funzione | Stato |
|---|---|
| Like | ✅ con lettura dello stato prima (il toggle di Vinted non deve togliere un like) |
| Offerta | ✅ |
| Commento | 🔁 Vinted non ha commenti pubblici sugli annunci: suggerimento da copiare, mai inviato |
| Combinazioni e ordine per campagna; modificabili in corsa rispettando ciò che è fatto | ✅ |
| Conferma per operazione, salto per condizioni (annuncio non attivo, già fatto) | ✅ |
| Timer tra operazioni dello stesso annuncio, per tipo, tra annunci, tra tipi; per campagna; timer attivo e tempo rimanente visibili | ✅ |
| Stop su 403/429/CAPTCHA/restrizioni indipendentemente dai timer | ✅ |

## 8. No Repeat / ledger

| Funzione | Stato |
|---|---|
| Verifica separata per tipo, per account, per annuncio | ✅ |
| ID, venditore, account, tipo, data, campagna, risultato, stato | ✅ |
| Annuncio ripubblicato: nuovo annuncio + collegamento storico se affidabile | ✅ (`relistOf`) |
| Stati Mai elaborato…Saltato | ✅ |
| Mai «completato» perché avviato; crash → recupero, verifica, «da verificare», niente ripetizioni | ✅ |
| Global Interaction Ledger condiviso | ✅ |

## 9. Smart Offer Engine — ✅ tutte le modalità, regole, arrotondamenti, importi casuali e anteprima

Limite: gli importi accettati da Vinted non sono documentati; un rifiuto viene mostrato con il messaggio di Vinted. Un importo sopra il prezzo è consentito in modalità Interazione con avviso.

## 10. AI Contextual Commenting

| Funzione | Stato |
|---|---|
| Suggerimenti da titolo, descrizione, categoria; più alternative; modifica; cronologia; lingua; tono | ✅ |
| LLM locale e API esterne (privacy, costi, latenza, chiavi) | ✅ regole locali predefinite; endpoint compatibile OpenAI facoltativo con permesso e chiave solo locale |
| Approvazione esplicita | ✅ niente viene inviato: si copia |

## 11. Campaign Manager — ✅

Creazione con tutti i campi; Avvia/Pausa/Riprendi/Interrompi/Salta/Rimuovi/Modifica/Riordina/Ripeti falliti/Dettagli; coda dinamica completa; ordine manuale, cronologico, per prezzo, casuale con anteprima e salvataggio; persistenza IndexedDB + journal; sopravvive a popup/dashboard chiusi, altre schede, sospensione del worker, riavvio del browser (provati).

## 12. Mini-Mode e FAB — ✅

FAB spostabile, ridimensionabile (dimensione), disattivabile; widget con campagna, account, progresso, completati, in attesa, operazione corrente, timer, stato; Pausa/Riprendi/Stop/Espandi/Chiudi/Riapri; aggiornamento in tempo reale.

## 13. Notifiche

| Funzione | Stato |
|---|---|
| Centro notifiche: tutte le categorie, durata, on/off, persistenti, storico, priorità, link, raggruppamento | ✅ |
| Pulitore notifiche: anteprima, selezione, progresso, pausa, annullamento, riepilogo, errori | 🟡 solo «segna come letta» (nessuna eliminazione); endpoint non verificato su Vinted reale |

## 14–16. Dashboard, statistiche, log, Health Center — ✅

Riepilogo con filtri temporali; grafici (interazioni, per account, per campagna, scansioni, riuscite/fallite, code); attività in tempo reale; widget attivabili e riordinabili; layout compatto/completo; tema scuro e chiaro; ricerca globale; comando rapido; scorciatoie. Log per categoria/account/campagna/annuncio/operazione con stack e soluzione, filtri, ricerca, esportazione, copia, pulizia selettiva, retention; Support Bundle redatto. Health Center con «Esegui controllo completo», circuit breaker, feature health, capability detection, kill switch globale e per modulo.

## 17–19. Connettività, limiti, divieto d'acquisto — ✅

Controllo reale della raggiungibilità (non `navigator.onLine`), pausa e ripresa solo con rete + sessione valide; soglie configurabili con orario di reset; divieto d'acquisto nell'architettura (guard), nel codice (nessun percorso), nell'interfaccia, nei permessi e nei test.

## 20–21. Onboarding e import/export — ✅

Wizard in 9 passi (disattivabile, riavviabile), glossario con tooltip; JSON con validazione, versionamento, anteprima, import selettivo, deduplicazione, backup preventivo, migrazioni; campagne importate sempre in bozza.

## 22. Architettura — ✅

IndexedDB, `storage.local`, `storage.session` (verificato disponibile), journal write-ahead, recupero, migrazioni db_v1→v2→v3 con rollback, integrità, Web Worker, graceful degradation, state machine.

## 23–25. Aggiornamenti, release, Discord

| Funzione | Stato |
|---|---|
| Versione, ultima release, controllo, notifica, changelog, link, download ZIP, verifica SHA-256, istruzioni | ✅ |
| Installazione automatica | ⛔ il browser non permette a un'estensione caricata da cartella di sostituirsi; «Installa» ricarica dopo l'estrazione |
| GitHub Actions: test, ZIP, esclusioni, checksum, allegati, artifact, errori | 🟡 workflow validati con actionlint e passi provati in locale; la prima esecuzione su GitHub avverrà alla prima release |
| Discord: release (secret `DISCORD_WEBHOOK_URL`), aggiornamenti, campagne, errori, sistema | ✅ nessun webhook nel codice; quello dell'estensione è personale e solo locale |

## 27. Extra — ✅

Global Kill Switch, Campaign Recovery Center, Preview Snapshot, Account Session Health, Offline Read-Only, Policy Validator, Tab Ownership Manager, Notification Center, Data Retention, Privacy e supporto, Keyboard Shortcuts, Feature Flags.

## Requisiti del progetto «Progetti Github»

Pulsante «Cerca aggiornamento» (popup, sidebar, Salute), link Ko-fi e Discord (popup, sidebar, Aiuto) con link Discord modificabile da `links.json` senza nuova versione, versionamento semantico.
