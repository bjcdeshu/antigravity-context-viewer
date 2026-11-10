'use strict';
const fs = require('fs');
const path = require('path');
const { ipcMain, app } = require('electron');
const { collect, collectTokenHistory } = require('./meter-collector');

function ensureProxyEnvironment(targetEnv = process.env) {
  try {
    const os = require('os');
    const localBase = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
    const cfgPath = path.join(localBase, 'AntigravityContextMeter', 'proxy.json');
    if (!fs.existsSync(cfgPath)) return;
    const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    if (!cfg || !cfg.httpProxy) return;
    const noProxy = cfg.noProxy || 'localhost,127.0.0.1,::1,127.0.0.0/8,10.0.0.0/8,192.168.0.0/16,172.16.0.0/12,<-loopback>';
    for (const k of ['HTTP_PROXY', 'http_proxy', 'HTTPS_PROXY', 'https_proxy']) {
      if (!targetEnv[k]) targetEnv[k] = cfg.httpProxy;
    }
    if (cfg.allProxy) {
      for (const k of ['ALL_PROXY', 'all_proxy']) {
        if (!targetEnv[k]) targetEnv[k] = cfg.allProxy;
      }
    }
    for (const k of ['NO_PROXY', 'no_proxy']) {
      if (!targetEnv[k]) targetEnv[k] = noProxy;
    }
  } catch {}
}
ensureProxyEnvironment(process.env);
exports.ensureProxyEnvironment = ensureProxyEnvironment;

function getMeterSource() {
  try {
    const coreCode = fs.readFileSync(path.join(__dirname, 'meter-core.js'), 'utf8');
    const rendererCode = fs.readFileSync(path.join(__dirname, 'meter-renderer.js'), 'utf8');
    return `${coreCode}\n${rendererCode}\ntrue;`;
  } catch (e) {
    return '';
  }
}

function isLocalMainFrameSender(event) {
  try {
    const rawUrl = event?.senderFrame?.url || event?.sender?.getURL?.() || '';
    const url = new URL(rawUrl);
    if (url.protocol !== 'https:' || url.hostname !== '127.0.0.1') return null;
    if (event.senderFrame && event.sender?.mainFrame && event.senderFrame !== event.sender.mainFrame) return null;
    return url;
  } catch {
    return null;
  }
}

function resolveTargetWindow(sender) {
  try {
    const { BrowserWindow } = require('electron');
    const direct = BrowserWindow.fromWebContents(sender);
    if (direct && !direct.isDestroyed?.()) return direct;
  } catch {}
  try {
    const utils = require('./utils');
    if (typeof utils.resolveHubWindowFromWebContents === 'function') {
      const hubWin = utils.resolveHubWindowFromWebContents(sender);
      if (hubWin && !hubWin.isDestroyed?.()) return hubWin;
    }
  } catch {}
  return null;
}

let registered = false;
const boundWindows = new WeakSet();
const boundWebContents = new WeakSet();
const injectionTimers = new WeakMap();

