/** Aiuto: guida rapida, cosa fa e cosa non fa, glossario, FAQ, supporto. */

import { h, icon, logo } from "../lib.js";
import { GLOSSARY, VERSION } from "../../shared/constants.js";
import { startOnboarding } from "./onboarding.js";

const FAQ = [
  ["Vintastic può comprare qualcosa per sbaglio?", "No. Non ha carrello, checkout o pagamenti, e ogni richiesta verso Vinted passa da una lista chiusa di operazioni ammesse (lettura, like, offerta, notifiche). Qualsiasi percorso d'acquisto viene bloccato prima di partire, e un test automatico lo verifica a ogni versione."],
  ["A chi può scrivere Vintastic?", "Solo ai venditori nell'elenco di Impostazioni › Messaggi (i tuoi account e chi ti ha dato l'ok). Un annuncio di qualcun altro non riceve messaggi: l'operazione viene saltata senza aprire la chat. In modalità B il testo viene scritto nella chat e Invia lo premi tu; in A lo preme Vintastic. Un messaggio conta come inviato solo quando compare nella conversazione, e non viene mai ripetuto da solo."],
  ["Dove sono finiti i commenti?", "Tolti nella 2.0.0: Vinted non ha commenti pubblici sugli annunci. Per scrivere al venditore c'è l'operazione «Messaggio privato»; le domande suggerite sono in «Domande al venditore»."],
  ["Devo tenere aperta la dashboard?", "No. La coda vive nel service worker e su disco: puoi chiudere popup e dashboard. Serve il browser aperto; Vintastic usa una sua scheda di Vinted (può restare in secondo piano). Il mini-widget sulle pagine Vinted mostra l'avanzamento."],
  ["Funziona a browser chiuso?", "No. Le estensioni lavorano solo con il browser aperto. Al riavvio la coda viene recuperata: le operazioni non partite tornano in attesa, quelle a metà diventano «da verificare»."],
  ["Cosa succede se Vinted mi chiede una verifica o un CAPTCHA?", "Tutte le campagne vanno in pausa, Vintastic porta in primo piano la scheda e aspetta che la completi tu. Non aggira niente e non legge i codici."],
  ["Posso usare più account?", "Vintastic usa l'account con cui sei collegato a Vinted. Riconosce gli account usati in passato e controlla che la sessione corrisponda alla campagna; il cambio di account si fa su Vinted."],
  ["Le soglie giornaliere sono limiti di Vinted?", "No: sono soglie tue, per tenere il ritmo sotto controllo. Vinted non pubblica i suoi limiti."],
  ["Un'operazione è «da verificare»: perché?", "Vintastic non sa se è arrivata a Vinted (rete caduta, crash durante l'invio). Non la ripete per non rischiare un doppione: controlla in Recupero e dimmi com'è andata."],
  ["Come aggiorno Vintastic?", "Salute › Cerca aggiornamento › Scarica e verifica. Estrai lo zip sopra la cartella e premi Installa. Un'estensione caricata da cartella non si può aggiornare da sola."],
];

export async function render(ctx) {
  const links = ctx.links || {};
  return h("div", { class: "grid" },
    h("div", { class: "page-head" }, logo(48), h("div", { class: "grow" }, h("h1", {}, "Aiuto"), h("p", {}, `Vintastic v${VERSION}`)),
      h("button", { class: "btn primary", onclick: () => startOnboarding(ctx, true) }, icon("play", 16), "Guida iniziale")),
    h("div", { class: "two" },
      h("div", { class: "card" }, h("h3", {}, icon("zap", 16), "In quattro passi"), h("ol", {},
        h("li", {}, "Accedi a Vinted nel browser: Vintastic riconosce l'account."),
        h("li", {}, h("a", { href: "#scanner" }, "Scanner"), ": incolla l'URL di un armadio e avvia la scansione."),
        h("li", {}, h("a", { href: "#listings" }, "Annunci"), ": filtra (ultimi N, ultimi giorni…), seleziona e «Aggiungi a campagna»."),
        h("li", {}, h("a", { href: "#campaigns" }, "Campagne"), ": anteprima, approva, avvia. Prima in simulazione, poi in modalità reale."))),
      h("div", { class: "card" }, h("h3", {}, icon("shield", 16), "Cosa non fa, per scelta"), h("ul", {},
        h("li", {}, "Non acquista nulla, in nessun caso."),
        h("li", {}, "Non aggira CAPTCHA, verifiche, 403/429 o restrizioni: si ferma."),
        h("li", {}, "Non legge né salva password, codici di verifica, cookie o token."),
        h("li", {}, "Non tocca le schede che non ha aperto lui."),
        h("li", {}, "Non manda i tuoi dati a server esterni (tranne, se lo attivi tu, l'AI esterna e Discord).")))),
    h("div", { class: "card" }, h("h3", {}, icon("help", 16), "Domande frequenti"), FAQ.map(([q, a]) => h("details", { style: { padding: "8px 0", borderBottom: "1px solid var(--border)" } }, h("summary", {}, h("b", {}, q)), h("p", { class: "small" }, a)))),
    h("div", { class: "card" }, h("h3", {}, icon("list", 16), "Glossario"), h("dl", { class: "kv" }, Object.entries(GLOSSARY).flatMap(([k, v]) => [h("dt", {}, h("b", {}, k)), h("dd", { class: "small" }, v)]))),
    h("div", { class: "card" }, h("h3", {}, icon("heart", 16), "Supporto e community"), h("div", { class: "row" },
      h("a", { class: "btn", href: links.discord?.url, target: "_blank", rel: "noopener" }, icon("discord", 16), "Discord"),
      h("a", { class: "btn", href: links.kofi?.url, target: "_blank", rel: "noopener" }, icon("coffee", 16), "Supporta su Ko-fi"),
      h("a", { class: "btn", href: links.github?.url, target: "_blank", rel: "noopener" }, icon("github", 16), "GitHub"),
      h("a", { class: "btn", href: links.bugReport?.url || `${links.github?.url}/issues/new`, target: "_blank", rel: "noopener" }, icon("file", 16), "Segnala un problema")),
      h("p", { class: "small muted" }, "Quando segnali un problema allega il Support Bundle (Log › Support Bundle): non contiene cookie, token, password né webhook.")));
}
