'use strict';
process.noAsar = true;

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const { getStateDir } = require('./asar-engine');
const { canRecoverDriftedMeterArchive } = require('./restore');
const { isRemotePageTarget, probeLocalAppOrigin } = require('./local-api');
const { inspectAsarStatus, patchAsarEntry } = require('./asar-patch');

const sha = buffer => crypto.createHash('sha256').update(buffer).digest('hex');

const RUNTIME_FILES = [
  'meter-main.js',
  'meter-core.js',
  'meter-renderer.js',
  'meter-collector.js',
  'meter-preload.js',
  'host-adapter.js',
  'auth-provider.js',
  'asar-patch.js',
  'heal.js',
  'attachment_scan.py'
];

function findAsarPath(customPath) {
  if (customPath) {
    const resolved = path.resolve(customPath);
    if (fs.existsSync(resolved) && fs.statSync(resolved).isDirectory()) {
      const inRes = path.join(resolved, 'resources', 'app.asar');
      if (fs.existsSync(inRes)) return inRes;
      const direct = path.join(resolved, 'app.asar');
      if (fs.existsSync(direct)) return direct;
    }
    if (fs.existsSync(resolved)) return resolved;
    throw new Error(`Could not find app.asar at specified path: ${customPath}`);
  }
  const home = os.homedir();
  const candidates = [];
  if (process.platform === 'win32') {
    const localAppData = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
    const programFiles = process.env.ProgramFiles || 'C:\\Program Files';
    candidates.push(
      path.join(localAppData, 'Programs', 'antigravity', 'resources', 'app.asar'),
      path.join(programFiles, 'antigravity', 'resources', 'app.asar'),
      path.join(programFiles, 'Google Antigravity', 'resources', 'app.asar'),
      path.join(home, 'AppData', 'Roaming', 'antigravity', 'resources', 'app.asar')
    );
  } else if (process.platform === 'darwin') {
    candidates.push(
      '/Applications/Antigravity.app/Contents/Resources/app.asar',
      path.join(home, 'Applications', 'Antigravity.app', 'Contents', 'Resources', 'app.asar')
    );
  } else {
    candidates.push(
      '/opt/antigravity/resources/app.asar',
      '/usr/lib/antigravity/resources/app.asar',
      '/usr/share/antigravity/resources/app.asar',
      path.join(home, '.local', 'share', 'antigravity', 'resources', 'app.asar')
    );
  }
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  throw new Error('Could not auto-detect Antigravity installation (app.asar). Use --path <path-to-app.asar>.');
}

function resolveStandaloneNodePath(asarPath) {
  const hostInstallRoot = asarPath ? path.resolve(path.dirname(path.dirname(asarPath))).toLowerCase() : '';
  const isInsideHostDir = candidate => {
    if (!candidate) return true;
    const norm = path.resolve(candidate).toLowerCase();
    return Boolean(hostInstallRoot && norm.startsWith(hostInstallRoot));
  };

  if (!process.env.ELECTRON_RUN_AS_NODE && !process.versions.electron && !isInsideHostDir(process.execPath)) {
    if (fs.existsSync(process.execPath)) {
      try {
        return fs.realpathSync.native ? fs.realpathSync.native(process.execPath) : fs.realpathSync(process.execPath);
      } catch {
        return process.execPath;
      }
    }
  }

  const candidates = [];
  if (process.platform === 'win32') {
    candidates.push(
      path.join(process.env.ProgramFiles || 'C:\\Program Files', 'nodejs', 'node.exe'),
      path.join(process.env.LOCALAPPDATA || '', 'Programs', 'nodejs', 'node.exe')
    );
    try {
      const whereOut = execFileSync('where.exe', ['node'], { encoding: 'utf8', windowsHide: true, timeout: 2000 });
      for (const line of whereOut.split(/\r?\n/)) {
        const p = line.trim();
        if (p) candidates.unshift(p);
      }
    } catch {}
  } else {
    candidates.push('/usr/local/bin/node', '/opt/homebrew/bin/node', '/usr/bin/node');
  }

  for (const c of candidates) {
    if (c && fs.existsSync(c)) {
      let real = c;
      try {
        real = fs.realpathSync.native ? fs.realpathSync.native(c) : fs.realpathSync(c);
      } catch {}
      if (!isInsideHostDir(real)) {
        return real;
      }
    }
  }
  return null;
}

