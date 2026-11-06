# Piano di test e risultati

**Ambiente.** Linux, Node 22, Google Chrome for Testing **153** (headless, estensione caricata con `--load-extension`), Playwright. Vinted è sostituito da un **Vinted finto** (`tests/e2e/fake_vinted.py`): pagine e API servite con `context.route`, con le forme di risposta note da Vinted_Relist e quelle ipotizzate in `adapter.js`. **Nessun test ha toccato Vinted reale.** Un test superato qui dimostra che Vintastic si comporta come previsto con *quelle* risposte; non dimostra che Vinted risponda così.

## Come si eseguono

```bash
npm test                          # scripts/check.mjs + 47 test unitari (node:test, fake-indexeddb)
python3 tests/e2e/run_all.py      # 18 scenari in Chrome; rapporto in tests/e2e/artifacts/report.json
actionlint .github/workflows/*.yml
npm run build                     # ZIP + SHA-256
```

## Test unitari (47/47 ✔)

| File | Copre |
|---|---|
| `offer.test.mjs` | arrotondamenti (,99 ,00 5 10, tre direzioni), modalità, sconti/incrementi, min/max, fasce, importi casuali (intervallo e riproducibilità), errori |
| `queue.test.mjs` | aggiunte senza doppioni, ordine/priorità, una sola operazione alla volta, modifiche che rispettano il completato, rimozioni, riordino, retry solo dei falliti certi, progresso, macchine a stati |
| `ledger-policy.test.mjs` | No Repeat per tipo/account, stati bloccanti, storico, annunci ripubblicati, Policy Validator (sessione, account, kill switch, snapshot, soglie), differenze di snapshot |
| `filters-timers.test.mjs` | Top N + periodo, intervalli, campo data scelto, ricerca/stato/prezzo, ordinamenti, timer (transizione, per tipo, tra annunci, minimo), soglie e azzeramento giornaliero |
| `guard.test.mjs` | **divieto d'acquisto**: 14 percorsi d'acquisto bloccati, lista ammessa, pulsanti in 10 lingue, analisi statica del codice, guard caricato per primo, permessi del manifest |
| `misc.test.mjs` | redazione, export senza segreti, import (bozze, running → verify), deduplicazione, semver e release GitHub, migrazione impostazioni v1→v3, normalizzazione annunci, suggerimenti, statistiche senza simulazioni |
| `db-migrations.test.mjs` | db_v1→v2→v3 con dati conservati, installazione pulita 0→3, **rollback** su passo fallito |

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
| 9 | Top N | ✔ | Top 20 degli ultimi 7 giorni, ordinati |
| 10 | Selezione annunci | ✔ | e2e via filtri e via wizard |
| 11 | Like | ✔ | 3 like sul Vinted finto, stato letto prima e dopo |
| 12 | Commenti | ✔ | Vinted non li supporta: diventano suggerimenti, nessun invio (verificato) |
| 13 | Offerte | ✔ | importi -20% con arrotondamento, inviati una volta |
| 14 | Combinazione operazioni | ✔ | like + offerta sullo stesso annuncio, nell'ordine scelto |
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
| 37 | Generazione ZIP | ✔ | 82 file, solo l'estensione, controllo di file obbligatori ed esclusi |
| 38 | Checksum | ✔ | `.sha256` generato e riletto dal version checker |
| 39 | Discord webhook | ◐ | validazione, permesso facoltativo, esclusione dagli export e payload del workflow provati; **invio reale a Discord non eseguibile** (nessuna rete verso discord.com in questo ambiente) |
| 40 | Chrome, Edge, Brave | ◐ | **Chrome 153 ✔**. Edge e Brave non installati qui: ✖ non provati |
| 41 | Divieto assoluto di acquisto | ✔ | unit (guard + analisi statica) + **ogni** scenario e2e verifica che nessuna richiesta d'acquisto sia partita |
| 42 | 403/429 e restrizioni | ✔ | 429 → pausa con backoff, operazione non consumata; CAPTCHA → pausa, sessione segnata, ripartenza bloccata |
| 43 | Persistenza dei dati | ✔ | stato e coda sopravvivono alla terminazione del worker e alla riapertura del browser |
| 44 | Prestazioni con migliaia di annunci | ✔ | 5000 annunci: import 1,4 s, query filtrata ~60 ms, pagina Annunci 0,2 s, nessun blocco misurabile |

**Non eseguito: nessuna prova su Vinted reale.** È il prossimo passo consigliato (vedi [ROADMAP](ROADMAP.md)).

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
| account (flaky) | la verifica leggeva l'elenco prima del nome utente | attesa esplicita nel test; ripetuto 3 volte senza errori |

## Prova manuale consigliata su Vinted reale

1. Salute › Esegui controllo completo.
2. Scansiona il **tuo** armadio (solo lettura).
3. Campagna con **1** annuncio, solo like, **simulazione** → poi reale.
4. Salute › Compatibilità: «Like» deve risultare OK.
5. Campagna con 1 annuncio, solo offerta, con «chiedi conferma» → controlla la chat su Vinted.
6. Notifiche › Carica anteprima → segna come letta 1 notifica.

Se qualcosa risponde in un formato diverso, il modulo si sospende da solo e il log dice cosa è cambiato: allega il Support Bundle alla segnalazione.
