"""
Vinted finto per i test end-to-end: pagine HTML e API /api/v2 servite con
Playwright (context.route). Registra ogni richiesta per verificare che
Vintastic non tocchi mai percorsi d'acquisto.
NON è Vinted: le forme delle risposte seguono quelle note (Vinted_Relist) e
le ipotesi documentate in adapter.js.
"""
import json, re, time

ORIGIN = "https://www.vinted.it"
USER_ID = "4242"
SELLER_ID = "77"
FORBIDDEN = re.compile(r"checkout|purchase|payment|/buy\b|/orders?\b|wallet|instant_buy|/cart\b|shipping", re.I)


class FakeVinted:
    def __init__(self, n_items=130, logged_in=True):
        now = int(time.time())
        self.items = {}
        for i in range(n_items):
            iid = 900000 + i
            self.items[iid] = {
                "id": iid, "title": f"Giacca vintage {i}" if i % 3 == 0 else f"Jeans {i}",
                "price": {"amount": f"{10 + i % 40}.0", "currency_code": "EUR"},
                "path": f"/items/{iid}-articolo-{i}", "user": {"id": int(SELLER_ID), "login": "venditrice_test"},
                "photo": {"id": 5000 + i, "url": f"https://images1.vinted.net/t/{i}.jpg", "high_resolution": {"timestamp": now - i * 7200}} if i % 10 != 9 else {"id": 5000 + i, "url": f"https://images1.vinted.net/t/{i}.jpg"},
                # Come su Vinted reale: l'armadio NON dà la data di pubblicazione, solo il timestamp della foto.
                "is_favourite": False, "favourite_count": i % 5, "view_count": i * 3,
                "is_closed": i == 5, "is_reserved": False,
            }
        self.logged_in = logged_in
        self.requests = []          # (method, path, body)
        self.favourites = set()
        self.offers = []            # (item_id, price)
        self.notifications = [{"id": 700 + i, "body": f"Notifica {i}", "is_read": i % 4 == 0, "updated_at": "2026-11-01T10:00:00Z"} for i in range(12)]
        self.read_calls = []
        self.fail = {}              # path regex -> status / "abort" / ("delay", s)
        self.captcha_items = set()
        self.price_override = {}
        self.item_api = True            # False: GET /items/:id non disponibile (come può succedere su Vinted reale)
        self.min_offer_ratio = None     # es. 0.9: offerte sotto il 90% del prezzo rifiutate
        # Chat «Chiedi info» con l'HTML reale fornito (textarea#composerInput, [data-testid="arrow-right"]).
        self.chat = {
            "nav": "full",          # full: pagina nuova /inbox/<uuid>?referrer=… (come vinted.it il 07/11/2026) · spa: stessa pagina · newtab: scheda nuova
            "open_delay": 0,        # secondi prima che compaia il campo del messaggio
            "ask_info": "on",       # on · off (pulsante assente) · disabled
            "composer": True,       # False: chat senza #composerInput
            "enable": True,         # False: il pulsante di invio resta disabilitato
            "send": "ok",           # ok · slow (messaggio dopo 3 s) · clear-only (si svuota, nessun messaggio) · stuck · captcha
            "old_bubble": None,     # testo di un messaggio identico già presente nella conversazione
            "captcha_on_open": False,
            "return_fail": False,   # dopo un invio la pagina dell'annuncio non si carica
        }
        self.messages = []          # (item_id, testo) messaggi arrivati al «server»
        self.send_clicks = 0        # pressioni di Invia (anche senza messaggio arrivato)

    # ------------------------------------------------------------------ html
    def _page(self, body, title="Vinted"):
        logged = '<a href="/member/notifications" data-testid="header-user-menu">Profilo</a>' if self.logged_in else '<a data-testid="header--login-button" href="/member/signup">Accedi</a>'
        # come il sito vero, la pagina chiama da sé le API (così il browser manda i cookie)
        boot = f'<script>fetch("/api/v2/users/{USER_ID}",{{credentials:"include",headers:{{"X-CSRF-Token":"csrf-test-token-1234567890","X-Anon-Id":"anon-1"}}}}).catch(()=>{{}})</script>' if self.logged_in else ""
        return f'<!doctype html><html lang="it"><head><meta charset="utf-8"><meta name="csrf-token" content="csrf-test-token-1234567890"><title>{title}</title></head><body><header>{logged}</header><main>{body}</main>{boot}</body></html>'

    def item_page(self, iid):
        it = self.items.get(iid)
        if not it:
            return 404, self._page("<h1>Pagina non trovata</h1>")
        if iid in self.captcha_items:
            return 200, self._page('<iframe src="https://geo.captcha-delivery.com/captcha/?x=1" title="captcha"></iframe>', "Verifica")
        data = json.dumps({"item": {**it, "is_favourite": iid in self.favourites, "user_id": int(SELLER_ID)}})
        btn = f'<button data-testid="item-favourite" aria-pressed="{"true" if iid in self.favourites else "false"}" aria-label="Aggiungi ai preferiti">♥</button>'
        buy = '<button data-testid="item-buy-button">Acquista</button><button>Fai un\'offerta</button>'
        ask = self.ask_info_button(iid)
        return 200, self._page(f'<h1>{it["title"]}</h1>{btn}{buy}{ask}<script id="__item" type="application/json">{data}</script>', it["title"])

    # ------------------------------------------------------------------ chat «Chiedi info»
    def chat_script(self, iid):
        """JS della chat finta: stessa struttura dell'HTML reale di Vinted."""
        cfg = json.dumps(self.chat)
        return """<script>(() => {
  const cfg = %s, iid = %d;
  window.renderChat = (root) => {
    if (cfg.captcha_on_open) { root.innerHTML = '<iframe src="https://geo.captcha-delivery.com/captcha/?x=1" title="captcha"></iframe>'; return; }
    const old = cfg.old_bubble ? '<div class="web_ui__MessageBubble">' + cfg.old_bubble + '</div>' : '';
    root.innerHTML = '<section class="thread">' + old + '</section>' + (cfg.composer ? `<div class="web_ui__InputBar">
      <div class="web_ui__InputBar__input"><textarea id="composerInput" name="composerInput" placeholder="Scrivi un messaggio qui" data-testid="composer--input" class="web_ui__InputBar__value" autocomplete="off"></textarea></div>
      <div class="web_ui__InputBar__suffix"><button type="button" disabled><span data-testid="arrow-right">➤</span></button></div></div>` : '');
    const ta = root.querySelector('#composerInput'), btn = root.querySelector('.web_ui__InputBar__suffix button'), thread = root.querySelector('.thread');
    if (!ta) return;
    ta.addEventListener('input', () => { btn.disabled = !cfg.enable || !ta.value.trim(); });
    const send = () => {
      const text = ta.value.trim();
      if (!text || btn.disabled) return;
      fetch('/__fake/chat_click', { method: 'POST', body: JSON.stringify({ item: iid }) });
      if (cfg.send === 'stuck') return;
      if (cfg.send === 'captcha') { document.body.insertAdjacentHTML('beforeend', '<iframe src="https://geo.captcha-delivery.com/captcha/?x=2" title="captcha"></iframe>'); return; }
      ta.value = ''; btn.disabled = true;
      if (cfg.send === 'clear-only') return;
      const add = () => fetch('/__fake/chat_send', { method: 'POST', body: JSON.stringify({ item: iid, text }) }).then(() => {
        const b = document.createElement('div'); b.className = 'web_ui__MessageBubble'; b.innerHTML = text.split('\\n').map((l) => '<span>' + l + '</span>').join('<br>');
        thread.append(b);
      });
      cfg.send === 'slow' ? setTimeout(add, 3000) : add();
    };
    btn.addEventListener('click', send);
    ta.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } });
  };
})();</script>""" % (cfg, iid)

    def ask_info_button(self, iid):
        if self.chat["ask_info"] == "off":
            return ""
        dis = " disabled" if self.chat["ask_info"] == "disabled" else ""
        conv = f"01a1b30b-910b-71b4-9955-{iid:012d}"
        url = f"/inbox/{conv}?referrer=%2Fitems%2F{iid}-articolo"
        go = {"full": f"location.href = '{url}';",
              "newtab": f"window.open('{url}', '_blank');",
              "spa": f"history.pushState({{}}, '', '/inbox/{conv}'); setTimeout(() => renderChat(document.querySelector('main')), {int(self.chat['open_delay'] * 1000)});"}[self.chat["nav"]]
        # Struttura copiata da vinted.it (07/11/2026): <button data-testid="ask-seller-button"> con l'etichetta «Chiedi info».
        return (f'<button type="button" class="web_ui__Button__button web_ui__Button__outlined web_ui__Button__default web_ui__Button__primary web_ui__Button__truncated" data-testid="ask-seller-button"{dis} id="ask-info"><span class="web_ui__Button__content"><span class="web_ui__Button__label">Chiedi info</span></span></button>'
                + self.chat_script(iid) + f"<script>document.getElementById('ask-info').addEventListener('click', () => {{ {go} }});</script>")

    def inbox_page(self, iid):
        return 200, self._page('<div id="chat"></div>' + self.chat_script(iid) + "<script>renderChat(document.getElementById('chat'));</script>", "Messaggi")

    def wardrobe_page(self):
        cards = "".join(f'<div data-testid="grid-item"><a href="{it["path"]}"><img alt="{it["title"]}, taglia M" src="{it["photo"]["url"]}"></a><p>{it["price"]["amount"]} €</p></div>' for it in list(self.items.values())[:24])
        return 200, self._page(f"<h1>Armadio</h1>{cards}")

    # ------------------------------------------------------------------ api
    def api(self, method, path, body):
        if not self.logged_in and method != "GET":
            return 401, {"message": "unauthorized"}
        m = re.match(r"^/wardrobe/(\d+)/items\?(.*)$", path)
        if m and method == "GET":
            q = dict(x.split("=") for x in m.group(2).split("&"))
            page, per = int(q.get("page", 1)), int(q.get("per_page", 20))
            all_items = list(self.items.values())
            chunk = all_items[(page - 1) * per: page * per]
            out = [{**it, "is_favourite": it["id"] in self.favourites} for it in chunk]
            return 200, {"items": out, "pagination": {"current_page": page, "total_pages": -(-len(all_items) // per), "total_entries": len(all_items), "per_page": per}}
        m = re.match(r"^/users/(\d+)$", path)
        if m:
            return (200, {"user": {"id": int(m.group(1)), "login": "andrea_test", "item_count": 12}}) if self.logged_in else (401, {})
        m = re.match(r"^/items/(\d+)$", path)
        if m and method == "GET":
            if not self.item_api:
                return 404, {"message": "not found"}
            iid = int(m.group(1))
            it = self.items.get(iid)
            if not it:
                return 404, {"message": "not found"}
            price = self.price_override.get(iid)
            item = {**it, "is_favourite": iid in self.favourites}
            if price is not None:
                item["price"] = {"amount": str(price), "currency_code": "EUR"}
            return 200, {"item": item}
        if path == "/user_favourites/toggle" and method == "POST":
            for iid in body.get("user_favourites", []):
                self.favourites ^= {int(iid)}
            return 200, {"code": 0}
        if path == "/conversations" and method == "POST":
            return 200, {"conversation": {"id": 1, "transaction": {"id": 50000 + int(body["item_id"]) % 10000}}}
        m = re.match(r"^/transactions/(\d+)/offer_requests$", path)
        if m and method == "POST":
            price = float(body["offer_request"]["price"])
            iid = next((i for i in self.items if 50000 + i % 10000 == int(m.group(1))), None)
            if price < 1 or (self.min_offer_ratio and iid and price < float(self.items[iid]["price"]["amount"]) * self.min_offer_ratio):
                return 422, {"errors": [{"field": "base", "value": "Il prezzo è troppo basso!"}]}
            self.offers.append((iid, price))
            return 200, {"offer_request": {"id": len(self.offers), "price": body["offer_request"]["price"]}}
        m = re.match(r"^/notifications\?(.*)$", path)
        if m and method == "GET":
            q = dict(x.split("=") for x in m.group(1).split("&"))
            page, per = int(q.get("page", 1)), int(q.get("per_page", 20))
            return 200, {"notifications": self.notifications[(page - 1) * per: page * per]}
        m = re.match(r"^/notifications/(\d+)$", path)
        if m and method == "PUT":
            nid = int(m.group(1))
            self.read_calls.append(nid)
            for n in self.notifications:
                if n["id"] == nid:
                    n["is_read"] = True
            return 200, {}
        return 404, {"message": f"fake: {method} {path} non gestito"}

    async def handle(self, route):
        req = route.request
        url = req.url
        path_q = url.split(ORIGIN, 1)[1] if url.startswith(ORIGIN) else url
        body = None
        if req.post_data:
            try:
                body = json.loads(req.post_data)
            except Exception:
                body = req.post_data
        self.requests.append((req.method, path_q, body))
        for pattern, action in list(self.fail.items()):
            if re.search(pattern, path_q):
                if action == "abort":
                    return await route.abort("failed")
                if isinstance(action, tuple) and action[0] == "delay":
                    import asyncio
                    await asyncio.sleep(action[1])
                    break
                if isinstance(action, int):
                    return await route.fulfill(status=action, content_type="application/json", body=json.dumps({"message": f"fake {action}"}))
        if path_q.startswith("/__fake/chat_"):
            if path_q == "/__fake/chat_click":
                self.send_clicks += 1
            else:
                self.messages.append((int(body["item"]), body["text"]))
            return await route.fulfill(status=200, content_type="application/json", body="{}")
        m = re.match(r"^/inbox/[0-9a-f-]+\?referrer=%2Fitems%2F(\d+)", path_q)
        if m:
            if self.chat["open_delay"]:
                import asyncio
                await asyncio.sleep(self.chat["open_delay"])
            status, html = self.inbox_page(int(m.group(1)))
            return await route.fulfill(status=status, content_type="text/html", body=html)
        if self.chat["return_fail"] and self.messages and re.match(r"^/items/\d+", path_q):
            import asyncio
            await asyncio.sleep(40)
        if path_q == "/robots.txt":
            return await route.fulfill(status=200, body="User-agent: *")
        if path_q.startswith("/api/v2/"):
            status, data = self.api(req.method, path_q[len("/api/v2"):], body)
            return await route.fulfill(status=status, content_type="application/json", body=json.dumps(data))
        m = re.match(r"^/items/(\d+)", path_q)
        if m:
            status, html = self.item_page(int(m.group(1)))
            return await route.fulfill(status=status, content_type="text/html", body=html)
        if re.match(r"^/member/\d+", path_q):
            status, html = self.wardrobe_page()
            return await route.fulfill(status=status, content_type="text/html", body=html)
        if path_q in ("/", "") or path_q.startswith("/?"):
            return await route.fulfill(status=200, content_type="text/html", body=self._page("<h1>Home</h1>"))
        return await route.fulfill(status=404, content_type="text/html", body=self._page("404"))

    def forbidden_requests(self):
        return [r for r in self.requests if FORBIDDEN.search(r[1])]

    def api_writes(self):
        return [r for r in self.requests if r[0] in ("POST", "PUT", "DELETE", "PATCH") and r[1].startswith("/api/")]
