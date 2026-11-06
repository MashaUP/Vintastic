# Modello dati

## IndexedDB `vintastic` (versione 3)

| Store | Chiave | Indici | Contenuto |
|---|---|---|---|
| `listings` | `id` | `sellerId`, `lastSeenAt`, `publishedAt` | Annuncio normalizzato: titolo, prezzo, valuta, foto, venditore, marca, taglia, categoria, stato (`active/sold/reserved/hidden/unavailable`), date separate (`publishedAt`, `updatedAt`, `repostedAt`, `photoAt`), `firstSeenAt`, `lastSeenAt`, `priceHistory[]`, `scanIds[]`, `scannedBy`, `relistOf` |
| `campaigns` | `id` | — | Campagna (sotto) |
| `items` | `id` | `campaignId`, `listingId` | Elemento di coda (sotto) |
| `ledger` | `key` = `account|annuncio|tipo` | `listingId`, `accountId`, `at` | Global Interaction Ledger |
| `journal` | `seq` (auto) | `opId`, `at` | Write-ahead log: `intent`, `sending`, `result` |
| `logs` | `seq` (auto) | `at` | Log diagnostici redatti |
| `activity` | `seq` (auto) | `at` | Centro attività in tempo reale |
| `notifications` | `id` | `at` | Centro notifiche |
| `scans` | `id` | `startedAt` | Scansioni |
| `suggestions` | `id` | `listingId` | Cronologia dei suggerimenti |
| `accounts` | `id` = `userId@origin` | — | Account rilevati, etichette, preferiti, note |
| `meta` | `key` | — | Filtri salvati, backup preventivo dell'import |

### Campagna

```js
{
  id, name, accountId, origin, scanAccountId,
  status: "draft" | "ready" | "running" | "paused" | "stopped" | "completed",
  dryRun,                                  // simulazione
  opsDefaults: { types, order, offerCfg, comment, requireConfirm },
  timers: { betweenOps, betweenItems, transitions, perType },
  skipRules: { notActive },
  sort: { mode, seed },
  snapshot: { at, hash, count },           // Preview Snapshot approvato
  pauseReason, pauseDetail, autoPaused, resumeAt, pendingConfirm,
  nextAt, nextLabel, nextOp, current, lastOp,
  consecutiveFailures, progress, history[], createdAt, startedAt, completedAt
}
```

### Elemento di coda e operazione

```js
{ id, campaignId, listingId, listing: { id, title, price, currency, url, photo, sellerId, sellerLogin, status, … },
  position, priority, removed, addedAt, history[],
  ops: [{ id, type: "like" | "comment" | "offer",
          status: "never" | "prepared" | "waiting" | "running" | "completed" | "failed" | "verify" | "cancelled" | "skipped",
          amount, offerCfg, offerPreview, comment, requireConfirm, confirmedAt,
          attempts, startedAt, finishedAt, error, reason, retryable, result }] }
```

### Voce del ledger

```js
{ key, accountId, listingId, sellerId, type, status, at, campaignId, opId, amount, result, simulated, title,
  history: [{ at, status, campaignId }] }
```

## chrome.storage.local

| Chiave | Contenuto |
|---|---|
| `settings` | Impostazioni (`DEFAULT_SETTINGS`, schema 3) |
| `settingsBackup_v<N>` | Copia prima di una migrazione |
| `session` | Ultimo stato noto: `loggedIn`, `userId`, `accountId`, `origin`, `login`, `challenge`, `checkedAt` |
| `counters` | Contatori del giorno per le soglie |
| `breakers`, `capabilities`, `lastHealth` | Salute dei moduli |
| `connectivity`, `authPending`, `blockStreak`, `lastRecovery` | Stato operativo |
| `updateStatus`, `links` | Aggiornamenti e link del progetto |
| `cleanerStatus` | Avanzamento del pulitore |

## chrome.storage.session (in memoria)

`vintedTokens` (CSRF e anon id per origine: mai su disco), `ownedTabs` (schede di Vintastic), `loginFetchAt`.

## Migrazioni

| Passo | Cosa fa |
|---|---|
| db_v1 | listings, campaigns, items, ledger, logs, notifications, meta |
| db_v2 | journal, scans, suggestions |
| db_v3 | indici `items.listingId`, `ledger.at`, `listings.publishedAt`; store `activity`, `accounts`; `simulated: false` sulle voci del ledger esistenti |
| settings_v2 | timer piatti → `betweenItems`; limite unico → per tipo |
| settings_v3 | notifiche e overlay da booleani a oggetti |

Le migrazioni del database girano dentro la transazione di upgrade: se un passo fallisce, IndexedDB annulla tutto e resta la versione precedente (provato). Prima di migrare le impostazioni viene salvato un backup.

## Formato di esportazione

```json
{ "app": "Vintastic", "schema": 1, "version": "1.0.0", "exportedAt": "…",
  "parts": { "settings": {}, "accounts": [], "campaigns": [{ "items": [] }], "filters": [], "dashboard": {}, "listings": [], "history": [] } }
```

Mai inclusi: webhook, chiavi API, cookie, token. All'importazione: campagne in bozza, operazioni `running` → `verify`, ledger solo in aggiunta.
