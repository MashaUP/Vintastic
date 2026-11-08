# Piano di test e risultati

**Ambiente.** Linux, Node 22, Google Chrome for Testing **153** (headless, estensione caricata con `--load-extension`), Python + Playwright. Vinted è sostituito da un **Vinted finto** (`tests/e2e/fake_vinted.py`): pagine e API servite con `context.route`, con le forme di risposta note da Vinted_Relist e quelle ipotizzate in `adapter.js`; la **chat** è costruita con l'HTML reale fornito («Chiedi info», `textarea#composerInput`, `[data-testid="arrow-right"]`). **Nessun test automatico ha toccato Vinted reale.** Nella 2.0.0 la pagina reale di un annuncio e la chat sono state *osservate* su vinted.it con Claude in Chrome, nel browser e con l'account dell'autore (07/11/2026): pulsante «Chiedi info», clic, apertura della chat, campo del messaggio. Nessun messaggio inviato. Un test superato qui dimostra che Vintastic si comporta come previsto con *quelle* pagine e risposte; non dimostra che Vinted risponda così.

## Come si eseguono

```bash
npm ci                            # una volta: fake-indexeddb per i test delle migrazioni
npm test                          # scripts/check.mjs + test unitari (node:test)
npm run test:e2e                  # scenari in Chrome (python3 tests/e2e/run_all.py [filtro…]); CHROME_PATH per un altro Chrome/Chromium
npm run build                     # dist/Vintastic-x.y.z.zip + .sha256
actionlint .github/workflows/*.yml
```

