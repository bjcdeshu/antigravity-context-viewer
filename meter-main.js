'use strict';
const fs = require('fs');
const path = require('path');

let ipcMain = null;
let app = null;
let electronSession = null;
let electronWebContents = null;
try {
  ({
    ipcMain,
    app,
    session: electronSession,
    webContents: electronWebContents
  } = require('electron'));
} catch {}

const {
  collectJsonAsync,
  collectTokenHistoryJsonAsync,
  pollGeneratorMetadataJsonAsync
} = require('./meter-collector');
const {
  isRemoteWebContents,
  isHostAuxOrRemoteWindow,
  resolveOwningWindowForWebContents,
  getCachedHostModule
} = require('./host-adapter');
const { resolveLsAuth, getActiveLsOrigin } = require('./auth-provider');

let activeStateDir = null;
let activeRuntimeRoot = __dirname;
let onHealthyCallback = null;
let preloadMode = 'none';
let lastAuthSource = 'none';

function getEffectiveStateDir() {
  if (activeStateDir) return activeStateDir;
  if (process.env.AG_METER_STATE_DIR) return process.env.AG_METER_STATE_DIR;
  const os = require('os');
  if (process.platform === 'win32') {
    return path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'AntigravityContextMeter');
  }
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'AntigravityContextMeter');
  }
  return path.join(process.env.XDG_STATE_HOME || path.join(os.homedir(), '.local', 'state'), 'AntigravityContextMeter');
}

