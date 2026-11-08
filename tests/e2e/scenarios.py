"""
Scenari end-to-end: Chrome vero con Vintastic caricata, Vinted FINTO (fake_vinted.py).
Ogni scenario parte da un profilo pulito. Nessuna richiesta raggiunge Vinted reale.
"""
import asyncio, json, time
from fake_vinted import ORIGIN, SELLER_ID, FakeVinted

WARDROBE = f"{ORIGIN}/member/{SELLER_ID}-venditrice_test"


def check(cond, msg):
    if not cond:
        raise AssertionError(msg)


async def scan(env, max_items=500):
    s = await env.rpc("scan.start", {"url": WARDROBE, "maxItems": max_items})
    async def done():
        lst = await env.rpc("scans.list", {"limit": 5})
        x = next((y for y in lst if y["id"] == s["id"]), None)
        return x if x and x["status"] != "running" else None
    return await env.wait_for(done, 90, 1, "fine scansione")


async def make_campaign(env, n=3, types=("like", "offer"), dry=False, offer=None, timers=None):
    res = await env.rpc("listings.query", {"filters": {"sellerId": SELLER_ID, "status": "active", "topN": n, "range": "all"}, "limit": n, "withIds": True})
    c = await env.rpc("campaigns.create", {"name": f"E2E {time.time():.0f}", "types": list(types), "dryRun": dry,
        "offerCfg": offer or {"mode": "saving", "rule": {"kind": "percentOff", "value": 20}, "rounding": {"style": "00", "direction": "down"}},
        "timers": timers or {"betweenOps": {"min": 0, "max": 0}, "betweenItems": {"min": 0, "max": 0}}, "listingIds": res["ids"]})
    return c, res["ids"]


async def finished(env, cid, timeout=120, statuses=("completed",)):
    async def f():
        c = (await env.campaign(cid))["campaign"]
        return c if c["status"] in statuses else None
    return await env.wait_for(f, timeout, 0.7, f"campagna in {statuses}")


# ----------------------------------------------------------------------------- scenari

async def t_install_and_ui(env):
    """Installazione pulita, onboarding, apertura di tutte le pagine, popup, side panel."""
    sw = await env.sw()
    await asyncio.sleep(1.5)
    tabs = [p.url for p in env.ctx.pages]
    check(any("dashboard.html#onboarding" in u for u in tabs), f"onboarding non aperto all'installazione: {tabs}")
    page = await env.open_ui()
    s = await env.rpc("settings.get")
    check(s["schema"] == 5 and s["killSwitch"] is False and s["campaignDefaults"]["addPosition"] == "start" and s["timers"]["betweenItems"] == {"min": 10, "max": 25}, "impostazioni predefinite (timer bassi)")
    logs = await env.rpc("logs.query", {})
    check(any("db_v4 → db_v5" in l["message"] for l in logs), "migrazione db registrata")
    routes = ["", "accounts", "scanner", "listings", "campaigns", "offers", "suggestions", "notifications", "stats", "logs", "health", "recovery", "settings", "help"]
    for r in routes:
        await page.goto(f"chrome-extension://{env.ext}/src/ui/dashboard.html#{r}")
        await page.wait_for_selector("#page > *:not(.muted)", timeout=10000)
        txt = await page.inner_text("#page")
        check("non si è caricata" not in txt, f"pagina #{r} in errore: {txt[:120]}")
    pop = await env.ctx.new_page()
    await pop.goto(f"chrome-extension://{env.ext}/src/ui/popup.html")
    await pop.wait_for_selector(".tabs")
    check("Apri dashboard" in await pop.inner_text("body"), "popup incompleto")
    check("Ko-fi" in await pop.inner_text("body") and "Discord" in await pop.inner_text("body"), "link Ko-fi/Discord nel popup")
    check("Cerca aggiornamento" in await pop.inner_text("body"), "pulsante Cerca aggiornamento nel popup")
    panel = await env.ctx.new_page()
    await panel.goto(f"chrome-extension://{env.ext}/src/ui/popup.html?mode=panel")
    await panel.wait_for_selector(".tabs")
    await page.goto(f"chrome-extension://{env.ext}/src/ui/dashboard.html#")
    await page.wait_for_selector("#page > *:not(.muted)")
    check(await page.locator("text=Aggiornamento a metà").count() == 0, "nessun avviso di versione quando coincide")
    await page.evaluate("window.__vt.overview.version = '0.9.0'; window.__vt.refresh()")
    await page.wait_for_selector("text=Aggiornamento a metà", timeout=5000)
    check(not env.errors, f"errori JS: {env.errors}")
    return "14 pagine, popup e side panel senza errori; onboarding aperto; db migrato a v5; avviso «motore vecchio»"


async def t_onboarding_wizard(env):
    """First Campaign Wizard fino all'avvio della simulazione."""
    await env.open_ui()
    await env.login_vinted()
    page = await env.open_ui("onboarding")
    await page.wait_for_selector(".modal-back.onboarding")
    nxt = page.locator(".onboarding .modal-foot .btn.primary")
    await nxt.click()                                   # introduzione → account
    await page.wait_for_selector("text=Account rilevato")
    await nxt.click()                                   # → sessione
    await page.wait_for_selector("text=Sessione valida", timeout=30000)
    await nxt.click()                                   # → armadio
    await page.fill(".onboarding input.input", WARDROBE)
    await nxt.click()                                   # → scansione
    await page.wait_for_selector("text=Scansione completata", timeout=60000)
    await nxt.click()                                   # → selezione
    await page.wait_for_selector(".onboarding select")
    await nxt.click()                                   # → interazioni
    await nxt.click()                                   # → simulazione
    await page.wait_for_selector("text=in Simulazione", timeout=20000)
    await nxt.click()                                   # → anteprima
    await page.click("text=Approva e avvia la simulazione")
    camps = await env.wait_for(lambda: env.rpc("campaigns.list"), 10)
    c = camps[0]
    check(c["dryRun"] is True, "la campagna del wizard deve essere una simulazione")
    await finished(env, c["id"], 120)
    check(not env.fake.api_writes(), f"la simulazione ha scritto su Vinted: {env.fake.api_writes()}")
    s = await env.rpc("settings.get")
    check(s["onboardingDone"], "onboarding segnato come completato")
    return "wizard completo (9 passi), simulazione eseguita, zero scritture su Vinted"


