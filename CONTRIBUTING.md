# Contribuire

Grazie! Qualche regola per mantenere Vintastic sicuro e semplice.

## Ambiente

```bash
npm ci                       # solo fake-indexeddb, per i test
npm test                     # controlli (scripts/check.mjs) + test unitari
python3 -m pip install playwright && python3 tests/e2e/run_all.py   # e2e (Chrome: CHROME_PATH)
npm run build                # pacchetto in dist/
```

Per provare a mano: `chrome://extensions` › Modalità sviluppatore › Carica estensione non pacchettizzata › la cartella del repository.

## Regole

- **Mai** aggiungere percorsi d'acquisto, clic su pulsanti della pagina, o richieste verso Vinted fuori dalla lista di `guard-core.js`. Una nuova richiesta va motivata e aggiunta alla lista con un test.
- **Mai** aggirare CAPTCHA, limiti o verifiche; mai ritmi pensati per sembrare umani.
- **Mai** segreti nel repository (il controllo blocca la release).
- Logica nuova = funzione pura in `src/shared/` con test in `tests/unit/`.
- Stato nuovo = migrazione in `src/shared/migrations.js` (database o impostazioni) con test.
- Ogni esito incerto deve finire in «da verificare», mai in «completato».
- Testi dell'interfaccia in italiano, semplici, senza gergo (o con un tooltip del glossario).

## Versioni

Semantic Versioning: MAJOR per cambi incompatibili, MINOR per funzioni nuove, PATCH per correzioni. Aggiorna i quattro file della versione e il CHANGELOG (vedi [RELEASE.md](docs/RELEASE.md)).

## Pull request

Descrivi cosa cambia e come l'hai provato. Il CI deve essere verde.