let cachedProxyConfig = undefined;
function ensureProxyEnvironment(targetEnv = process.env) {
  try {
    if (cachedProxyConfig === undefined) {
      const cfgPath = path.join(getEffectiveStateDir(), 'proxy.json');
      cachedProxyConfig = fs.existsSync(cfgPath) ? JSON.parse(fs.readFileSync(cfgPath, 'utf8')) : null;
    }
    const cfg = cachedProxyConfig;
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

let cachedMeterSource = '';
let cachedMeterVersion = '3.2.0';
function getMeterSource(forceReload = false) {
  if (cachedMeterSource && !forceReload) return cachedMeterSource;
  try {
    const coreCode = fs.readFileSync(path.join(activeRuntimeRoot, 'meter-core.js'), 'utf8');
    const rendererCode = fs.readFileSync(path.join(activeRuntimeRoot, 'meter-renderer.js'), 'utf8');
    const vm = rendererCode.match(/(?:METER_VERSION\s*=\s*|version:\s*)['"]([^'"]+)['"]/);
    if (vm && vm[1]) cachedMeterVersion = vm[1];
    cachedMeterSource = `${coreCode}\n${rendererCode}\ntrue;`;
    return cachedMeterSource;
  } catch {
    return '';
  }
}

let lastRuntimeStampKey = '';
function recordRuntimeHeartbeat(origin, extra = {}) {
  try {
    if (!origin) return;
    if (extra.authSource) lastAuthSource = extra.authSource;
    const stateDir = getEffectiveStateDir();
    const key = `${process.pid}:${origin}:${cachedMeterVersion}:${preloadMode}:${lastAuthSource}`;
    if (key === lastRuntimeStampKey && !extra.force) return;
    lastRuntimeStampKey = key;
    fs.mkdirSync(stateDir, { recursive: true });
    const stampPath = path.join(stateDir, 'runtime-status.json');
    const tmpPath = `${stampPath}.tmp-${process.pid}`;
    fs.writeFileSync(tmpPath, JSON.stringify({
      meterVersion: cachedMeterVersion,
      hookVersion: 1,
      preloadMode,
      authSource: lastAuthSource,
      appVersion: typeof app?.getVersion === 'function' ? app.getVersion() : null,
      pid: process.pid,
      origin,
      updatedAt: new Date().toISOString()
    }));
    fs.renameSync(tmpPath, stampPath);
  } catch {}
}

function isAuxiliaryInternalUrl(rawUrl) {
  const s = String(rawUrl || '');
  if (!s) return false;
  return (
    s.startsWith('data:') ||
    s.startsWith('plugin:') ||
    s.startsWith('devtools:') ||
    s.startsWith('agy-browser-stream:') ||
    s.startsWith('chrome-extension:')
  );
}

function isLocalHubOriginUrl(rawUrl) {
  return /^https:\/\/127\.0\.0\.1:\d+\//.test(String(rawUrl || ''));
}

function isLocalWebContentsTarget(wc, opts = {}) {
  if (!wc || wc.isDestroyed?.()) return false;
  try {
    if (typeof wc.getType === 'function' && wc.getType() === 'webview') {
      return false;
    }
  } catch {}
  if (isRemoteWebContents(wc, opts)) return false;
  try {
    const defaultSes = opts.defaultSession !== undefined ? opts.defaultSession : electronSession?.defaultSession;
    if (defaultSes && wc.session && wc.session !== defaultSes) {
      return false;
    }
  } catch {}
  return true;
}

function isLocalWindowTarget(win, opts = {}) {
  if (!win || win.isDestroyed?.()) return false;
  if (isHostAuxOrRemoteWindow(win, opts)) return false;
  try {
    const directWc = win.webContents;
    if (directWc && !isLocalWebContentsTarget(directWc, opts)) {
      return false;
    }
  } catch {}
  return true;
}

exports.isLocalWebContentsTarget = isLocalWebContentsTarget;
exports.isLocalWindowTarget = isLocalWindowTarget;

function isLocalMainFrameSender(event, opts = {}) {
  try {
    if (event?.sender && !isLocalWebContentsTarget(event.sender, opts)) return null;
    if (event?.sender) {
      const owningWin = resolveOwningWindowForWebContents(event.sender, opts);
      if (owningWin && isHostAuxOrRemoteWindow(owningWin, opts)) return null;
    }
    const rawUrl = event?.senderFrame?.url || event?.sender?.getURL?.() || '';
    const url = new URL(rawUrl);
    if (url.protocol !== 'https:' || url.hostname !== '127.0.0.1') return null;
    if (event.senderFrame && event.sender?.mainFrame && event.senderFrame !== event.sender.mainFrame) return null;
    const activeLsOrigin = getActiveLsOrigin(opts);
    if (activeLsOrigin && url.origin !== activeLsOrigin) return null;
    return url;
  } catch {
    return null;
  }
}

exports.isLocalMainFrameSender = isLocalMainFrameSender;

function getWindowWebContents(win, opts = {}) {
  if (!isLocalWindowTarget(win, opts)) return null;
  try {
    const direct = win.webContents;
    if (direct && isLocalWebContentsTarget(direct, opts) && !isAuxiliaryInternalUrl(direct.getURL?.())) {
      return direct;
    }
  } catch {}
  try {
    const utils = opts.utils ?? getCachedHostModule('utils', opts);
    if (utils && typeof utils.getHubWebContents === 'function') {
      const hubWc = utils.getHubWebContents(win);
      if (hubWc && isLocalWebContentsTarget(hubWc, opts) && !isAuxiliaryInternalUrl(hubWc.getURL?.())) {
        return hubWc;
      }
    }
  } catch {}
  try {
    const children = win.contentView?.children;
    if (Array.isArray(children)) {
      for (const view of children) {
        const wc = view?.webContents;
        if (wc && isLocalWebContentsTarget(wc, opts) && isLocalHubOriginUrl(wc.getURL?.())) {
          return wc;
        }
      }
      for (const view of children) {
        const wc = view?.webContents;
        if (wc && isLocalWebContentsTarget(wc, opts) && !isAuxiliaryInternalUrl(wc.getURL?.())) {
          return wc;
        }
      }
    }
  } catch {}
  return null;
}

exports.getWindowWebContents = getWindowWebContents;

function applyWindowsMenuBarFix(win) {
  if (process.platform !== 'win32' || !win || win.isDestroyed?.()) return;
  try {
    if (typeof win.setMenuBarVisibility === 'function') win.setMenuBarVisibility(false);
    win.autoHideMenuBar = true;
  } catch {}
}

let registeredIpc = false;
let registeredPreload = false;
const boundWindows = new WeakSet();
const boundWebContents = new WeakSet();
const activeLocalWebContents = new Set();
const injectionTimers = new WeakMap();
const wcProbeTimers = new WeakMap();
const inflightInjections = new WeakMap();

function clearTargetTimers(keyObj) {
  const inj = injectionTimers.get(keyObj);
  if (inj) {
    clearTimeout(inj);
    injectionTimers.delete(keyObj);
  }
  const probe = wcProbeTimers.get(keyObj);
  if (probe) {
    clearInterval(probe);
    wcProbeTimers.delete(keyObj);
  }
}

async function callWithAuthRetry(origin, senderWc, fn) {
  let auth = await resolveLsAuth(origin, senderWc);
  if (auth?.source) recordRuntimeHeartbeat(origin, { authSource: auth.source });
  try {
    return await fn(auth?.csrfToken || '');
  } catch (err) {
    if (err && err.code === 'AUTH') {
      auth = await resolveLsAuth(origin, senderWc);
      if (auth?.csrfToken) {
        recordRuntimeHeartbeat(origin, { authSource: auth.source });
        return await fn(auth.csrfToken);
      }
    }
    throw err;
  }
}

function registerIpcOnce() {
  if (registeredIpc || !ipcMain || typeof ipcMain.handle !== 'function') return;
  registeredIpc = true;

  ipcMain.handle('context-meter:scan', async (event, id, force) => {
    const url = isLocalMainFrameSender(event);
    if (!url) throw new Error('仅允许本机主聊天窗口');
    recordRuntimeHeartbeat(url.origin);
    try {
      const out = await callWithAuthRetry(url.origin, event.sender, csrfToken =>
        collectJsonAsync(url.origin, id, { force: force === true, csrfToken })
      );
      return { ok: true, json: out.json, stats: out.stats };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('context-meter:token-history', async (event, force) => {
    const url = isLocalMainFrameSender(event);
    if (!url) throw new Error('仅允许本机主聊天窗口');
    recordRuntimeHeartbeat(url.origin);
    try {
      const out = await callWithAuthRetry(url.origin, event.sender, csrfToken =>
        collectTokenHistoryJsonAsync({ origin: url.origin, force: force === true, csrfToken })
      );
      return { ok: true, json: out.json, stats: out.stats };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('context-meter:poll-metadata', async (event, id, offset) => {
    const url = isLocalMainFrameSender(event);
    if (!url) throw new Error('仅允许本机主聊天窗口');
    try {
      const out = await callWithAuthRetry(url.origin, event.sender, csrfToken =>
        pollGeneratorMetadataJsonAsync(url.origin, id, offset, { csrfToken })
      );
      return { ok: true, json: out.json };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('context-meter:sync-overlay', async (event, options) => {
    try {
      if (!isLocalMainFrameSender(event)) return { ok: false };
      const targetWin = resolveOwningWindowForWebContents(event.sender);
      if (!targetWin || targetWin.isDestroyed?.() || isHostAuxOrRemoteWindow(targetWin)) return { ok: false };
      applyWindowsMenuBarFix(targetWin);
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

function registerSessionPreloadOnce() {
  if (registeredPreload || !electronSession?.defaultSession) return;
  const preloadFile = path.join(activeRuntimeRoot, 'meter-preload.js');
  if (!fs.existsSync(preloadFile)) return;
  const ses = electronSession.defaultSession;
  try {
    if (typeof ses.registerPreloadScript === 'function') {
      ses.registerPreloadScript({ type: 'frame', filePath: preloadFile });
      preloadMode = 'registerPreloadScript';
      registeredPreload = true;
      return;
    }
  } catch {}
  try {
    if (typeof ses.setPreloads === 'function' && typeof ses.getPreloads === 'function') {
      const existing = ses.getPreloads() || [];
      if (!existing.includes(preloadFile)) {
        ses.setPreloads([...existing, preloadFile]);
      }
      preloadMode = 'setPreloads';
      registeredPreload = true;
    }
  } catch {}
}

async function injectIntoWebContents(wc, options = {}) {
  if (!wc || wc.isDestroyed?.() || !isLocalWebContentsTarget(wc)) return false;
  const earlyWin = resolveOwningWindowForWebContents(wc);
  if (earlyWin && isHostAuxOrRemoteWindow(earlyWin)) return false;
  const url = String(wc.getURL?.() || '');
  if (!isLocalHubOriginUrl(url)) {
    const attempt = Number(options.attempt || 0);
    const delays = [300, 600, 1000, 1500, 2500];
    if (attempt < delays.length && !wc.isDestroyed?.()) {
      const prev = injectionTimers.get(wc);
      if (prev) clearTimeout(prev);
      const t = setTimeout(() => {
        injectionTimers.delete(wc);
        void injectIntoWebContents(wc, { ...options, attempt: attempt + 1 });
      }, delays[attempt]);
      t.unref?.();
      injectionTimers.set(wc, t);
    }
    return false;
  }

  try {
    const owningWin = resolveOwningWindowForWebContents(wc);
    if (owningWin) applyWindowsMenuBarFix(owningWin);

    const existing = inflightInjections.get(wc);
    if (existing && !options.force && !options.reloadSource) return await existing;

    const runInject = (async () => {
      if (existing) {
        try { await existing; } catch {}
      }
      if (wc.isDestroyed?.()) return false;
      if (!options.force && !options.reloadSource) {
        try {
          const alive = await wc.executeJavaScript(
            'Boolean(window.__AGContextMeter && document.getElementById("ag-context-meter") && (window.__AGContextMeter.ensureAlive ? window.__AGContextMeter.ensureAlive() : true))'
          );
          if (alive === true) {
            try { onHealthyCallback?.(); } catch {}
            return true;
          }
        } catch {}
      }
      const runtimeSource = getMeterSource(Boolean(options.reloadSource));
      if (!runtimeSource) return false;
      await wc.executeJavaScript(runtimeSource);
      try {
        const origin = new URL(url).origin;
        const auth = await resolveLsAuth(origin, wc);
        recordRuntimeHeartbeat(origin, { authSource: auth?.source || 'none', force: Boolean(options.reloadSource) });
      } catch {}
      try { onHealthyCallback?.(); } catch {}
      return true;
    })();

    inflightInjections.set(wc, runInject);
    try {
      return await runInject;
    } finally {
      if (inflightInjections.get(wc) === runInject) inflightInjections.delete(wc);
    }
  } catch (error) {
    const attempt = Number(options.attempt || 0);
    const delays = [350, 1000, 2500];
    if (attempt < delays.length && !wc.isDestroyed?.()) {
      const prev = injectionTimers.get(wc);
      if (prev) clearTimeout(prev);
      const t = setTimeout(() => {
        injectionTimers.delete(wc);
        void injectIntoWebContents(wc, { ...options, attempt: attempt + 1 });
      }, delays[attempt]);
      t.unref?.();
      injectionTimers.set(wc, t);
    } else {
      console.warn('[Context Meter]', error?.message || String(error));
    }
    return false;
  }
}

async function ensureMeterInjected(win, options = {}) {
  if (!isLocalWindowTarget(win)) return false;
  applyWindowsMenuBarFix(win);
  const wc = getWindowWebContents(win);
  if (!wc || wc.isDestroyed?.()) {
    const attempt = Number(options.attempt || 0);
    const delays = [300, 600, 1000, 1500, 2500];
    if (attempt < delays.length && win && !win.isDestroyed?.()) {
      const prevTimer = injectionTimers.get(win);
      if (prevTimer) clearTimeout(prevTimer);
      const t = setTimeout(() => {
        injectionTimers.delete(win);
        void ensureMeterInjected(win, { ...options, attempt: attempt + 1 });
      }, delays[attempt]);
      t.unref?.();
      injectionTimers.set(win, t);
    }
    return false;
  }
  bindWebContentsTarget(wc);
  return injectIntoWebContents(wc, options);
}

exports.ensureMeterInjected = ensureMeterInjected;

function bindWebContentsTarget(wc) {
  if (!wc || wc.isDestroyed?.() || !isLocalWebContentsTarget(wc)) return false;
  const initialWin = resolveOwningWindowForWebContents(wc);
  if (initialWin && isHostAuxOrRemoteWindow(initialWin)) return false;
  if (boundWebContents.has(wc)) return true;
  boundWebContents.add(wc);
  activeLocalWebContents.add(wc);

  setImmediate(() => {
    const owningWin = resolveOwningWindowForWebContents(wc);
    if (owningWin && !isHostAuxOrRemoteWindow(owningWin)) applyWindowsMenuBarFix(owningWin);
  });

  wc.on?.('did-finish-load', () => {
    void injectIntoWebContents(wc, { force: true });
  });
  wc.on?.('dom-ready', () => {
    const owningWin = resolveOwningWindowForWebContents(wc);
    if (owningWin && !isHostAuxOrRemoteWindow(owningWin)) applyWindowsMenuBarFix(owningWin);
    void injectIntoWebContents(wc, { force: false });
  });
  wc.on?.('did-navigate', () => {
    void injectIntoWebContents(wc, { force: false });
  });
  wc.on?.('did-navigate-in-page', () => {
    void injectIntoWebContents(wc, { force: false });
  });
  wc.on?.('zoom-changed', () => {
    try {
      Promise.resolve(wc.executeJavaScript('window.__AGContextMeter?.ensureAlive?.()')).catch(() => {});
    } catch {}
  });
  wc.once?.('destroyed', () => {
    activeLocalWebContents.delete(wc);
    clearTargetTimers(wc);
  });
  return true;
}

function bindWindowWebContents(win) {
  const wc = getWindowWebContents(win);
  if (!wc || wc.isDestroyed?.()) return false;
  const probe = wcProbeTimers.get(win);
  if (probe) {
    clearInterval(probe);
    wcProbeTimers.delete(win);
  }
  return bindWebContentsTarget(wc);
}

exports.installContextMeter = function installContextMeter(win) {
  registerIpcOnce();
  registerSessionPreloadOnce();
  if (!isLocalWindowTarget(win)) return;

  if (!boundWindows.has(win)) {
    boundWindows.add(win);
    applyWindowsMenuBarFix(win);
    const onWinVisibleOrActive = () => {
      applyWindowsMenuBarFix(win);
      bindWindowWebContents(win);
      void ensureMeterInjected(win, { force: false });
    };
    win.on?.('show', onWinVisibleOrActive);
    win.on?.('restore', onWinVisibleOrActive);
    win.on?.('focus', onWinVisibleOrActive);
    win.on?.('closed', () => clearTargetTimers(win));
  }

  const boundNow = bindWindowWebContents(win);
  if (!boundNow && !wcProbeTimers.has(win)) {
    let attempts = 0;
    const maxAttempts = 40;
    const probe = setInterval(() => {
      attempts += 1;
      if (!win || win.isDestroyed?.() || attempts > maxAttempts) {
        clearInterval(probe);
        wcProbeTimers.delete(win);
        return;
      }
      if (bindWindowWebContents(win)) {
        void ensureMeterInjected(win, { force: false });
      }
    }, 150);
    probe.unref?.();
    wcProbeTimers.set(win, probe);
  }
};

let reloadWatcher = null;
let lastReloadSignalText = '';
function startReloadSignalWatcher() {
  if (reloadWatcher) return;
  try {
    const stateSubDir = path.join(getEffectiveStateDir(), 'state');
    fs.mkdirSync(stateSubDir, { recursive: true });
    const sigFile = path.join(stateSubDir, 'reload.signal');
    if (fs.existsSync(sigFile)) {
      try { lastReloadSignalText = fs.readFileSync(sigFile, 'utf8'); } catch {}
    }
    reloadWatcher = fs.watch(stateSubDir, (_eventType, filename) => {
      if (filename && filename !== 'reload.signal') return;
      try {
        if (!fs.existsSync(sigFile)) return;
        const txt = fs.readFileSync(sigFile, 'utf8');
        if (!txt || txt === lastReloadSignalText) return;
        lastReloadSignalText = txt;
        getMeterSource(true);
        for (const wc of Array.from(activeLocalWebContents)) {
          if (!wc.isDestroyed?.() && isLocalHubOriginUrl(wc.getURL?.())) {
            void injectIntoWebContents(wc, { force: true, reloadSource: true });
          }
        }
      } catch {}
    });
    reloadWatcher.on?.('error', () => {
      try { reloadWatcher.close(); } catch {}
      reloadWatcher = null;
    });
    reloadWatcher.unref?.();
  } catch {}
}

let started = false;
exports.start = function start(options = {}) {
  if (options.stateDir) activeStateDir = options.stateDir;
  if (options.runtimeRoot && fs.existsSync(options.runtimeRoot)) {
    activeRuntimeRoot = options.runtimeRoot;
  }
  if (typeof options.onHealthy === 'function') {
    onHealthyCallback = options.onHealthy;
  }
  getMeterSource(true);
  registerIpcOnce();
  registerSessionPreloadOnce();
  startReloadSignalWatcher();

  if (started) return;
  started = true;

  try {
    if (app && typeof app.on === 'function') {
      app.on('web-contents-created', (_event, contents) => {
        try {
          if (bindWebContentsTarget(contents)) {
            void injectIntoWebContents(contents, { force: false });
          }
        } catch {}
      });
      app.on('browser-window-created', (_event, win) => {
        try {
          exports.installContextMeter(win);
        } catch {}
      });
    }
    if (electronWebContents && typeof electronWebContents.getAllWebContents === 'function') {
      for (const wc of electronWebContents.getAllWebContents()) {
        if (bindWebContentsTarget(wc)) {
          void injectIntoWebContents(wc, { force: true });
        }
      }
    }
  } catch {}
};

// Legacy direct-require fallback (if required directly without calling start())
try {
  if (app && typeof app.on === 'function' && !globalThis.__agcmLoaderBootstrapped) {
    if (typeof app.isReady === 'function' && app.isReady()) {
      exports.start();
    } else if (typeof app.once === 'function') {
      app.once('ready', () => exports.start());
    }
  }
} catch {}