async def t_scan_filters(env):
    """Scansione con paginazione, nessun doppione, date separate, filtri Top N + periodo."""
    await env.open_ui()
    await env.fast_settings()
    await env.login_vinted()
    s1 = await scan(env)
    check(s1["status"] == "done", f"scansione: {s1}")
    check(s1["found"] == 130 and s1["added"] == 130 and s1["pages"] == 2, f"conteggi prima scansione: {s1}")
    s2 = await scan(env)
    check(s2["added"] == 0 and s2["updated"] == 130, f"seconda scansione deve aggiornare, non duplicare: {s2}")
    allq = await env.rpc("listings.query", {"filters": {}, "limit": 500})
    check(allq["all"] == 130, f"annunci in archivio: {allq['all']}")
    ids = [l["id"] for l in allq["items"]]
    check(len(ids) == len(set(ids)), "doppioni in archivio")
    sold = [l for l in allq["items"] if l["status"] == "sold"]
    check(len(sold) == 1, "stato venduto riconosciuto")
    check(all(l["publishedAt"] is None for l in allq["items"]), "nessuna data di pubblicazione inventata (come su Vinted)")
    nophoto = [l for l in allq["items"] if l["photoAt"] is None]
    check(len(nophoto) == 13, f"13 annunci senza nessuna data: {len(nophoto)}")
    check(all(l.get("scanRank") is not None for l in allq["items"]), "posizione nell'ordine di Vinted salvata")
    top = await env.rpc("listings.query", {"filters": {"topN": 20, "range": "7d"}, "limit": 50})
    check(top["total"] == 20, f"Top 20 ultimi 7 giorni (data della foto): {top['total']}")
    d = [l["photoAt"] for l in top["items"]]
    check(d == sorted(d, reverse=True), "Top N ordinato dal più recente")
    top5 = await env.rpc("listings.query", {"filters": {"topN": 5, "range": "all", "dateField": "publishedAt"}, "limit": 50})
    check([l["id"] for l in top5["items"]] == [str(900000 + i) for i in range(5)], f"senza date: i primi 5 nell'ordine di Vinted: {[l['id'] for l in top5['items']]}")
    custom = await env.rpc("listings.query", {"filters": {"topN": 37}, "limit": 50})
    check(custom["total"] == 37, f"numero personalizzato (37): {custom['total']}")
    r24 = await env.rpc("listings.query", {"filters": {"range": "24h"}, "limit": 500})
    check(0 < r24["total"] < 20 and r24["noDate"] == 13, f"ultime 24 ore: {r24['total']} (senza data {r24['noDate']})")
    desc = await env.rpc("listings.query", {"filters": {}, "sort": "date", "dir": "desc", "limit": 3})
    asc = await env.rpc("listings.query", {"filters": {}, "sort": "date", "dir": "asc", "limit": 130})
    check(desc["items"][0]["id"] == "900000", f"più recenti in cima: {desc['items'][0]['id']}")
    check(asc["items"][0]["photoAt"] is None or asc["items"][0]["id"] != "900000", "ordine ribaltato")
    dated = [l["photoAt"] for l in asc["items"] if l["photoAt"]]
    check(dated == sorted(dated), "crescente: dal meno recente")
    pa = await env.rpc("listings.query", {"filters": {}, "sort": "price", "dir": "asc", "limit": 1})
    pd = await env.rpc("listings.query", {"filters": {}, "sort": "price", "dir": "desc", "limit": 1})
    check(pa["items"][0]["price"] < pd["items"][0]["price"], "prezzo crescente/decrescente")
    check(not env.fake.api_writes(), "la scansione non deve scrivere su Vinted")
    # Interfaccia: «Aggiungi annunci» con numero personalizzato e ultime 24 ore
    page = env.ui
    c = await env.rpc("campaigns.create", {"name": "Personalizzato", "types": ["like"], "dryRun": True})
    await page.goto(f"chrome-extension://{env.ext}/src/ui/dashboard.html#campaigns/{c['id']}")
    await page.reload()                     # chiude la guida iniziale aperta al primo avvio del profilo
    await page.click("text=Aggiungi annunci")
    await page.select_option(".modal select >> nth=1", "custom")
    await page.fill(".modal input[type=number]", "7")
    await page.select_option(".modal select >> nth=2", "7d")
    await page.click(".modal-foot >> text=Aggiungi")
    async def added():
        x = await env.campaign(c["id"])
        return x if x["items"] else None
    x = await env.wait_for(added, 15, 0.5, "annunci aggiunti dal dialogo")
    check(len(x["items"]) == 7, f"numero personalizzato dal dialogo: {len(x['items'])}")
    # Annunci: pulsante per ribaltare l'ordine
    await page.goto(f"chrome-extension://{env.ext}/src/ui/dashboard.html#listings")
    await page.wait_for_selector("text=Più recenti in cima")
    first_desc = await page.inner_text("table.table tbody tr >> nth=0")
    await page.click("text=Più recenti in cima")
    await page.wait_for_selector("text=Meno recenti in cima")
    first_asc = await page.inner_text("table.table tbody tr >> nth=0")
    check(first_desc != first_asc, "il pulsante ribalta la classifica")
    return f"130 annunci; data della foto come ripiego, ordine di Vinted senza date; Top20/7g={top['total']}, 24h={r24['total']}; personalizzato 7 dal dialogo; ordine ribaltabile"


async def t_campaign_real(env):
    """Like + offerta reali (su Vinted finto), anteprima, snapshot, ledger, No Repeat."""
    await env.open_ui()
    await env.fast_settings()
    await env.login_vinted()
    await scan(env)
    c, ids = await make_campaign(env, 3, ("like", "offer"))
    r = await env.rpc("campaigns.start", {"id": c["id"]})
    check(r["ok"] is False and any("approvazione" in e for e in r["validation"]["errors"]), "senza anteprima approvata non deve partire")
    pv = await env.rpc("campaigns.preview", {"id": c["id"]})
    amounts = [o["amount"] for i in pv["items"] for o in i["ops"] if o["type"] == "offer"]
    check(all(a and a > 0 for a in amounts), f"importi offerte in anteprima: {amounts}")
    await env.rpc("campaigns.approve", {"id": c["id"]})
    r = await env.rpc("campaigns.start", {"id": c["id"]})
    check(r["ok"], f"avvio: {r}")
    done = await finished(env, c["id"], 120)
    p = done["progress"]
    check(p["completed"] == 6 and p["failed"] == 0 and p["verify"] == 0, f"progresso: {p}")
    check(env.fake.favourites == {int(i) for i in ids}, f"like su Vinted finto: {env.fake.favourites}")
    check(len(env.fake.offers) == 3, f"offerte inviate: {env.fake.offers}")
    for iid, price in env.fake.offers:
        base = float(env.fake.items[iid]["price"]["amount"])
        check(price < base and price == int(base * 0.8), f"importo offerta {price} per prezzo {base}")
    ledger = await env.rpc("ledger.list", {})
    check(len([e for e in ledger if e["status"] == "completed"]) == 6, "ledger: 6 completate")
    writes_before = len(env.fake.api_writes())
    # No Repeat: stessa campagna di nuovo → tutto saltato, nessuna scrittura nuova
    c2 = await env.rpc("campaigns.create", {"name": "Ripetizione", "types": ["like", "offer"], "dryRun": False, "listingIds": ids,
        "timers": {"betweenOps": {"min": 0, "max": 0}, "betweenItems": {"min": 0, "max": 0}}})
    pv2 = await env.rpc("campaigns.preview", {"id": c2["id"]})
    check(any("già state eseguite" in w for w in pv2["validation"]["warnings"]), "avviso No Repeat in anteprima")
    await env.rpc("campaigns.approve", {"id": c2["id"]})
    await env.rpc("campaigns.start", {"id": c2["id"]})
    d2 = await finished(env, c2["id"], 60)
    check(d2["progress"]["skipped"] == 6, f"No Repeat: {d2['progress']}")
    check(len(env.fake.api_writes()) == writes_before, "No Repeat: nessuna nuova scrittura su Vinted")
    # Il like già fatto non blocca un'offerta nuova su un altro annuncio
    check(not env.fake.forbidden_requests(), f"richieste vietate: {env.fake.forbidden_requests()}")
    stats = await env.rpc("stats.get", {"range": "today"})
    check(stats["totals"]["likes"] == 3 and stats["totals"]["offers"] == 3, f"statistiche: {stats['totals']}")
    return "6/6 operazioni reali completate; offerte -20% arrotondate; ripetizione: 6 saltate, 0 scritture"


