"""
Scenari dei messaggi privati: Chrome vero con Vintastic caricata, Vinted FINTO con la
chat costruita sull'HTML reale («Chiedi info», textarea#composerInput,
[data-testid="arrow-right"]). Nessun messaggio raggiunge Vinted reale.
"""
import asyncio, json
from fake_vinted import ORIGIN, SELLER_ID
from scenarios import check, scan, make_campaign, finished, kill_service_worker

TEMPLATES = [{"id": "a", "name": "Disponibile", "text": "Ciao! {titolo} è ancora disponibile?"},
             {"id": "b", "name": "Prezzo", "text": "Salve, per {titolo} a {prezzo} fai spedizione veloce?"}]


async def setup(env, recipients=(SELLER_ID,), mode="auto", wait=None, text=None, retry=(2, 2)):
    await env.open_ui()
    await env.fast_settings()
    await env.login_vinted()
    await scan(env)
    m = {"recipients": [{"id": r, "label": f"test {r}"} for r in recipients], "mode": mode, "templates": TEMPLATES}
    if wait:
        m["manualWaitSeconds"] = wait
    if text:
        m["text"] = text
    # Nuovi tentativi di un'operazione non partita: brevi nei test (predefinito 60 s e 300 s).
    await env.rpc("settings.save", {"patch": {"messages": m, "opRetry": {"attempts": 3, "delaysSec": list(retry)}}})


async def msg_campaign(env, n=1, types=("message",), dry=False, message=None, offset=0):
    res = await env.rpc("listings.query", {"filters": {"sellerId": SELLER_ID, "status": "active", "topN": n + offset, "range": "all"}, "limit": n + offset, "withIds": True})
    ids = res["ids"][offset:offset + n]
    c = await env.rpc("campaigns.create", {"name": f"Messaggi {offset}", "types": list(types), "dryRun": dry, "listingIds": ids,
        "message": message or {"source": "default"}, "timers": {"betweenOps": {"min": 0, "max": 0}, "betweenItems": {"min": 0, "max": 0}}})
    return c, ids


async def approve_start(env, cid):
    pv = await env.rpc("campaigns.preview", {"id": cid})
    await env.rpc("campaigns.approve", {"id": cid})
    r = await env.rpc("campaigns.start", {"id": cid})
    return pv, r


def msg_ops(x):
    return [o for i in x["items"] for o in i["ops"] if o["type"] == "message"]


async def wait_ops(env, cid, pred, timeout=60, what="stato dei messaggi"):
    async def f():
        x = await env.campaign(cid)
        return x if pred(msg_ops(x), x["campaign"]) else None
    return await env.wait_for(f, timeout, 0.4, what)


async def worker(env, part, timeout=40):
    async def f():
        for p in env.ctx.pages:
            if part in p.url and not p.url.startswith("chrome-extension://"):
                return p
        return None
    return await env.wait_for(f, timeout, 0.3, f"scheda di lavoro su {part}")


async def composer_value(page):
    try:
        return await page.evaluate("document.querySelector('#composerInput')?.value ?? null")
    except Exception:
        return None


def chat_requests(env):
    return [r for r in env.fake.requests if r[1].startswith("/inbox/") or r[1].startswith("/__fake/chat_")]


# ----------------------------------------------------------------------------- scenari

