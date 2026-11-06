/** Accesso ES module al guard (il codice vero è in guard-core.js, condiviso col content script). */
import "./guard-core.js";

const G = globalThis.VTGuard;
export const {
  FORBIDDEN_PATH, FORBIDDEN_TEXT, ALLOWED, PurchaseGuardError,
  isForbiddenPath, assertRequestAllowed, isForbiddenElement, safeClick,
} = G;
export default G;
