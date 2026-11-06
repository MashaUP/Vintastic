"""Avvio di Chrome con Vintastic caricata e il Vinted finto."""
import asyncio, os, tempfile, json, time
from playwright.async_api import async_playwright
from fake_vinted import FakeVinted, ORIGIN, USER_ID

EXT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
CHROME = os.environ.get("CHROME_PATH", "/usr/bin/google-chrome")
os.environ.setdefault("PW_EXPERIMENTAL_SERVICE_WORKER_NETWORK_EVENTS", "1")


class Env:
    def __init__(self, pw, ctx, fake, profile):
        self.pw, self.ctx, self.fake, self.profile = pw, ctx, fake, profile
        self.errors = []
        self.ext = None
        self.ui = None

    async def sw(self):
        for w in self.ctx.service_workers:
            if w.url.startswith("chrome-extension://"):
                return w
        return await self.ctx.wait_for_event("serviceworker", timeout=20000)

    async def open_ui(self, route=""):
        if not self.ext:                       # l'id non cambia dopo un reload dell'estensione
            sw = await self.sw()
            self.ext = sw.url.split("/")[2]
        page = await self.ctx.new_page()
        page.on("pageerror", lambda e: self.errors.append(f"pageerror {page.url}: {e}"))
        for attempt in range(20):             # dopo un reload l'estensione può impiegare qualche secondo
            try:
                await page.goto(f"chrome-extension://{self.ext}/src/ui/dashboard.html#{route}")
                if await page.evaluate("Boolean(globalThis.chrome && chrome.runtime && chrome.runtime.id)"):
                    break
            except Exception:
                pass
            await asyncio.sleep(1)
        await page.wait_for_function("() => !document.getElementById('app')?.hasAttribute('aria-busy')", timeout=15000)
        self.ui = page
        return page

    async def rpc_raw(self, method, params=None):
        return await self.ui.evaluate("([m,pr]) => chrome.runtime.sendMessage({type:'vt:rpc', method:m, params:pr})", [method, params or {}])

    async def rpc(self, method, params=None, page=None):
        p = page or self.ui
        r = await p.evaluate("([m,pr]) => chrome.runtime.sendMessage({type:'vt:rpc', method:m, params:pr})", [method, params or {}])
        if isinstance(r, dict) and r.get("ok") is False and r.get("error"):
            raise RuntimeError(f"{method}: {r['error']}")
        return r

    async def wait_for(self, fn, timeout=60, interval=0.5, what="condizione"):
        end = time.time() + timeout
        last = None
        while time.time() < end:
            last = await fn()
            if last:
                return last
            await asyncio.sleep(interval)
        raise AssertionError(f"Timeout in attesa di: {what} (ultimo valore {last!r})")

    async def campaign(self, cid):
        return await self.rpc("campaigns.get", {"id": cid})

    async def login_vinted(self):
        """Apre Vinted come farebbe l'utente: la pagina fa le sue chiamate API e Vintastic rileva l'account."""
        page = await self.ctx.new_page()
        await page.goto(ORIGIN + "/")
        await self.wait_for(lambda: self._sess_ok(), 20, what="sessione rilevata")
        return page

    async def _sess_ok(self):
        s = await self.rpc("session.get")
        return s if s.get("loggedIn") and s.get("userId") == USER_ID else None

    async def fast_settings(self):
        await self.rpc("settings.save", {"patch": {"timers": {"betweenOps": {"min": 0, "max": 0}, "betweenItems": {"min": 0, "max": 0}, "minFloor": 1,
            "transitions": {"like>offer": {"min": 0, "max": 0}, "like>comment": {"min": 0, "max": 0}, "comment>offer": {"min": 0, "max": 0}}}, "onboardingDone": True}})


async def start(fake=None, profile=None):
    pw = await async_playwright().start()
    profile = profile or tempfile.mkdtemp(prefix="vt-e2e-")
    ctx = await pw.chromium.launch_persistent_context(profile, executable_path=CHROME, headless=True,
        args=[f"--disable-extensions-except={EXT}", f"--load-extension={EXT}", "--headless=new", "--no-sandbox", "--no-first-run"])
    fake = fake or FakeVinted()
    await ctx.add_cookies([{"name": "v_uid", "value": USER_ID, "domain": "www.vinted.it", "path": "/", "secure": True, "httpOnly": True}])
    await ctx.route("https://www.vinted.it/**", fake.handle)
    await ctx.route("https://images1.vinted.net/**", lambda r: r.fulfill(status=200, content_type="image/svg+xml", body='<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10" fill="#8f6ef2"/></svg>'))
    env = Env(pw, ctx, fake, profile)
    env.github = None
    # GitHub registrato all'avvio: le route aggiunte dopo non valgono per il service worker.
    async def gh(route):
        if env.github:
            return await env.github(route)
        return await route.fulfill(status=404, body="{}")
    for pattern in ("https://api.github.com/**", "https://github.com/**", "https://raw.githubusercontent.com/**"):
        await ctx.route(pattern, gh)
    return env


async def stop(env):
    try:
        try:
            await env.ctx.unroute_all(behavior="ignoreErrors")
        except Exception:
            pass
        await env.ctx.close()
    finally:
        await env.pw.stop()