async def t_msg_auto(env):
    """Modalità A: simulazione senza chat, poi invio reale con rotazione e segnaposto, ritorno, No Repeat, privacy."""
    await setup(env)
    c, ids = await msg_campaign(env, 2, dry=True, message={"source": "rotate"})
    _, r = await approve_start(env, c["id"])
    check(r["ok"], f"avvio simulazione: {r}")
    await finished(env, c["id"], 60)
    check(not chat_requests(env), f"la simulazione non apre chat: {chat_requests(env)}")
    sim = msg_ops(await env.campaign(c["id"]))
    check(all(o["status"] == "completed" and o["result"]["simulated"] for o in sim), f"simulate: {sim}")

    await env.rpc("campaigns.goLive", {"id": c["id"]})
    pv, r = await approve_start(env, c["id"])
    texts = [o["text"] for i in pv["items"] for o in i["ops"] if o["type"] == "message"]
    titles = [i["listing"]["title"] for i in pv["items"]]
    check(texts[0] == f"Ciao! {titles[0]} è ancora disponibile?" and texts[1].startswith(f"Salve, per {titles[1]} a "), f"rotazione e segnaposto: {texts}")
    check(r["ok"], f"avvio reale: {r}")
    done = await finished(env, c["id"], 120)
    check(done["progress"]["completed"] == 2 and done["progress"]["verify"] == 0, f"progresso: {done['progress']}")
    check([t for _, t in env.fake.messages] == texts, f"messaggi arrivati: {env.fake.messages}")
    check(env.fake.send_clicks == 2, f"un solo clic per messaggio: {env.fake.send_clicks}")
    # Dopo ogni invio la scheda torna sull'annuncio.
    seq = [r[1] for r in env.fake.requests if r[1].startswith("/__fake/chat_send") or r[1].startswith("/items/")]
    for iid in ids:
        sent_at = next(k for k, p in enumerate(seq) if p.startswith("/__fake/chat_send") and k >= seq.index(next(x for x in seq if x.startswith(f"/items/{iid}"))))
        check(any(p.startswith(f"/items/{iid}") for p in seq[sent_at + 1:]), f"ritorno all'annuncio {iid}: {seq}")
    page = await worker(env, "/items/")
    check(f"/items/{ids[-1]}" in page.url, f"scheda finale sull'annuncio: {page.url}")
    led = [e for e in await env.rpc("ledger.list", {}) if e["type"] == "message"]
    check(len(led) == 2 and all(e["status"] == "completed" for e in led), f"ledger: {led}")
    stats = await env.rpc("stats.get", {"range": "today"})
    check(stats["totals"]["messages"] == 2, f"statistiche: {stats['totals']}")
    lim = await env.rpc("limits.status")
    check(lim["message"]["used"] == 2 and lim["message"]["max"] == 10, f"contatori: {lim['message']}")

    # No Repeat: stessa coda di nuovo → saltati, nessuna chat aperta.
    before = len(chat_requests(env))
    c2, _ = await msg_campaign(env, 2, message={"source": "custom", "text": "Un altro testo"})
    pv2, r2 = await approve_start(env, c2["id"])
    check(any("già state eseguite" in w for w in pv2["validation"]["warnings"]), "avviso No Repeat")
    d2 = await finished(env, c2["id"], 60)
    check(d2["progress"]["skipped"] == 2 and len(chat_requests(env)) == before and len(env.fake.messages) == 2, f"No Repeat: {d2['progress']}")

    # Soglia giornaliera: 2 già inviati oggi, soglia 3 → parte un messaggio, poi pausa fino a mezzanotte.
    await env.rpc("settings.save", {"patch": {"limits": {"perDay": {"message": 3}}}})
    c3, _ = await msg_campaign(env, 2, offset=2)
    pv3, r3 = await approve_start(env, c3["id"])
    check(r3["ok"] and any("restano 1" in w for w in pv3["validation"]["warnings"]), f"avviso soglia: {pv3['validation']['warnings']}")
    p3 = await finished(env, c3["id"], 60, ("paused",))
    check(p3["pauseReason"] == "limit" and p3["resumeAt"] and len(env.fake.messages) == 3, f"soglia: {p3['pauseReason']} · {len(env.fake.messages)} messaggi")
    await env.rpc("campaigns.stop", {"id": c3["id"]})
    texts += [o["text"] for i in pv3["items"] for o in i["ops"]]

    # Privacy: i testi non sono nei log né nel Support Bundle.
    logs = json.dumps(await env.rpc("logs.query", {"limit": 2000}), ensure_ascii=False)
    bundle = json.dumps(await env.rpc("support.bundle"), ensure_ascii=False)
    for t in texts + [TEMPLATES[0]["text"], "Un altro testo"]:
        check(t not in logs and t not in bundle, f"testo privato trapelato: {t}")

    # Interfaccia: dettaglio e anteprima mostrano il testo, nessun errore JS.
    old = env.ui
    ui = await env.open_ui(f"campaigns/{c2['id']}")
    await ui.wait_for_selector("text=Coda", timeout=15000)
    await ui.click("text=Anteprima e approvazione")
    await ui.wait_for_selector(".modal-back", timeout=10000)
    check(await ui.locator(".modal-back >> text=Un altro testo").count() == 0, "i messaggi saltati non sono in anteprima")
    await ui.click(".modal-back >> text=Chiudi")
    # «Nuova campagna»: editor del messaggio con anteprima del testo.
    await ui.click("text=← Campagne")
    await ui.click("text=Nuova campagna")
    await ui.click(".modal-back >> summary:has-text('Messaggio privato')")
    await ui.select_option('.modal-back select[aria-label="Testo del messaggio"]', "custom")
    await ui.fill(".modal-back textarea[placeholder^='Scrivi qui']", "Ciao {venditore}, {titolo}?")
    check(await ui.locator(".modal-back >> text=Ciao venditrice, Giacca di jeans vintage?").count() == 1, "anteprima del testo nell'editor")
    await ui.click(".modal-back >> text=Annulla")
    await ui.close()
    env.ui = old
    return "simulazione: 0 chat; reale: 2/2 inviati e verificati (rotazione + segnaposto), ritorno all'annuncio; ripetizione: 2 saltati, 0 chat; soglia giornaliera → pausa; testi assenti da log e Support Bundle; editor con anteprima"


