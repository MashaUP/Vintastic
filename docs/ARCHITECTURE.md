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
| `src/shared/` | Logica pura condivisa e testata in Node: macchine a stati, coda, ledger, offerte, filtri, timer e soglie, policy, snapshot, migrazioni, import/export, redazione, versioni, suggerimenti, statistiche, **guard** del divieto d'acquisto |
| `src/background/` | Service worker: router RPC, motore delle campagne, persistenza (IndexedDB), sessione, schede, salute e circuit breaker, connettività, notifiche e Discord, scanner, pulitore notifiche, aggiornamenti, backup |
| `src/content/` | Sulle pagine Vinted: client API con guard, adapter (scansione, like, offerta, sessione, notifiche), overlay |
| `src/ui/` | Dashboard (14 sezioni), popup, side panel, wizard, Web Worker per dati grandi |

## Scelte principali

**Operazioni via API interne, non via clic.** Vinted è un'app Next.js; i suoi pulsanti cambiano spesso. Come Vinted_Relist, Vintastic usa le stesse API che usa il sito (`/api/v2/…`) dal contesto della pagina (cookie e CSRF della sessione), con le intestazioni del sito. Ogni chiamata passa da `VTGuard.assertRequestAllowed`: una lista chiusa di metodo + percorso + contenuto. Il content script non preme mai pulsanti della pagina.

**Una scheda di lavoro di proprietà.** Le operazioni avvengono in una scheda aperta da Vintastic (Tab Ownership Manager): naviga sulla pagina dell'annuncio, aspetta che il content script dica «pronto» (con lo stato della pagina: login, CAPTCHA), poi esegue. Le schede dell'utente si usano solo in lettura e solo su sua richiesta (es. «Scansiona questo armadio»).

**Service worker effimero.** Chrome sospende il worker dopo ~30 s di inattività. Per questo:
- tutto lo stato è su disco (IndexedDB + `storage.local`); `storage.session` solo per dati che possono sparire (token, schede);
- intervalli brevi con `setTimeout` mentre il worker è vivo, più un allarme `vt-engine` di riserva; watchdog `vt-watchdog` ogni minuto;
- le porte aperte (overlay, dashboard) mandano un ping ogni 20 s mentre una campagna gira.

**Journal write-ahead.** Prima di un'operazione: `intent`. Subito prima della richiesta di scrittura: `sending`. Dopo: `result`. Al riavvio (`engine.recover`): senza `sending` → di nuovo in attesa; con `sending` e senza esito → **da verificare**, mai ripetuta.

**Lock unico.** Tutte le scritture su campagne e code passano da `withLock` (catena di promesse) o da `patchCampaign`/`claimOp`, che rileggono dentro il lock: una modifica dell'utente durante un'operazione non viene persa e un elemento rimosso non viene eseguito.

## Flusso di un'operazione

1. `tick()` sceglie la campagna con `nextAt` più vicino e la prossima operazione (`queue.nextOp`).
2. Controlli senza toccare Vinted: annuncio attivo, modulo disponibile (feature flag, kill switch, circuit breaker), **ledger** (No Repeat), conferma richiesta, soglie, importo dell'offerta.
3. Simulazione → completata con `simulated: true`, nessuna richiesta.
4. Reale → sessione e account corrispondenti, altrimenti autenticazione assistita.
5. `claimOp` (atomico) → ledger `running` → journal `intent` → scheda sulla pagina dell'annuncio → pagina pronta (CAPTCHA? login?) → journal `sending` → `vt:exec`.
6. Esito classificato: `done/already` → completata; `priceChanged` → pausa per nuova approvazione; `blocked/captcha` → pausa di tutto con backoff; `auth` → autenticazione assistita; `failed` → fallita (ripetibile se l'esito è certo); `changed/unsupported` → circuit breaker del modulo; `uncertain` → da verificare.
7. Timer successivo da `timers.delayBefore` (transizione, per tipo, tra annunci, minimo assoluto).

## Macchine a stati

Operazione: `prepared → waiting → running → completed | failed | verify | skipped`; `waiting → cancelled`; `failed → waiting` (solo retry esplicito); `verify → completed | failed` (solo risoluzione). Campagna: `draft → ready → running ⇄ paused → stopped | completed`. Le transizioni non previste lanciano `TransitionError` (`src/shared/states.js`).

## Degradazione controllata

Ogni modulo (scanner, like, offerte, commenti, pulitore, overlay, aggiornamenti, Discord, AI) ha feature flag, kill switch e circuit breaker. Una risposta di Vinted in un formato inatteso apre il breaker di **quel** modulo (`hard`), lo registra con la spiegazione e lascia funzionare il resto (testato: offerte isolate, scanner attivo). Gli errori temporanei aprono il breaker dopo 3 di fila e lo richiudono in prova dopo 30 minuti.

## Side panel, overlay, popup

- **Overlay** (content script, Shadow DOM): visibile mentre lavori su Vinted, nessuna interferenza con gli stili del sito.
- **Side panel**: stessa interfaccia del popup, aperta accanto a qualsiasi sito.
- **Popup**: azioni rapide sull'annuncio della scheda attiva.

Tutti e tre si aggiornano dalla stessa porta in tempo reale.

## Web Worker

`src/ui/workers/data-worker.js`: parsing dei backup JSON e CSV di migliaia di righe fuori dal thread della pagina. Filtri e ordinamenti dell'archivio girano nel service worker, che è già un thread separato. Con 5000 annunci: query filtrata ~70 ms, nessun blocco misurabile dell'interfaccia (vedi TEST_PLAN).
