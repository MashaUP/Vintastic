/**
 * Canale in tempo reale verso dashboard, popup, side panel e overlay sulle pagine
 * Vinted (chrome.runtime.Port). Le porte aperte tengono anche sveglio il worker.
 */

const ports = new Set();

export function attachPort(port) {
  ports.add(port);
  port.onDisconnect.addListener(() => ports.delete(port));
}

export function broadcast(type, payload = {}) {
  for (const p of ports) {
    try { p.postMessage({ type, ...payload }); } catch { ports.delete(p); }
  }
}

export const portCount = () => ports.size;