async def t_msg_manual(env):
    """Modalità B: chat che si apre con ritardo nella stessa pagina, testo compilato, nessun clic automatico, invio dell'utente (anche con testo cambiato e con Invio)."""
    await setup(env, mode="manual", text="Ciao! {titolo} è disponibile?")
    env.fake.chat.update({"nav": "spa", "open_delay": 2})
    c, ids = await msg_campaign(env, 2)
    pv, r = await approve_start(env, c["id"])
    check(r["ok"], f"avvio: {r}")
    want = [o["text"] for i in pv["items"] for o in i["ops"] if o["type"] == "message"]
    check(all(o["mode"] == "manual" for i in pv["items"] for o in i["ops"]), "modalità B dalle impostazioni")
    page = await worker(env, "/inbox/")
    await env.wait_for(lambda: _eq(page, want[0]), 30, 0.3, "testo compilato")
    await asyncio.sleep(4)
    check(env.fake.send_clicks == 0 and not env.fake.messages, "modalità B: nessun invio automatico")
    x = await env.campaign(c["id"])
    check(x["campaign"]["current"] and x["campaign"]["current"].get("awaitingUser"), f"in attesa dell'utente: {x['campaign']['current']}")
    notes = await env.rpc("notifications.list", {})
    check(any("Premi Invia" in n["title"] for n in notes), "notifica «Premi Invia»")
    await page.click('[data-testid="arrow-right"]')
    await wait_ops(env, c["id"], lambda ops, _: sum(o["status"] == "completed" for o in ops) == 1, 30, "primo messaggio confermato")
    # Secondo annuncio: l'utente cambia il testo e invia con Invio.
    page = await worker(env, "/inbox/")
    await env.wait_for(lambda: _eq(page, want[1]), 40, 0.3, "secondo testo compilato")
    await page.fill("#composerInput", "Testo cambiato da me, va bene lo stesso?")
    await page.press("#composerInput", "Enter")
    done = await finished(env, c["id"], 60)
    check(done["progress"]["completed"] == 2 and done["progress"]["verify"] == 0, f"progresso: {done['progress']}")
    check([t for _, t in env.fake.messages] == [want[0], "Testo cambiato da me, va bene lo stesso?"], f"messaggi: {env.fake.messages}")
    page = await worker(env, "/items/")
    check(f"/items/{ids[1]}" in page.url, f"ritorno all'annuncio: {page.url}")
    return "chat aperta con 2 s di ritardo (stessa pagina), testo compilato, 0 clic automatici in 4 s, invio con il pulsante e con Invio (testo cambiato) riconosciuti, ritorno all'annuncio"


