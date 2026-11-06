# Creare una release

## Cosa fai tu

1. Aggiorna la versione (semver `x.y.z`) in **quattro** posti: `manifest.json`, `package.json`, `version.json`, `src/shared/constants.js` (`VERSION`). Aggiungi la sezione `## [x.y.z] - data` in `CHANGELOG.md`. Se qualcosa non torna, i controlli lo dicono prima della pubblicazione (`npm test`).
2. Carica le modifiche su `main`.
3. Su GitHub: **Releases › Draft a new release**
   - **Tag**: `vx.y.z` (crealo dalla stessa schermata, su `main`)
   - **Titolo** e **descrizione** (le novità)
   - **Publish release**

Fine. Il resto lo fa GitHub Actions.

## Cosa fa GitHub Actions (`.github/workflows/release.yml`)

| Passo | Dettaglio |
|---|---|
| Checkout del tag | il codice esatto della release |
| Dipendenze | `npm ci` (solo `fake-indexeddb`, per i test) |
| Controllo del tag | deve essere `vX.Y.Z` e coincidere con la versione del manifest |
| `npm test` | versioni allineate, domini allineati, file del manifest presenti, sintassi di ogni file, JSON validi, **nessun segreto nel repository**, 47 test unitari tra cui il **divieto d'acquisto** |
| `npm run build` | `dist/Vintastic-x.y.z.zip` con la cartella `Vintastic/` (solo i file dell'estensione: niente test, script, workflow, node_modules) e `Vintastic-x.y.z.zip.sha256` |
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
npm run build           # dist/Vintastic-x.y.z.zip + .sha256
python3 tests/e2e/run_all.py   # scenari end-to-end (Chrome + Playwright)
```

## Pacchetto per GitHub (consegna)

`Vintastic_GitHub.zip` contiene la cartella `Vintastic_GitHub/` con tutti i file del repository e `Vintastic-x.y.z.zip` (la cartella `Vintastic/` pronta per «Carica estensione non pacchettizzata»).
