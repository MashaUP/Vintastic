"""Test DOM isolati del flusso messaggi di Vintastic, con una pagina Vinted finta.

Richiede il modulo Python Playwright e Chromium. Non contatta Vinted e non invia messaggi reali.
Esecuzione: python3 tests/e2e/message_dom_smoke.py
"""
from __future__ import annotations

import asyncio
import os
from pathlib import Path

from playwright.async_api import async_playwright

ROOT = Path(__file__).resolve().parents[2]
ADAPTER = ROOT / "src" / "content" / "adapter.js"

LISTING_HTML = """<!doctype html><html lang="it"><head><title>Annuncio test</title></head><body>
<button id="ask-info"><span class="web_ui__Button__content"><span class="web_ui__Button__label">Chiedi info</span></span></button>
<div id="history"></div>
<script>
window.fixture = { sendMode: 'success', opensChat: true, enableButton: true, stayOnChat: false, initialBubble: false };
window.addEventListener('popstate', () => {});
document.querySelector('#ask-info').addEventListener('click', () => {
  if (!window.fixture.opensChat) return;
  window.__mockLocation.pathname = '/inbox/conversation-1';
  document.body.innerHTML = `
    <div class="web_ui__InputBar">
      <div class="web_ui__InputBar__input"><textarea id="composerInput" name="composerInput" placeholder="Scrivi un messaggio qui" data-testid="composer--input" class="web_ui__InputBar__value" autocomplete="off"></textarea></div>
      <div class="web_ui__InputBar__suffix"><button type="button" disabled><span data-testid="arrow-right">→</span></button></div>
    </div>
    <div id="thread"></div>`;
  const input = document.querySelector('#composerInput');
  const send = document.querySelector('.web_ui__InputBar__suffix button');
  if (window.fixture.initialBubble) {
    const old = document.createElement('div'); old.className = 'web_ui__Message__bubble'; old.textContent = 'Ciao! Testo uguale';
    document.querySelector('#thread').append(old);
  }
  input.addEventListener('input', () => { send.disabled = !window.fixture.enableButton || !input.value.trim(); });
  send.addEventListener('click', () => {
    if (window.fixture.sendMode === 'no-bubble') return;
    if (window.fixture.sendMode === 'clear-only') { input.value = ''; input.dispatchEvent(new Event('input', { bubbles: true })); return; }
    const bubble = document.createElement('div'); bubble.className = 'web_ui__Message__bubble'; bubble.textContent = input.value;
    document.querySelector('#thread').append(bubble);
    if (window.fixture.sendMode !== 'keep-text') input.value = '';
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
});
</script></body></html>"""



async def setup_page(browser, fixture: dict | None = None):
    context = await browser.new_context()
    page = await context.new_page()
    await page.set_content(LISTING_HTML)
    await page.evaluate("""() => {
      window.__mockLocation = { origin: 'https://www.vinted.it', pathname: '/items/123456-annuncio-test', href: 'https://www.vinted.it/items/123456-annuncio-test' };
      window.__mockHistory = { back() {
        if (window.fixture.stayOnChat) return;
        window.__mockLocation.pathname = '/items/123456-annuncio-test';
        const marker = document.createElement('span'); marker.hidden = true; marker.textContent = 'back'; document.body.append(marker);
      } };
    }""")
    if fixture:
        await page.evaluate("(value) => Object.assign(window.fixture, value)", fixture)
    source = ADAPTER.read_text(encoding="utf-8")
    wrapped = "(function(location, history) {\n" + source + "\n})(window.__mockLocation, window.__mockHistory);"
    await page.add_script_tag(content=wrapped)
    # Accelera i timeout lunghi del prodotto in modo controllato; le attese DOM
    # diventano brevi nei test negativi, senza modificare il codice dell'estensione.
    await page.evaluate("""() => {
      const native = window.setTimeout.bind(window);
      window.setTimeout = (fn, ms, ...args) => native(fn, Math.min(Number(ms) || 0, 90), ...args);
    }""")
    return context, page


async def start_message(page, mode: str, text: str):
    await page.evaluate("""({mode, text}) => {
      window.__messagePromise = window.VT.message({ listing: { id: '123456' }, op: { mode, text } });
    }""", {"mode": mode, "text": text})


async def read_result(page):
    return await page.evaluate("() => window.__messagePromise")


