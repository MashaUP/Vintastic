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
        return 200, self._page(f'<h1>{it["title"]}</h1>{btn}{buy}<script id="__item" type="application/json">{data}</script>', it["title"])

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
            if price < 1:
                return 422, {"errors": [{"field": "price", "value": "troppo basso"}]}
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
