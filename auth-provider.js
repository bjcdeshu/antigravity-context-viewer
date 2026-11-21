'use strict';
// Main-process Language Server CSRF & Origin provider for Antigravity v2.34.0+ (`authBootstrap`).
// Tokens stay strictly in main-process / worker memory and are never written to disk or logs.

const { getCachedHostModule, findCachedHostModuleWithExport } = require('./host-adapter');

function normalizeOrigin(rawUrl) {
  try {
    const u = new URL(String(rawUrl || ''));
    if ((u.protocol === 'https:' || u.protocol === 'http:') && (u.hostname === '127.0.0.1' || u.hostname === 'localhost')) {
      return u.origin;
    }
  } catch {}
  return null;
}

function getActiveLsOrigin(opts = {}) {
  const mod = opts.authBootstrap
    ?? getCachedHostModule('authBootstrap', opts)
    ?? findCachedHostModuleWithExport('getActiveLsCsrfToken', opts.appPath);
  if (!mod) return null;
  try {
    const rawBase = typeof mod.getActiveLsBaseUrl === 'function'
      ? mod.getActiveLsBaseUrl()
      : (typeof mod.getActiveLsPort === 'function' && mod.getActiveLsPort() > 0
        ? `https://127.0.0.1:${mod.getActiveLsPort()}`
        : null);
    return normalizeOrigin(rawBase);
  } catch {
    return null;
  }
}

/**
 * Synchronously resolves the active Language Server CSRF token from host `authBootstrap`
 * (or any cached host module exporting `getActiveLsCsrfToken`), strictly verifying that
 * the active LS origin matches `expectedOrigin`.
 */
function getSyncLsAuth(expectedOrigin, opts = {}) {
  const normExpected = normalizeOrigin(expectedOrigin);
  if (!normExpected) return null;

  const mod = opts.authBootstrap
    ?? getCachedHostModule('authBootstrap', opts)
    ?? findCachedHostModuleWithExport('getActiveLsCsrfToken', opts.appPath);

  if (mod && typeof mod.getActiveLsCsrfToken === 'function') {
    try {
      const rawToken = mod.getActiveLsCsrfToken();
      if (typeof rawToken !== 'string') return null;
      const token = rawToken.trim();
      const rawBase = typeof mod.getActiveLsBaseUrl === 'function'
        ? mod.getActiveLsBaseUrl()
        : (typeof mod.getActiveLsPort === 'function' && mod.getActiveLsPort() > 0
          ? `https://127.0.0.1:${mod.getActiveLsPort()}`
          : null);
      const lsOrigin = normalizeOrigin(rawBase);
      if (token && lsOrigin === normExpected) {
        return { csrfToken: token, origin: lsOrigin, source: 'authBootstrap' };
      }
    } catch {}
  }
  return null;
}

/**
 * Resolves LS CSRF auth for `expectedOrigin`, trying synchronous `authBootstrap` first,
 * then renderer `window.__APP_CONFIG__?.csrfToken` (legacy <= v2.33 fallback).
 */
async function resolveLsAuth(expectedOrigin, senderWc = null, opts = {}) {
  const syncHit = getSyncLsAuth(expectedOrigin, opts);
  if (syncHit) return syncHit;

  if (senderWc && !senderWc.isDestroyed?.() && typeof senderWc.executeJavaScript === 'function') {
    try {
      const senderOrigin = normalizeOrigin(senderWc.getURL?.());
      if (senderOrigin && senderOrigin === normalizeOrigin(expectedOrigin)) {
        const pageToken = await senderWc.executeJavaScript('window.__APP_CONFIG__?.csrfToken || ""');
        if (typeof pageToken === 'string' && pageToken.trim()) {
          return { csrfToken: pageToken.trim(), origin: senderOrigin, source: 'renderer-app-config' };
        }
      }
    } catch {}
  }
  return null;
}

module.exports = {
  normalizeOrigin,
  getActiveLsOrigin,
  getSyncLsAuth,
  resolveLsAuth
};
