/**
 * Redazione dei dati sensibili per log, Support Bundle ed esportazioni.
 * Rimuove cookie, token, password, chiavi API, webhook, email e numeri lunghi
 * che possono essere identificativi. Meglio togliere troppo che troppo poco.
 */

const SENSITIVE_KEYS = /(cookie|token|csrf|password|passwd|secret|authorization|auth|session|api[_-]?key|apikey|webhook|anon[_-]?id|access|refresh|bearer|email|phone|iban|card)/i;

const PATTERNS = [
  [/https:\/\/(?:ptb\.|canary\.)?discord(?:app)?\.com\/api\/webhooks\/[^\s"']+/gi, "[webhook rimosso]"],
  [/\b(?:Bearer|Token)\s+[A-Za-z0-9._~+/-]+=*/gi, "[token rimosso]"],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}/g, "[jwt rimosso]"],
  [/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, "[email rimossa]"],
  [/(access_token_web|_vinted_[a-z_]+|v_uid|anon_id|datadome)=[^;\s"']+/gi, "$1=[rimosso]"],
  [/\bsk-[A-Za-z0-9_-]{10,}/g, "[chiave rimossa]"],
];

export function redactString(s) {
  let out = String(s);
  for (const [re, rep] of PATTERNS) out = out.replace(re, rep);
  return out;
}

export function redact(value, depth = 0) {
  if (depth > 8) return "[…]";
  if (value == null) return value;
  if (typeof value === "string") return redactString(value);
  if (typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    if (SENSITIVE_KEYS.test(k) && !/^(accountId|sessionHealth|authState|auth_state)$/i.test(k)) {
      out[k] = v ? "[rimosso]" : v;
      continue;
    }
    out[k] = redact(v, depth + 1);
  }
  return out;
}
