# Architettura

Vintastic è un'estensione **Manifest V3** in JavaScript puro (moduli ES), senza dipendenze a runtime e senza build. Quattro parti comunicano solo con messaggi.

```
┌────────────────────────── Browser ──────────────────────────┐
│                                                             │
│  Dashboard / Popup / Side panel (src/ui)                    │
│     │  chrome.runtime.sendMessage({type:"vt:rpc"})          │
│     │  Port "vt-ui" ← eventi in tempo reale                 │
│     ▼                                                       │
│  Service worker (src/background)  ── IndexedDB "vintastic"  │
│     │  motore campagne · journal · ledger · scheduler       │  chrome.storage.local (impostazioni, contatori)
│     │  sessione · salute · notifiche · aggiornamenti        │  chrome.storage.session (token Vinted, schede)
│     │  chrome.tabs.sendMessage({type:"vt:exec"})            │
│     ▼                                                       │
│  Content script su www.vinted.* (src/content)               │
│     guard-core.js → vinted-api.js → adapter.js              │
│     overlay.js (FAB + mini-widget, Shadow DOM)              │
│     │  fetch same-origin /api/v2/… (solo lista ammessa)     │
│     ▼                                                       │
│  Vinted                                                     │
└─────────────────────────────────────────────────────────────┘
```

## Componenti

| Cartella | Ruolo |
|---|---|
| `src/shared/` | Logica pura condivisa e testata in Node: macchine a stati, coda, ledger, offerte, **messaggi** (destinatari, testi, segnaposto), filtri, timer e soglie, policy, snapshot, migrazioni, import/export, redazione, versioni, suggerimenti, statistiche, **guard** del divieto d'acquisto |
| `src/background/` | Service worker: router RPC, motore delle campagne, persistenza (IndexedDB), sessione, schede, salute e circuit breaker, connettività, notifiche e Discord, scanner, pulitore notifiche, aggiornamenti, backup |
| `src/content/` | Sulle pagine Vinted: client API con guard, adapter (scansione, like, offerta, messaggio, sessione, notifiche), overlay |
| `src/ui/` | Dashboard (14 sezioni), popup, side panel, wizard, editor dei messaggi, Web Worker per dati grandi |

## Scelte principali

**Operazioni via API interne, non via clic.** Vinted è un'app Next.js; i suoi pulsanti cambiano spesso. Come Vinted_Relist, Vintastic usa le stesse API che usa il sito (`/api/v2/…`) dal contesto della pagina (cookie e CSRF della sessione), con le intestazioni del sito. Ogni chiamata passa da `VTGuard.assertRequestAllowed`: una lista chiusa di metodo + percorso + contenuto. L'unica eccezione sono i **messaggi privati**: per non usare endpoint di messaggistica, Vintastic usa i controlli visibili della chat («Chiedi info», `textarea#composerInput`, pulsante con `[data-testid="arrow-right"]`), e ogni clic passa da `VTGuard.safeClick`, che rifiuta qualsiasi elemento d'acquisto.

**Una scheda di lavoro di proprietà.** Le operazioni avvengono in una scheda aperta da Vintastic (Tab Ownership Manager): naviga sulla pagina dell'annuncio, aspetta che il content script dica «pronto» (con lo stato della pagina: login, CAPTCHA), poi esegue. Le schede dell'utente si usano solo in lettura e solo su sua richiesta (es. «Scansiona questo armadio»).

**Service worker effimero.** Chrome sospende il worker dopo ~30 s di inattività. Per questo:
- tutto lo stato è su disco (IndexedDB + `storage.local`); `storage.session` solo per dati che possono sparire (token, schede);
- intervalli brevi con `setTimeout` mentre il worker è vivo, più un allarme `vt-engine` di riserva; watchdog `vt-watchdog` ogni minuto;
- le porte aperte (overlay, dashboard) mandano un ping ogni 20 s mentre una campagna gira.