async def _eq(page, text):
    return (await composer_value(page)) == text


async def t_msg_manual_timeout(env):
    """Modalità B: nessuno preme Invia → non inviato, pausa; campo svuotato a mano senza messaggio → da verificare."""
    await setup(env, mode="manual", wait=5)
    c, _ = await msg_campaign(env, 1)
    _, r = await approve_start(env, c["id"])
    check(r["ok"], f"avvio: {r}")
    # 2.0.0: si fermano solo i messaggi della campagna (qui non c'è altro, quindi la campagna finisce).
    p = await finished(env, c["id"], 60, ("completed", "paused"))
    check(p["suspended"].get("message", {}).get("kind") == "manual", f"messaggi sospesi per invio manuale mancato: {p.get('suspended')}")
    notes = await env.rpc("notifications.list", {})
    check(any("sospesi" in n["title"] for n in notes), "notifica della sospensione")
    op = msg_ops(await env.campaign(c["id"]))[0]
    check(op["status"] == "failed" and op["retryable"] is True and "niente è stato inviato" in op["error"], f"operazione: {op}")
    page = await worker(env, "/inbox/")
    check((await composer_value(page)) == op["text"], "il testo resta nel campo")
    check(not env.fake.messages and env.fake.send_clicks == 0, "niente inviato")
    led = [e for e in await env.rpc("ledger.list", {}) if e["type"] == "message"][0]
    check(led["status"] == "failed", f"ledger ripetibile: {led['status']}")
    # «Ripeti falliti»: questa volta l'utente svuota il campo senza inviare → esito incerto.
    opened = len([r for r in env.fake.requests if r[1].startswith("/inbox/")])
    await env.rpc("campaigns.mutate", {"id": c["id"], "action": "retry", "args": {}})
    r = await env.rpc("campaigns.resume", {"id": c["id"]})
    check(r["ok"], f"ripresa dopo «Ripeti falliti»: {r}")
    await env.wait_for(lambda: asyncio.sleep(0, len([r for r in env.fake.requests if r[1].startswith("/inbox/")]) > opened), 30, 0.3, "chat riaperta")
    page = await worker(env, "/inbox/")
    await env.wait_for(lambda: _eq(page, op["text"]), 30, 0.3, "testo compilato di nuovo")
    await page.fill("#composerInput", "")
    x = await wait_ops(env, c["id"], lambda ops, _: ops[0]["status"] == "verify", 30, "da verificare")
    check("svuotato" in msg_ops(x)[0]["error"], f"motivo: {msg_ops(x)[0]['error']}")
    await asyncio.sleep(4)
    check(env.fake.send_clicks == 0 and not env.fake.messages, "nessun nuovo tentativo automatico")
    return "5 s senza Invio → non inviato, ripetibile, messaggi sospesi (gli altri tipi continuerebbero); campo svuotato a mano senza messaggio → da verificare, non ripetuto"


