/**
 * Versioni e version.json — funzioni pure.
 * Il file letto da GitHub è trattato come dato non attendibile: semver
 * obbligatorio, nome dello zip vincolato, note mostrate come testo.
 */

const SEMVER = /^v?(\d{1,4})\.(\d{1,4})\.(\d{1,6})(?:-([0-9A-Za-z-]{1,20}(?:\.[0-9A-Za-z-]{1,20}){0,4}))?$/;

export const parseVersion = (v) => {
  const m = SEMVER.exec(String(v ?? "").trim());
  return m ? { major: +m[1], minor: +m[2], patch: +m[3], pre: m[4] || null, text: `${m[1]}.${m[2]}.${m[3]}${m[4] ? `-${m[4]}` : ""}` } : null;
};

/** -1, 0, 1 oppure null se una delle due non è semver. Prerelease < release. */
export function compareVersions(a, b) {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa || !pb) return null;
  for (const k of ["major", "minor", "patch"]) if (pa[k] !== pb[k]) return pa[k] > pb[k] ? 1 : -1;
  if (!pa.pre && !pb.pre) return 0;
  if (!pa.pre) return 1;
  if (!pb.pre) return -1;
  const xa = pa.pre.split(".");
  const xb = pb.pre.split(".");
  for (let i = 0; i < Math.max(xa.length, xb.length); i++) {
    if (xa[i] == null) return -1;
    if (xb[i] == null) return 1;
    const na = /^\d+$/.test(xa[i]);
    const nb = /^\d+$/.test(xb[i]);
    if (na && nb && +xa[i] !== +xb[i]) return +xa[i] > +xb[i] ? 1 : -1;
    if (na !== nb) return na ? -1 : 1;
    if (xa[i] !== xb[i]) return xa[i] > xb[i] ? 1 : -1;
  }
  return 0;
}

/** Nome dello zip installabile scritto da `npm run package` in version.json. */
const ZIP_NAME = /^Vintastic-\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?\.zip$/;

/**
 * Interpreta version.json (standard comuni, sezione 2), letto da raw.githubusercontent.com.
 * Il contenuto è un dato non attendibile: versione semver obbligatoria, nome dello zip vincolato,
 * SHA-256 di 64 caratteri esadecimali, al massimo 12 note da 300 caratteri mostrate come testo.
 */
export function parseVersionFile(json, installed) {
  if (!json || typeof json !== "object") return { ok: false, error: "version.json non valido." };
  const v = parseVersion(json.version);
  if (!v || v.text !== String(json.version).trim()) return { ok: false, error: "version.json non contiene una versione valida (x.y.z)." };
  const cmp = compareVersions(v.text, installed);
  const zip = ZIP_NAME.test(String(json.zip || "")) ? json.zip : null;
  const sha256 = /^[a-f0-9]{64}$/i.test(String(json.sha256 || "")) ? String(json.sha256).toLowerCase() : null;
  const notes = Array.isArray(json.notes) ? json.notes.map((n) => String(n).slice(0, 300)).slice(0, 12) : [];
  const date = typeof json.date === "string" && /^\d{4}-\d{2}-\d{2}/.test(json.date) ? json.date.slice(0, 10) : null;
  return { ok: true, latest: v.text, available: cmp === 1, zip, sha256, notes, date };
}

export function githubError(status) {
  if (status === 404) return "version.json non trovato: il controllo funziona quando il repository è pubblico e contiene i file di Vintastic.";
  if (status === 403 || status === 429) return "GitHub ha limitato le richieste da questa rete: riprova più tardi.";
  if (!status) return "GitHub non è raggiungibile: controlla la connessione.";
  return `GitHub ha risposto con un errore (HTTP ${status}).`;
}
