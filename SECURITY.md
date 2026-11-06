# Sicurezza

## Principi

1. **Divieto assoluto di acquisto.** Vintastic non ha carrello, checkout, pagamenti né conferme d'ordine. `src/shared/guard-core.js` (caricato per primo nel content script) ammette solo queste richieste verso Vinted:

   | Metodo | Percorso | Scopo |
   |---|---|---|
   | GET | `/wardrobe/:id/items?…` | lettura armadio |
   | GET | `/users/:id` | profilo (sessione) |
   | GET | `/items/:id` | lettura annuncio |
   | GET | `/notifications?…` | elenco notifiche |
   | PUT | `/notifications/:id` | segna come letta |
   | POST | `/user_favourites/toggle` | like |
   | POST | `/conversations` (solo `initiator: buyer_enters_offer_form`) | modulo offerta |
   | POST | `/transactions/:id/offer_requests` | invio offerta |

   Qualsiasi altro percorso, e ogni percorso che contenga checkout, purchase, payment, buy, order, wallet, cart, shipping o `/transactions/:id` diverso da `offer_requests`, lancia `PurchaseGuardError` prima della richiesta. Test: `tests/unit/guard.test.mjs` (percorsi, pulsanti in 10 lingue, analisi statica del codice, permessi del manifest) e controllo su ogni scenario e2e.

2. **Nessun aggiramento.** CAPTCHA, verifiche, 401/403/429 e restrizioni fermano le campagne; l'utente completa le verifiche di persona.

3. **Nessuna credenziale.** Vintastic legge solo il cookie `v_uid` (id numerico). CSRF e anon id osservati nelle richieste del sito restano in `chrome.storage.session` (memoria). Password, codici di verifica e 2FA non vengono mai letti.

4. **Redazione.** Log, esportazioni e Support Bundle passano da `redact()`: cookie, token, JWT, webhook, email, chiavi API rimossi.

5. **Nessun server.** I dati restano nel browser. Uscite: GitHub (aggiornamenti, `links.json`), e solo se attivati dall'utente con permesso facoltativo: Discord e l'endpoint AI scelto.

6. **Schede dell'utente intatte.** Vintastic naviga e chiude solo le schede che ha aperto (Tab Ownership Manager).

## Permessi

| Permesso | Perché |
|---|---|
| `storage`, `unlimitedStorage` | impostazioni, archivio annunci, code |
| `alarms` | ripresa del motore, controlli periodici |
| `notifications` | notifiche di sistema |
| `tabs` | scheda di lavoro di Vintastic, azioni rapide sull'annuncio aperto |
| `cookies` | leggere **solo** il cookie `v_uid` (id utente) |
| `webRequest` | osservare (senza modificare) le intestazioni CSRF/anon-id delle richieste di Vinted |
| `downloads` | salvare lo zip di un aggiornamento verificato |
| `sidePanel` | pannello laterale |
| host `www.vinted.*` | content script e API |
| host GitHub | aggiornamenti e link |
| facoltativi: `discord.com`, `localhost`, `https://*/*` | richiesti solo se configuri Discord o un endpoint AI |

## Segnalare una vulnerabilità

Non aprire una issue pubblica: scrivi in privato all'autore tramite [Discord](https://discord.gg/EPsbQCuAkx) o una [security advisory](https://github.com/MashaUP/Vintastic/security/advisories/new) su GitHub. Indica versione, passi per riprodurre e impatto.