function deployRuntimeFiles(stateDir) {
  const runtimeDir = path.join(stateDir, 'runtime');
  fs.mkdirSync(runtimeDir, { recursive: true });
  fs.copyFileSync(path.join(__dirname, 'loader.js'), path.join(stateDir, 'loader.js'));
  for (const file of RUNTIME_FILES) {
    const src = path.join(__dirname, file);
    if (fs.existsSync(src)) {
      fs.copyFileSync(src, path.join(runtimeDir, file));
    }
  }
  return runtimeDir;
}

function triggerReloadSignal(stateDir) {
  try {
    const stateSubDir = path.join(stateDir, 'state');
    fs.mkdirSync(stateSubDir, { recursive: true });
    fs.writeFileSync(path.join(stateSubDir, 'reload.signal'), `${Date.now()}:${process.pid}\n`, 'utf8');
    return true;
  } catch {
    return false;
  }
}

function isRunningRuntimeHookActive(stateDir) {
  try {
    const stampPath = path.join(stateDir, 'runtime-status.json');
    if (!fs.existsSync(stampPath)) return false;
    const rt = JSON.parse(fs.readFileSync(stampPath, 'utf8'));
    if (!rt || !rt.pid || !rt.hookVersion) return false;
    const stampAgeMs = Date.now() - (Date.parse(rt.updatedAt || '') || 0);
    if (!Number.isFinite(stampAgeMs) || stampAgeMs > 12 * 3600 * 1000) return false;
    process.kill(rt.pid, 0);
    if (process.platform === 'win32') {
      const out = execFileSync('tasklist.exe', ['/FI', `PID eq ${Number(rt.pid)}`, '/NH'], {
        encoding: 'utf8',
        windowsHide: true,
        timeout: 1500
      });
      if (!/Antigravity\.exe/i.test(out)) return false;
    }
    return true;
  } catch {
    return false;
  }
}

