# Creare una release

## Cosa fai tu

1. Aggiorna la versione (semver `x.y.z`) in `manifest.json` (la fonte), `package.json`, `version.json` (con `date` e `notes`) e `src/shared/constants.js` (`VERSION`). Aggiungi la sezione `## [x.y.z] - data` in `CHANGELOG.md`.
2. `npm run package`: aggiorna la versione nel README, crea lo zip, lo mette nella radice al posto del vecchio, scrive `zip` e `sha256` in `version.json` e crea `dist/Vintastic_GitHub.zip`. Poi `npm test` (controlli, ESLint, test di unità): si ferma se versione, zip e impronta non coincidono.
3. Carica le modifiche su `main` e **cancella lo zip vecchio** dalla radice (caricando una cartella, GitHub non lo toglie). Da questo momento «Cerca aggiornamento» vede la versione nuova.
4. Su GitHub: **Releases › Draft a new release** → tag `vx.y.z` su `main`, titolo e descrizione brevi → **Publish release**.

## Cosa fa GitHub Actions (`.github/workflows/release.yml`)

| Passo | Dettaglio |
|---|---|
| Checkout del tag | il codice esatto della release |
| Dipendenze | `npm ci` (solo `fake-indexeddb`, per i test) |
| Controllo del tag | deve essere `vX.Y.Z` e coincidere con la versione del manifest |
| `npm test` | versioni allineate, domini allineati, file del manifest presenti, sintassi di ogni file, JSON validi, `links.json` e `version.json` nel formato comune, zip della radice uguale all'impronta di `version.json`, **nessun segreto nel repository**, ESLint, test di unità tra cui il **divieto d'acquisto** |
| Pacchetto | lo zip della radice (lo stesso di `version.json`) e il suo `.sha256` |
| Allegati | ZIP e checksum caricati sulla release (`gh release upload --clobber`) |
| Riepilogo | tabella con lo SHA-256 nel summary del job |
| Artifact | conservati 90 giorni |
| Discord | se esiste il secret `DISCORD_WEBHOOK_URL`, messaggio con titolo, link e note |
| Errori | il job fallisce con un messaggio chiaro; nessun allegato parziale |

Il workflow `ci.yml` esegue test e pacchetto di prova a ogni push e pull request.

Se un job fallisce dopo la pubblicazione: correggi, carica su `main`, sposta il tag o rilancia a mano da **Actions › Release › Run workflow** indicando il tag.

## Segreti

| Nome | Obbligatorio | Uso |
|---|---|---|
| `GITHUB_TOKEN` | automatico | allegare i file alla release |
| `DISCORD_WEBHOOK_URL` | no | annuncio delle release su Discord (Settings › Secrets and variables › Actions) |

Nessun segreto va nel repository: `scripts/check.mjs` blocca la release se trova webhook Discord, token GitHub o chiavi API nei file.

## Prova in locale

```bash
npm ci
npm test                # controlli + test unitari
npm run lint            # solo ESLint
npm run build           # dist/Vintastic-x.y.z.zip + .sha256
npm run package         # in più: zip nella radice, version.json, dist/Vintastic_GitHub.zip
python3 tests/e2e/run_all.py   # scenari end-to-end (Chrome + Playwright)
```

## Pacchetto per GitHub (consegna)

`Vintastic_GitHub.zip` contiene la cartella `Vintastic_GitHub/` con tutti i file del repository e `Vintastic-x.y.z.zip` (la cartella `Vintastic/` pronta per «Carica estensione non pacchettizzata»).

## Cambiare un link (Discord, Ko-fi, segnalazioni)

Modifica `links.json` su `main` e aumenta `revision`: Vintastic lo rilegge entro 12 ore e a ogni «Cerca aggiornamento». Nessuna versione nuova. Chiavi solo minuscole (`bugs`, non `bugReport`), solo `https` verso GitHub, Discord, Ko-fi o `mashaup.github.io`: `npm run check` lo controlla.
