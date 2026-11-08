"""
2.0.0 — cicli di esecuzione (riprocessare annunci già elaborati) e interfaccia
(«Posizione» In cima, commenti tolti, notifiche non coperte).
"""
import asyncio
from fake_vinted import SELLER_ID
from scenarios import check, scan, make_campaign, finished, kill_service_worker


async def t_cycles(env):
    """Nuovo ciclo su un annuncio: anteprima di cosa si ripete, conferma, approvazione, cronologia intatta, No Repeat per i duplicati."""
    await env.open_ui()
    await env.fast_settings()
    await env.login_vinted()
    await scan(env)
    c, ids = await make_campaign(env, 2, ("like", "offer"))
    await env.rpc("campaigns.approve", {"id": c["id"]})
    await env.rpc("campaigns.start", {"id": c["id"]})
    await finished(env, c["id"], 90)
    check(len(env.fake.offers) == 2 and env.fake.favourites == {int(i) for i in ids}, "primo ciclo eseguito")
    data = await env.campaign(c["id"])
    first = next(i for i in data["items"] if i["listingId"] == ids[0])
    env.fake.favourites.clear()                       # il like è stato tolto su Vinted
    # Anteprima: cosa si ripeterà e cosa no.
    pv = await env.rpc("campaigns.cyclePreview", {"id": c["id"], "itemIds": [first["id"]]})
    check(pv["nextCycle"] == 2 and sorted(r["type"] for r in pv["repeat"]) == ["like", "offer"] and pv["items"] == 1, f"anteprima del ciclo: {pv}")
    r = await env.rpc_raw("campaigns.newCycle", {"id": c["id"], "itemIds": [first["id"]]})
    check(r.get("__vtError") and "conferma" in r["error"], "senza conferma esplicita non parte")
    r = await env.rpc("campaigns.newCycle", {"id": c["id"], "itemIds": [first["id"]], "confirm": True})
    check(r["ok"] and r["cycle"] == 2 and r["repeated"] == 2, f"nuovo ciclo: {r}")
    # Il riavvio del service worker non perde niente.
    await kill_service_worker(env)
    await asyncio.sleep(1)
    data = await env.campaign(c["id"])
    camp = data["campaign"]
    check(camp["cycle"]["n"] == 2 and len(camp["cycles"]) == 1 and camp["status"] == "ready" and not camp["snapshot"], f"campagna dopo il riavvio: {camp['status']} {camp.get('cycle')}")
    it0 = next(i for i in data["items"] if i["id"] == first["id"])
    it1 = next(i for i in data["items"] if i["id"] != first["id"])
    check([(o["type"], o["status"], o["cycle"]) for o in it0["ops"]] == [("like", "waiting", 2), ("offer", "waiting", 2)], f"operazioni del ciclo 2: {it0['ops']}")
    check(len(it0["pastCycles"]) == 1 and all(o["status"] == "completed" and o["finishedAt"] for o in it0["pastCycles"][0]["ops"]), "cronologia del ciclo 1 intatta")
    check(all(o["cycle"] == 1 and o["status"] == "completed" for o in it1["ops"]) and not it1.get("pastCycles"), "l'altro annuncio non è cambiato")
    r = await env.rpc_raw("campaigns.start", {"id": c["id"]})
    check(r["ok"] is False, "serve una nuova approvazione")
    await env.rpc("campaigns.approve", {"id": c["id"]})
    await env.rpc("campaigns.start", {"id": c["id"]})
    await finished(env, c["id"], 90)
    check(len(env.fake.offers) == 3 and env.fake.offers[-1][0] == int(ids[0]), f"una sola offerta nuova, sull'annuncio scelto: {env.fake.offers}")
    check(env.fake.favourites == {int(ids[0])}, f"like rimesso solo sull'annuncio scelto: {env.fake.favourites}")
    led = [e for e in await env.rpc("ledger.list", {}) if e["listingId"] == ids[0] and e["type"] == "offer"][0]
    keys = {h.get("cycleKey") for h in led["history"] if h["status"] == "completed"}
    check(len(keys) == 2, f"ledger: due esecuzioni in due cicli diversi: {led['history']}")
    # Duplicato accidentale: un'altra campagna sugli stessi annunci viene bloccata dal No Repeat.
    before = len(env.fake.offers)
    c2, _ = await make_campaign(env, 2, ("offer",))
    await env.rpc("campaigns.approve", {"id": c2["id"]})
    await env.rpc("campaigns.start", {"id": c2["id"]})
    d2 = await finished(env, c2["id"], 60)
    check(d2["progress"]["skipped"] == 2 and len(env.fake.offers) == before, f"No Repeat: {d2['progress']}")
    # Interfaccia: tabella dei cicli e dialogo del nuovo ciclo.
    old = env.ui
    ui = await env.open_ui(f"campaigns/{c['id']}")
    await ui.wait_for_selector("text=Cicli (attuale: 2)", timeout=15000)
    await ui.click("button:has-text('Nuovo ciclo…')")
    await ui.wait_for_selector(".modal-back >> text=si ripeteranno", timeout=10000)
    await ui.click(".modal-back >> text=Annulla")
    await ui.close()
    env.ui = old
    return "ciclo 2 su 1 annuncio: anteprima, conferma obbligatoria, riapprovazione, 1 like + 1 offerta ripetuti; ciclo 1 intatto; stato salvato dopo il riavvio; duplicato accidentale bloccato"


