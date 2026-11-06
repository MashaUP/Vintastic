/**
 * Versioni e GitHub Releases — funzioni pure.
 * La risposta di GitHub è trattata come dato non attendibile: semver
 * obbligatorio, nomi degli allegati vincolati, note mostrate come testo.
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

const ZIP_NAME = /^vintastic-\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?\.zip$/i;
const SHA_NAME = /^vintastic-\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?\.zip\.sha256$/i;
const SAFE_URL = /^https:\/\/(github\.com|api\.github\.com|objects\.githubusercontent\.com|release-assets\.githubusercontent\.com)\//;

/** Riduce la risposta di /releases/latest a ciò che serve, validando tutto. */
export function parseRelease(json) {
  if (!json || typeof json !== "object") return { ok: false, error: "Risposta di GitHub non valida." };
  const v = parseVersion(json.tag_name);
  if (!v) return { ok: false, error: `Tag di versione non valido: ${String(json.tag_name).slice(0, 40)}` };
  const assets = Array.isArray(json.assets) ? json.assets : [];
  const zip = assets.find((a) => ZIP_NAME.test(a?.name || "") && SAFE_URL.test(a?.browser_download_url || ""));
  const sha = assets.find((a) => SHA_NAME.test(a?.name || "") && SAFE_URL.test(a?.browser_download_url || ""));
  return {
    ok: true,
    version: v.text,
    prerelease: Boolean(json.prerelease) || Boolean(v.pre),
    name: String(json.name || `Vintastic ${v.text}`).slice(0, 120),
    notes: String(json.body || "").slice(0, 8000),
    url: SAFE_URL.test(json.html_url || "") ? json.html_url : null,
    publishedAt: json.published_at ? Date.parse(json.published_at) : null,
    zip: zip ? { name: zip.name, url: zip.browser_download_url, size: Number(zip.size) || null } : null,
    sha: sha ? { name: sha.name, url: sha.browser_download_url } : null,
  };
}

/** Il file .sha256 generato dalla release: "<hash>  <nome>". */
export function parseShaFile(text, zipName) {
  for (const line of String(text).split(/\r?\n/)) {
    const m = line.trim().match(/^([a-f0-9]{64})\s+\*?(.+)$/i);
    if (m && (!zipName || m[2].trim() === zipName)) return m[1].toLowerCase();
  }
  return null;
}

export function githubError(status) {
  if (status === 404) return "Nessuna release pubblicata (o repository privato/inesistente).";
  if (status === 403 || status === 429) return "GitHub ha limitato le richieste da questa rete (rate limit): riprova più tardi.";
  if (!status) return "GitHub non è raggiungibile: controlla la connessione.";
  return `GitHub ha risposto con un errore (HTTP ${status}).`;
}