async def t_msg_failures(env):
    """Destinatari, pulsante assente/disabilitato, chat senza campo, Invia mai abilitato, campo svuotato senza messaggio, messaggio identico già presente."""
    await setup(env, recipients=("99",))
    out = []
    # Venditore non autorizzato: il like parte, il messaggio viene saltato senza chat.
    c, _ = await msg_campaign(env, 1, types=("like", "message"), offset=0)
    pv, r = await approve_start(env, c["id"])
    check(r["ok"], f"avvio: {r}")
    d = await finished(env, c["id"], 60)
    ops = (await env.campaign(c["id"]))["items"][0]["ops"]
    check([o["status"] for o in ops] == ["completed", "skipped"] and "destinatari" in ops[1]["reason"], f"non autorizzato: {ops}")
    check(not chat_requests(env), "nessuna chat aperta per un venditore non autorizzato")
    out.append("non autorizzato: saltato senza chat")
    # Nessun destinatario: non parte.
    await env.rpc("settings.save", {"patch": {"messages": {"recipients": []}}})
    c, _ = await msg_campaign(env, 1, offset=1)
    _, r = await approve_start(env, c["id"])
    check(r["ok"] is False and any("Nessun destinatario" in e for e in r["validation"]["errors"]), f"senza destinatari: {r}")
    out.append("elenco vuoto: avvio bloccato")
    await env.rpc("settings.save", {"patch": {"messages": {"recipients": [{"id": SELLER_ID}]}}})

    async def case(offset, chat, expect, what, timeout=60, statuses=("completed", "paused")):
        env.fake.chat.update(chat)
        cc, _ = await msg_campaign(env, 1, offset=offset)
        _, rr = await approve_start(env, cc["id"])
        check(rr["ok"], f"{what}: avvio {rr}")
        x = await finished(env, cc["id"], timeout, statuses)
        op = msg_ops(await env.campaign(cc["id"]))[0]
        check(expect(op, x), f"{what}: {op['status']} · {op.get('error') or op.get('reason')} · pausa {x.get('pauseReason')}")
        for k, v in {"ask_info": "on", "composer": True, "enable": True, "send": "ok", "old_bubble": None}.items():
            env.fake.chat[k] = v
        if x["status"] == "paused":
            await env.rpc("campaigns.stop", {"id": cc["id"]})
        return op

    clicks = env.fake.send_clicks
    await case(2, {"ask_info": "disabled"}, lambda op, x: op["status"] == "failed" and op["retryable"] is False, "«Chiedi info» disabilitato")
    out.append("«Chiedi info» disabilitato: fallito, non ripetibile")
    await case(3, {"ask_info": "off"}, lambda op, x: op["status"] == "failed" and "isolato" in op["error"], "«Chiedi info» assente")
    br = await env.rpc("health.breakers")
    await env.rpc("health.resetBreaker", {"module": "message"})
    out.append(f"«Chiedi info» assente: modulo isolato ({(br.get('message') or {}).get('state', 'registrato')})")
    op = await case(4, {"composer": False}, lambda op, x: op["status"] == "failed" and "Non partita dopo 3 tentativi" in op["error"] and "#composerInput non c'è" in op["error"] and x["suspended"].get("message"), "chat senza #composerInput", 240)
    out.append("chat senza campo: 3 tentativi distanziati, poi fallito con diagnosi, messaggi sospesi")
    await case(5, {"enable": False}, lambda op, x: op["status"] == "failed" and op["retryable"] is True, "Invia mai abilitato")
    check(env.fake.send_clicks == clicks, "nessun clic se Invia non si abilita")
    out.append("Invia mai abilitato: fallito, ripetibile, 0 clic")
    op = await case(6, {"send": "clear-only"}, lambda op, x: op["status"] == "verify", "campo svuotato senza messaggio")
    n = env.fake.send_clicks
    await asyncio.sleep(4)
    check(env.fake.send_clicks == n == clicks + 1, "esito incerto non ripetuto")
    out.append("campo svuotato senza messaggio: da verificare, 1 solo clic")
    # Messaggio identico già nella conversazione + invio che non arriva: non va scambiato per riuscito.
    s = await env.rpc("settings.get")
    await case(7, {"old_bubble": s["messages"]["text"], "send": "stuck"}, lambda op, x: op["status"] == "verify", "messaggio identico già presente")
    out.append("messaggio identico già presente: non confuso con quello nuovo (da verificare)")
    check(not env.fake.messages, f"nessun messaggio arrivato in questi casi: {env.fake.messages}")
    return " · ".join(out)


