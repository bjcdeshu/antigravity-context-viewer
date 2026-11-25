'use strict';
// Antigravity Context Meter v3.2.0 — Minimal External Bootstrap Loader
// Deployed to <stateDir>/loader.js and required by a single try/catch hook on line 1 of app.asar's main entry.
// Zero external dependencies; guarded by a boot circuit breaker, legacy collision check, and disabled switch.

(function bootstrapContextMeterLoader() {
  if (globalThis.__agcmLoaderBootstrapped) return;
  globalThis.__agcmLoaderBootstrapped = true;

  // Never run inside ELECTRON_RUN_AS_NODE (agy-node.cmd), renderer, utility, or worker processes.
  if (
    process.env.ELECTRON_RUN_AS_NODE ||
    process.env.AG_METER_DISABLE === '1' ||
    process.type !== 'browser'
  ) {
    return;
  }

  const fs = require('fs');
  const path = require('path');
  const { spawn } = require('child_process');

  const stateDir = __dirname;
  const configPath = path.join(stateDir, 'config.json');
  const proxyPath = path.join(stateDir, 'proxy.json');
  const bootStatePath = path.join(stateDir, 'state', 'boot.json');
  const healLogPath = path.join(stateDir, 'state', 'heal-log.jsonl');

  const isPidAlive = pid => {
    if (!pid || pid <= 0) return false;
    try {
      process.kill(pid, 0);
      return true;
    } catch (err) {
      return err && err.code === 'EPERM';
    }
  };

  const logHealEvent = obj => {
    try {
      fs.mkdirSync(path.dirname(healLogPath), { recursive: true });
      fs.appendFileSync(healLogPath, JSON.stringify({ ts: new Date().toISOString(), ...obj }) + '\n', 'utf8');
    } catch {}
  };

  let config = {};
  try {
    if (fs.existsSync(configPath)) {
      config = JSON.parse(fs.readFileSync(configPath, 'utf8')) || {};
    }
  } catch {}

  if (config.disabled === true) return;

  // 1. Inject optional proxy environment before host languageServer spawns child processes.
  try {
    if (fs.existsSync(proxyPath)) {
      const cfg = JSON.parse(fs.readFileSync(proxyPath, 'utf8'));
      if (cfg && cfg.httpProxy) {
        const noProxy = cfg.noProxy || 'localhost,127.0.0.1,::1,127.0.0.0/8,10.0.0.0/8,192.168.0.0/16,172.16.0.0/12,<-loopback>';
        for (const k of ['HTTP_PROXY', 'http_proxy', 'HTTPS_PROXY', 'https_proxy']) {
          if (!process.env[k]) process.env[k] = cfg.httpProxy;
        }
        if (cfg.allProxy) {
          for (const k of ['ALL_PROXY', 'all_proxy']) {
            if (!process.env[k]) process.env[k] = cfg.allProxy;
          }
        }
        for (const k of ['NO_PROXY', 'no_proxy']) {
          if (!process.env[k]) process.env[k] = noProxy;
        }
      }
    }
  } catch {}

  let electron;
  try {
    electron = require('electron');
  } catch {
    return;
  }
  const { app, autoUpdater } = electron;
  if (!app || typeof app.once !== 'function') return;

  const runtimeRoot = (config.runtimeRoot && fs.existsSync(config.runtimeRoot))
    ? config.runtimeRoot
    : path.join(stateDir, 'runtime');

  const resolveUsableNodeBin = targetAsar => {
    const hostRoot = targetAsar ? path.resolve(path.dirname(path.dirname(targetAsar))).toLowerCase() : '';
    const hostExe = path.resolve(process.execPath).toLowerCase();
    const candidates = [
      config.nodePath,
      process.platform === 'win32'
        ? path.join(process.env.ProgramFiles || 'C:\\Program Files', 'nodejs', 'node.exe')
        : '/usr/local/bin/node',
      process.platform === 'win32'
        ? path.join(process.env.LOCALAPPDATA || '', 'Programs', 'nodejs', 'node.exe')
        : '/opt/homebrew/bin/node',
      process.platform === 'win32' ? null : '/usr/bin/node'
    ];
    for (const c of candidates) {
      if (!c) continue;
      try {
        if (!fs.existsSync(c)) continue;
        const real = path.resolve(fs.realpathSync.native ? fs.realpathSync.native(c) : fs.realpathSync(c));
        const lower = real.toLowerCase();
        // Never use Antigravity.exe or anything inside $INSTDIR as helper binary — NSIS needs $INSTDIR unlocked!
        if (lower === hostExe || (hostRoot && lower.startsWith(hostRoot))) continue;
        return real;
      } catch {}
    }
    return null;
  };

  // 2. Attach Update Self-Healer ("Restart to Update" -> one-shot detached heal.js)
  // Kept independent of runtime UI circuit breaker so self-healing survives across host upgrades.
  let healSpawned = false;
  const triggerUpdateHeal = () => {
    if (healSpawned || config.autoHeal === false) return;
    const healScript = path.join(runtimeRoot, 'heal.js');
    const targetAsar = config.asarPath || (typeof app.getAppPath === 'function' ? app.getAppPath() : '');
    if (!targetAsar || !targetAsar.toLowerCase().endsWith('.asar') || !fs.existsSync(healScript)) return;

    const nodeBin = resolveUsableNodeBin(targetAsar);
    if (!nodeBin) {
      logHealEvent({ event: 'spawn-skipped', reason: 'node_binary_missing', configuredNodePath: config.nodePath || null });
      return;
    }

    let oldSig = '';
    try {
      const st = fs.statSync(targetAsar);
      oldSig = `${st.size}:${Math.trunc(st.mtimeMs)}`;
    } catch {}
    const oldVer = typeof app.getVersion === 'function' ? String(app.getVersion() || '') : '';

    healSpawned = true;
    // Reset guard after 20s in case user/host cancelled quit so a subsequent update click still works
    const resetTimer = setTimeout(() => { healSpawned = false; }, 20000);
    resetTimer.unref?.();

    try {
      const args = [
        healScript,
        '--wait-update',
        '--asar', targetAsar,
        '--state-dir', stateDir,
        '--parent-pid', String(process.pid)
      ];
      if (oldSig) args.push('--old-sig', oldSig);
      if (oldVer) args.push('--old-ver', oldVer);
      const child = spawn(nodeBin, args, {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
        cwd: stateDir
      });
      child.unref();
    } catch (err) {
      healSpawned = false;
      logHealEvent({ event: 'spawn-error', error: err?.message || String(err) });
    }
  };

  try {
    if (autoUpdater && typeof autoUpdater.on === 'function') {
      autoUpdater.on('before-quit-for-update', triggerUpdateHeal);
    }
  } catch {}

  // 3. Defer runtime startup until Electron `ready` so second-instance exits (before ready)
  // never touch boot.json or spawn workers unnecessarily.
  app.once('ready', () => {
    try {
      // C1 Safety Guard: if a legacy v3.1.x in-ASAR `dist/meter-main.js` is still packed inside app.asar,
      // skip external runtime so `ipcMain.handle` never double-registers inside `createWindow()`.
      try {
        const appPath = typeof app.getAppPath === 'function' ? app.getAppPath() : '';
        if (appPath && fs.existsSync(path.join(appPath, 'dist', 'meter-main.js'))) {
          return;
        }
      } catch {}

      const appVersion = typeof app.getVersion === 'function' ? app.getVersion() : 'unknown';
      const runtimeVersion = String(config.meterVersion || '3.2.0');
      const bootKey = `${appVersion}:${runtimeVersion}`;

      let boot = { key: bootKey, unconfirmed: 0, tripped: false, pid: 0 };
      try {
        if (fs.existsSync(bootStatePath)) {
          const prev = JSON.parse(fs.readFileSync(bootStatePath, 'utf8'));
          if (prev && prev.key === bootKey) boot = prev;
        }
      } catch {}

      if (boot.tripped || Number(boot.unconfirmed) >= 2) {
        return;
      }

      const writeBoot = next => {
        try {
          fs.mkdirSync(path.dirname(bootStatePath), { recursive: true });
          const tmp = `${bootStatePath}.tmp-${process.pid}`;
          fs.writeFileSync(tmp, JSON.stringify(next));
          fs.renameSync(tmp, bootStatePath);
        } catch {}
      };

      // M6 Guard: do not increment unconfirmed if another primary instance is currently alive
      const primaryAliveElsewhere = boot.pid && boot.pid !== process.pid && isPidAlive(Number(boot.pid));
      if (!primaryAliveElsewhere) {
        boot.unconfirmed = (Number(boot.unconfirmed) || 0) + 1;
        boot.pid = process.pid;
        boot.lastBootAt = new Date().toISOString();
        writeBoot(boot);
      }

      let confirmed = false;
      const confirmBoot = () => {
        if (confirmed) return;
        confirmed = true;
        writeBoot({ key: bootKey, unconfirmed: 0, tripped: false, pid: process.pid, confirmedAt: new Date().toISOString() });
      };

      // Graceful quit before 12s is NOT a crash — clear unconfirmed count cleanly.
      app.once('before-quit', confirmBoot);
      const aliveTimer = setTimeout(confirmBoot, 12000);
      aliveTimer.unref?.();

      const mainEntry = path.join(runtimeRoot, 'meter-main.js');
      if (!fs.existsSync(mainEntry)) return;
      const meterMain = require(mainEntry);
      if (meterMain && typeof meterMain.start === 'function') {
        meterMain.start({
          stateDir,
          runtimeRoot,
          config,
          onHealthy: confirmBoot
        });
      }
    } catch (err) {
      try {
        console.warn('[Context Meter Loader] Startup skipped safely:', err?.message || String(err));
      } catch {}
    }
  });
})();