async def t_dynamic_queue(env):
    """Coda dinamica: aggiunte, rimozioni, modifiche e priorità durante l'esecuzione; pausa/ripresa; chiusura dashboard."""
    page = await env.open_ui()
    await env.fast_settings()
    await env.login_vinted()
    await scan(env)
    c, ids = await make_campaign(env, 4, ("like",), timers={"betweenOps": {"min": 0, "max": 0}, "betweenItems": {"min": 3, "max": 3}})
    await env.rpc("campaigns.approve", {"id": c["id"]})
    await env.rpc("campaigns.start", {"id": c["id"]})
    async def one_done():
        x = (await env.campaign(c["id"]))["campaign"]
        return x if (x["progress"] or {}).get("completed", 0) >= 1 else None
    await env.wait_for(one_done, 60, 0.3, "primo like")
    # durante l'esecuzione: aggiungi 2 annunci in cima con like+offerta
    extra = (await env.rpc("listings.query", {"filters": {"sellerId": SELLER_ID, "status": "active"}, "offset": 10, "limit": 2}))["items"]
    r = await env.rpc("campaigns.add", {"id": c["id"], "listingIds": [x["id"] for x in extra], "spec": {"types": ["like", "offer"]}, "where": "start"})
    check(r["added"] == 2, f"aggiunta durante l'esecuzione: {r}")
    data = await env.campaign(c["id"])
    items = data["items"]
    waiting = [i for i in items if all(o["status"] == "waiting" for o in i["ops"]) and i["listingId"] in ids]
    victim = waiting[-1]
    await env.rpc("campaigns.mutate", {"id": c["id"], "action": "remove", "args": {"ids": [victim["id"]]}})
    added_item = next(i for i in (await env.campaign(c["id"]))["items"] if i["listingId"] == extra[0]["id"])
    off = next(o for o in added_item["ops"] if o["type"] == "offer")
    await env.rpc("campaigns.mutate", {"id": c["id"], "action": "editOps", "args": {"id": added_item["id"], "patch": {off["id"]: {"amount": 7.77}}}})
    # completato non modificabile
    done_item = next(i for i in (await env.campaign(c["id"]))["items"] if any(o["status"] == "completed" for o in i["ops"]))
    done_op = next(o for o in done_item["ops"] if o["status"] == "completed")
    r = await env.rpc("campaigns.mutate", {"id": c["id"], "action": "editOps", "args": {"id": done_item["id"], "patch": {done_op["id"]: {"remove": True}}}})
    check(r["ok"] is False, "un'operazione completata non deve essere modificabile")
    # pausa e ripresa, con la dashboard chiusa
    await env.rpc("campaigns.pause", {"id": c["id"]})
    p1 = (await env.campaign(c["id"]))["campaign"]
    check(p1["status"] == "paused", "pausa")
    await asyncio.sleep(4)
    check((await env.campaign(c["id"]))["campaign"]["progress"]["completed"] == p1["progress"]["completed"], "in pausa non deve avanzare")
    r = await env.rpc("campaigns.resume", {"id": c["id"]})
    check(r["ok"], f"ripresa: {r}")
    helper = await env.ctx.new_page()
    await helper.goto(f"chrome-extension://{env.ext}/src/ui/popup.html")
    await page.close()                                   # dashboard chiusa durante la campagna
    env.ui = helper
    done = await finished(env, c["id"], 120)
    items = (await env.campaign(c["id"]))["items"]
    removed = next(i for i in items if i["id"] == victim["id"])
    check(removed["removed"] and removed["ops"][0]["status"] == "cancelled", "elemento rimosso non eseguito")
    check(int(victim["listingId"]) not in env.fake.favourites, "nessun like sull'annuncio rimosso")
    check(any(abs(p - 7.77) < 0.001 for _, p in env.fake.offers), f"offerta modificata a 7.77: {env.fake.offers}")
    check(all(int(x["id"]) in env.fake.favourites for x in extra), "annunci aggiunti durante l'esecuzione elaborati")
    hist = [h["action"] for h in done["history"]]
    for a in ("aggiunti annunci", "remove", "editOps", "pausa", "ripresa"):
        check(a in hist, f"storico senza «{a}»: {hist}")
    return f"aggiunte/rimozioni/modifiche in corsa ok; pausa ferma l'avanzamento; completata con dashboard chiusa ({done['progress']['completed']} ok)"


async def t_block_429_captcha(env):
    """429 → pausa di tutto, operazione rimessa in attesa (non consumata); CAPTCHA → pausa e scheda in primo piano."""
    await env.open_ui()
    await env.fast_settings()
    await env.login_vinted()
    await scan(env)
    c, ids = await make_campaign(env, 2, ("like",))
    env.fake.fail[r"/user_favourites/toggle"] = 429
    await env.rpc("campaigns.approve", {"id": c["id"]})
    await env.rpc("campaigns.start", {"id": c["id"]})
    p = await finished(env, c["id"], 60, ("paused",))
    check(p["pauseReason"] == "blocked" and p["autoPaused"] and p["resumeAt"], f"pausa 429: {p['pauseReason']} {p.get('pauseDetail')}")
    items = (await env.campaign(c["id"]))["items"]
    check(all(o["status"] == "waiting" for i in items for o in i["ops"]), "dopo un 429 l'operazione torna in attesa")
    ledger = await env.rpc("ledger.list", {})
    check(not any(e["status"] in ("running", "completed") for e in ledger), f"ledger dopo 429: {ledger}")
    toggles = [r for r in env.fake.requests if r[1].endswith("/user_favourites/toggle")]
    check(len(toggles) == 1, f"un solo tentativo, nessun retry automatico immediato: {len(toggles)}")
    # CAPTCHA
    del env.fake.fail[r"/user_favourites/toggle"]
    env.fake.captcha_items = {int(ids[0]), int(ids[1])}
    r = await env.rpc("campaigns.resume", {"id": c["id"]})
    check(r["ok"], f"ripresa: {r}")
    p = await finished(env, c["id"], 60, ("paused",))
    check(p["pauseReason"] == "captcha", f"pausa captcha: {p['pauseReason']}")
    sess = await env.rpc("session.get")
    check(sess["challenge"] is True, "sessione segnata con verifica in corso")
    v = await env.rpc("campaigns.start", {"id": c["id"]})
    check(v["ok"] is False and any("verifica" in e.lower() for e in v["validation"]["errors"]), "con una verifica in corso non riparte")
    notes = await env.rpc("notifications.list", {})
    check(any("verifica" in n["title"].lower() for n in notes), "notifica della verifica")
    return "429: pausa automatica con ripresa programmata, operazione non consumata; CAPTCHA: pausa, sessione segnata, ripartenza bloccata"


async def t_uncertain_and_resolve(env):
    """Rete caduta durante l'invio dell'offerta → DA VERIFICARE, mai ripetuta; risoluzione manuale."""
    await env.open_ui()
    await env.fast_settings()
    await env.login_vinted()
    await scan(env)
    c, ids = await make_campaign(env, 1, ("offer",))
    env.fake.fail[r"/offer_requests"] = "abort"
    await env.rpc("campaigns.approve", {"id": c["id"]})
    await env.rpc("campaigns.start", {"id": c["id"]})
    async def has_verify():
        x = await env.campaign(c["id"])
        return x if any(o["status"] == "verify" for i in x["items"] for o in i["ops"]) else None
    x = await env.wait_for(has_verify, 60, 0.5, "operazione da verificare")
    n = len([r for r in env.fake.requests if r[1].endswith("/offer_requests")])
    await asyncio.sleep(3)
    check(len([r for r in env.fake.requests if r[1].endswith("/offer_requests")]) == n == 1, "un esito incerto non deve essere ripetuto")
    rec = await env.rpc("recovery.list")
    check(len(rec["verify"]) == 1, "Recovery Center elenca l'operazione")
    del env.fake.fail[r"/offer_requests"]
    await env.rpc("health.connectivity", {"origin": ORIGIN})
    it = x["items"][0]
    op = it["ops"][0]
    # Stessa offerta in un'altra campagna: bloccata dal ledger finché è da verificare
    c2 = await env.rpc("campaigns.create", {"name": "Doppione", "types": ["offer"], "dryRun": False, "listingIds": ids})
    pv = await env.rpc("campaigns.preview", {"id": c2["id"]})
    check(any("da verificare" in w for w in pv["validation"]["warnings"]), "il ledger segnala l'esito da verificare")
    await env.rpc("campaigns.mutate", {"id": c["id"], "action": "resolveVerify", "args": {"id": it["id"], "opId": op["id"], "done": False}})
    led = [e for e in await env.rpc("ledger.list", {}) if e["type"] == "offer"][0]
    check(led["status"] == "failed", "risolta come non eseguita → ripetibile")
    await env.rpc("campaigns.mutate", {"id": c["id"], "action": "retry", "args": {}})
    st = (await env.campaign(c["id"]))["campaign"]["status"]
    if st == "paused":
        await env.rpc("campaigns.resume", {"id": c["id"]})
    elif st in ("ready", "completed"):
        await env.rpc("campaigns.approve", {"id": c["id"]})
        await env.rpc("campaigns.start", {"id": c["id"]})
    await finished(env, c["id"], 60)
    check(len(env.fake.offers) == 1, f"offerta inviata una sola volta dopo la risoluzione: {env.fake.offers}")
    return "esito incerto → da verificare, 1 sola richiesta; ledger blocca doppioni; risolto e ripetuto con successo"