async def main():
    if not ADAPTER.exists():
        raise RuntimeError(f"Adapter non trovato: {ADAPTER}")
    results = []

    async with async_playwright() as p:
        executable = os.environ.get("CHROME_PATH", "/usr/bin/chromium")
        browser = await p.chromium.launch(executable_path=executable, headless=True, args=["--no-sandbox", "--disable-dev-shm-usage"])
        try:
            # A automatica: Chiedi info → compilazione → click → nuovo bubble → back.
            ctx, page = await setup_page(browser)
            await start_message(page, "auto", "Ciao! Testo uguale")
            result = await read_result(page)
            assert result["outcome"] == "done" and result["sent"] is True, result
            assert await page.evaluate("window.__mockLocation.pathname") == "/items/123456-annuncio-test"
            results.append(("A automatica: invio verificato e ritorno annuncio", "PASS"))
            await ctx.close()

            # B manuale: il codice compila ma non clicca; il click umano completa il flusso.
            ctx, page = await setup_page(browser, {"initialBubble": True})
            await start_message(page, "manual", "Ciao! Testo uguale")
            await page.wait_for_function("() => document.querySelector('#composerInput')?.value === 'Ciao! Testo uguale'")
            assert await page.locator("#thread .web_ui__Message__bubble").count() == 1, "il messaggio precedente deve restare l'unico bubble prima del click"
            await page.locator(".web_ui__InputBar__suffix button").click()
            result = await read_result(page)
            assert result["outcome"] == "done" and result["sent"] is True, result
            assert await page.evaluate("window.__mockLocation.pathname") == "/items/123456-annuncio-test"
            results.append(("B manuale: compila senza inviare, poi rileva click umano", "PASS"))
            await ctx.close()

            # B senza click: deve scadere come non inviato e non deve inventare un successo.
            ctx, page = await setup_page(browser)
            await start_message(page, "manual", "Non inviare")
            result = await read_result(page)
            assert result["outcome"] == "failed" and result["sent"] is False, result
            results.append(("B manuale: nessun click, nessun invio dichiarato", "PASS"))
            await ctx.close()

            # A senza conferma DOM: dopo un click il risultato deve essere verify, mai retry.
            ctx, page = await setup_page(browser, {"sendMode": "no-bubble"})
            await start_message(page, "auto", "Esito incerto")
            result = await read_result(page)
            assert result["outcome"] == "uncertain" and result["sent"] is True, result
            results.append(("A senza bubble: esito incerto, nessun retry automatico", "PASS"))
            await ctx.close()

            # B con click ma senza bubble: stessa protezione No Repeat.
            ctx, page = await setup_page(browser, {"sendMode": "no-bubble"})
            await start_message(page, "manual", "Invio manuale incerto")
            await page.wait_for_function("() => document.querySelector('#composerInput')?.value === 'Invio manuale incerto'")
            await page.locator(".web_ui__InputBar__suffix button").click()
            result = await read_result(page)
            assert result["outcome"] == "uncertain" and result["sent"] is True, result
            results.append(("B con click ma senza bubble: esito incerto, nessun retry", "PASS"))
            await ctx.close()

            # Chiedi info mancante: deve fallire prima di compilare/inviare.
            ctx, page = await setup_page(browser)
            await page.evaluate("document.querySelector('#ask-info').remove()")
            result = await page.evaluate("() => window.VT.message({ listing: { id: '123456' }, op: { mode: 'auto', text: 'test' } })")
            assert result["outcome"] == "changed" and result["sent"] is False, result
            results.append(("Pulsante Chiedi info assente: stop sicuro", "PASS"))
            await ctx.close()


            # Il testo uguale già presente nella chat non può essere scambiato per il nuovo invio.
            ctx, page = await setup_page(browser, {"initialBubble": True, "sendMode": "clear-only"})
            await start_message(page, "auto", "Ciao! Testo uguale")
            result = await read_result(page)
            assert result["outcome"] == "uncertain" and result["sent"] is True, result
            results.append(("Bubble precedente identico: non viene confuso con un nuovo invio", "PASS"))
            await ctx.close()

            # Un click confermato ma ritorno alla pagina non riuscito resta da verificare.
            ctx, page = await setup_page(browser, {"stayOnChat": True})
            await start_message(page, "auto", "Messaggio inviato")
            result = await read_result(page)
            assert result["outcome"] == "uncertain" and result["sent"] is True, result
            assert await page.evaluate("window.__mockLocation.pathname") == "/inbox/conversation-1"
            results.append(("Invio verificato ma ritorno non riuscito: esito da verificare", "PASS"))
            await ctx.close()

            # Pulsante che non si abilita: nessun click e nessun tentativo di invio.
            ctx, page = await setup_page(browser, {"enableButton": False})
            await start_message(page, "auto", "Pulsante disabilitato")
            result = await read_result(page)
            assert result["outcome"] == "failed" and result["sent"] is False, result
            results.append(("Pulsante invio disabilitato: stop senza invio", "PASS"))
            await ctx.close()

            # CAPTCHA prima di aprire la chat: stop preventivo.
            ctx, page = await setup_page(browser)
            await page.evaluate("""() => { const f = document.createElement('iframe'); f.src = 'https://geo.captcha-delivery.com/captcha/?test=1'; document.body.append(f); }""")
            result = await page.evaluate("() => window.VT.message({ listing: { id: '123456' }, op: { mode: 'auto', text: 'test' } })")
            assert result["outcome"] == "captcha" and result["sent"] is False, result
            results.append(("CAPTCHA prima dell'apertura chat: stop preventivo", "PASS"))
            await ctx.close()

            # Chat che non si apre: non deve tentare il composer.
            ctx, page = await setup_page(browser, {"opensChat": False})
            result = await page.evaluate("() => window.VT.message({ listing: { id: '123456' }, op: { mode: 'auto', text: 'test' } })")
            assert result["outcome"] == "failed" and result["sent"] is False, result
            results.append(("Chat non aperta: stop senza invio", "PASS"))
            await ctx.close()
        finally:
            await browser.close()

    for name, status in results:
        print(f"{status} — {name}")
    print(f"\n{len(results)}/{len(results)} test DOM messaggi superati")


if __name__ == "__main__":
    asyncio.run(main())
