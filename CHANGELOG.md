# Changelog

Tutte le modifiche rilevanti di Vintastic. Formato [Keep a Changelog](https://keepachangelog.com/it/1.1.0/), versioni [Semantic Versioning](https://semver.org/lang/it/).

## [1.4.0] - 2026-11-07

Messaggi privati rifatti: destinatari autorizzati, più fonti per il testo, invio in due fasi e verifiche più rigorose. Le versioni 1.3.0 e 1.3.1 non vanno usate per i messaggi.

### Aggiunto
- **Destinatari autorizzati** (Impostazioni › Messaggi): i messaggi partono solo verso i venditori in elenco, senza limite di numero. Si aggiungono con l'ID, con il link del profilo o da un armadio scansionato. Un annuncio di un altro venditore viene saltato senza aprire la chat (controllo nell'anteprima, nel motore e sulla pagina prima del clic). Con l'elenco vuoto le campagne con messaggi non partono.
- **Fonti del testo** per campagna: messaggio predefinito, un modello salvato, testo scritto ora, rotazione o scelta casuale (riproducibile) tra modelli, domanda sull'annuncio generata dalle regole locali. **Modelli** riutilizzabili e **segnaposto** `{titolo}` `{prezzo}` `{marca}` `{taglia}` `{venditore}`.
- Testo **modificabile annuncio per annuncio** dalla coda; **modalità A/B per campagna** (o quella delle impostazioni).
- L'anteprima mostra il testo esatto di ogni messaggio e la modalità; il testo approvato è quello che parte.
- Modalità B: la scheda di Vinted passa in primo piano con il testo scritto e arriva la notifica «Premi Invia»; l'utente può cambiare il testo o inviare con Invio. Attesa configurabile fino a 4 minuti; se nessuno invia, niente parte e la campagna va in pausa.
- Messaggi nel menu del FAB, colore dedicato nelle statistiche e nei grafici «Riuscite».

### Corretto
- **Invio in due fasi**: «Chiedi info» → attesa del campo `#composerInput` (stessa pagina o pagina nuova) → compilazione/invio → verifica. Prima, se la chat si apriva in una pagina nuova, il comando si perdeva.
- **Divieto d'acquisto aggirato dai clic dei messaggi** (1.3.0): i clic usavano un evento sintetico che il controllo statico non vedeva. Ora «Chiedi info» e Invia passano da `VTGuard.safeClick`, con un test.
- Il messaggio è confermato solo da un messaggio **nuovo** nella conversazione e con il campo svuotato; testi su più righe riconosciuti. Un messaggio identico già presente non conta.
- Un messaggio inviato e verificato non diventa più «da verificare» se il ritorno all'annuncio non riesce: resta completato (con un avviso nei log) e il ledger impedisce doppioni.
- Il journal segna il punto di non ritorno solo quando il testo sta per essere scritto: un crash prima (durante l'apertura della chat) rimette il messaggio in coda invece di bloccarlo «da verificare».
- **Pagina cambiata durante un comando**: prima veniva considerato «non inviato» (rischio di doppione per like e offerte); ora solo un comando mai arrivato alla pagina è «non inviato», il resto è «da verificare».
- **Ledger bloccato in «in corso»** dopo due tentativi non partiti di fila (es. due 429): l'annuncio non si poteva più usare. Ora torna allo stato di prima del tentativo.
- L'anteprima dei messaggi mostrava «Preferito»; le transizioni dei timer verso e dal messaggio erano incomplete.
- Testi dei messaggi, modelli e destinatari esclusi dal Support Bundle (prima c'erano, dentro le impostazioni).

### Modificato
- Le impostazioni dei messaggi non fanno più parte dello snapshot: ne fa parte il testo calcolato per ogni annuncio. Like e offerte approvati con le versioni precedenti restano validi.
- Test: i test DOM isolati della 1.3.1 (che sostituivano `location` e `history`) sono sostituiti da 6 scenari end-to-end con l'estensione vera e la chat finta costruita sull'HTML reale.
- Documentazione e changelog riordinati.

## [1.3.1] - 2026-11-07

### Corretto
- Un tentativo di invio senza conferma resta «da verificare», senza ripetizioni automatiche.
- Un messaggio precedente con lo stesso testo non viene scambiato per quello appena inviato.
- Cambiare testo o modalità dopo l'approvazione richiede una nuova anteprima.

## [1.3.0] - 2026-11-07

### Aggiunto
- Operazione «Messaggio privato» nelle campagne: «Chiedi info», compilazione della chat e verifica dell'invio, modalità automatica (predefinita) o con invio manuale, testo configurabile, soglia di 10 messaggi al giorno, protezione anti-duplicazione con il ledger.

## [1.2.0] - 2026-11-07

### Aggiunto
- **Eliminare campagne**: una, più (selezione) o tutte, anche in corso (vengono fermate dopo l'operazione in invio). Il registro anti-duplicati resta.
- **Notifiche**: «Elimina tutte» e cestino sulla singola notifica.
- **Offerte in percentuale ±**: una sola percentuale, negativa (sconto) o positiva (sopra il prezzo). **Predefinito +5%** sul prezzo, centesimi esatti.
- Cambiando le regole delle offerte di una campagna, le offerte in attesa e quelle **rifiutate da Vinted per l'importo** vengono ricalcolate e si possono rimandare.
- **Recupero**: risoluzione in blocco delle operazioni da verificare («Tutti i like: eseguiti», «Tutte: eseguite / non eseguite»).

### Corretto
- **Like segnati «da verificare» anche se messi**: dopo l'invio la rilettura usava i dati incorporati nella pagina, fermi al caricamento (prima del like). Ora conta solo una rilettura dall'API; senza, vale la conferma di Vinted.
- La pagina **Salute** non si caricava finché su GitHub non c'è una release («Nessuna release pubblicata»): uno stato «ok: false» veniva scambiato per un errore.
- Un'offerta **rifiutata per l'importo** («Il prezzo è troppo basso!») non spegne più il modulo offerte dopo tre volte.
- «Elimina» nelle notifiche cancellava solo quelle già lette.

## [1.1.0] - 2026-11-06

### Aggiunto
- **Numero personalizzato** in «Aggiungi annunci alla coda» (oltre a 5, 10, 20, 50, 100).
- **Ordine ribaltabile** nella pagina Annunci: per data, prezzo, titolo o «visti di recente», con un pulsante per mettere in cima i più recenti o i meno recenti.
- **Avviso «aggiornamento a metà»** con pulsante «Ricarica Vintastic» quando i file sono nuovi ma il motore è ancora la versione vecchia (era la causa di «Metodo sconosciuto: campaigns.goLive»).

### Corretto
- «Ultimi N» e i periodi non trovavano niente su Vinted reale (**«Nessun annuncio con questi criteri»**): l'armadio di Vinted non dà la data di pubblicazione. Ora la data predefinita è «pubblicazione, altrimenti data della foto (stima)» e, senza date, vale l'ordine «più recenti prima» dell'armadio su Vinted. Nessuna data viene inventata.
- Quando non ci sono annunci, il messaggio spiega il motivo (senza data, già fatti, periodo vuoto).
- Icona nella barra del browser grande quanto le altre.

### Modificato
- Documentazione su Discord rimossa (le istruzioni restano in Impostazioni › Discord).

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