async def kill_service_worker(env):
    """Termina il service worker come fa Chrome (sospensione/crash): via CDP."""
    page = env.ui
    cdp = await env.ctx.new_cdp_session(page)
    await cdp.send("ServiceWorker.enable")
    await cdp.send("ServiceWorker.stopAllWorkers")
    await cdp.detach()


async def t_crash_recovery(env):
    """Service worker terminato durante l'invio → DA VERIFICARE; browser chiuso prima dell'invio → di nuovo in attesa."""
    import harness
    await env.open_ui()
    await env.fast_settings()
    await env.login_vinted()
    await scan(env)
    c, ids = await make_campaign(env, 2, ("offer",))
    env.fake.fail[r"/offer_requests"] = ("delay", 6)
    await env.rpc("campaigns.approve", {"id": c["id"]})
    await env.rpc("campaigns.start", {"id": c["id"]})
    await env.wait_for(lambda: asyncio.sleep(0, any(r[1].endswith("/offer_requests") for r in env.fake.requests)), 60, 0.2, "invio in corso")
    await kill_service_worker(env)
    await asyncio.sleep(1)
    async def recovered():
        r = await env.rpc("recovery.list")
        return r if r.get("lastRecovery") and r["lastRecovery"]["verify"] >= 1 else None
    rec = await env.wait_for(recovered, 30, 1, "recupero dopo la terminazione del worker")
    check(len(rec["verify"]) == 1, f"un'operazione da verificare: {rec['verify']}")
    led = [e for e in await env.rpc("ledger.list", {}) if e["status"] == "verify"]
    check(len(led) == 1, "ledger in verifica dopo il crash")
    camp = (await env.campaign(c["id"]))["campaign"]
    check(camp["current"] is None or camp["current"]["opId"] != rec["verify"][0]["op"]["id"], "l'operazione incerta non è più quella corrente")
    await asyncio.sleep(8)
    sent = len([r for r in env.fake.requests if r[1].endswith("/offer_requests")])
    verify_items = (await env.rpc("recovery.list"))["verify"]
    check(verify_items and verify_items[0]["listing"]["id"] in ids, "l'operazione incerta resta da verificare")
    check(sent <= 2, f"l'offerta incerta non è stata ripetuta: {sent} invii")
    del env.fake.fail[r"/offer_requests"]
    await env.rpc("campaigns.pause", {"id": c["id"]})

    # Browser chiuso durante la preparazione (pagina dell'annuncio lenta) → riaperto con lo stesso profilo
    c2, ids2 = await make_campaign(env, 1, ("like",))
    env.fake.fail[r"^/items/\d+"] = ("delay", 15)
    await env.rpc("campaigns.approve", {"id": c2["id"]})
    await env.rpc("campaigns.start", {"id": c2["id"]})
    async def running():
        x = await env.campaign(c2["id"])
        return x if any(o["status"] == "running" for i in x["items"] for o in i["ops"]) else None
    await env.wait_for(running, 30, 0.3, "like in preparazione")
    fake, profile = env.fake, env.profile
    await harness.stop(env)
    likes_before = [r for r in fake.requests if r[1].endswith("/user_favourites/toggle")]
    del fake.fail[r"^/items/\d+"]
    env2 = await harness.start(fake=fake, profile=profile)
    try:
        await env2.open_ui()
        async def back_waiting():
            x = await env2.campaign(c2["id"])
            ops = [o for i in x["items"] for o in i["ops"]]
            return x if ops and all(o["status"] in ("waiting", "completed") for o in ops) else None
        x = await env2.wait_for(back_waiting, 40, 1, "operazione non inviata rimessa in coda dopo il riavvio")
        # Dopo il riavvio la campagna riprende e può già aver messo il like: conta ciò che è partito PRIMA.
        check(not likes_before, "nessun like inviato prima del riavvio")
        check(len([r for r in fake.requests if r[1].endswith("/user_favourites/toggle")]) <= 1, "al massimo un like dopo il riavvio, nessun doppione")
        rec2 = await env2.rpc("recovery.list")
        check(rec2["lastRecovery"]["reset"] >= 1, f"recupero: {rec2['lastRecovery']}")
        check(len(rec2["verify"]) == 1, "lo stato 'da verificare' sopravvive al riavvio del browser")
        env.errors.extend(env2.errors)
    finally:
        await harness.stop(env2)
    return "worker terminato in invio → da verificare, non ripetuta; browser chiuso in preparazione → rimessa in coda; stato sopravvissuto al riavvio"


async def t_price_snapshot_and_limits(env):
    """Prezzo cambiato → pausa per nuova approvazione; soglia giornaliera → pausa con orario di reset."""
    await env.open_ui()
    await env.fast_settings()
    await env.login_vinted()
    await scan(env)
    c, ids = await make_campaign(env, 1, ("offer",))
    await env.rpc("campaigns.approve", {"id": c["id"]})
    env.fake.price_override[int(ids[0])] = 99
    await env.rpc("campaigns.start", {"id": c["id"]})
    p = await finished(env, c["id"], 60, ("paused",))
    check(p["pauseReason"] == "snapshot", f"pausa per snapshot: {p['pauseReason']}")
    check(not env.fake.offers, "nessuna offerta con prezzo cambiato")
    v = await env.rpc("campaigns.start", {"id": c["id"]})
    check(v["ok"] is False, "non riparte senza nuova approvazione")
    pv = await env.rpc("campaigns.preview", {"id": c["id"]})
    newamt = [o["amount"] for i in pv["items"] for o in i["ops"]][0]
    check(newamt and newamt < 99 and newamt > 50, f"importo ricalcolato sul nuovo prezzo: {newamt}")
    await env.rpc("campaigns.approve", {"id": c["id"]})
    await env.rpc("campaigns.resume", {"id": c["id"]})
    await finished(env, c["id"], 60)
    check(len(env.fake.offers) == 1 and env.fake.offers[0][1] == newamt, f"offerta sul nuovo prezzo: {env.fake.offers}")
    # Soglia: like al giorno = 1
    await env.rpc("settings.save", {"patch": {"limits": {"perDay": {"like": 1}}}})
    c2, _ = await make_campaign(env, 3, ("like",))
    pv = await env.rpc("campaigns.preview", {"id": c2["id"]})
    check(any("restano" in w for w in pv["validation"]["warnings"]), "avviso soglia in anteprima")
    await env.rpc("campaigns.approve", {"id": c2["id"]})
    await env.rpc("campaigns.start", {"id": c2["id"]})
    p = await finished(env, c2["id"], 60, ("paused",))
    check(p["pauseReason"] == "limit" and "azzera" in p["pauseDetail"], f"pausa soglia: {p['pauseReason']} {p['pauseDetail']}")
    check(len(env.fake.favourites) == 1, "solo 1 like oltre la soglia non passa")
    return "prezzo cambiato: pausa + ricalcolo + nuova approvazione; soglia 1 like/giorno rispettata con orario di reset"


