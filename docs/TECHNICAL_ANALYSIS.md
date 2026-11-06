# Analisi tecnica

## Punto di partenza

Vintastic è nato come repository nuovo e indipendente (non esisteva codice precedente con questo nome). Le basi tecniche vengono da Vinted_Relist e Keep_Watching (vedi gli audit). Linguaggio: JavaScript (moduli ES) senza framework né build; test in Node (`node:test`) e Python/Playwright.

## Cosa si può fare su Vinted, e come

| Capacità | Come | Verificato |
|---|---|---|
| Sapere chi è collegato | Cookie `v_uid` (solo l'id) + intestazioni delle richieste del sito | Sì, in Vinted_Relist (versioni usate dall'autore) |
| Leggere un armadio | `GET /api/v2/wardrobe/:id/items?page&per_page&order=newest_first` | Endpoint usato da Vinted_Relist; forma della risposta gestita in modo difensivo |
| Leggere un annuncio | `GET /api/v2/items/:id`, altrimenti i dati incorporati nella pagina e lo stato del pulsante dei preferiti | Non verificato su Vinted reale |
| Like | `POST /api/v2/user_favourites/toggle` (`{type:"item", user_favourites:[id]}`) | **Non verificato.** È un toggle: Vintastic lo invia solo se ha letto che il like non c'è |
| Offerta | `POST /api/v2/conversations` (`initiator: buyer_enters_offer_form`) → `POST /api/v2/transactions/:id/offer_requests` | **Non verificato.** Un formato diverso apre il circuit breaker delle offerte |
| Commento pubblico | Non esiste su Vinted | → suggerimenti da copiare |
| Notifiche | `GET /api/v2/notifications`, `PUT /api/v2/notifications/:id` | **Non verificato.** Se non disponibile, il modulo si spegne con spiegazione |
| Cambiare account | Non possibile da un'estensione | Login/logout fatti dall'utente su Vinted |

Prima prova sul sito vero consigliata: Salute › controllo; una campagna con **un** annuncio, prima in simulazione, poi reale con «conferma prima di ogni offerta». La pagina Salute mostra se like, offerta e notifiche hanno risposto nel formato atteso.

## Vincoli di Manifest V3 e di Chrome

- **Service worker sospeso** dopo ~30 s di inattività: stato su disco, allarmi di riserva, ping dalle porte aperte durante le campagne.
- **`chrome.alarms`**: intervallo minimo 30 s per le estensioni pacchettizzate; per gli intervalli brevi si usa `setTimeout` mentre il worker è vivo.
- **Schede in secondo piano**: Chrome rallenta i timer delle pagine nascoste, ma le richieste e i messaggi funzionano. I timer del motore stanno nel service worker. Una scheda **minimizzata** o in secondo piano va bene; non serve tenerla in primo piano.
- **Browser chiuso**: nessuna estensione lavora. Al riavvio la coda si recupera.
- **`sessionStorage`** del DOM non esiste nel service worker: non è usato. `chrome.storage.session` sì, verificato dal controllo di salute.
- **Aggiornamento automatico** di un'estensione non pacchettizzata: impossibile.
- **Content script come moduli**: non supportati staticamente; i file del content script sono script classici in un namespace `VT`.

## Problemi trovati e risolti durante lo sviluppo

| Problema | Causa | Correzione |
|---|---|---|
| Scritture concorrenti su campagne | Il motore scriveva fuori dal lock mentre l'utente modificava la coda | `withLock`, `patchCampaign`, `claimOp` |
| Pagina «pronta» sbagliata | La scheda di lavoro poteva annunciare la pagina precedente | `waitReady` con controllo del percorso (id dell'annuncio, non lo slug) |
| Il testo «null» nell'interfaccia | `replaceChildren`/`append` nativi stampano `null` | Inserimenti sicuri (dashboard) e `put()` (overlay) |
| Tre pagine non si caricavano | Parentesi sbilanciate; `node --check` non controllava i moduli | `scripts/check.mjs` controlla ogni file come modulo |
| Sessione non rilevata in alcuni contesti | L'intestazione Cookie non sempre visibile a webRequest | `chrome.cookies` per `v_uid`; webRequest solo in positivo |
| Workflow di release non valido | Due punti non quotati nello YAML | Rilevato con actionlint, corretto |
| Popup oltre i 600 px | Il piè di pagina con Ko-fi, Discord e «Cerca aggiornamento» finiva fuori vista | Interfaccia compattata |

## Debito tecnico noto

| Voce | Impatto |
|---|---|
| Endpoint di like/offerte/notifiche non osservati su Vinted reale | Alto: va verificato alla prima prova (il resto si isola da solo) |
| Elenco dei domini Vinted ripetuto in manifest e `constants.js` | Basso: lo allinea e lo controlla `scripts/check.mjs` |
| Le pagine della dashboard si ridisegnano intere a ogni evento (con debounce) | Basso fino a qualche migliaio di elementi in coda |
| Nessun linter JS nel CI | Medio: c'è il controllo di sintassi; ESLint è in ROADMAP |
| Edge e Brave non provati in automatico | Medio: stessa base Chromium, nessuna API specifica di Chrome tranne `sidePanel` (presente in Edge ≥ 114, Brave) |
