/**
 * Web Worker per i dati grandi: parsing dei backup JSON, CSV di migliaia di
 * righe, filtri pesanti. Gira fuori dal thread principale: l'interfaccia resta reattiva.
 */
self.onmessage = (e) => {
  const m = e.data || {};
  try {
    if (m.type === "parse") {
      const t0 = performance.now();
      const json = JSON.parse(m.text);
      self.postMessage({ ok: true, json, ms: Math.round(performance.now() - t0), size: m.text.length });
    } else if (m.type === "csv") {
      const esc = (v) => {
        if (v == null) return "";
        const s = String(v);
        return /[";\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
      };
      const lines = [m.columns.join(";")];
      for (const r of m.rows) lines.push(m.columns.map((c) => esc(/At$/.test(c) && r[c] ? new Date(r[c]).toISOString() : r[c])).join(";"));
      self.postMessage({ ok: true, text: lines.join("\n") });
    }
  } catch (err) {
    self.postMessage({ ok: false, error: err.message });
  }
};