async def t_offline_autopause(env):
    """Rete giù → pausa automatica (controllo vero, non navigator.onLine); rete su + sessione valida → ripresa."""
    await env.open_ui()
    await env.fast_settings()
    await env.login_vinted()
    await scan(env)
    c, ids = await make_campaign(env, 3, ("like",), timers={"betweenOps": {"min": 0, "max": 0}, "betweenItems": {"min": 5, "max": 5}})
    await env.rpc("campaigns.approve", {"id": c["id"]})
    await env.rpc("campaigns.start", {"id": c["id"]})
    env.fake.fail[r"robots\.txt"] = "abort"
    st = await env.rpc("health.connectivity", {"origin": ORIGIN})
    check(st["online"] is False, "Vinted non raggiungibile rilevato")
    p = await finished(env, c["id"], 20, ("paused",))
    check(p["pauseReason"] == "offline" and p["autoPaused"], f"pausa offline: {p['pauseReason']}")
    ov = await env.rpc("overview")
    check(ov["connectivity"]["online"] is False, "stato offline esposto alla UI (sola lettura)")
    lst = await env.rpc("listings.query", {"filters": {}, "limit": 5})
    check(lst["total"] == 130, "dati consultabili offline")
    del env.fake.fail[r"robots\.txt"]
    await env.rpc("health.connectivity", {"origin": ORIGIN})
    # la ripresa la decide il watchdog (ogni minuto) dopo aver ricontrollato rete e sessione
    await finished(env, c["id"], 150, ("completed", "running"))
    return "offline → pausa automatica; dati consultabili; ripresa automatica dopo verifica di rete e sessione"


async def t_cleaner_suggestions(env):
    """Pulitore notifiche (solo segna come lette, solo selezionate), domande al venditore, commenti tolti."""
    await env.open_ui()
    await env.login_vinted()
    items = await env.rpc("cleaner.preview", {"pages": 3})
    check(len(items) == 12, f"anteprima notifiche: {len(items)}")
    unread = [n["id"] for n in items if not n["isRead"]][:4]
    await env.rpc("cleaner.clean", {"ids": unread})
    async def cleaned():
        s = await env.rpc("cleaner.status")
        return s if s and s["status"] == "done" else None
    st = await env.wait_for(cleaned, 60, 1, "pulizia completata")
    check(st["done"] == 4 and st["failed"] == 0, f"pulizia: {st}")
    check(sorted(env.fake.read_calls) == sorted(int(x) for x in unread), "solo le notifiche selezionate")
    writes = env.fake.api_writes()
    check(all(w[0] == "PUT" and "/notifications/" in w[1] for w in writes), f"il pulitore ha fatto altro: {writes}")
    await scan(env)
    lst = (await env.rpc("listings.query", {"filters": {"search": "Giacca"}, "limit": 1}))["items"][0]
    rec = await env.rpc("suggest.generate", {"listingId": lst["id"], "opts": {"count": 3}})
    check(len(rec["texts"]) == 3 and any("spalle" in t for t in rec["texts"]), f"suggerimenti: {rec['texts']}")
    # 2.0.0: i commenti non esistono più come operazione.
    r = await env.rpc_raw("campaigns.create", {"name": "Commenti", "types": ["comment"], "dryRun": False, "listingIds": [lst["id"]]})
    check(r.get("__vtError") and "Scegli almeno un'operazione" in r.get("error", ""), f"campagna di soli commenti rifiutata: {r}")
    c = await env.rpc("campaigns.create", {"name": "Misto", "types": ["like", "comment"], "dryRun": True, "listingIds": [lst["id"]]})
    ops = [o["type"] for i in (await env.campaign(c["id"]))["items"] for o in i["ops"]]
    check(ops == ["like"] and c["opsDefaults"]["types"] == ["like"], f"il tipo «comment» viene ignorato: {ops}")
    check(len(env.fake.api_writes()) == len(writes), "niente inviato a Vinted")
    return "4 notifiche segnate come lette (solo PUT /notifications); domande pertinenti; operazione «comment» non più accettata"


async def t_backup_import(env):
    """Esportazione e importazione in un profilo pulito: bozze, niente segreti, niente esecuzioni."""
    await env.open_ui()
    await env.fast_settings()
    await env.login_vinted()
    await scan(env)
    await env.rpc("settings.save", {"patch": {"discord": {"webhookUrl": "https://discord.com/api/webhooks/123456789/abcdefghijklmnopqrstuvwxyz0123"}, "ai": {"apiKey": "sk-test-1234567890abcdef"}}})
    c, _ = await make_campaign(env, 2, ("like",))
    exp = await env.rpc("backup.export", {"parts": ["settings", "accounts", "campaigns", "listings", "history", "filters", "dashboard"]})
    raw = json.dumps(exp)
    check("webhooks/123456789" not in raw and "sk-test" not in raw, "segreti nell'export")
    check(len(exp["parts"]["listings"]) == 130, "annunci esportati")
    return exp


async def t_import_into_fresh(env, exp):
    await env.open_ui()
    pv = await env.rpc("backup.preview", {"json": exp})
    check(pv["ok"], f"anteprima import: {pv}")
    r = await env.rpc("backup.import", {"json": exp, "parts": ["settings", "campaigns", "listings", "history"]})
    check(r["ok"], f"import: {r}")
    camps = await env.rpc("campaigns.list")
    check(len(camps) == 1 and camps[0]["status"] == "draft", f"campagna importata come bozza: {camps}")
    await asyncio.sleep(3)
    check(not env.fake.api_writes(), "l'import non deve eseguire nulla")
    r2 = await env.rpc("backup.import", {"json": exp, "parts": ["listings"]})
    lst = await env.rpc("listings.query", {"filters": {}, "limit": 1})
    check(lst["all"] == 130, "deduplicazione all'import")
    bad = await env.rpc("backup.preview", {"json": {"app": "Altro"}})
    check(bad["ok"] is False, "file estraneo rifiutato")
    pre = await env.rpc("backup.preImport")
    check(pre and pre["app"] == "Vintastic", "backup preventivo salvato")
    return "import in profilo pulito: bozze, deduplica, file estranei rifiutati, backup preventivo"


async def t_updates(env):
    """Version checker su GitHub Releases finto: disponibilità, checksum, rate limit."""
    import hashlib
    zip_bytes = b"PK\x03\x04finto-zip-vintastic"
    good = hashlib.sha256(zip_bytes).hexdigest()
    state = {"sha": good, "status": 200}
    async def gh(route):
        u = route.request.url
        if "releases/latest" in u:
            if state["status"] != 200:
                return await route.fulfill(status=state["status"], headers={"x-ratelimit-reset": str(int(time.time()) + 600)}, body="{}")
            return await route.fulfill(status=200, content_type="application/json", body=json.dumps({
                "tag_name": "v9.9.0", "name": "Vintastic 9.9.0", "body": "- novità di prova", "html_url": "https://github.com/MashaUP/Vintastic/releases/tag/v9.9.0",
                "assets": [{"name": "Vintastic-9.9.0.zip", "browser_download_url": "https://github.com/MashaUP/Vintastic/releases/download/v9.9.0/Vintastic-9.9.0.zip", "size": len(zip_bytes)},
                           {"name": "Vintastic-9.9.0.zip.sha256", "browser_download_url": "https://github.com/MashaUP/Vintastic/releases/download/v9.9.0/Vintastic-9.9.0.zip.sha256"}]}))
        if u.endswith(".zip"):
            return await route.fulfill(status=200, content_type="application/zip", body=zip_bytes)
        if u.endswith(".sha256"):
            return await route.fulfill(status=200, body=f"{state['sha']}  Vintastic-9.9.0.zip\n")
        return await route.fulfill(status=404, body="")
    env.github = gh
    await env.open_ui()
    st = await env.rpc("updates.check")
    check(st["ok"] and st["available"] and st["latest"] == "9.9.0", f"aggiornamento: {st}")
    notes = await env.rpc("notifications.list", {})
    check(any("9.9.0" in n["title"] for n in notes), "notifica nuova versione")
    d = await env.rpc("updates.download")
    check(d["verified"] and d["hash"] == good, f"download verificato: {d}")
    state["sha"] = "0" * 64
    try:
        await env.rpc("updates.download")
        raise AssertionError("checksum sbagliato accettato")
    except RuntimeError as e:
        check("NON corrispondente" in str(e), str(e))
    state["status"] = 403
    st = await env.rpc_raw("updates.check")
    check(st["ok"] is False and "rate limit" in st["error"] and st["rateLimitedUntil"], f"rate limit: {st}")
    return "nuova versione rilevata e notificata; SHA-256 verificato; checksum errato rifiutato; rate limit gestito"


