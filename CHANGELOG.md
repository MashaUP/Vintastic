# Changelog

Tutte le modifiche rilevanti di Vintastic. Formato [Keep a Changelog](https://keepachangelog.com/it/1.1.0/), versioni [Semantic Versioning](https://semver.org/lang/it/).

## [1.0.1] - 2026-11-06

### Corretto
- Dopo una **simulazione** la campagna non si poteva eseguire davvero: le operazioni simulate restavano «Completato» e l'avvio diceva «Non ci sono operazioni da eseguire». Ora, passando alla modalità reale (pulsante **Esegui davvero su Vinted** o togliendo la spunta Simulazione), le operazioni simulate tornano in coda; si riapprova l'anteprima e si avvia.
- Le operazioni fatte in simulazione si chiamano **«Simulato»**, non «Completato», e la campagna simulata spiega che niente è stato inviato a Vinted.

### Modificato
- Pacchetto per l'utente: `Vintastic-x.y.z.zip` con la cartella `Vintastic/` (nome con versione e maiuscola).
- Documentazione ridotta all'essenziale.

## [1.0.0] - 2026-11-06

Prima versione.

### Aggiunto
- **Scanner degli armadi** con paginazione, archivio locale senza doppioni, storico prezzi, annunci ripubblicati collegati, date separate (pubblicazione, aggiornamento, ripubblicazione, foto), ripiego sulla pagina se l'API non risponde.
- **Filtri** Top N e per periodo combinabili, prezzo, stato, venditore, «escludi già fatti»; filtri salvabili; esportazione CSV.
- **Campagne** di like e offerte con il proprio account: ordine delle operazioni, timer per operazione/annuncio/tipo, conferma facoltativa, simulazione (Dry Run).
- **Coda dinamica** modificabile durante l'esecuzione: aggiunte, rimozioni, modifiche, priorità, riordino (manuale, cronologico, prezzo, casuale con anteprima), «Ripeti falliti», storico di ogni modifica.
- **Global Interaction Ledger** (No Repeat) per account, annuncio e tipo.
- **Smart Offer Engine**: modalità Risparmio/Interazione/Personalizzata, sconti e incrementi, minimo/massimo, fasce di prezzo, arrotondamenti, importi casuali, anteprima.
- **Suggerimenti AI** di domande al venditore: regole locali o endpoint compatibile OpenAI; si copiano (Vinted non ha commenti pubblici).
- **Policy Validator**, **Preview Snapshot**, soglie giornaliere, **Kill Switch** globale e per modulo, **circuit breaker**, feature flag.
- **Pausa automatica** su 403/429 (backoff), CAPTCHA/verifiche, rete assente (controllo reale), sessione scaduta o account diverso, con **autenticazione assistita** e ripresa dal punto esatto.
- **Journal write-ahead** e **Campaign Recovery Center**: dopo un crash niente viene ripetuto alla cieca.
- **Dashboard** con riepilogo, grafici, attività in tempo reale, riepilogo code, stato del sistema; widget personalizzabili, tema chiaro/scuro, ricerca globale, comando rapido, scorciatoie.
- **Popup** e **side panel** con azioni rapide sull'annuncio aperto; **FAB** e **mini-widget** sulle pagine Vinted.
- **Centro notifiche** e **pulitore notifiche** di Vinted (solo «segna come letta»).
- **Log e diagnostica** con possibile soluzione, **Health Center**, **Support Bundle** redatto.
- **Backup** JSON con validazione, anteprima, import selettivo, deduplicazione, backup preventivo; **migrazioni** versionate con rollback.
- **Aggiornamenti** da GitHub Releases con verifica SHA-256; **release automatiche** (GitHub Actions) con ZIP, checksum, artifact e notifica Discord facoltativa.
- **Guida iniziale** in 9 passi e glossario contestuale.
- Logo Vintastic (V ispirata alla forma di quella di Vinted, con anello e scintilla) e tema viola.

### Sicurezza
- Divieto assoluto di acquisto applicato da una lista chiusa di richieste e verificato da test dedicati.
- Nessun webhook, token o chiave nel codice o negli export.
