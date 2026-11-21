'use strict';
// Safe read-only adapter for optional Antigravity host modules inside app.asar/dist/.
// Never forces eager loading of uninitialized host modules unless safe, and always degrades cleanly.

const path = require('path');

function resolveHostDistModulePath(relName, customAppPath) {
  let appPath = customAppPath || null;
  if (!appPath) {
    try {
      const { app } = require('electron');
      if (app && typeof app.getAppPath === 'function') {
        appPath = app.getAppPath();
      }
    } catch {}
  }
  if (!appPath) return null;
  const cleanRel = String(relName || '').replace(/^[\\/]+/, '');
  const target = path.join(appPath, 'dist', cleanRel);
  try {
    return require.resolve(target);
  } catch {
    return null;
  }
}

function getCachedHostModule(relName, options = {}) {
  const resolved = resolveHostDistModulePath(relName, options.appPath);
  if (!resolved) return null;
  let cached = require.cache && require.cache[resolved];
  if (!cached && process.platform === 'win32' && require.cache) {
    const targetLower = resolved.toLowerCase();
    for (const [k, v] of Object.entries(require.cache)) {
      if (k.toLowerCase() === targetLower) {
        cached = v;
        break;
      }
    }
  }
  if (cached && cached.loaded && cached.exports) {
    return cached.exports;
  }
  if (options.allowRequire === true) {
    try {
      return require(resolved);
    } catch {
      return null;
    }
  }
  return null;
}

function findCachedHostModuleWithExport(exportName, customAppPath) {
  if (!exportName || !require.cache) return null;
  let appPath = customAppPath || '';
  if (!appPath) {
    try {
      const { app } = require('electron');
      appPath = app?.getAppPath?.() || '';
    } catch {}
  }
  const normPrefix = appPath ? path.resolve(appPath).toLowerCase() : '';
  for (const [modId, mod] of Object.entries(require.cache)) {
    if (!mod || !mod.loaded || !mod.exports) continue;
    if (normPrefix && !path.resolve(modId).toLowerCase().startsWith(normPrefix)) continue;
    try {
      if (typeof mod.exports[exportName] === 'function') {
        return mod.exports;
      }
    } catch {}
  }
  return null;
}

function isRemoteWebContents(wc, opts = {}) {
  if (!wc || wc.isDestroyed?.()) return false;
  try {
    const wb = opts.windowBackends ?? getCachedHostModule('remote/windowBackends', opts);
    if (wb && typeof wb.remoteBackendOf === 'function' && wb.remoteBackendOf(wc)) {
      return true;
    }
  } catch {}
  try {
    const rws = getCachedHostModule('remote/remoteWindowSecurity', opts);
    if (rws && typeof rws.isRemoteContents === 'function' && rws.isRemoteContents(wc)) {
      return true;
    }
  } catch {}
  return false;
}

function isHostAuxOrRemoteWindow(win, opts = {}) {
  if (!win || win.isDestroyed?.()) return true;
  if (win.__isWebviewPopupWindow) return true;
  try {
    const hw = opts.hubWindows ?? getCachedHostModule('hubWindows', opts);
    if (hw && typeof hw.isAuxWindow === 'function' && hw.isAuxWindow(win)) {
      return true;
    }
  } catch {}
  try {
    const wb = opts.windowBackends ?? getCachedHostModule('remote/windowBackends', opts);
    if (wb && typeof wb.isLocalAppWindow === 'function' && !wb.isLocalAppWindow(win)) {
      return true;
    }
  } catch {}
  return false;
}

function resolveOwningWindowForWebContents(wc, opts = {}) {
  if (!wc || wc.isDestroyed?.()) return null;
  try {
    const { BrowserWindow, BaseWindow } = opts.electron ?? require('electron');
    if (typeof BrowserWindow?.fromWebContents === 'function') {
      const bw = BrowserWindow.fromWebContents(wc);
      if (bw && !bw.isDestroyed?.()) return bw;
    }
    const utils = opts.utils ?? getCachedHostModule('utils', opts);
    if (utils && typeof utils.resolveHubWindowFromWebContents === 'function') {
      const hw = utils.resolveHubWindowFromWebContents(wc);
      if (hw && !hw.isDestroyed?.()) return hw;
    }
    if (typeof BaseWindow?.getAllWindows === 'function') {
      const walkView = view => {
        if (!view || typeof view !== 'object') return false;
        if (view.webContents === wc) return true;
        if (Array.isArray(view.children)) {
          for (const ch of view.children) {
            if (walkView(ch)) return true;
          }
        }
        return false;
      };
      for (const win of BaseWindow.getAllWindows()) {
        if (!win || win.isDestroyed?.()) continue;
        if (win.webContents === wc || walkView(win.contentView)) return win;
      }
    }
  } catch {}
  return null;
}

module.exports = {
  resolveHostDistModulePath,
  getCachedHostModule,
  findCachedHostModuleWithExport,
  isRemoteWebContents,
  isHostAuxOrRemoteWindow,
  resolveOwningWindowForWebContents
};