async def t_overlay(env):
    """FAB e mini-widget sulla pagina Vinted, aggiornati in tempo reale."""
    await env.open_ui()
    await env.fast_settings()
    await env.login_vinted()
    await scan(env)
    vp = await env.ctx.new_page()
    await vp.goto(WARDROBE)
    await vp.wait_for_selector("vintastic-overlay >> .fab", timeout=15000)
    await vp.click("vintastic-overlay >> .fab")
    await vp.wait_for_selector("vintastic-overlay >> text=Scansiona questo armadio")
    c, _ = await make_campaign(env, 3, ("like",), dry=True, timers={"betweenOps": {"min": 0, "max": 0}, "betweenItems": {"min": 2, "max": 2}})
    await env.rpc("campaigns.approve", {"id": c["id"]})
    await env.rpc("campaigns.start", {"id": c["id"]})
    await vp.wait_for_selector("vintastic-overlay >> .widget", timeout=15000)
    txt = await vp.inner_text("vintastic-overlay >> .widget")
    check(c["name"] in txt and "Simulazione" in txt, f"widget: {txt}")
    await vp.click("vintastic-overlay >> .widget >> text=Pausa")
    p = await finished(env, c["id"], 10, ("paused",))
    await vp.wait_for_selector("vintastic-overlay >> .widget >> text=Riprendi", timeout=10000)
    await vp.click("vintastic-overlay >> .widget >> text=Riprendi")
    await finished(env, c["id"], 60)
    # pagina di un annuncio: «Aggiungi a una campagna»
    item = next(iter(env.fake.items))
    await vp.goto(f"{ORIGIN}/items/{item}-x")
    await vp.click("vintastic-overlay >> .fab")
    await vp.click("vintastic-overlay >> text=Aggiungi a una campagna")
    await vp.click("vintastic-overlay >> .menu >> text=Aggiungi")
    await asyncio.sleep(1.5)
    camps = await env.rpc("campaigns.list")
    total = sum((x["progress"] or {}).get("items", 0) for x in camps)
    check(total >= 4, "annuncio aggiunto dalla pagina")
    check(not env.fake.api_writes(), "l'overlay non scrive su Vinted")
    return "FAB su armadio e annuncio; widget in tempo reale con pausa/riprendi; aggiunta dalla pagina"


async def t_performance(env):
    """Migliaia di annunci: query, filtri e tabella senza blocchi."""
    await env.open_ui()
    now = int(time.time() * 1000)
    listings = [{"id": str(2000000 + i), "title": f"Articolo {i}", "price": 5 + i % 90, "currency": "EUR", "sellerId": str(i % 25), "sellerLogin": f"v{i % 25}",
                 "status": "active", "publishedAt": now - i * 60000, "photoAt": now - i * 60000, "firstSeenAt": now, "lastSeenAt": now, "url": f"{ORIGIN}/items/{2000000 + i}"} for i in range(5000)]
    exp = {"app": "Vintastic", "schema": 1, "version": "1.0.0", "parts": {"listings": listings}}
    t0 = time.time()
    r = await env.rpc("backup.import", {"json": exp, "parts": ["listings"]})
    t_import = time.time() - t0
    check(r["ok"], f"import 5000: {r}")
    t0 = time.time()
    q = await env.rpc("listings.query", {"filters": {"topN": 100, "range": "7d", "search": "Articolo"}, "limit": 50, "withIds": True})
    t_query = time.time() - t0
    check(q["total"] == 100, f"query: {q['total']}")
    page = env.ui
    t0 = time.time()
    await page.goto(f"chrome-extension://{env.ext}/src/ui/dashboard.html#listings")
    await page.wait_for_selector("table.table tbody tr", timeout=20000)
    t_render = time.time() - t0
    lag = await page.evaluate("""() => new Promise((res) => { let max = 0, last = performance.now(); const id = setInterval(() => { const n = performance.now(); max = Math.max(max, n - last - 50); last = n; }, 50); setTimeout(() => { clearInterval(id); res(max); }, 1500); })""")
    check(t_query < 3 and t_render < 6, f"tempi: query {t_query:.2f}s, pagina {t_render:.2f}s")
    return f"5000 annunci: import {t_import:.1f}s, query filtrata {t_query*1000:.0f} ms, pagina Annunci {t_render:.1f}s, lag max {lag:.0f} ms"


async def t_health_kill(env):
    """Health Center, kill switch globale e per modulo, circuit breaker."""
    await env.open_ui()
    await env.fast_settings()
    await env.login_vinted()
    await scan(env)
    h = await env.rpc("health.check")
    names = {c["id"]: c for c in h["checks"]}
    for k in ("sw", "storage", "db", "queue", "session", "cap-wardrobeApi", "kill", "version", "errors", "net"):
        check(k in names, f"controllo mancante: {k}")
    check(names["db"]["status"] == "ok" and names["cap-wardrobeApi"]["status"] == "ok", f"db/compatibilità: {names['db']} {names['cap-wardrobeApi']}")
    c, _ = await make_campaign(env, 3, ("like",), timers={"betweenOps": {"min": 0, "max": 0}, "betweenItems": {"min": 4, "max": 4}})
    await env.rpc("campaigns.approve", {"id": c["id"]})
    await env.rpc("campaigns.start", {"id": c["id"]})
    await env.rpc("health.killSwitch", {"on": True})
    p = await finished(env, c["id"], 20, ("paused",))
    check(p["pauseReason"] == "kill", "kill switch ferma la campagna")
    r = await env.rpc("campaigns.resume", {"id": c["id"]})
    check(r["ok"] is False, "con il kill switch non riparte")
    await env.rpc("health.killSwitch", {"on": False})
    await env.rpc("health.moduleKill", {"module": "like", "on": True})
    r = await env.rpc("campaigns.resume", {"id": c["id"]})
    check(r["ok"] is False and any("like" in e.lower() for e in r["validation"]["errors"]), "campagna di soli like con il modulo like spento: non parte")
    sc = await scan(env)
    check(sc["status"] == "done", "lo scanner funziona con il modulo like spento")
    await env.rpc("campaigns.stop", {"id": c["id"]})
    # 2.0.0: con like spenti una campagna like + offerta parte, fa le offerte e i like aspettano.
    offers_before = len(env.fake.offers)
    res = await env.rpc("listings.query", {"filters": {"sellerId": SELLER_ID, "status": "active", "topN": 10, "range": "all"}, "limit": 10, "withIds": True})
    cm = await env.rpc("campaigns.create", {"name": "Like spenti", "types": ["like", "offer"], "dryRun": False, "listingIds": res["ids"][6:8],
        "timers": {"betweenOps": {"min": 0, "max": 0}, "betweenItems": {"min": 0, "max": 0}}})
    await env.rpc("campaigns.approve", {"id": cm["id"]})
    r = await env.rpc("campaigns.start", {"id": cm["id"]})
    check(r["ok"] and any("Like" in w for w in r["validation"]["warnings"]), f"parte con un avviso sui like: {r['validation']}")
    pm = await finished(env, cm["id"], 60, ("paused",))
    data = await env.campaign(cm["id"])
    st = {t: [o["status"] for i in data["items"] for o in i["ops"] if o["type"] == t] for t in ("like", "offer")}
    check(st["offer"] == ["completed", "completed"] and st["like"] == ["waiting", "waiting"] and len(env.fake.offers) == offers_before + 2, f"offerte eseguite, like in attesa: {st}")
    check(pm["pauseReason"] == "module" and "Like" in pm["pauseDetail"], f"pausa spiegata solo alla fine: {pm['pauseReason']} {pm['pauseDetail']}")
    await env.rpc("health.moduleKill", {"module": "like", "on": False})
    await env.rpc("campaigns.stop", {"id": cm["id"]})
    # circuit breaker: formato API cambiato (conversations senza transaction) → modulo offerte isolato
    async def broken(route):
        await route.fulfill(status=200, content_type="application/json", body='{"conversation":{"id":1}}')
    await env.ctx.route("https://www.vinted.it/api/v2/conversations", broken)
    c2, _ = await make_campaign(env, 1, ("offer",))
    await env.rpc("campaigns.approve", {"id": c2["id"]})
    await env.rpc("campaigns.start", {"id": c2["id"]})
    p2 = await finished(env, c2["id"], 60, ("completed", "paused"))
    br = await env.rpc("health.breakers")
    check(br.get("offer", {}).get("state") == "open", f"circuit breaker offerte: {br}")
    op2 = (await env.campaign(c2["id"]))["items"][0]["ops"][0]
    check(op2["status"] == "failed" and "isolato" in op2["error"], f"offerta fallita, modulo isolato: {op2}")
    sc = await scan(env)
    check(sc["status"] == "done", "lo scanner continua con il modulo offerte isolato")
    await env.rpc("health.resetBreaker", {"module": "offer"})
    bundle = await env.rpc("support.bundle")
    raw = json.dumps(bundle)
    check("csrf-test-token" not in raw and "v_uid=4242" not in raw, "Support Bundle senza token o cookie")
    return "Health Center completo; kill switch globale e per modulo (like spenti: le offerte partono, i like aspettano); circuit breaker isola le offerte e lo scanner continua"


