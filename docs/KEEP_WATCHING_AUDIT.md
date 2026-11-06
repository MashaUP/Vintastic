# Audit di Keep_Watching

Repository analizzato: `MashaUP/Keep_Watching` (versione 1.6.0, MIT, stesso autore). Codice letto: `manifest.json`, `src/site-health.js`, struttura di `src/lib` (`health.js`, `links.js`, `stats.js`, `updates.js`), `README.md`, test unitari ed e2e.

| Funzione di Keep_Watching | In Vintastic | Note |
|---|---|---|
| Centro salute e «Verifica tutto» senza toccare il sito | MIGLIORATA | Health Center con «Esegui controllo completo»: worker, storage, database, code, sessione, compatibilità, moduli, kill switch, versione, errori ricorrenti, rete |
| Riconoscimento delle pagine per struttura, non per dominio; segnala quando il sito è cambiato | MIGLIORATA | Capability detection: ogni modulo registra se l'endpoint ha risposto nel formato atteso; formato cambiato → circuit breaker del solo modulo |
| Cronologia eventi locale, esportabile e cancellabile | GIÀ PRESENTE | Log + centro attività, esportazione JSON/CSV, pulizia selettiva, retention |
| Ripresa «con esito verificato»: un tentativo è riuscito solo se il risultato si vede davvero | GIÀ PRESENTE | Like riletto dopo l'invio; esito non verificabile = «da verificare» |
| Statistiche locali con grafico, esportazione CSV/JSON, importazione con unione senza doppioni | MIGLIORATA | Statistiche con 6 periodi, 6 grafici, CSV; backup JSON con deduplicazione |
| Profili di impostazioni (Normale, Notturno…) | NON COMPATIBILE | Sostituiti da impostazioni per campagna |
| Barra sul player personalizzabile: dimensione, densità, opacità, posizione, animazioni ridotte | GIÀ PRESENTE | FAB e widget: dimensione, posizione trascinabile, ridimensionabile, `prefers-reduced-motion` |
| Guida alle scorciatoie (Alt+Shift+H) e comandi configurabili | GIÀ PRESENTE | `?` nella dashboard, comandi del browser, link a `chrome://extensions/shortcuts` |
| Notifiche desktop con clic che riporta alla scheda giusta | GIÀ PRESENTE | Clic → dashboard sulla pagina collegata |
| «Cerca aggiornamento» con novità e download dello zip | MIGLIORATA | Con verifica SHA-256 |
| Link ufficiali da `links.json` | GIÀ PRESENTE | |
| Test unitari + e2e Python/Playwright con server finto | GIÀ PRESENTE | Stessa impostazione in `tests/` |
| Script di pacchetto (`package.sh`, `package.ps1`) | MIGLIORATA | `scripts/build.mjs` + GitHub Actions |
| Funzioni del player (salto intro, timer di spegnimento, schermo intero…) | NON COMPATIBILE | Specifiche dello streaming |

Nessun file è stato copiato: Keep_Watching è servito come riferimento per l'impostazione di salute, cronologia, statistiche e test.