async function tryHotInject(options = {}) {
  try {
    const stateDir = getStateDir();
    if (!options.onlyIfMissing && isRunningRuntimeHookActive(stateDir)) {
      deployRuntimeFiles(stateDir);
      triggerReloadSignal(stateDir);
      return true;
    }

    const onlyIfMissing = Boolean(options && options.onlyIfMissing);
    const appData = process.env.APPDATA || (process.platform === 'darwin'
      ? path.join(os.homedir(), 'Library', 'Application Support')
      : path.join(os.homedir(), '.config'));
    const portFile = path.join(appData, 'Antigravity', 'DevToolsActivePort');
    if (!fs.existsSync(portFile)) return false;
    const port = Number(fs.readFileSync(portFile, 'utf8').split(/\r?\n/)[0]);
    if (!port) return false;
    const pages = await new Promise((resolve, reject) => {
      const req = http.get(`http://127.0.0.1:${port}/json/list`, res => {
        let body = '';
        res.on('data', c => body += c);
        res.on('end', () => { try { resolve(JSON.parse(body)); } catch (e) { reject(e); } });
      });
      req.setTimeout(2500, () => req.destroy(new Error('timeout')));
      req.on('error', reject);
    });
    const candidateTargets = pages.filter(
      p => p.type === 'page' && /^https:\/\/127\.0\.0\.1:\d+\//.test(p.url) && !isRemotePageTarget(p)
    );
    const targets = [];
    const verifiedOrigins = new Map();
    for (const candidate of candidateTargets) {
      const origin = new URL(candidate.url).origin;
      if (!verifiedOrigins.has(origin)) {
        verifiedOrigins.set(origin, Boolean(await probeLocalAppOrigin(origin)));
      }
      if (verifiedOrigins.get(origin)) targets.push(candidate);
    }
    if (!targets.length) return false;

    const livePath = fs.existsSync(path.join(stateDir, '.live-session.json'))
      ? path.join(stateDir, '.live-session.json')
      : path.join(__dirname, '.live-session.json');
    const liveInfo = fs.existsSync(livePath) ? JSON.parse(fs.readFileSync(livePath, 'utf8')) : null;
    let bundle = null;
    let historyJson = '';

    for (const target of targets) {
      const ws = new WebSocket(target.webSocketDebuggerUrl);
      await new Promise((resolve, reject) => {
        ws.addEventListener('open', resolve, { once: true });
        ws.addEventListener('error', reject, { once: true });
      });
      let seq = 0;
      const sendCdp = (method, params = {}) => new Promise((resolve, reject) => {
        const id = ++seq;
        const timer = setTimeout(() => reject(new Error('CDP timeout')), 5000);
        const handler = ev => {
          const d = JSON.parse(ev.data);
          if (d.id === id) {
            clearTimeout(timer);
            ws.removeEventListener('message', handler);
            resolve(d);
          }
        };
        ws.addEventListener('message', handler);
        ws.send(JSON.stringify({ id, method, params }));
      });
      const evalExpr = expression => sendCdp('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });

      if (onlyIfMissing) {
        const probe = await evalExpr('Boolean(window.__AGContextMeter && document.getElementById("ag-context-meter"))');
        if (probe?.result?.result?.value === true) {
          ws.close();
          continue;
        }
      }

      if (!bundle) {
        bundle = ['meter-core.js', 'meter-renderer.js']
          .map(f => fs.readFileSync(path.join(__dirname, f), 'utf8'))
          .join('\n');
        try {
          const { collectTokenHistoryJsonAsync } = require('./meter-collector');
          const res = await collectTokenHistoryJsonAsync({
            origin: new URL(target.url).origin,
            force: !onlyIfMissing
          });
          historyJson = res?.json || '';
        } catch {}
      }

      let liveAlive = false;
      if (liveInfo && liveInfo.pid && liveInfo.origin === new URL(target.url).origin) {
        try { process.kill(liveInfo.pid, 0); liveAlive = true; } catch {}
      }
      const liveAssign = liveAlive
        ? `window.__AGContextMeterLive=${JSON.stringify({ port: liveInfo.port, token: liveInfo.token, preferLive: true })};`
        : 'window.__AGContextMeterLive=null;';
      const historyAssign = historyJson
        ? `window.__AGContextMeterHistory=${historyJson};`
        : '';

      if (liveAssign) await evalExpr(liveAssign);
      if (historyAssign) await evalExpr(historyAssign);
      await evalExpr(bundle);

      try {
        const bootScript = `${liveAssign}\n${historyAssign}\nif (!window.__AGContextMeter) {\n  const run = () => {\n${bundle}\n  };\n  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', run, { once: true });\n  else run();\n}`;
        await sendCdp('Page.enable', {});
        await sendCdp('Page.addScriptToEvaluateOnNewDocument', { source: bootScript });
      } catch {}

      ws.close();
    }
    return true;
  } catch {
    return false;
  }
}

async function install(options = {}) {
  const customPathIdx = process.argv.indexOf('--path');
  const customPath = options.path || (customPathIdx >= 0 ? process.argv[customPathIdx + 1] : null);
  const devMode = Boolean(options.dev || process.argv.includes('--dev'));
  const forceMode = Boolean(options.force || process.argv.includes('--force'));
  const installed = findAsarPath(customPath);
  const stateDir = getStateDir();
  const manifestPath = path.join(stateDir, 'installation.json');
  const legacyManifestPath = path.join(__dirname, 'installation.json');
  const activeManifestPath = fs.existsSync(manifestPath)
    ? manifestPath
    : (fs.existsSync(legacyManifestPath) ? legacyManifestPath : null);

  // 1. Cleanly migrate off legacy v3.1.x full-ASAR utils.js patches if present on the same host version
  const preStatus = inspectAsarStatus(installed);
  if (preStatus.hasLegacyUtilsPatch && activeManifestPath) {
    try {
      const prev = JSON.parse(fs.readFileSync(activeManifestPath, 'utf8'));
      if (prev && prev.backup && fs.existsSync(prev.backup)) {
        const curSha = sha(fs.readFileSync(installed));
        if (
          (curSha === prev.patchedSha256 || canRecoverDriftedMeterArchive(installed, prev.backup)) &&
          sha(fs.readFileSync(prev.backup)) === prev.originalSha256
        ) {
          fs.copyFileSync(prev.backup, installed);
        }
      }
    } catch {}
  }
  // C1 Safety Check: never stack v3.2 hook onto a still-patched v3.1 legacy ASAR
  const postMigrateStatus = preStatus.hasLegacyUtilsPatch ? inspectAsarStatus(installed) : preStatus;
  if (postMigrateStatus.hasLegacyUtilsPatch) {
    throw new Error(
      `检测到旧版 (<= v3.1) 全包补丁仍在 ${installed} 中生效且无法在线还原（文件正被运行中的客户端占用或备份缺失）。请先退出一次 Antigravity 客户端后再运行 node cli.js install 完成平滑迁移！`
    );
  }

  // 2. Deploy external loader.js + runtime files + config.json
  const deployedRuntimeDir = deployRuntimeFiles(stateDir);
  const effectiveRuntimeRoot = devMode ? __dirname : deployedRuntimeDir;
  const loaderPath = path.join(stateDir, 'loader.js');
  const undoFilePath = path.join(stateDir, 'state', 'asar-undo.json');
  const bootStatePath = path.join(stateDir, 'state', 'boot.json');
  const meterVersion = require('./package.json').version || '3.2.0';
  const nodePath = resolveStandaloneNodePath(installed);

  fs.mkdirSync(path.join(stateDir, 'state'), { recursive: true });
  const config = {
    schemaVersion: 1,
    meterVersion,
    mode: devMode ? 'dev' : 'release',
    disabled: false,
    autoHeal: Boolean(nodePath),
    asarPath: installed,
    runtimeRoot: effectiveRuntimeRoot,
    repoRoot: __dirname,
    nodePath,
    updatedAt: new Date().toISOString()
  };
  fs.writeFileSync(path.join(stateDir, 'config.json'), JSON.stringify(config, null, 2));

  // Clear any prior boot circuit-breaker trip so the newly installed runtime runs cleanly
  try {
    if (fs.existsSync(bootStatePath)) fs.unlinkSync(bootStatePath);
  } catch {}

  // 3. Apply sub-10ms in-place 1-line hook to app.asar entry (dist/main.js)
  let patchRes;
  try {
    patchRes = patchAsarEntry({
      asarPath: installed,
      loaderPath,
      undoFilePath,
      allowUnknownFuse: forceMode
    });
  } catch (err) {
    if (err.code === 'EBUSY' || err.code === 'EPERM') {
      throw new Error(`无法写入目标文件 (${installed})：文件正被锁定，请先退出 Antigravity 客户端后再试。`);
    }
    throw err;
  }

  const manifest = {
    patchArchitecture: 'v3.2-hook',
    meterVersion,
    version: patchRes.appVersion,
    installed,
    entryPath: patchRes.entryPath,
    loaderPath,
    runtimeRoot: effectiveRuntimeRoot,
    undoFilePath,
    patchMode: patchRes.mode,
    patchElapsedMs: patchRes.elapsedMs,
    autoHealReady: Boolean(nodePath),
    nodePath,
    installedAt: new Date().toISOString()
  };
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

  const liveInjected = await tryHotInject();
  return { ...manifest, liveInjected };
}

if (require.main === module) {
  install()
    .then(manifest => console.log(JSON.stringify(manifest, null, 2)))
    .catch(error => {
      console.error(String(error.stack || error.message).slice(0, 2000));
      process.exitCode = 1;
    });
}

module.exports = {
  install,
  findAsarPath,
  tryHotInject,
  deployRuntimeFiles,
  triggerReloadSignal,
  resolveStandaloneNodePath
};