async def t_msg_captcha_return(env):
    """Ritorno all'annuncio non riuscito, invio lento, CAPTCHA dopo il clic, CAPTCHA all'apertura della chat."""
    await setup(env)
    out = []
    env.fake.chat.update({"send": "slow"})
    c, _ = await msg_campaign(env, 1, offset=0)
    await approve_start(env, c["id"])
    await finished(env, c["id"], 90)
    check(msg_ops(await env.campaign(c["id"]))[0]["status"] == "completed" and len(env.fake.messages) == 1, "messaggio lento (3 s) confermato")
    out.append("messaggio comparso dopo 3 s: confermato")
    env.fake.chat.update({"send": "ok", "return_fail": True})
    c, _ = await msg_campaign(env, 1, offset=1)
    await approve_start(env, c["id"])
    await finished(env, c["id"], 120)
    check(msg_ops(await env.campaign(c["id"]))[0]["status"] == "completed", "ritorno fallito: il messaggio inviato resta completato (mai ripetuto)")
    logs = await env.rpc("logs.query", {"limit": 500})
    check(any("ritorno all'annuncio non è confermato" in (l.get("message") or "") for l in logs), "avviso del ritorno mancato nei log")
    env.fake.chat["return_fail"] = False
    out.append("ritorno non riuscito: completato + avviso, nessun doppione")
    env.fake.chat.update({"send": "captcha"})
    c, _ = await msg_campaign(env, 1, offset=2)
    await approve_start(env, c["id"])
    x = await wait_ops(env, c["id"], lambda ops, _: ops[0]["status"] == "verify", 90, "CAPTCHA dopo il clic → da verificare")
    # La pagina della chat segnala la verifica con un piccolo ritardo (600 ms): si aspetta che arrivi,
    # altrimenti la pagina pulita qui sotto potrebbe arrivare prima e il segnale dopo.
    async def flagged():
        ss = await env.rpc("session.get")
        return ss if ss.get("challenge") else None
    await env.wait_for(flagged, 15, 0.2, "verifica segnalata dalla pagina della chat")
    out.append("CAPTCHA dopo il clic: da verificare")
    await env.rpc("campaigns.stop", {"id": c["id"]})
    home = await env.login_vinted()          # una pagina senza verifica: la sessione torna pulita
    async def clean():
        ss = await env.rpc("session.get")
        return ss if not ss.get("challenge") else None
    await env.wait_for(clean, 20, 0.3, "sessione senza verifica dopo una pagina pulita")
    await home.close()
    env.fake.chat.update({"send": "ok", "captcha_on_open": True})
    clicks = env.fake.send_clicks
    c, _ = await msg_campaign(env, 1, offset=3)
    _, r = await approve_start(env, c["id"])
    check(r["ok"], f"avvio: {r}")
    p = await finished(env, c["id"], 90, ("paused",))
    op = msg_ops(await env.campaign(c["id"]))[0]
    check(p["pauseReason"] == "captcha" and op["status"] == "waiting" and env.fake.send_clicks == clicks, f"CAPTCHA all'apertura: {p['pauseReason']} {op['status']}")
    out.append("CAPTCHA all'apertura: pausa, non inviato, non aggirato")
    return " · ".join(out)


