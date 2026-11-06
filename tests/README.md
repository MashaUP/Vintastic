# Test

- `unit/` — test unitari in Node (`npm test`). Logica pura di `src/shared/` e migrazioni IndexedDB con `fake-indexeddb`.
- `e2e/` — scenari in Chrome con l'estensione caricata e un **Vinted finto** (`fake_vinted.py`), Python + Playwright:
  `python3 tests/e2e/run_all.py [filtro…]`. Variabile `CHROME_PATH` per il percorso di Chrome (predefinito `/usr/bin/google-chrome`).
  Rapporto in `e2e/artifacts/report.json`.

Nessun test contatta Vinted reale. Risultati e copertura: [docs/TEST_PLAN.md](../docs/TEST_PLAN.md).
