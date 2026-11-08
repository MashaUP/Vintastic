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