async def t_msg_crash(env):
    """Service worker terminato con il messaggio pronto (B) → da verificare; ripresa senza doppioni; impostazioni salvate."""
    await setup(env, mode="manual")
    c, ids = await msg_campaign(env, 1, message={"source": "template", "templateId": "b"})
    pv, r = await approve_start(env, c["id"])
    text = msg_ops({"items": pv["items"]})[0]["text"]
    page = await worker(env, "/inbox/")
    await env.wait_for(lambda: _eq(page, text), 30, 0.3, "testo compilato")
    await kill_service_worker(env)
    await asyncio.sleep(1)
    async def recovered():
        rec = await env.rpc("recovery.list")
        return rec if rec.get("lastRecovery") and rec["lastRecovery"]["verify"] >= 1 else None
    rec = await env.wait_for(recovered, 30, 1, "recupero dopo la terminazione del worker")
    check(len(rec["verify"]) == 1 and rec["verify"][0]["op"]["type"] == "message", f"da verificare: {rec['verify']}")
    led = [e for e in await env.rpc("ledger.list", {}) if e["type"] == "message"]
    check(led and led[0]["status"] == "verify", f"ledger: {led}")
    # Impostazioni sopravvissute al riavvio del worker.
    s = await env.rpc("settings.get")
    check(s["messages"]["mode"] == "manual" and len(s["messages"]["templates"]) == 2 and s["messages"]["recipients"][0]["id"] == SELLER_ID, f"impostazioni: {s['messages']}")
    # Nuova campagna sullo stesso annuncio: bloccata dal ledger.
    before = len(chat_requests(env))
    c2, _ = await msg_campaign(env, 1)
    pv2, r2 = await approve_start(env, c2["id"])
    check(any("da verificare" in w for w in pv2["validation"]["warnings"]), "avviso: esito da verificare")
    d2 = await finished(env, c2["id"], 60)
    check(d2["progress"]["skipped"] == 1 and len(chat_requests(env)) == before, f"nessun doppione: {d2['progress']}")
    check(not env.fake.messages and env.fake.send_clicks == 0, "niente inviato")
    # Interfaccia delle impostazioni: aggiunta di un destinatario dal link del profilo.
    ui = await env.open_ui("settings?tab=messages")
    await ui.wait_for_selector("text=Destinatari autorizzati", timeout=15000)
    await ui.fill('input[aria-label="ID o link del profilo"]', f"{ORIGIN}/member/31337-amica")
    await ui.fill('input[aria-label="Nome del destinatario"]', "Migliore amica")
    await ui.click("button:has-text('Aggiungi')")
    async def saved():
        s = await env.rpc("settings.get")
        return s if any(r["id"] == "31337" and r["label"] == "Migliore amica" for r in s["messages"]["recipients"]) else None
    await env.wait_for(saved, 10, 0.3, "destinatario salvato dall'interfaccia")
    return "worker terminato con il messaggio pronto → da verificare, non ripetuto; nuova campagna saltata dal ledger; impostazioni persistenti; destinatario aggiunto dall'interfaccia"


async def t_msg_isolation(env):
    """Il bug della 1.4.0: un messaggio che non riesce ad aprire la chat bloccava like e offerte di tutta la coda."""
    await setup(env, retry=(3, 3))
    env.fake.chat.update({"composer": False})          # la chat si apre ma il campo non c'è mai
    c, ids = await msg_campaign(env, 3, types=("like", "offer", "message"))
    pv, r = await approve_start(env, c["id"])
    check(r["ok"], f"avvio: {r}")
    x = await finished(env, c["id"], 300, ("completed", "paused"))
    data = await env.campaign(c["id"])
    by = {t: [o for i in data["items"] for o in i["ops"] if o["type"] == t] for t in ("like", "offer", "message")}
    check(all(o["status"] == "completed" for o in by["like"]) and env.fake.favourites == {int(i) for i in ids}, f"tutti i like: {[o['status'] for o in by['like']]}")
    check(all(o["status"] == "completed" for o in by["offer"]) and len(env.fake.offers) == 3, f"tutte le offerte: {[o['status'] for o in by['offer']]}")
    check(x["suspended"].get("message"), f"solo i messaggi sospesi: {x.get('suspended')}")
    check(not env.fake.messages and env.fake.send_clicks == 0, "nessun messaggio inviato")
    # Ordine: il like del secondo annuncio parte prima che il messaggio del primo abbia finito i tentativi.
    seq = [(r[0], r[1]) for r in env.fake.requests if r[1].startswith("/api/v2/user_favourites/toggle") or r[1].startswith("/inbox/")]
    first_like_after_chat = next((k for k, (_, p) in enumerate(seq) if "favourites" in p and k > 0 and any("/inbox/" in q for _, q in seq[:k])), None)
    check(first_like_after_chat is not None, f"like eseguiti dopo il primo errore della chat: {seq[:8]}")
    tried = [o for o in by["message"] if o.get("error")]
    check(tried and all("#composerInput non c'è" in o["error"] for o in tried), f"diagnosi nell'errore: {[o.get('error') for o in by['message']]}")
    check(all(o["status"] in ("waiting", "failed") for o in by["message"]), "nessun messaggio dato per inviato")
    check(x["status"] == "paused" and "Restano solo operazioni bloccate" in (x.get("pauseDetail") or ""), f"pausa spiegata alla fine: {x['status']} {x.get('pauseDetail')}")
    return f"3/3 like e 3/3 offerte eseguiti nonostante la chat rotta; {len(tried)} messaggi tentati con diagnosi, poi messaggi sospesi; pausa solo a fine coda"


