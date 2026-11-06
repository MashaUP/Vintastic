# Configurare Discord

Due integrazioni, indipendenti e facoltative.

## 1. Creare un webhook

1. Apri il tuo server Discord.
2. Apri le **impostazioni del canale** desiderato (icona a ingranaggio accanto al nome del canale).
3. Vai su **Integrazioni**.
4. **Webhook › Nuovo webhook**.
5. Scegli **nome** (es. «Vintastic») e **canale**.
6. **Copia URL del webhook**. Ha la forma `https://discord.com/api/webhooks/<numero>/<codice>`.
7. Configuralo in uno dei modi qui sotto.

L'URL è una chiave: chi lo ha può scrivere nel canale. Non incollarlo in file del repository, issue o messaggi pubblici. Se finisce in giro: Discord › Integrazioni › elimina il webhook e creane uno nuovo.

## 2. Notifiche delle release (GitHub Actions)

1. Repository su GitHub › **Settings › Secrets and variables › Actions**.
2. **New repository secret**: nome `DISCORD_WEBHOOK_URL`, valore = l'URL del webhook.
3. Alla prossima release pubblicata, il workflow manda un messaggio con titolo, link e note.

Se il secret non c'è, il passo viene saltato senza errori.

## 3. Notifiche dall'estensione (facoltative)

Per ricevere su Discord «campagna completata», errori importanti, problemi di sistema e aggiornamenti disponibili:

1. Vintastic › **Impostazioni › Discord**.
2. Incolla l'URL e premi **Salva**: il browser chiede il permesso di contattare `discord.com` (permesso facoltativo, richiesto solo ora).
3. Premi **Invia prova**.
4. Scegli quali eventi inviare.

Perché così: un webhook dentro un'estensione distribuita pubblicamente sarebbe visibile a chiunque la scarichi. Per questo Vintastic **non ne contiene nessuno**: usa solo il tuo, salvato nel tuo browser, mai esportato nei backup né nel Support Bundle. Se vuoi notifiche di gruppo senza dare il webhook a nessuno, la soluzione è un piccolo backend tuo (es. un Cloudflare Worker) che riceve gli eventi e li inoltra: Vintastic non lo richiede.

## Link della community

Il link d'invito mostrato nell'estensione (`https://discord.gg/EPsbQCuAkx`) arriva da `links.json` nella radice del repository: per cambiarlo modifica quel file su `main`. Le estensioni installate lo rileggono entro 12 ore, senza nuova versione.
