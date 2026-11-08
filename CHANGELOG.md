# Changelog

Tutte le modifiche rilevanti di Vintastic. Formato [Keep a Changelog](https://keepachangelog.com/it/1.1.0/), versioni [Semantic Versioning](https://semver.org/lang/it/).

## [2.0.0] - 2026-11-07

Versione MAJOR: tolta un'operazione (i commenti) con migrazione dei dati non reversibile (db_v4, impostazioni schema 4) e cambiato il modo in cui il motore gestisce gli errori.

### Corretto
- **Campagne bloccate da un messaggio** (causa principale). Un'operazione che non partiva tornava «in attesa» in testa alla coda: il motore riprendeva sempre la stessa (il messaggio del primo annuncio), e dopo 3 tentativi metteva in pausa tutta la campagna. Like e offerte degli altri annunci non arrivavano mai. Il conteggio degli errori, poi, era unico per tutti i tipi. Ora:
  - un'operazione che non parte si riprova più tardi (1 e poi 5 minuti, configurabile) e intanto si eseguono le altre, anche sullo stesso annuncio; dopo 3 tentativi è «fallita» (ripetibile con «Ripeti falliti»);
  - 3 errori di fila dello stesso tipo sospendono **solo quel tipo** nella campagna (notifica, riquadro nella campagna), gli altri continuano; 6 errori di fila di tipi diversi mettono in pausa la campagna (problema generale);
  - un modulo isolato dal circuit breaker (es. «Chiedi info» assente) non mette più in pausa la campagna: le sue operazioni aspettano, le altre partono; il validatore non blocca l'avvio se resta qualcosa da fare.
- **«Chiedi info»**, verificato sul vinted.it reale il 07/11/2026 con Claude in Chrome: il pulsante è `<button data-testid="ask-seller-button">` con l'etichetta «Chiedi info»; il clic porta, con un caricamento completo della pagina, a `/inbox/<uuid>?referrer=…`, dove `textarea#composerInput` c'è entro pochi secondi. Selettori invariati, cambiato il contesto in cui vengono cercati:
  - la scheda di lavoro va in primo piano durante i messaggi (in background la chat può non disegnarsi; disattivabile);
  - l'attesa della chat segue lo stato reale della pagina (indirizzo, caricamento, presenza di Vintastic, campo), non un tempo fisso: il limite riparte finché la pagina naviga;
  - chat aperta in una **scheda nuova**: trovata, usata e chiusa;
  - Vintastic assente sulla pagina della chat: reinserito (permesso `scripting`, senza avvisi all'installazione);
  - pulsante cercato prima per `data-testid` e poi per etichetta esatta, sempre risalendo al pulsante;
  - **diagnosi** nel messaggio d'errore: clic senza effetto, chat aperta ma campo assente (con il numero di campi di testo), Vintastic che non risponde, pagina in caricamento, scheda in background.
- Invio manuale (B) non arrivato: si fermano solo i messaggi della campagna, non tutto.
- «Ripeti falliti» fa ripartire da zero il conteggio dei tentativi.
- «In cima» capovolgeva l'ordine degli annunci aggiunti insieme: ora il gruppo va in cima nel suo ordine.
- Centro notifiche: la pastiglia della gravità («Avviso», «Critico») stava in una colonna da 26 px pensata per le icone del feed e copriva l'inizio del testo. Ora ha una colonna sua.

### Aggiunto
- **Cicli: riprocessare gli annunci già elaborati** senza creare una nuova campagna. «Nuovo ciclo…» nella coda (tutti, alcuni) o l'icona su un singolo annuncio. Prima di confermare si vede esattamente cosa si ripete e cosa no, con il motivo; poi l'anteprima va riapprovata. Si ripetono solo operazioni concluse con certezza (completate, o saltate perché già fatte prima); mai quelle da verificare, in corso o fallite.
  - Ogni ciclo ha un numero e un identificativo; la cronologia dei cicli precedenti (data, esito, importo, errori) resta in ogni annuncio («cicli precedenti»), nel registro (storico con il ciclo) e nei log; tabella «Cicli» nella campagna.
  - **No Repeat** invariato per i duplicati accidentali (stesso ciclo, altra campagna); lascia passare solo il nuovo ciclo scelto. Un esito incerto non si ripete mai, nemmeno in un nuovo ciclo.
- Impostazioni: errori per tipo e per campagna, tentativi; Messaggi: scheda in primo piano.
- Domande al venditore (ex «Suggerimenti AI»): pulsante «Modello» per salvarle come modello di messaggio.

### Rimosso
- **Commenti pubblici**: operazione, voce nelle campagne e nel FAB, modifica del testo, anteprima, soglia giornaliera, transizioni dei timer, feature flag, statistiche, tile «Commenta» del popup, filtri dei log, test e documentazione. I messaggi privati restano.

### Migrazioni
- **db_v3 → db_v4**: dalle code spariscono le operazioni «comment» (annotato nella cronologia dell'elemento; un elemento con soli commenti viene tolto, non cancellato); dalle campagne il tipo «comment»; dal registro le voci «comment». Campagne: ciclo 1, «Posizione» In cima se mai scelta. Rollback automatico se un passo fallisce.
- **Impostazioni schema 3 → 4**: via le chiavi dei commenti; «Posizione» predefinita In cima solo se non c'è già una scelta.
- Backup delle versioni 1.x importati con le stesse regole.

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