function registerIpcOnce() {
  if (registered) return;
  registered = true;

  ipcMain.handle('context-meter:scan', async (event, id, force) => {
    const url = isLocalMainFrameSender(event);
    if (!url) throw new Error('仅允许本机主聊天窗口');
    try { return { ok: true, data: await collect(url.origin, id, { force: force === true }) }; }
    catch (e) { return { ok: false, error: e.message }; }
  });

  ipcMain.handle('context-meter:token-history', async (event, force) => {
    const url = isLocalMainFrameSender(event);
    if (!url) throw new Error('仅允许本机主聊天窗口');
    try { return { ok: true, data: collectTokenHistory({ force: force === true }) }; }
    catch (e) { return { ok: false, error: e.message }; }
  });

  ipcMain.handle('context-meter:sync-overlay', async (event, options) => {
    try {
      const targetWin = resolveTargetWindow(event.sender);
      if (!targetWin || targetWin.isDestroyed?.()) return { ok: false };
      if (process.platform === 'win32') {
        try {
          if (typeof targetWin.setMenuBarVisibility === 'function') targetWin.setMenuBarVisibility(false);
          targetWin.autoHideMenuBar = true;
        } catch {}
      }
      if (typeof targetWin.setTitleBarOverlay !== 'function') return { ok: true };
      const patch = {};
      if (options && typeof options.color === 'string') patch.color = options.color;
      if (options && typeof options.symbolColor === 'string') patch.symbolColor = options.symbolColor;
      const rawHeight = options && Number.isFinite(Number(options.height))
        ? Number(options.height)
        : (options && Number.isFinite(Number(options.heightCssPx)) ? Number(options.heightCssPx) : null);
      if (rawHeight !== null && rawHeight >= 24 && rawHeight <= 64) {
        const zf = typeof event.sender?.getZoomFactor === 'function' ? event.sender.getZoomFactor() : 1;
        const scaled = options && Number.isFinite(Number(options.heightCssPx))
          ? Math.round(rawHeight * (Number.isFinite(zf) && zf > 0 ? zf : 1))
          : Math.round(rawHeight);
        patch.height = Math.max(24, Math.min(64, scaled));
      }
      if (Object.keys(patch).length > 0) {
        targetWin.setTitleBarOverlay(patch);
      }
      return { ok: true, patch };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });
}

async function ensureMeterInjected(win, options = {}) {
  try {
    if (!win || win.isDestroyed?.()) return false;
    const wc = win.webContents;
    if (!wc || wc.isDestroyed?.()) return false;
    const url = wc.getURL?.() || '';
    if (!/^https:\/\/127\.0\.0\.1:\d+\//.test(url)) {
      const attempt = Number(options.attempt || 0);
      const delays = [300, 600, 1000, 1500, 2500];
      if (attempt < delays.length && win && !win.isDestroyed?.()) {
        const prevTimer = injectionTimers.get(win);
        if (prevTimer) clearTimeout(prevTimer);
        const t = setTimeout(() => {
          injectionTimers.delete(win);
          void ensureMeterInjected(win, { ...options, attempt: attempt + 1 });
        }, delays[attempt]);
        injectionTimers.set(win, t);
      }
      return false;
    }

    if (!options.force) {
      try {
        const alive = await wc.executeJavaScript(
          'Boolean(window.__AGContextMeter && document.getElementById("ag-context-meter") && (window.__AGContextMeter.ensureAlive ? window.__AGContextMeter.ensureAlive() : true))'
        );
        if (alive === true) return true;
      } catch {}
    }

    const runtimeSource = getMeterSource();
    if (!runtimeSource) return false;
    await wc.executeJavaScript(runtimeSource);
    return true;
  } catch (error) {
    const attempt = Number(options.attempt || 0);
    const delays = [350, 1000, 2500];
    if (attempt < delays.length && win && !win.isDestroyed?.()) {
      const prevTimer = injectionTimers.get(win);
      if (prevTimer) clearTimeout(prevTimer);
      const t = setTimeout(() => {
        injectionTimers.delete(win);
        void ensureMeterInjected(win, { ...options, attempt: attempt + 1 });
      }, delays[attempt]);
      injectionTimers.set(win, t);
    } else {
      console.warn('[Context Meter]', error?.message || String(error));
    }
    return false;
  }
}

exports.ensureMeterInjected = ensureMeterInjected;

exports.installContextMeter = function (win) {
  registerIpcOnce();
  if (!win || win.isDestroyed?.()) return;

  if (!boundWindows.has(win)) {
    boundWindows.add(win);
    if (process.platform === 'win32') {
      try {
        if (typeof win.setMenuBarVisibility === 'function') win.setMenuBarVisibility(false);
        win.autoHideMenuBar = true;
      } catch {}
    }
    const onWinVisibleOrActive = () => {
      if (process.platform === 'win32') {
        try {
          if (typeof win.setMenuBarVisibility === 'function') win.setMenuBarVisibility(false);
          win.autoHideMenuBar = true;
        } catch {}
      }
      void ensureMeterInjected(win, { force: false });
    };
    win.on?.('show', onWinVisibleOrActive);
    win.on?.('restore', onWinVisibleOrActive);
    win.on?.('focus', onWinVisibleOrActive);
  }

  const wc = win.webContents;
  if (wc && !boundWebContents.has(wc)) {
    boundWebContents.add(wc);
    wc.on('did-finish-load', () => {
      void ensureMeterInjected(win, { force: true });
    });
    wc.on('dom-ready', () => {
      void ensureMeterInjected(win, { force: false });
    });
    wc.on('did-navigate', () => {
      void ensureMeterInjected(win, { force: false });
    });
    wc.on('did-navigate-in-page', () => {
      void ensureMeterInjected(win, { force: false });
    });
    wc.on('zoom-changed', () => {
      try {
        void wc.executeJavaScript('window.__AGContextMeter?.ensureAlive?.()');
      } catch {}
    });
  }
};

try {
  if (app && typeof app.on === 'function') {
    app.on('browser-window-created', (_event, win) => {
      try {
        exports.installContextMeter(win);
        void ensureMeterInjected(win, { force: false });
      } catch {}
    });
    app.on('activate', () => {
      try {
        const utils = require('./utils');
        const wins = typeof utils.getHubWindows === 'function' ? utils.getHubWindows() : [];
        for (const w of wins) {
          exports.installContextMeter(w);
          void ensureMeterInjected(w, { force: true });
        }
      } catch {}
    });
    app.on('second-instance', () => {
      try {
        const utils = require('./utils');
        setTimeout(() => {
          try {
            const wins = typeof utils.getHubWindows === 'function' ? utils.getHubWindows() : [];
            for (const w of wins) {
              exports.installContextMeter(w);
              void ensureMeterInjected(w, { force: true });
            }
          } catch {}
        }, 120);
      } catch {}
    });
  }
} catch {}