async def t_msg_newtab(env):
    """La chat si apre in una scheda nuova: Vintastic la trova, invia, la chiude; la scheda di lavoro resta sull'annuncio."""
    await setup(env)
    env.fake.chat.update({"nav": "newtab"})
    c, ids = await msg_campaign(env, 1)
    pv, r = await approve_start(env, c["id"])
    check(r["ok"], f"avvio: {r}")
    await finished(env, c["id"], 90)
    op = msg_ops(await env.campaign(c["id"]))[0]
    check(op["status"] == "completed" and len(env.fake.messages) == 1, f"messaggio: {op['status']} {op.get('error')}")
    await asyncio.sleep(1)
    check(not [p for p in env.ctx.pages if "/inbox/" in p.url], "scheda della chat chiusa")
    logs = await env.rpc("logs.query", {"limit": 300})
    check(any("scheda nuova" in (l.get("message") or "") for l in logs), "registrato nei log")
    return "chat in una scheda nuova: trovata, messaggio verificato, scheda chiusa"


async def t_msg_hydration(env):
    """Come vinted.it (08/11/2026): «Chiedi info» compare prima di essere cliccabile. Vintastic aspetta
    che lo diventi, ripete il clic se non ha effetto, funziona anche su una pagina senza React."""
    await setup(env)
    out = []

    async def one(offset, chat, what, timeout=90):
        env.fake.chat.update(chat)
        early, ask = env.fake.early_clicks, env.fake.ask_clicks
        c, _ = await msg_campaign(env, 1, offset=offset)
        _, r = await approve_start(env, c["id"])
        check(r["ok"], f"{what}: avvio {r}")
        await finished(env, c["id"], timeout)
        op = msg_ops(await env.campaign(c["id"]))[0]
        check(op["status"] == "completed", f"{what}: {op['status']} · {op.get('error')}")
        return env.fake.early_clicks - early, env.fake.ask_clicks - ask

    e, a = await one(0, {"hydrate_ms": 1500}, "idratazione dopo 1,5 s")
    check(e == 0 and a == 1, f"un solo clic, dopo l'idratazione: prima {e}, efficaci {a}")
    out.append("pulsante cliccabile dopo 1,5 s: aspettato, 0 clic a vuoto, 1 clic")
    e, a = await one(1, {"hydrate_ms": 7000}, "idratazione lenta (7 s)")
    check(e == 0 and a == 1, f"idratazione lenta: prima {e}, efficaci {a}")
    out.append("pulsante cliccabile dopo 7 s: aspettato")
    e, a = await one(2, {"hydrate_ms": 1000, "dead_clicks": 1}, "primo clic ignorato")
    check(a == 1, f"nuovo clic dopo uno senza effetto: efficaci {a}")
    out.append("primo clic senza effetto: ripetuto dopo 5 s, chat aperta")
    e, a = await one(3, {"react": False, "dead_clicks": 0}, "pagina senza React")
    check(a == 1, f"senza React: efficaci {a}")
    out.append("pagina senza React: si procede dopo 4 s, 1 clic")
    check(len(env.fake.messages) == 4, f"4 messaggi arrivati: {env.fake.messages}")
    return " · ".join(out)