async def t_ui_v2(env):
    """«Posizione» In cima predefinita e salvata, nessun controllo dei commenti, pastiglie delle notifiche non sovrapposte."""
    await env.open_ui()
    await env.fast_settings()
    await env.login_vinted()
    await scan(env)
    c, _ = await make_campaign(env, 1, ("like",), dry=True)
    old = env.ui
    ui = await env.open_ui(f"campaigns/{c['id']}")
    await ui.wait_for_selector("text=Coda", timeout=15000)
    await ui.click("button:has-text('Aggiungi annunci')")
    sel = ui.locator('.modal-back select[aria-label="Posizione"]')
    check(await sel.input_value() == "start", "Posizione predefinita: In cima")
    ops_text = await ui.locator(".modal-back").inner_text()
    check("Commento" not in ops_text, "nessun commento tra le operazioni")
    await sel.select_option("end")
    await ui.click(".modal-back >> button:has-text('Aggiungi')")
    await asyncio.sleep(1.5)
    camp = (await env.campaign(c["id"]))["campaign"]
    check(camp["addPosition"] == "end", f"scelta salvata nella campagna: {camp.get('addPosition')}")
    await ui.reload()
    await ui.wait_for_selector("text=Coda", timeout=15000)
    await ui.click("button:has-text('Aggiungi annunci')")
    check(await ui.locator('.modal-back select[aria-label="Posizione"]').input_value() == "end", "riaprendo resta «In fondo»")
    await ui.click(".modal-back >> text=Annulla")
    # Nuova campagna dalla pagina Annunci: In cima.
    await ui.goto(ui.url.split("#")[0] + "#campaigns?new=1")
    await ui.wait_for_selector(".modal-back", timeout=10000)
    check("Commento" not in await ui.locator(".modal-back").inner_text(), "creazione: nessun commento")
    await ui.click(".modal-back >> text=Annulla")
    # Notifiche: pastiglia «Avviso» e testo non si sovrappongono.
    for lv in ("warning", "critical", "info"):
        await env.rpc("notifications.test", {"level": lv})
    await ui.goto(ui.url.split("#")[0] + "#notifications")
    await ui.wait_for_selector(".feed.notes li", timeout=15000)
    boxes = await ui.evaluate("""() => [...document.querySelectorAll('.feed.notes li')].map((li) => {
        const p = li.children[0].getBoundingClientRect(), t = li.children[1].getBoundingClientRect();
        return { pill: p.right, text: t.left, label: li.children[0].textContent };
    })""")
    check(boxes and all(b["pill"] <= b["text"] for b in boxes), f"pastiglie dentro la loro colonna: {boxes}")
    await ui.close()
    env.ui = old
    return f"Posizione: In cima → scelta «In fondo» salvata e riproposta; nessun controllo dei commenti; {len(boxes)} notifiche senza sovrapposizioni"