**Journal write-ahead.** Prima di un'operazione: `intent`. Subito prima della richiesta di scrittura: `sending`. Dopo: `result`. Al riavvio (`engine.recover`): senza `sending` → di nuovo in attesa; con `sending` e senza esito → **da verificare**, mai ripetuta.

**Lock unico.** Tutte le scritture su campagne e code passano da `withLock` (catena di promesse) o da `patchCampaign`/`claimOp`, che rileggono dentro il lock: una modifica dell'utente durante un'operazione non viene persa e un elemento rimosso non viene eseguito.

## Flusso di un'operazione

1. `tick()` sceglie la campagna con `nextAt` più vicino e la prossima operazione **eseguibile adesso** (`queue.nextOp`): salta quelle con un nuovo tentativo programmato (`retryAfter`) e quelle dei tipi bloccati (`blockedTypes`: sospesi nella campagna o modulo non disponibile), anche sullo stesso annuncio.
2. Controlli senza toccare Vinted: annuncio attivo, modulo disponibile (feature flag, kill switch, circuit breaker), **ledger** (No Repeat), conferma richiesta, soglie, importo dell'offerta.
3. Simulazione → completata con `simulated: true`, nessuna richiesta.
4. Reale → sessione e account corrispondenti, altrimenti autenticazione assistita.
5. `claimOp` (atomico) → ledger `running` → journal `intent` → scheda sulla pagina dell'annuncio → pagina pronta (CAPTCHA? login?) → journal `sending` → `vt:exec` (per i messaggi le fasi descritte più sotto).
6. Esito classificato: `done/already` → completata; `priceChanged` → pausa per nuova approvazione; `blocked/captcha` → pausa di tutto con backoff; `auth` → autenticazione assistita; `failed` → fallita (ripetibile se l'esito è certo); `changed/unsupported` → circuit breaker del modulo (solo quel modulo si ferma); `uncertain` → da verificare.
7. Timer successivo da `timers.delayBefore` (transizione, per tipo, tra annunci, minimo assoluto). Se non c'è niente di eseguibile ma restano operazioni: si aspetta il primo `retryAfter`; se restano solo tipi bloccati → pausa con la spiegazione (`waitOrPause`).

## Errori e pause (2.0.0)

Fino alla 1.4.0 un'operazione non partita tornava «in attesa» in testa alla coda: `nextOp` la riprendeva subito e un solo contatore di errori metteva in pausa l'intera campagna dopo 3 tentativi. Un messaggio che non apriva la chat bloccava like e offerte di tutti gli annunci successivi. Ora:

| Evento | Effetto |
|---|---|
| Operazione non partita per un motivo suo (pagina, chat, scheda) | `retryAfter` dopo 30 s e poi 120 s (`opRetry`, impostabile; fino alla 2.0.0 60 e 300 s); dopo 3 tentativi «fallita», ripetibile. Intanto si eseguono le altre |
| 3 errori di fila dello stesso tipo (`maxConsecutiveFailures`) | `campaign.suspended[tipo]`: solo quel tipo si ferma nella campagna, notifica; gli altri continuano. Riprendere azzera |
| 6 errori di fila di tipi diversi (`maxConsecutiveFailuresAll`) | pausa `errors` della campagna (probabile problema generale) |
| Modulo isolato dal circuit breaker | le sue operazioni aspettano, le altre partono; il validatore blocca solo se non resterebbe niente |
| CAPTCHA, 403/429, sessione | come prima: pausa di tutto (riguardano l'account, non l'operazione) |
| Invio manuale (B) non arrivato | messaggi sospesi nella campagna (`kind: "manual"`) |

## Cicli (2.0.0)

Riprocessare gli annunci già elaborati senza nuove campagne. `queue.refreshPlan` decide cosa si ripete: operazioni completate o saltate perché già fatte (`result.ledger === "done"`); mai `verify`, `running`, in coda o fallite. `engine.startNewCycle` richiede `confirm: true`, sposta le operazioni ripetute in `item.pastCycles` (data, esito, importo, errori restano), crea quelle nuove con `cycle`, `cycleId` e `newCycle: true`, azzera lo snapshot (anteprima da riapprovare) e annota il ciclo nella campagna (`cycle`, `cycles`). Il ciclo corrente si riusa se non è ancora partito niente.

Il ledger registra `cycleKey = campagna#ciclo` con ogni stato e lo conserva nello storico. `canInteract(entry, { cycleKey, newCycle })`: completata nello stesso ciclo → bloccata (`sameCycle`); completata altrove senza nuovo ciclo → bloccata (`done`, duplicato accidentale); nuovo ciclo voluto → ammessa (`newCycle`); `running`/`verify` → sempre bloccata.

## Azzerare lo storico e like rimesso (2.2.0)

`engine.clearHistory({ listingIds, types, campaignId })` (RPC `ledger.clear`): toglie dal `ledger` le voci dei tipi scelti per quegli annunci, tranne `running` e `verify`; poi `queue.resetLedgerSkipped` rimette `waiting` le operazioni `skipped` con `result.ledger` `done`/`sameCycle` nelle campagne aperte (e in quella da cui si azzera, anche se completata). Interfaccia in `src/ui/history-dialog.js`.

Like con `c.likeExisting = "relike"` (predefinito `campaignDefaults.likeExisting`): `VT.like` con `op.relike`, se lo stato letto è «piace» → toggle, rilettura API = non piace, attesa, toggle, rilettura = piace. Ogni passo che non torna → `failed` ripetibile: il tentativo dopo riparte da una pagina ricaricata e rilegge lo stato, quindi non inverte mai un like a caso.

## Menu Venditore e letture con una campagna in corso (2.1.0)

`sellers.menu` (`src/background/sellers.js`, logica pura in `src/shared/sellers.js`) unisce tre fonti: gli account seguiti dall'account collegato (`GET /users/:id/followed_users`, a pagine, salvati in `meta` `following:<account>` e riletti se più vecchi di un giorno o con «Aggiorna seguiti»), i destinatari dei messaggi non seguiti, gli altri venditori con annunci scansionati. Un venditore senza annunci scansionati si può scegliere: la finestra avvia `scan.start` e aspetta `scan.get` prima di aggiungere.

`tabs.withReaderTab`: senza campagne in esecuzione le letture usano la scheda di lavoro (`ensureAt`); con una campagna in esecuzione si apre una scheda in background (`reader`), si aspetta che Vintastic risponda (reinserito se manca) e la si chiude. Così una scansione o la lettura dei seguiti non sposta la scheda di lavoro a metà di un'operazione.

## Messaggi privati

Logica pura in `src/shared/messages.js`, fasi in `engine.runMessage` e `adapter.js`.

1. **Anteprima** (`fillMessageOps`): per ogni messaggio in attesa si controlla il destinatario (elenco di Impostazioni › Messaggi; un venditore estraneo → saltato, nessuna chat) e si calcolano testo e modalità dalla configurazione della campagna (`opsDefaults.message`: predefinito, modello, scritto ora, rotazione, casuale, suggerimento; segnaposto). Testo e modalità entrano nello snapshot: si invia ciò che è stato approvato. I testi scritti a mano per un annuncio (`textLocked`) restano.
2. **Prima di toccare Vinted**: destinatario e testo ricontrollati (anche in simulazione, che non apre chat), ledger, soglia giornaliera.
3. `engine.waitClickable` (2.1.0): su vinted.it «Chiedi info» compare ~1,3 s dopo l'apertura della pagina ma diventa cliccabile solo dopo l'idratazione di React (~2,6–2,9 s, misurato l'08/11/2026); un clic prima va a vuoto. Con `chrome.scripting.executeScript` nel mondo `MAIN` (i content script, nel mondo isolato, non vedono le proprietà di React) si legge se il pulsante ha `__reactProps$…onClick`; si aspetta fino a 20 s. Pagina senza segni di Next.js/React: si prosegue 4 s dopo il caricamento completo. Nessun clic in questa fase.
   `vt:msgOpen` sulla pagina dell'annuncio: venditore della pagina = venditore dell'anteprima e autorizzato, annuncio attivo, clic su «Chiedi info» (`button[data-testid="ask-seller-button"]`, altrimenti l'etichetta esatta risalendo al pulsante). Nessun messaggio ancora.
4. `engine.waitChat` aspetta la chat guardando lo stato reale: indirizzo e caricamento della scheda, schede nuove aperte dal clic (`openerTabId`), presenza di Vintastic (`vt:msgComposer`; se manca su una pagina caricata viene reinserito con `chrome.scripting`), campo `#composerInput`. Il limite (25 s senza cambiamenti, 60 s al massimo) riparte finché la pagina naviga. Su vinted.it il clic porta, con un caricamento completo, a `/inbox/<uuid>?referrer=…`. Se la scheda resta sull'annuncio con il pulsante presente, `vt:msgOpen` si ripete dopo 5 s (al massimo 3 clic in tutto: aprire la chat non invia niente). Se la chat non arriva, `messages.chatDiagnosis` spiega quale caso si è verificato. Per i messaggi la scheda di lavoro va in primo piano (`messages.focusTab`), anche da una finestra ridotta a icona.
5. Journal `sending` (punto di non ritorno), poi `vt:msgFill`: testo nel campo; in A clic su Invia, in B scheda in primo piano e notifica.
6. `vt:msgStatus` ogni secondo (45 s in A, fino a 4 minuti in B): confermato solo se il campo è vuoto **e** compare un messaggio nuovo con quel testo (conteggio rispetto a prima dell'invio). Il clic dell'utente e il tasto Invio si registrano in fase di cattura, con il testo effettivo.
7. Esito: confermato → completato, poi ritorno all'annuncio (se non riesce: avviso, il messaggio resta completato). Tentato ma non confermato, CAPTCHA dopo il clic, pagina persa → **da verificare**, mai ripetuto. In B senza invio e con il testo ancora nel campo → fallito ripetibile e messaggi sospesi nella campagna.

Il contenuto dei messaggi non va in log, journal, ledger o Support Bundle (`redactMessages`).

## Macchine a stati

Operazione: `prepared → waiting → running → completed | failed | verify | skipped`; `waiting → cancelled`; `failed → waiting` (solo retry esplicito); `verify → completed | failed` (solo risoluzione). Campagna: `draft → ready → running ⇄ paused → stopped | completed`. Le transizioni non previste lanciano `TransitionError` (`src/shared/states.js`).

## Degradazione controllata

Ogni modulo (scanner, like, offerte, messaggi, pulitore, overlay, aggiornamenti, Discord, AI) ha feature flag, kill switch e circuit breaker. Una risposta di Vinted in un formato inatteso apre il breaker di **quel** modulo (`hard`), lo registra con la spiegazione e lascia funzionare il resto (testato: offerte isolate, scanner attivo). Gli errori temporanei aprono il breaker dopo 3 di fila e lo richiudono in prova dopo 30 minuti.

## Side panel, overlay, popup

- **Overlay** (content script, Shadow DOM): visibile mentre lavori su Vinted, nessuna interferenza con gli stili del sito.
- **Side panel**: stessa interfaccia del popup, aperta accanto a qualsiasi sito.
- **Popup**: azioni rapide sull'annuncio della scheda attiva.

Tutti e tre si aggiornano dalla stessa porta in tempo reale.

## Web Worker

`src/ui/workers/data-worker.js`: parsing dei backup JSON e CSV di migliaia di righe fuori dal thread della pagina. Filtri e ordinamenti dell'archivio girano nel service worker, che è già un thread separato. Con 5000 annunci: query filtrata ~70 ms, nessun blocco misurabile dell'interfaccia (vedi TEST_PLAN).