async def t_discord(env):
    """Webhook Discord: validazione URL, permesso facoltativo richiesto, invio solo se concesso; mai negli export."""
    await env.open_ui()
    r = await env.rpc("discord.test")
    check(r["sent"] is False and "non valido" in r["reason"], f"senza webhook: {r}")
    await env.rpc("settings.save", {"patch": {"discord": {"webhookUrl": "https://discord.com/api/webhooks/123456789/abcdefghijklmnopqrstuvwxyz0123"}, "features": {"discord": True}}})
    r = await env.rpc("discord.test")
    check(r["sent"] is False and "permesso" in r["reason"], f"senza permesso facoltativo non invia: {r}")
    await env.rpc("settings.save", {"patch": {"discord": {"webhookUrl": "https://evil.example/hook"}}})
    r = await env.rpc("discord.test")
    check(r["sent"] is False and "non valido" in r["reason"], "URL non Discord rifiutato")
    exp = await env.rpc("backup.export", {"parts": ["settings"]})
    check("evil.example" not in json.dumps(exp), "webhook escluso dall'export")
    return "URL validato; senza il permesso facoltativo per discord.com non parte nulla; webhook mai esportato"


async def t_account_switch(env):
    """Etichette account; sessione di un altro account → pausa, autenticazione assistita, ripresa dopo il ritorno."""
    from fake_vinted import USER_ID
    await env.open_ui()
    await env.fast_settings()
    vp = await env.login_vinted()
    async def with_login():
        a = await env.rpc("accounts.list")
        return a if a and a[0].get("login") else None
    accs = await env.wait_for(with_login, 20, 0.5, "nome utente letto dalla scheda Vinted")
    check(len(accs) == 1 and accs[0]["login"] == "andrea_test" and accs[0]["current"], f"account rilevato: {accs}")
    await env.rpc("accounts.update", {"id": accs[0]["id"], "patch": {"label": "Personalizzato", "customLabel": "Il mio negozio", "favorite": True}})
    a = (await env.rpc("accounts.list"))[0]
    check(a["customLabel"] == "Il mio negozio" and a["label"] == "Personalizzato", "etichetta personalizzata salvata")
    await scan(env)
    c, ids = await make_campaign(env, 3, ("like",), timers={"betweenOps": {"min": 0, "max": 0}, "betweenItems": {"min": 3, "max": 3}})
    await env.rpc("campaigns.approve", {"id": c["id"]})
    await env.rpc("campaigns.start", {"id": c["id"]})
    async def one():
        x = (await env.campaign(c["id"]))["campaign"]
        return x if (x["progress"] or {}).get("completed", 0) >= 1 else None
    await env.wait_for(one, 60, 0.3, "primo like")
    # L'utente entra con un altro account su Vinted
    await env.ctx.add_cookies([{"name": "v_uid", "value": "5555", "domain": "www.vinted.it", "path": "/", "secure": True, "httpOnly": True}])
    await vp.reload()
    async def switched():
        s = await env.rpc("session.get")
        return s if s.get("userId") == "5555" else None
    await env.wait_for(switched, 20, 0.5, "sessione del secondo account")
    p = await finished(env, c["id"], 30, ("paused",))
    check(p["pauseReason"] == "auth" and "Account della sessione diverso" in p["pauseDetail"], f"pausa per account diverso: {p['pauseReason']} {p.get('pauseDetail')}")
    pend = (await env.rpc("recovery.list"))["authPending"]
    check(pend and pend["accountId"].startswith(USER_ID), "autenticazione assistita in attesa")
    likes_before = len(env.fake.favourites)
    r = await env.rpc("campaigns.resume", {"id": c["id"]})
    check(r["ok"] is False and any("non è quello della campagna" in e for e in r["validation"]["errors"]), "non riparte con l'account sbagliato")
    # Torna all'account giusto: il controllo periodico lo rileva e consente la ripresa
    await env.ctx.add_cookies([{"name": "v_uid", "value": USER_ID, "domain": "www.vinted.it", "path": "/", "secure": True, "httpOnly": True}])
    await vp.reload()
    async def resolved():
        s = await env.rpc("session.get")
        pend = (await env.rpc("recovery.list"))["authPending"]
        return True if s.get("userId") == USER_ID and pend is None else None
    await env.wait_for(resolved, 90, 2, "autenticazione risolta dal watchdog")
    notes = await env.rpc("notifications.list", {})
    check(any("Sessione di nuovo valida" in n["title"] for n in notes), "notifica di sessione valida")
    r = await env.rpc("campaigns.resume", {"id": c["id"]})
    check(r["ok"], f"ripresa dopo il ritorno: {r}")
    await finished(env, c["id"], 60)
    check(len(env.fake.favourites) == 3 and likes_before < 3, "la campagna riprende dal punto esatto")
    return "etichette ok; altro account → pausa + autenticazione assistita; ritorno rilevato → ripresa dal punto esatto"


async def t_sim_then_live(env):
    """Simulazione completata → «Esegui davvero» → le operazioni tornano in coda e partono davvero (bug 1.0.0)."""
    await env.open_ui()
    await env.fast_settings()
    await env.login_vinted()
    await scan(env)
    c, ids = await make_campaign(env, 2, ("like", "offer"), dry=True)
    await env.rpc("campaigns.approve", {"id": c["id"]})
    await env.rpc("campaigns.start", {"id": c["id"]})
    await finished(env, c["id"], 60)
    check(not env.fake.api_writes(), "la simulazione non scrive su Vinted")
    r = await env.rpc_raw("campaigns.start", {"id": c["id"]})
    check(r["ok"] is False and any("Esegui davvero" in e for e in r["validation"]["errors"]), f"messaggio chiaro dopo la simulazione: {r}")
    await env.rpc("campaigns.goLive", {"id": c["id"]})
    data = await env.campaign(c["id"])
    check(data["campaign"]["dryRun"] is False and data["campaign"]["status"] == "ready", f"campagna pronta in modalità reale: {data['campaign']['status']}")
    ops = [o for i in data["items"] for o in i["ops"]]
    check(sum(o["status"] == "waiting" for o in ops) == 4, f"like e offerte di nuovo in coda: {[o['status'] for o in ops]}")
    r = await env.rpc_raw("campaigns.start", {"id": c["id"]})
    check(r["ok"] is False, "serve una nuova approvazione dell'anteprima")
    await env.rpc("campaigns.approve", {"id": c["id"]})
    r = await env.rpc("campaigns.start", {"id": c["id"]})
    check(r["ok"], f"avvio reale: {r}")
    await finished(env, c["id"], 90)
    check(env.fake.favourites == {int(i) for i in ids}, f"like inviati davvero: {env.fake.favourites}")
    check(len(env.fake.offers) == 2, f"offerte inviate davvero: {env.fake.offers}")
    return "simulazione → «Esegui davvero su Vinted» → 2 like e 2 offerte inviate"