async def t_seller_menu(env):
    """Menu Venditore: account seguiti (da Vinted), destinatari non seguiti, scansione automatica di un
    venditore mai scansionato; con una campagna in corso la lettura usa una scheda sua."""
    await env.open_ui()
    await env.fast_settings()
    await env.login_vinted()
    await env.rpc("settings.save", {"patch": {"messages": {"recipients": [{"id": "88", "label": "Ragazzo"}, {"id": "99", "label": "Amica"}]}}})
    m = await env.rpc("sellers.menu", {"refresh": True})
    check(not m.get("followingError"), f"seguiti letti: {m.get('followingError')}")
    check([e["login"] for e in m["following"]] == ["amico_test", "venditrice_test"], f"seguiti: {m['following']}")
    check(all(e["count"] == 0 for e in m["following"]), "nessun annuncio ancora scansionato")
    check(next(e for e in m["following"] if e["sellerId"] == "88")["recipient"] is True, "88: seguito e destinatario")
    check([e["sellerId"] for e in m["recipients"]] == ["99"], f"destinatari non seguiti: {m['recipients']}")
    check(any(r[1].startswith("/api/v2/users/4242/followed_users?") for r in env.fake.requests), "lettura con followed_users")
    # Dalla finestra «Aggiungi annunci»: venditore mai scansionato → prima l'armadio, poi la coda.
    c = await env.rpc("campaigns.create", {"name": "Menu venditore", "types": ["like"], "dryRun": True, "listingIds": [],
                                          "timers": {"betweenOps": {"min": 0, "max": 0}, "betweenItems": {"min": 0, "max": 0}}})
    old = env.ui
    ui = await env.open_ui(f"campaigns/{c['id']}")
    await ui.wait_for_selector("text=Coda", timeout=15000)
    await ui.click("button:has-text('Aggiungi annunci')")
    sel = ui.locator('.modal-back select[aria-label="Venditore"]')
    await ui.wait_for_function("() => document.querySelector('.modal-back select[aria-label=\"Venditore\"]')?.options.length > 1", timeout=15000)
    labels = await sel.evaluate("(s) => [...s.options].map((o) => o.textContent)")
    groups = await sel.evaluate("(s) => [...s.querySelectorAll('optgroup')].map((g) => g.label)")
    check(groups[:2] == ["Account che segui", "Destinatari dei messaggi (non seguiti)"], f"gruppi: {groups}")
    check(any("@venditrice_test" in t and "da scansionare" in t for t in labels), f"opzioni: {labels}")
    await sel.select_option(SELLER_ID)
    hint = await ui.locator(".modal-back").inner_text()
    check("non ancora scansionati" in hint, "spiegato che prima si legge l'armadio")
    await ui.click(".modal-back >> button:has-text('Aggiungi')")
    async def added():
        x = await env.campaign(c["id"])
        return x if len([i for i in x["items"] if not i.get("removed")]) > 0 else None
    x = await env.wait_for(added, 90, 1, "annunci aggiunti dopo la scansione")
    n = len([i for i in x["items"] if not i.get("removed")])
    scans = await env.rpc("scans.list", {"limit": 5})
    check(scans and scans[0]["sellerId"] == SELLER_ID and scans[0]["status"] == "done", f"scansione: {scans[:1]}")
    m2 = await env.rpc("sellers.menu")
    check(next(e for e in m2["following"] if e["sellerId"] == SELLER_ID)["count"] > 0, "dopo la scansione il conteggio c'è")
    await ui.close()
    env.ui = old
    # Campagna in corso: la lettura dei seguiti non sposta la scheda di lavoro.
    run, _ = await make_campaign(env, 4, ("like",), timers={"betweenOps": {"min": 0, "max": 0}, "betweenItems": {"min": 40, "max": 40}})
    await env.rpc("campaigns.preview", {"id": run["id"]})
    await env.rpc("campaigns.approve", {"id": run["id"]})
    r = await env.rpc("campaigns.start", {"id": run["id"]})
    check(r["ok"], f"avvio: {r}")
    async def first_done():
        y = await env.campaign(run["id"])
        return y if y["campaign"]["progress"]["completed"] >= 1 else None
    await env.wait_for(first_done, 60, 0.5, "primo like")
    worker = [p for p in env.ctx.pages if "/items/" in p.url]
    check(len(worker) == 1, f"scheda di lavoro sull'annuncio: {[p.url for p in env.ctx.pages]}")
    before = worker[0].url
    env.fake.following.append(("123", "nuovo_seguito"))
    m3 = await env.rpc("sellers.menu", {"refresh": True})
    check(any(e["sellerId"] == "123" for e in m3["following"]), f"seguiti riletti durante la campagna: {m3.get('followingError')}")
    check(worker[0].url == before, f"scheda di lavoro non spostata: {before} → {worker[0].url}")
    await asyncio.sleep(1)
    check(not [p for p in env.ctx.pages if "/member/general/following" in p.url], "scheda di lettura chiusa")
    await env.rpc("campaigns.stop", {"id": run["id"]})
    return f"seguiti {len(m['following'])} + destinatari non seguiti {len(m['recipients'])}; venditore mai scansionato: armadio letto e {n} annunci aggiunti; con la campagna in corso lettura in una scheda separata"