- `tests/unit/`: logica pura di `src/shared/` e migrazioni IndexedDB.
- `tests/e2e/`: `fake_vinted.py` (Vinted finto), `harness.py` (avvio di Chrome con l'estensione), `scenarios.py` (funzioni generali), `messages.py` (messaggi privati), `cycles.py` (cicli, interfaccia 2.0, menu Venditore), `run_all.py` (esecuzione e rapporto in `tests/e2e/artifacts/report.json`). Ogni scenario parte da un profilo pulito e controlla che nessuna richiesta d'acquisto sia partita e che le pagine non abbiano errori JavaScript.

## Risultati 2.2.0

| Suite | Superati | Falliti | Note |
|---|---|---|---|
| `npm test` (controlli + unitari) | 93 (controlli + 92 test) | 0 | nuovo: azzeramento dello storico (`resetLedgerSkipped`: solo i tipi e gli annunci scelti, mai «da verificare», mai le saltate per altri motivi) |
| `npm run test:e2e` | 35 scenari | 0 | giro completo 34/35: «menu Venditore» falliva perché la scheda di lettura in background a volte restava non caricata; corretto in `tabs.withReaderTab` (si ricarica una volta se Vintastic non risponde) e ripetuto 3 volte da solo ✔. Nuovo: «storico azzerabile, like tolto e rimesso, filtri immediati» |
| `npm run build` + verifica del pacchetto | ✔ | — | `Vintastic-2.2.0.zip`, 88 file, SHA-256 `cf488ac31cd6a358b502260ea174d2424b97959e364e5630c70e827ff7b2864b`; pacchetto GitHub estratto in una cartella pulita, `npm ci && npm test` superato |

Lo scenario nuovo verifica: «Azzera storico…» dalla campagna con il pulsante rapido «Like» (like di nuovo in attesa, offerte ancora saltate, campagna completata → pronta, registro senza like e con le offerte); like già presente tolto e rimesso (2 toggle per annuncio, like presente alla fine, esito «tolto e rimesso»); «Lascialo» (nessun toggle); filtri degli Annunci mentre scrivi (130 → 0 → 130 senza perdere il cursore, «No Repeat» al cambio del menu); chip «Offerta ×» che azzera solo quella voce; nuova campagna che scorre da sola spuntando «Offerta» e aprendo «Messaggio privato» col triangolo.

**Non eseguito su Vinted reale**: il like tolto e rimesso (toggle due volte) è provato solo sul Vinted finto.

## Risultati 2.1.0

| Suite | Superati | Falliti | Note |
|---|---|---|---|
| `npm test` (controlli + unitari) | 92 (controlli + 91 test) | 0 | nuovi: `sellers.test.mjs` (3), migrazione db_v4→v5, impostazioni 4→5, lista consentita con `followed_users` |
| `npm run test:e2e` | 34 scenari | 0 | giro completo 33/34: «messaggi: ritorno, invio lento, CAPTCHA» falliva per una corsa nel test (la pagina della chat segnala la verifica ~0,2 s dopo l'esito, il test andava avanti prima); il test ora aspetta il segnale, scenario ripetuto da solo ✔. Nuovi: «Chiedi info» cliccabile in ritardo, menu Venditore |
| `npm run build` + verifica del pacchetto | ✔ | — | `Vintastic-2.1.0.zip`, 87 file, SHA-256 `6f982a6b3f3a0b4f94066b86a9b0849bfa50c9138209a20f3adcfc05174172de`; pacchetto GitHub estratto in una cartella pulita, `npm ci && npm test` superato |

### Osservato su Vinted reale (08/11/2026, Claude in Chrome nel browser dell'autore, nessun messaggio inviato)

| Prova | Esito |
|---|---|
| Pagina dell'annuncio: quando compare «Chiedi info» e quando diventa cliccabile | pulsante a ~1,3 s, pagina completa a ~1,6 s, gestore di clic di React a **~2,6–2,9 s** (due misure) |
| Clic appena compare il pulsante (1,2 s) | **nessun effetto**, la pagina resta sull'annuncio: è l'errore della 2.0.0 («il clic su «Chiedi info» non ha aperto la chat») |
| Clic a pagina pronta | chat `/inbox/<uuid>?referrer=…` aperta, `textarea#composerInput` presente, pulsante Invia (`aria-label="Invia messaggio"`) abilitato dopo aver scritto; testo cancellato senza inviare |
| `GET /api/v2/users/:id/followed_users?page=1&per_page=20` | 200, `users[]` con `id` e `login`, `pagination.total_pages` |

### Non eseguibili qui (2.1.0)

| Test | Motivo |
|---|---|
| Invio di un messaggio con Vintastic su Vinted reale | serve la tua sessione: è la prima prova da fare con la 2.1.0 |
| Idratazione in una scheda davvero in background | in headless la scheda risulta visibile; coperto da attesa fino a 20 s + nuovo clic |
| Menu Venditore con il tuo account vero | la lettura dei seguiti è stata provata a mano su vinted.it, non dall'estensione |

## Risultati 2.0.0

| Suite | Superati | Falliti | Note |
|---|---|---|---|
| `npm test` (controlli + unitari) | 87 (controlli + 86 test) | 0 | |
| `npm run test:e2e` | 32 scenari | 0 | ultimo giro completo 32/32. Nel giro precedente 30/32: due scenari vecchi si aspettavano il comportamento 1.4.0 (schema 3; pausa dell’intera campagna con un modulo spento), aggiornati al nuovo comportamento voluto e ripassati |
| `npm run build` + installazione del pacchetto | ✔ | — | `Vintastic-2.0.0.zip`, 85 file, SHA-256 `5f58e0e15f6bacdf7ed5926492c4225a25afb2d78beee6aac78705b1ca62ff60`; installato in Chrome senza errori |

## Test unitari

| File | Copre |
|---|---|
| `offer.test.mjs` | arrotondamenti (,99 ,00 5 10, tre direzioni), modalità, sconti/incrementi, min/max, fasce, importi casuali (intervallo e riproducibilità), errori |
| `queue.test.mjs` | aggiunte senza doppioni, ordine/priorità, una sola operazione alla volta, modifiche che rispettano il completato, rimozioni, riordino, retry solo dei falliti certi, progresso, macchine a stati |
| `ledger-policy.test.mjs` | No Repeat per tipo/account, stati bloccanti, storico, annunci ripubblicati, Policy Validator (sessione, account, kill switch, snapshot, soglie, messaggio dopo una simulazione), differenze di snapshot |
| `filters-timers.test.mjs` | data automatica (pubblicazione → foto → ordine di Vinted), Top N + periodo, intervalli, campo data scelto, ricerca/stato/prezzo, ordinamenti, timer (transizione, per tipo, tra annunci, minimo), soglie e azzeramento giornaliero |
| `guard.test.mjs` | **divieto d'acquisto**: 14 percorsi d'acquisto bloccati, lista ammessa, pulsanti in 10 lingue, analisi statica del codice, guard caricato per primo, permessi del manifest |
| `misc.test.mjs` | redazione, export senza segreti, import (bozze, running → verify), deduplicazione, semver e release GitHub, migrazione impostazioni v1→v5 (3→4 commenti, 4→5 timer più bassi solo se ai vecchi predefiniti), normalizzazione annunci, suggerimenti, statistiche senza simulazioni |
| `db-migrations.test.mjs` | db_v1→v2→v3 con dati conservati, db_v3→v4 (commenti), **db_v4→v5** (timer delle campagne aperte; valori scelti a mano e campagne concluse invariati), installazione pulita 0→5, **rollback** su passo fallito |
| `sellers.test.mjs` | **2.1.0**: menu Venditore (seguiti, destinatari non seguiti, altri scansionati, niente doppioni o id non validi), testo delle opzioni |
| `campaign-flow.test.mjs` | **2.0.0**: messaggio rinviato che non blocca like e offerte (la causa del blocco), tipi sospesi e moduli isolati, nuovi tentativi programmati, No Repeat con i cicli (stesso ciclo, altra campagna, nuovo ciclo, incerti mai), piano e applicazione del nuovo ciclo (cronologia, id, altri annunci intatti, testo a mano), riepilogo dei cicli, riapprovazione, validatore con modulo isolato, diagnosi della chat, selettori verificati, commenti assenti dal codice, «Posizione», notifiche, ordine di «In cima» |
| `messages.test.mjs` | messaggio distinto dal commento, predefiniti (A, 10 al giorno, nessun destinatario), campagne nuove senza messaggi, **destinatari** (id, link, doppioni, nessun limite, se stessi, estranei), testo 1–1000, segnaposto, **6 fonti del testo** (predefinito, modello, scritto ora, rotazione, casuale riproducibile, suggerimento), modalità per campagna, anteprima (estranei saltati, testo a mano fisso, operazioni concluse intatte), **snapshot** con testo e modalità e compatibilità con 1.2.0/1.3.1, Policy Validator, soglia 10/giorno, No Repeat, pulizia delle impostazioni, **privacy** (Support Bundle, log), statistiche, clic solo da `VTGuard.safeClick` e nessuna API di messaggistica |

## I 44 test richiesti

✔ eseguito e superato · ◐ eseguito in parte · ✖ non eseguibile qui (motivo)

| # | Test | Esito | Come |
|---|---|---|---|
| 1 | Installazione pulita | ✔ | e2e «installazione»: worker attivo, guida aperta, db migrato a v3 |
| 2 | Apertura popup | ✔ | e2e: popup e side panel, Ko-fi/Discord/Cerca aggiornamento presenti |
| 3 | Apertura dashboard | ✔ | e2e: tutte le 14 sezioni senza errori JS |
| 4 | Gestione account | ✔ | e2e «account»: rilevamento, nome utente, etichetta personalizzata, preferito |
| 5 | Cambio account | ◐ | e2e: cambio di sessione simulato cambiando il cookie `v_uid`; il login/logout vero su Vinted non è riproducibile |
| 6 | Autenticazione assistita | ✔ | e2e: pausa `auth`, attesa, rilevamento del ritorno, notifica, ripresa dal punto esatto |
| 7 | Scansione armadio | ✔ | 130 annunci in 2 pagine, ri-scansione senza doppioni |
| 8 | Filtri temporali | ✔ | unit + e2e (24 ore, 7 giorni, personalizzato) |
| 9 | Top N | ✔ | Top 20 degli ultimi 7 giorni, numero personalizzato (anche dal dialogo), primi 5 nell'ordine di Vinted senza date, ordine ribaltabile |
| 10 | Selezione annunci | ✔ | e2e via filtri e via wizard |
| 11 | Like | ✔ | 3 like sul Vinted finto, stato letto prima e dopo; anche senza API di lettura (nessun falso «da verificare») |
| 12 | Commenti | — | **tolti nella 2.0.0** (Vinted non li ha): migrazione db_v4 e impostazioni 4 provate, operazione «comment» rifiutata |
| 13 | Offerte | ✔ | importi -20% con arrotondamento, inviati una volta; predefinito +5%; «prezzo troppo basso» → nuove regole → ricalcolo e invio |
| 14 | Combinazione operazioni | ✔ | like + offerta sullo stesso annuncio, nell'ordine scelto; simulazione → «Esegui davvero su Vinted» → invio reale (corretto nella 1.0.1) |
| 15 | Timer | ✔ | unit + e2e (intervallo di 3 s tra annunci rispettato, nessun avanzamento in pausa) |
| 16 | No Repeat | ✔ | campagna ripetuta: 6 saltate, 0 scritture |
| 17 | Coda dinamica | ✔ | e2e «coda dinamica» |
| 18 | Aggiunte durante la campagna | ✔ | 2 annunci in cima con like + offerta |
| 19 | Rimozione | ✔ | elemento rimosso mai eseguito |
| 20 | Modifica operazioni in attesa | ✔ | offerta portata a 7,77 € e inviata così; completate non modificabili |
| 21 | Pausa e ripresa | ✔ | |
| 22 | Chiusura popup durante una campagna | ✔ | il popup non tiene stato; la campagna vive nel worker |
| 23 | Chiusura dashboard | ✔ | campagna completata con la dashboard chiusa |
| 24 | Navigazione su altre schede | ◐ | la scheda di lavoro resta separata; in headless tutte le schede sono «in secondo piano», quindi il caso è coperto, ma non con una finestra minimizzata vera |
| 25 | Mini-Mode | ✔ | widget aggiornato in tempo reale, Pausa/Riprendi dal widget |
| 26 | Floating Action Button | ✔ | menu su armadio e annuncio, aggiunta dalla pagina |
| 27 | Notifiche | ✔ | centro notifiche, raggruppamento, nuova versione, verifica richiesta, sessione valida |
| 28 | Pulitore notifiche | ✔ | 4 selezionate segnate come lette; solo `PUT /notifications/:id` |
| 29 | Dashboard e statistiche | ✔ | conteggi corretti dopo la campagna, simulazioni escluse |
| 30 | Log e diagnostica | ✔ | Health Center completo, Support Bundle senza token né cookie |
| 31 | Auto-pause rete | ✔ | robots.txt irraggiungibile → pausa; ritorno → ripresa automatica dal watchdog |
| 32 | Recupero dopo crash | ✔ | worker terminato (CDP) in fase di invio → «da verificare», non ripetuta; browser chiuso in preparazione → rimessa in coda |
| 33 | Migrazioni database | ✔ | unit (v1→v2→v3, rollback) + installazione pulita in Chrome |
| 34 | Import/export | ✔ | esportazione senza segreti, importazione in un profilo nuovo, bozze, deduplica, file estraneo rifiutato |
| 35 | Aggiornamenti | ✔ | GitHub finto: nuova versione, notifica, SHA-256 verificato, checksum errato rifiutato, rate limit |
| 36 | GitHub Actions | ◐ | `actionlint` OK (ha trovato e fatto correggere un errore YAML); ogni passo provato in locale; **non eseguito su GitHub** (il repository non esiste ancora) |
| 37 | Generazione ZIP | ✔ | 85 file, solo l'estensione, controllo di file obbligatori ed esclusi |
| 38 | Checksum | ✔ | `.sha256` generato e riletto dal version checker |
| 39 | Discord webhook | ◐ | validazione, permesso facoltativo, esclusione dagli export e payload del workflow provati; **invio reale a Discord non eseguibile** (nessuna rete verso discord.com in questo ambiente) |
| 40 | Chrome, Edge, Brave | ◐ | **Chrome 153 ✔**. Edge e Brave non installati qui: ✖ non provati |
| 41 | Divieto assoluto di acquisto | ✔ | unit (guard + analisi statica) + **ogni** scenario e2e verifica che nessuna richiesta d'acquisto sia partita |
| 42 | 403/429 e restrizioni | ✔ | 429 → pausa con backoff, operazione non consumata; CAPTCHA → pausa, sessione segnata, ripartenza bloccata |
| 43 | Persistenza dei dati | ✔ | stato e coda sopravvivono alla terminazione del worker e alla riapertura del browser |
| 44 | Prestazioni con migliaia di annunci | ✔ | 5000 annunci: import 1,4 s, query filtrata ~60 ms, pagina Annunci 0,2 s, nessun blocco misurabile |

**Non eseguito: nessuna prova su Vinted reale.** È il prossimo passo consigliato (vedi la prova manuale qui sotto).

## 2.0.0: campagne, operazioni, cicli, interfaccia

### Operazioni

| Operazione | Test | Esito | Dove |
|---|---|---|---|
| Like | individuazione dello stato, toggle, rilettura, ledger, statistiche | ✔ simulato | campagna reale, like senza API di lettura, cicli |
| Offerte | importo, invio, esito, rifiuto «prezzo troppo basso», nuovo ciclo | ✔ simulato | campagna reale, offerte rifiutate, cicli |
| Messaggi A | apertura chat, compilazione, clic, messaggio verificato, ritorno | ✔ simulato | messaggi A, chat in una scheda nuova |
| Messaggi B | compilazione, attesa, invio dell'utente (pulsante e Invio), timeout | ✔ simulato | messaggi B, timeout |
| «Chiedi info» su vinted.it | pulsante (`data-testid="ask-seller-button"`), clic (anche non «fidato»), chat `/inbox/<uuid>`, `#composerInput` | ✔ **reale, solo osservazione** | Claude in Chrome, 07/11/2026; nessun messaggio inviato |
| Commenti pubblici | rimossi dal codice, dall'interfaccia, dai dati | ✔ | unit (analisi del codice, migrazioni), e2e (dialoghi, rifiuto del tipo) |

### Campagne ed errori

| Caso | Esito | Dove |
|---|---|---|
| Creazione, modifica, salvataggio, avvio, pausa, ripresa, stop | ✔ | wizard, coda dinamica, campagna reale |
| Recupero dopo crash, campagna persistente | ✔ | recupero dopo crash, crash dei messaggi, cicli (riavvio del worker) |
| Aggiunta e rimozione dinamica, ordinamento | ✔ | coda dinamica; «In cima» conserva l'ordine (unit) |
| Limiti giornalieri | ✔ | snapshot e soglie, messaggi A (soglia 3) |
| **Chat rotta: like e offerte continuano** (bug 1.4.0) | ✔ | «chat rotta non blocca like e offerte»: 3/3 like e 3/3 offerte, messaggi sospesi con diagnosi, pausa solo a fine coda |
| Modulo spento: gli altri tipi partono | ✔ | Health Center: like spenti, offerte eseguite, like in attesa |
| Circuit breaker | ✔ | Health Center (offerte isolate), errori dei messaggi («Chiedi info» assente) |
| Errori di fila per tipo / per campagna | ✔ | unit + e2e (messaggi sospesi dopo 3) |

### Cicli

| Caso | Esito | Dove |
|---|---|---|
| Annuncio completato riattivato | ✔ | cicli |
| Nuovo ciclo identificato (numero, id, tabella) | ✔ | cicli (unit + interfaccia) |
| Cronologia precedente intatta (date, esiti, ledger) | ✔ | cicli |
| Duplicati accidentali bloccati | ✔ | cicli (altra campagna: 2 saltate, 0 offerte), unit (stesso ciclo) |
| Errore nel primo ciclo non compromette il successivo | ✔ | unit (fallite escluse, completate ripetute) |
| Refresh di un annuncio non tocca gli altri | ✔ | unit + cicli |
| Riavvio dell'estensione | ✔ | cicli (worker terminato dopo il nuovo ciclo) |
| Conferma esplicita e riapprovazione | ✔ | cicli |

### Interfaccia

| Caso | Esito | Dove |
|---|---|---|
| Notifiche in alto a sinistra non coperte | ✔ | interfaccia 2.0: posizione delle pastiglie misurata (Avviso, Critico, Info) |
| «Posizione» In cima predefinita, salvata e riproposta | ✔ | interfaccia 2.0 + unit |
| Nessun controllo dei commenti | ✔ | interfaccia 2.0 (creazione, aggiunta) + analisi del codice |
| Tutte le pagine si aprono senza errori JavaScript | ✔ | installazione e interfaccia |

### Non eseguibili qui

| Test | Motivo |
|---|---|
| Invio di un messaggio su Vinted reale (A e B) | serve la tua sessione e il destinatario autorizzato: tabella più sotto |
| Chat in una scheda **in background** su Vinted reale | il browser controllato da Claude in Chrome risulta sempre «visibile»; in Chrome headless non si riproduce. Per questo la 2.0.0 porta la scheda in primo piano durante i messaggi |
| Content script assente nella pagina della chat | non riproducibile con il Vinted finto (il manifest lo inserisce sempre); il reinserimento è coperto solo dal codice e dalla diagnosi (unit) |
| Edge, Brave, GitHub Actions | non disponibili in questo ambiente |

## Messaggi privati (1.4.0)

Scenari in `tests/e2e/messages.py`, con l'estensione vera, il motore vero e la chat finta. Tutti **simulati**: nessun messaggio è stato inviato su Vinted reale.

| # | Caso | Esito | Scenario |
|---|---|---|---|
| 1 | Pulsante «Chiedi info» presente | ✔ | messaggi A |
| 2 | Pulsante assente / disabilitato | ✔ | errori: assente → modulo isolato (circuit breaker), disabilitato → fallito non ripetibile |
| 3 | Chat che si apre con ritardo | ✔ | messaggi B: 2 s, nella stessa pagina (navigazione interna); pagina nuova come su vinted.it; scheda nuova; invio lento: messaggio dopo 3 s |
| 4 | Campo `#composerInput` presente | ✔ | tutti |
| 5 | Campo non trovato | ✔ | errori: 3 tentativi distanziati, poi fallito con diagnosi, messaggi sospesi, nessun clic (2.0.0) |
| 6 | Pulsante freccia inizialmente disabilitato | ✔ | la chat finta lo abilita solo con testo, come quella vera |
| 7 | Pulsante che si abilita dopo la compilazione | ✔ | tutti; mai abilitato → fallito ripetibile, 0 clic |
| 8 | Invio automatico e messaggio visibile | ✔ | messaggi A: 2/2, un clic per messaggio |
| 9 | Modalità manuale senza clic automatico | ✔ | messaggi B: 0 clic in 4 s, scheda in primo piano, notifica «Premi Invia» |
| 10 | Clic manuale dell'utente e rilevamento | ✔ | messaggi B: clic sul pulsante e tasto Invio, anche con testo cambiato |
| 11 | Timeout manuale | ✔ | timeout B: attesa portata a 5 s nelle impostazioni (il predefinito è 240 s, stesso codice) → non inviato, ripetibile, messaggi sospesi |
| 12 | Campo svuotato ma messaggio non visibile | ✔ | A: «clear-only» → da verificare, 1 clic; B: campo svuotato a mano → da verificare |
| 13 | CAPTCHA durante l'operazione | ✔ | all'apertura della chat → pausa, non inviato; dopo il clic → da verificare |
| 14 | Ritorno all'annuncio originale | ✔ | messaggi A e B: richiesta della pagina dell'annuncio dopo ogni invio, scheda finale sull'annuncio |
| 15 | Ritorno non riuscito | ✔ | resta completato (verificato), avviso nei log, nessun doppione |
| 16 | Interruzione del service worker durante l'invio | ✔ | crash: worker terminato con il testo nel campo (B) → da verificare |
| 17 | Ripresa senza duplicare | ✔ | crash: nuova campagna sullo stesso annuncio saltata dal ledger, 0 chat aperte |
| — | Venditore non autorizzato / elenco vuoto | ✔ | saltato senza aprire la chat (il like sullo stesso annuncio parte) / avvio bloccato |
| — | Simulazione | ✔ | nessuna chat, nessuna richiesta |
| — | Messaggio identico già nella conversazione | ✔ | non scambiato per quello nuovo |
| — | Soglia giornaliera | ✔ | unit (10) + e2e (soglia 3 → pausa fino a mezzanotte) |
| — | Persistenza delle impostazioni | ✔ | dopo il riavvio del worker; destinatario aggiunto dall'interfaccia |
| — | Privacy | ✔ | testi assenti da log e Support Bundle |

### Prove su Vinted reale (da fare, con i tuoi account)

| Passo | Modalità B | Modalità A |
|---|---|---|
| Destinatario: il tuo account principale in Impostazioni › Messaggi | da fare | da fare |
| Apertura della chat da «Chiedi info» | da fare | da fare |
| Testo compilato nel campo | da fare | da fare |
| Nessun invio automatico (B) / clic automatico (A) | da fare | da fare |
| Invio (tuo in B) e messaggio visibile nella chat | da fare | da fare |
| Operazione «Completato» nella campagna | da fare | da fare |
| Ritorno all'annuncio | da fare | da fare |

Ordine consigliato: campagna con **1** annuncio del tuo account principale, dall'account di prova; prima **B**, poi **A**. Se qualcosa non torna, il log dice in quale fase (apertura, campo, invio, conferma) e il Support Bundle non contiene i testi.

## Problemi trovati dai test e corretti

| Test | Problema | Correzione |
|---|---|---|
| caricamento pagine | 3 sezioni non si aprivano (parentesi) | corrette; `check.mjs` ora controlla i moduli |
| interfaccia | testo «null» nel popup e nel menu dell'overlay | inserimenti sicuri |
| sessione | account non rilevato quando l'intestazione Cookie non è visibile | `chrome.cookies` per `v_uid` |
| sessione | rilevamento «uscito» falso dopo il riavvio del worker | webRequest solo in positivo |
| actionlint | YAML del workflow di release non valido | corretto |
| screenshot | nome della campagna tagliato nel widget; nome utente assente | layout del widget; lettura del nome dalla scheda Vinted |
| popup | piè di pagina oltre i 600 px | compattato |
| like (1.2.0) | like «da verificare» anche se messi: rilettura dai dati vecchi della pagina | dopo l'invio conta solo l'API; scenario «like senza API di lettura» |
| Salute (1.2.0) | la pagina non si apriva senza release su GitHub | gli errori RPC sono marcati (`__vtError`), uno stato «ok: false» non è un errore |
| offerte (1.2.0) | tre importi rifiutati spegnevano il modulo offerte | i rifiuti 400/422 non contano per il circuit breaker |
| date (1.1.0) | «Nessun annuncio» su Vinted reale: l'armadio non dà la data di pubblicazione (il Vinted finto la dava) | data della foto e ordine dell'armadio come ripiego; il Vinted finto ora è senza date come quello vero |
| ordinamento (1.1.0) | il vecchio ordinamento per prezzo ignorava la direzione | direzione rispettata |
| simulazione (1.0.1) | dopo una simulazione la campagna non si poteva eseguire davvero | operazioni simulate rimesse in coda passando alla modalità reale |
| account (flaky) | la verifica leggeva l'elenco prima del nome utente | attesa esplicita nel test; ripetuto 3 volte senza errori |
| messaggi (1.4.0) | clic dei messaggi con evento sintetico, invisibile al controllo del divieto d'acquisto | `VTGuard.safeClick` + test |
| messaggi (1.4.0) | chat aperta in una pagina nuova: il comando si perdeva | invio in due fasi guidato dal motore |
| messaggi (1.4.0) | inviato e verificato ma «da verificare» se il ritorno non riusciva | completato + avviso |
| messaggi (1.4.0) | testo e destinatari dei messaggi nel Support Bundle | `redactMessages` |
| ledger (1.4.0) | dopo due tentativi non partiti di fila l'annuncio restava «in corso» per sempre | ritorno allo stato precedente al tentativo |
| schede (1.4.0) | pagina cambiata durante un comando = «non inviato» (rischio di doppioni) | solo «comando mai arrivato» è non inviato |
| rotazione (test) | ordine di rotazione casuale tra annunci aggiunti nello stesso istante | ordine di aggiunta stabile (`addSeq`) |
| campagne (2.0.0) | un messaggio che non apriva la chat bloccava like e offerte di tutta la coda | rinvio per operazione, sospensione per tipo, breaker senza pausa globale |
| «In cima» (2.0.0) | gli annunci aggiunti insieme finivano in ordine inverso | il gruppo va in cima nel suo ordine |
| notifiche (2.0.0) | pastiglia «Avviso» in una colonna da 26 px, sopra il testo | colonna dedicata (`.feed.notes`) |
| «Ripeti falliti» (2.0.0) | il conteggio dei tentativi non ripartiva | azzerato a ogni «Ripeti falliti» |
| «Chiedi info» (2.1.0) | clic appena la pagina era caricata, prima che Vinted rendesse il pulsante cliccabile: la chat non si apriva mai | attesa del gestore di clic (lettura nel mondo della pagina) + nuovo clic dopo 5 s |
| schede (2.1.0) | con una campagna in corso una scansione spostava la scheda di lavoro | scheda di lettura separata |
| log (2.1.0) | «Serve una scheda di Vinted aperta» aggiunto a ogni errore con la parola «scheda» | solo per scheda di lavoro chiusa/assente |
| recupero dopo crash (test) | controllava «nessun like prima del riavvio» dopo il riavvio, quando la campagna poteva già averlo messo | conteggio preso alla chiusura del browser + controllo «al massimo un like dopo» |

## Prova manuale consigliata su Vinted reale

1. Salute › Esegui controllo completo.
2. Scansiona il **tuo** armadio (solo lettura).
3. Campagna con **1** annuncio, solo like, **simulazione** → poi reale.
4. Salute › Compatibilità: «Like» deve risultare OK.
5. Campagna con 1 annuncio, solo offerta, con «chiedi conferma» → controlla la chat su Vinted.
6. Notifiche › Carica anteprima → segna come letta 1 notifica.
7. Messaggi: vedi la tabella «Prove su Vinted reale» qui sopra (prima B, poi A).

Se qualcosa risponde in un formato diverso, il modulo si sospende da solo e il log dice cosa è cambiato: allega il Support Bundle alla segnalazione.