async def t_like_without_item_api(env):
    """Bug 1.1.0: like messo ma «da verificare» perché la rilettura usava i dati vecchi della pagina."""
    env.fake.item_api = False                     # GET /items/:id non disponibile: resta solo la pagina
    await env.open_ui()
    await env.fast_settings()
    await env.login_vinted()
    await scan(env)
    c, ids = await make_campaign(env, 3, ("like",))
    await env.rpc("campaigns.approve", {"id": c["id"]})
    await env.rpc("campaigns.start", {"id": c["id"]})
    done = await finished(env, c["id"], 90, ("completed", "paused"))
    p = done["progress"]
    check(done["status"] == "completed" and p["completed"] == 3 and p["verify"] == 0, f"like confermati, nessun «da verificare»: {done['status']} {p}")
    check(env.fake.favourites == {int(i) for i in ids}, "like messi su Vinted")
    toggles = [r for r in env.fake.requests if r[1].endswith("/user_favourites/toggle")]
    check(len(toggles) == 3, f"un solo toggle per annuncio (nessun like tolto): {len(toggles)}")
    return "3 like senza API di lettura: completati, nessun falso «da verificare», un toggle per annuncio"


async def t_offer_rules_and_cleanup(env):
    """Offerta rifiutata (prezzo troppo basso) → nuove regole +5% → ricalcolo e invio; eliminazione campagne e notifiche; risoluzione in blocco."""
    env.fake.min_offer_ratio = 0.9
    await env.open_ui()
    await env.fast_settings()
    await env.login_vinted()
    await scan(env)
    c, ids = await make_campaign(env, 3, ("offer",))                     # -20%: Vinted finto rifiuta sotto il 90%
    await env.rpc("campaigns.approve", {"id": c["id"]})
    await env.rpc("campaigns.start", {"id": c["id"]})
    p = await finished(env, c["id"], 60, ("paused", "completed"))
    items = (await env.campaign(c["id"]))["items"]
    errs = [o["error"] for i in items for o in i["ops"] if o["status"] == "failed"]
    check(len(errs) == 3 and all("troppo basso" in e for e in errs), f"offerte rifiutate con il messaggio di Vinted: {errs}")
    br = await env.rpc("health.breakers")
    check(br.get("offer", {}).get("state") != "open", f"un importo rifiutato non spegne il modulo offerte: {br}")
    # Nuove regole: predefinite (+5%)
    await env.rpc("campaigns.update", {"id": c["id"], "patch": {"opsDefaults": {**(await env.campaign(c["id"]))["campaign"]["opsDefaults"], "offerCfg": None}}})
    data = await env.campaign(c["id"])
    amounts = {i["listingId"]: o["amount"] for i in data["items"] for o in i["ops"]}
    for lid, amt in amounts.items():
        base = float(env.fake.items[int(lid)]["price"]["amount"])
        check(abs(amt - round(base * 1.05, 2)) < 0.011, f"ricalcolo a +5%: {amt} su {base}")
    check(all(o["status"] == "waiting" for i in data["items"] for o in i["ops"]), "offerte rifiutate di nuovo in coda")
    await env.rpc("campaigns.approve", {"id": c["id"]})
    r = await env.rpc("campaigns.start", {"id": c["id"]})
    check(r["ok"], f"ripartenza: {r}")
    await finished(env, c["id"], 60)
    check(len(env.fake.offers) == 3 and all(pr > float(env.fake.items[iid]["price"]["amount"]) for iid, pr in env.fake.offers), f"offerte +5% inviate: {env.fake.offers}")
    # Predefinito delle nuove campagne: +5%
    c2 = await env.rpc("campaigns.create", {"name": "Default", "types": ["offer"], "dryRun": True, "listingIds": [ids[0]]})
    pv = await env.rpc("campaigns.preview", {"id": c2["id"]})
    a2 = pv["items"][0]["ops"][0]["amount"]
    check(abs(a2 - round(float(env.fake.items[int(ids[0])]["price"]["amount"]) * 1.05, 2)) < 0.011, f"nuova campagna a +5%: {a2}")
    # Eliminazione: una campagna in corso + altre, poi tutte
    c3, _ = await make_campaign(env, 4, ("like",), dry=True, timers={"betweenOps": {"min": 0, "max": 0}, "betweenItems": {"min": 30, "max": 30}})
    await env.rpc("campaigns.approve", {"id": c3["id"]})
    await env.rpc("campaigns.start", {"id": c3["id"]})
    await asyncio.sleep(2)
    r = await env.rpc("campaigns.deleteMany", {"ids": [c3["id"]]})
    check(r["deleted"] == 1, f"campagna in corso eliminata: {r}")
    r = await env.rpc("campaigns.deleteMany", {"all": True})
    check(not await env.rpc("campaigns.list"), f"tutte eliminate: {r}")
    led = await env.rpc("ledger.list", {})
    check(len([e for e in led if e["status"] == "completed"]) == 3, "il registro anti-duplicati resta")
    # Notifiche: elimina tutte
    check(len(await env.rpc("notifications.list", {})) > 0, "ci sono notifiche")
    r = await env.rpc("notifications.delete", {"all": True})
    check(r["deleted"] > 0 and not await env.rpc("notifications.list", {}), "tutte le notifiche eliminate")
    # Salute si apre anche senza release su GitHub
    page = env.ui
    await page.goto(f"chrome-extension://{env.ext}/src/ui/dashboard.html#health")
    await page.wait_for_selector("text=Esegui controllo completo", timeout=15000)
    check("non si è caricata" not in await page.inner_text("#page"), "pagina Salute caricata")
    return "rifiuto «prezzo troppo basso» senza spegnere le offerte; regole +5% ricalcolate e inviate; eliminazione di campagne (anche in corso) e notifiche; Salute ok senza release"


async def t_resolve_all(env):
    """Recupero: risoluzione in blocco delle operazioni da verificare."""
    await env.open_ui()
    await env.fast_settings()
    await env.login_vinted()
    await scan(env)
    c, ids = await make_campaign(env, 3, ("like",))
    env.fake.fail[r"/user_favourites/toggle"] = 502          # risposta di errore del server: esito incerto
    await env.rpc("settings.save", {"patch": {"maxConsecutiveFailures": 10}})
    await env.rpc("campaigns.approve", {"id": c["id"]})
    await env.rpc("campaigns.start", {"id": c["id"]})
    async def three():
        r = await env.rpc("recovery.list")
        return r if len(r["verify"]) == 3 else None
    await env.wait_for(three, 60, 0.5, "3 da verificare")
    r = await env.rpc("recovery.resolveAll", {"type": "like", "done": True})
    check(r["resolved"] == 3, f"risolte in blocco: {r}")
    check(not (await env.rpc("recovery.list"))["verify"], "niente più da verificare")
    led = [e for e in await env.rpc("ledger.list", {}) if e["status"] == "completed"]
    check(len(led) == 3, "registro aggiornato: eseguite")
    return "3 like «da verificare» segnati come eseguiti in un colpo, registro aggiornato"