def toggles(env):
    return [r for r in env.fake.requests if r[0] == "POST" and r[1] == "/api/v2/user_favourites/toggle"]


async def t_history_relike(env):
    """2.2.0: «Azzera storico» (solo like / mix) dalla campagna e dagli Annunci; like già presente su
    Vinted tolto e rimesso; filtri degli Annunci applicati mentre scrivi; nuova campagna che mostra
    da sola le opzioni appena aperte."""
    ui = await env.open_ui()
    await env.fast_settings()
    await env.login_vinted()
    await scan(env)
    out = []
    # 1) Primo giro: 2 like + 2 offerte reali.
    c1, ids = await make_campaign(env, 2, ("like", "offer"))
    await env.rpc("campaigns.preview", {"id": c1["id"]}); await env.rpc("campaigns.approve", {"id": c1["id"]})
    check((await env.rpc("campaigns.start", {"id": c1["id"]}))["ok"], "avvio 1")
    await finished(env, c1["id"])
    check(env.fake.favourites == {int(i) for i in ids}, "like messi")
    # 2) Stessi annunci in una nuova campagna: il No Repeat li salta.
    c2, _ = await make_campaign(env, 2, ("like", "offer"))
    await env.rpc("campaigns.preview", {"id": c2["id"]}); await env.rpc("campaigns.approve", {"id": c2["id"]})
    check((await env.rpc("campaigns.start", {"id": c2["id"]}))["ok"], "avvio 2")
    await finished(env, c2["id"])
    ops = [o for i in (await env.campaign(c2["id"]))["items"] for o in i["ops"]]
    check(all(o["status"] == "skipped" for o in ops), f"No Repeat: {[o['status'] for o in ops]}")
    # 3) «Azzera storico…» dalla campagna, solo like: i like tornano in attesa, le offerte restano saltate.
    page = await env.open_ui(f"campaigns/{c2['id']}")
    await page.wait_for_selector("text=Coda", timeout=15000)
    await page.click("button:has-text('Azzera storico')")
    await page.click(".modal-back >> button:has-text('Like')")          # pulsante rapido «Like»
    await page.click(".modal-back >> .modal-foot >> button:has-text('Azzera')")
    async def reset():
        x = await env.campaign(c2["id"])
        st = {(o["type"], o["status"]) for i in x["items"] for o in i["ops"]}
        return x if ("like", "waiting") in st and x["campaign"]["status"] == "ready" else None
    x = await env.wait_for(reset, 15, 0.3, "like di nuovo in attesa, campagna riaperta")
    st = sorted({(o["type"], o["status"]) for i in x["items"] for o in i["ops"]})
    check(st == [("like", "waiting"), ("offer", "skipped")], f"solo i like azzerati: {st}")
    check(x["campaign"]["status"] == "ready", f"campagna riaperta: {x['campaign']['status']}")
    led = await env.rpc("ledger.list", {})
    check(not [e for e in led if e["type"] == "like"] and len([e for e in led if e["type"] == "offer"]) == 2, "registro: like tolti, offerte rimaste")
    out.append("Azzera storico (solo like) dalla campagna: like di nuovo in attesa, offerte ancora saltate")
    # 4) Il like c'è già su Vinted: tolto e rimesso (2 toggle per annuncio), alla fine il like c'è.
    before = len(toggles(env))
    await env.rpc("campaigns.preview", {"id": c2["id"]}); await env.rpc("campaigns.approve", {"id": c2["id"]})
    check((await env.rpc("campaigns.start", {"id": c2["id"]}))["ok"], "avvio 3")
    await finished(env, c2["id"])
    likes = [o for i in (await env.campaign(c2["id"]))["items"] for o in i["ops"] if o["type"] == "like"]
    check(all(o["status"] == "completed" for o in likes), f"like: {[o['status'] for o in likes]}")
    check(len(toggles(env)) - before == 4, f"2 toggle per annuncio (toglie e rimette): {len(toggles(env)) - before}")
    check(env.fake.favourites == {int(i) for i in ids}, f"alla fine il like c'è: {env.fake.favourites}")
    check(all("tolto e rimesso" in ((o.get("result") or {}).get("detail") or "") for o in likes), f"esito «tolto e rimesso»: {[(o.get('result') or {}).get('detail') for o in likes]}")
    out.append("like già presente: tolto e rimesso, 2 toggle per annuncio, like presente alla fine")
    # 5) «Lascialo»: nessun toggle.
    c3, _ = await make_campaign(env, 1, ("like",))
    await env.rpc("campaigns.update", {"id": c3["id"], "patch": {"likeExisting": "keep"}})
    await env.rpc("ledger.clear", {"campaignId": c3["id"], "types": ["like"]})
    await env.rpc("campaigns.preview", {"id": c3["id"]}); await env.rpc("campaigns.approve", {"id": c3["id"]})
    before = len(toggles(env))
    check((await env.rpc("campaigns.start", {"id": c3["id"]}))["ok"], "avvio 4")
    await finished(env, c3["id"])
    check(len(toggles(env)) == before, "«Lascialo»: nessun toggle")
    out.append("«Lascialo»: like già presente contato come fatto, nessun toggle")
    # 6) Annunci: chip cliccabile e azzeramento in blocco; filtri mentre scrivi.
    await page.goto(page.url.split("#")[0] + "#listings")
    await page.wait_for_selector("text=Seleziona tutti", timeout=15000)
    total = int((await page.locator("text=/annunci su/").first.inner_text()).split()[0])
    await page.fill('input[data-fkey="search"]', "zzzz-nessuno")
    await page.wait_for_function("() => /^0 annunci su/.test([...document.querySelectorAll('span')].map(s => s.textContent).find(t => /annunci su/.test(t)) || '')", timeout=5000)
    focused = await page.evaluate("() => document.activeElement?.dataset?.fkey")
    check(focused == "search", f"cursore ancora nella ricerca: {focused}")
    await page.fill('input[data-fkey="search"]', "")
    await page.wait_for_function(f"() => /^{total} annunci su/.test([...document.querySelectorAll('span')].map(s => s.textContent).find(t => /annunci su/.test(t)) || '')", timeout=5000)
    out.append(f"filtri: ricerca applicata mentre scrivi ({total} → 0 → {total}), senza perdere il cursore")
    await page.select_option('select[aria-label="Escludi già fatti"]', "offer")
    await page.wait_for_function(f"() => /^{total - 2} annunci su/.test([...document.querySelectorAll('span')].map(s => s.textContent).find(t => /annunci su/.test(t)) || '')", timeout=5000)
    await page.select_option('select[aria-label="Escludi già fatti"]', "")
    await page.wait_for_function(f"() => /^{total} annunci su/.test([...document.querySelectorAll('span')].map(s => s.textContent).find(t => /annunci su/.test(t)) || '')", timeout=5000)
    chip = page.locator("button.op-chip:has-text('Offerta')").first
    await chip.click()
    await page.click(".modal-back >> .modal-foot >> button:has-text('Azzera')")
    await env.wait_for(lambda: _offers_left(env, 1), 10, 0.3, "una offerta tolta dal registro")
    out.append("chip «Offerta ×» negli Annunci: azzera solo quella")
    # 7) Nuova campagna: spuntando «Offerta» la sezione si apre e si vede.
    await page.goto(page.url.split("#")[0] + "#campaigns")
    await page.click("button:has-text('Nuova campagna')")
    body = page.locator(".modal-back .modal-body")
    await page.wait_for_timeout(500)
    top0 = await body.evaluate("(b) => b.scrollTop")
    await page.locator(".modal-back .widget-cfg label.check:has-text('Offerta') input").check()
    await page.wait_for_timeout(900)
    info = await page.evaluate("""() => { const d = [...document.querySelectorAll('.modal-back details')].find(x => x.querySelector('summary').textContent.includes('Regole delle offerte'));
      const b = document.querySelector('.modal-back .modal-body').getBoundingClientRect(); const r = d.getBoundingClientRect();
      return { open: d.open, visible: r.top >= b.top - 1 && r.top < b.bottom, scroll: document.querySelector('.modal-back .modal-body').scrollTop }; }""")
    check(info["open"] and info["visible"], f"sezione offerte aperta e visibile: {info}")
    check(info["scroll"] > top0, f"la finestra è scesa da sola: {top0} → {info['scroll']}")
    out.append(f"nuova campagna: «Offerta» apre «Regole delle offerte» e scorre ({top0} → {info['scroll']} px)")
    # Clic sul triangolo di una sezione chiusa: la finestra scende da sola fino a mostrarla.
    await body.evaluate("(b) => { b.scrollTop = 0; }")
    await page.locator(".modal-back details summary:has-text('Messaggio privato')").click()
    await page.wait_for_timeout(900)
    info2 = await page.evaluate("""() => { const d = [...document.querySelectorAll('.modal-back details')].find(x => x.querySelector('summary').textContent.includes('Messaggio privato'));
      const b = document.querySelector('.modal-back .modal-body').getBoundingClientRect(); const r = d.getBoundingClientRect();
      return { open: d.open, bottomVisible: r.bottom <= b.bottom + 1 || r.top <= b.top + 1, scroll: document.querySelector('.modal-back .modal-body').scrollTop }; }""")
    check(info2["open"] and info2["scroll"] > 0 and info2["bottomVisible"], f"sezione aperta col triangolo mostrata: {info2}")
    out.append(f"triangolo «Messaggio privato»: la finestra scende da sola ({info2['scroll']} px)")
    return " · ".join(out)


async def _offers_left(env, n):
    led = await env.rpc("ledger.list", {})
    return True if len([e for e in led if e["type"] == "offer"]) == n else None
