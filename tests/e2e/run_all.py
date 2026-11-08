"""
Esegue gli scenari end-to-end in Chrome con il Vinted finto.
Uso: python3 tests/e2e/run_all.py [nome_scenario ...]
Rapporto: tests/e2e/artifacts/report.json
"""
import asyncio, json, os, sys, time, traceback
sys.path.insert(0, os.path.dirname(__file__))
import harness
import scenarios as S
import messages as M
import cycles as Y

ORDER = [
    ("installazione e interfaccia", S.t_install_and_ui),
    ("guida iniziale (wizard)", S.t_onboarding_wizard),
    ("scansione, filtri, Top N", S.t_scan_filters),
    ("account, cambio account, autenticazione assistita", S.t_account_switch),
    ("campagna reale like+offerta, No Repeat", S.t_campaign_real),
    ("simulazione poi modalità reale", S.t_sim_then_live),
    ("coda dinamica, pausa/ripresa, dashboard chiusa", S.t_dynamic_queue),
    ("429 e CAPTCHA", S.t_block_429_captcha),
    ("esito incerto e risoluzione", S.t_uncertain_and_resolve),
    ("recupero dopo crash", S.t_crash_recovery),
    ("snapshot prezzo e soglie", S.t_price_snapshot_and_limits),
    ("auto-pause rete", S.t_offline_autopause),
    ("pulitore notifiche e suggerimenti", S.t_cleaner_suggestions),
    ("backup e importazione", None),
    ("aggiornamenti GitHub", S.t_updates),
    ("FAB e mini-widget", S.t_overlay),
    ("prestazioni 5000 annunci", S.t_performance),
    ("Health Center, kill switch, circuit breaker", S.t_health_kill),
    ("Discord webhook", S.t_discord),
    ("like senza API di lettura", S.t_like_without_item_api),
    ("offerte rifiutate, regole +5%, eliminazioni", S.t_offer_rules_and_cleanup),
    ("risoluzione in blocco", S.t_resolve_all),
    ("messaggi A: simulazione, invio, ritorno, No Repeat, privacy", M.t_msg_auto),
    ("messaggi B: compilazione e invio dell'utente", M.t_msg_manual),
    ("messaggi B: timeout e campo svuotato", M.t_msg_manual_timeout),
    ("messaggi: destinatari e casi di errore", M.t_msg_failures),
    ("messaggi: ritorno, invio lento, CAPTCHA", M.t_msg_captcha_return),
    ("messaggi: crash del worker e ripresa", M.t_msg_crash),
    ("messaggi: chat rotta non blocca like e offerte", M.t_msg_isolation),
    ("messaggi: chat in una scheda nuova", M.t_msg_newtab),
    ("cicli: riprocessare annunci completati", Y.t_cycles),
    ("interfaccia 2.0: Posizione, commenti, notifiche", Y.t_ui_v2),
]


async def run_one(name, fn):
    t0 = time.time()
    env = await harness.start()
    try:
        if fn is None:          # backup → import in un profilo nuovo
            exp = await S.t_backup_import(env)
            await harness.stop(env)
            env = await harness.start()
            detail = await S.t_import_into_fresh(env, exp)
        else:
            detail = await fn(env)
        forbidden = env.fake.forbidden_requests()
        if forbidden:
            raise AssertionError(f"Richieste d'acquisto verso Vinted: {forbidden}")
        if env.errors:
            raise AssertionError(f"Errori JavaScript nelle pagine: {env.errors[:3]}")
        return {"name": name, "ok": True, "seconds": round(time.time() - t0, 1), "detail": detail, "requests": len(env.fake.requests)}
    except Exception as e:
        return {"name": name, "ok": False, "seconds": round(time.time() - t0, 1), "error": f"{type(e).__name__}: {e}", "trace": traceback.format_exc()[-2500:]}
    finally:
        try:
            await harness.stop(env)
        except Exception:
            pass          # già chiuso dallo scenario (riavvio del browser)


async def main():
    want = [a.lower() for a in sys.argv[1:]]
    results = []
    for name, fn in ORDER:
        if want and not any(w in name.lower() for w in want):
            continue
        r = await run_one(name, fn)
        results.append(r)
        mark = "✔" if r["ok"] else "✖"
        print(f"{mark} {name} ({r['seconds']} s) — {r.get('detail') or r.get('error')}", flush=True)
        if not r["ok"]:
            print(r["trace"], flush=True)
    os.makedirs(os.path.join(os.path.dirname(__file__), "artifacts"), exist_ok=True)
    with open(os.path.join(os.path.dirname(__file__), "artifacts", "report.json"), "w") as f:
        json.dump(results, f, indent=2, ensure_ascii=False)
    ok = sum(r["ok"] for r in results)
    print(f"\n{ok}/{len(results)} scenari superati")
    sys.exit(0 if ok == len(results) else 1)


if __name__ == "__main__":
    asyncio.run(main())
