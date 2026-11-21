#!/usr/bin/env node
'use strict';
process.noAsar = true;

/**
 * Antigravity Context Meter CLI (v3.2.0)
 * In-place <10ms single-line hook installer, external runtime manager, hot-reloader & update self-healer.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn, execFileSync } = require('child_process');
const { getStateDir } = require('./asar-engine');
const { install, findAsarPath, tryHotInject, deployRuntimeFiles, triggerReloadSignal } = require('./install');
const { restore } = require('./restore');
const { inspectAsarStatus } = require('./asar-patch');
const { runHeal } = require('./heal');
const { resolvePython } = require('./meter-collector');
const { isRemotePageTarget, probeLocalAppOrigin, extractLocalOriginsFromLogText } = require('./local-api');

function isPidAlive(pid) {
  if (!pid || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err && err.code === 'EPERM';
  }
}

function detectHostProcessRunning() {
  try {
    if (process.platform === 'win32') {
      const out = execFileSync('tasklist.exe', ['/FI', 'IMAGENAME eq Antigravity.exe', '/NH'], {
        encoding: 'utf8',
        windowsHide: true,
        timeout: 2500
      });
      return /Antigravity\.exe/i.test(out);
    }
    const out = execFileSync('pgrep', ['-i', 'antigravity'], { encoding: 'utf8', timeout: 2000 });
    return Boolean(out.trim());
  } catch {
    return false;
  }
}

function getLatestLoggedOrigin() {
  try {
    const home = os.homedir();
    const logCandidates = process.platform === 'win32'
      ? [path.join(process.env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'Antigravity', 'logs', 'main.log')]
      : process.platform === 'darwin'
        ? [path.join(home, 'Library', 'Logs', 'Antigravity', 'main.log')]
        : [path.join(process.env.XDG_CONFIG_HOME || path.join(home, '.config'), 'Antigravity', 'logs', 'main.log')];
    for (const p of logCandidates) {
      if (!fs.existsSync(p)) continue;
      const st = fs.statSync(p);
      const readLen = Math.min(st.size, 65536);
      const fd = fs.openSync(p, 'r');
      try {
        const buf = Buffer.allocUnsafe(readLen);
        fs.readSync(fd, buf, 0, readLen, st.size - readLen);
        const txt = buf.toString('utf8');
        // Match both v2.33 `Local: https://127.0.0.1:PORT/` and v2.34 `[AuthBootstrap] Loading Hub window URL: https://127.0.0.1:PORT/`
        const authBootMatches = [...txt.matchAll(/Loading Hub window URL:\s+(https:\/\/127\.0\.0\.1:\d+)\//g)];
        if (authBootMatches.length) return authBootMatches[authBootMatches.length - 1][1];
        const origins = extractLocalOriginsFromLogText(txt);
        if (origins.length) return origins[0];
      } finally {
        fs.closeSync(fd);
      }
    }
  } catch {}
  return null;
}

function getDevToolsPort() {
  const appData = process.env.APPDATA || (process.platform === 'darwin'
    ? path.join(os.homedir(), 'Library', 'Application Support')
    : path.join(os.homedir(), '.config'));
  const portFile = path.join(appData, 'Antigravity', 'DevToolsActivePort');
  if (!fs.existsSync(portFile)) return null;
  const port = Number(fs.readFileSync(portFile, 'utf8').split(/\r?\n/)[0]);
  return Number.isFinite(port) && port > 0 ? port : null;
}

function readLiveRuntimeStamp(stateDir) {
  try {
    const stampPath = path.join(stateDir, 'runtime-status.json');
    if (!fs.existsSync(stampPath)) return null;
    const rt = JSON.parse(fs.readFileSync(stampPath, 'utf8'));
    if (!rt || !isPidAlive(Number(rt.pid))) return null;
    const ageMs = Date.now() - (Date.parse(rt.updatedAt || '') || 0);
    if (!Number.isFinite(ageMs) || ageMs > 12 * 3600 * 1000) return null;
    if (process.platform === 'win32') {
      const out = execFileSync('tasklist.exe', ['/FI', `PID eq ${Number(rt.pid)}`, '/NH'], {
        encoding: 'utf8',
        windowsHide: true,
        timeout: 1500
      });
      if (!/Antigravity\.exe/i.test(out)) return null;
    }
    return rt;
  } catch {
    return null;
  }
}

async function queryLiveWindow() {
  const stateDir = getStateDir();
  const rt = readLiveRuntimeStamp(stateDir);
  const port = getDevToolsPort();

  if (!port) {
    if (rt) {
      return {
        running: true,
        cdpPort: null,
        cdpEnabled: false,
        pageFound: true,
        origin: rt.origin || null,
        active: true,
        version: rt.meterVersion || null,
        hookVersion: rt.hookVersion || null,
        preloadMode: rt.preloadMode || null,
        authSource: rt.authSource || null,
        hasIpcBridge: true,
        note: '外置运行时原生生效中（每次客户端升级将自动自愈）'
      };
    }
    const hostRunning = detectHostProcessRunning();
    if (hostRunning) {
      return {
        running: true,
        cdpPort: null,
        cdpEnabled: false,
        pageFound: true,
        origin: getLatestLoggedOrigin(),
        active: false,
        version: null,
        hasIpcBridge: false,
        note: '客户端运行中（当前进程尚未加载钩子，重启一次后永久自动续接更新）'
      };
    }
    return { running: false };
  }

  try {
    const pages = await new Promise((resolve, reject) => {
      const req = http.get(`http://127.0.0.1:${port}/json/list`, res => {
        let body = '';
        res.on('data', c => body += c);
        res.on('end', () => { try { resolve(JSON.parse(body)); } catch (e) { reject(e); } });
      });
      req.setTimeout(2500, () => req.destroy(new Error('timeout')));
      req.on('error', reject);
    });
    const candidates = pages
      .filter(p => p.type === 'page' && /^https:\/\/127\.0\.0\.1:\d+\//.test(p.url) && !isRemotePageTarget(p));
    let target = candidates[0] || null;
    for (const candidate of candidates) {
      if (await probeLocalAppOrigin(new URL(candidate.url).origin)) {
        target = candidate;
        break;
      }
    }
    if (!target) return { running: true, cdpPort: port, pageFound: false };

    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve, { once: true });
      ws.addEventListener('error', reject, { once: true });
    });
    const status = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timeout')), 4000);
      ws.addEventListener('message', ev => {
        const d = JSON.parse(ev.data);
        if (d.id === 1) {
          clearTimeout(timer);
          resolve(d.result?.result?.value || null);
        }
      });
      ws.send(JSON.stringify({
        id: 1,
        method: 'Runtime.evaluate',
        params: {
          expression: `(() => {
            const s = window.__AGContextMeter?.snapshot();
            const root = document.getElementById('ag-context-meter')?.shadowRoot;
            return {
              active: Boolean(window.__AGContextMeter),
              version: window.__AGContextMeter?.version || null,
              hasIpcBridge: Boolean(window.contextMeterAPI?.scan),
              badgeText: root?.getElementById('amount')?.textContent || null,
              route: s?.route || null,
              latest: s?.latest || null
            };
          })()`,
          returnByValue: true
        }
      }));
    });
    ws.close();
    return { running: true, cdpPort: port, cdpEnabled: true, pageFound: true, origin: new URL(target.url).origin, ...status };
  } catch (e) {
    return { running: Boolean(rt), error: e.message };
  }
}

async function cmdStatus(customPath) {
  const stateDir = getStateDir();
  const loaderPath = path.join(stateDir, 'loader.js');
  let asarInfo = null;
  try {
    const asarPath = findAsarPath(customPath);
    asarInfo = inspectAsarStatus(asarPath, loaderPath);
  } catch {}

  let config = null;
  try {
    const cfgPath = path.join(stateDir, 'config.json');
    if (fs.existsSync(cfgPath)) config = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  } catch {}

  let bootState = null;
  try {
    const bootPath = path.join(stateDir, 'state', 'boot.json');
    if (fs.existsSync(bootPath)) bootState = JSON.parse(fs.readFileSync(bootPath, 'utf8'));
  } catch {}

  const live = await queryLiveWindow();
  const py = resolvePython();
  const report = {
    asarPath: asarInfo?.asarPath || null,
    antigravityVersion: asarInfo?.appVersion || null,
    asarPatched: Boolean(asarInfo?.hooked || asarInfo?.hasLegacyUtilsPatch),
    hookArchitecture: asarInfo?.hooked ? 'v3.2-single-line-hook' : (asarInfo?.hasLegacyUtilsPatch ? 'legacy-utils-patch' : 'unpatched'),
    hookMatchesExpected: Boolean(asarInfo?.hookMatchesExpected),
    asarIntegrityFuse: asarInfo?.fuses?.asarIntegrityEnabled ?? null,
    asarIntegrityState: asarInfo?.fuses?.asarIntegrityState || 'unknown',
    config: config ? {
      meterVersion: config.meterVersion,
      mode: config.mode,
      disabled: Boolean(config.disabled),
      autoHeal: Boolean(config.autoHeal),
      nodePathExists: Boolean(config.nodePath && fs.existsSync(config.nodePath)),
      runtimeRoot: config.runtimeRoot
    } : null,
    bootCircuitBreaker: bootState,
    liveWindow: live,
    pythonAttachmentScanner: py || 'unavailable (optional)'
  };
  console.log(JSON.stringify(report, null, 2));
  return report;
}

async function cmdCheck(customPath) {
  console.log('🔍 [Antigravity 对话上下文查看器] 正在执行环境预检...');
  console.log(`  - Node.js 运行时: ${process.version} (${process.execPath})`);
  try {
    const asarPath = findAsarPath(customPath);
    const st = inspectAsarStatus(asarPath);
    console.log(`  - Antigravity 路径: ${asarPath} (v${st.appVersion}, IntegrityFuse=${st.fuses.asarIntegrityEnabled ? 'ON' : 'OFF'})`);
  } catch (e) {
    console.error(`  ❌ Antigravity 路径探测失败: ${e.message}`);
    process.exitCode = 1;
    return;
  }
  const py = resolvePython();
  console.log(`  - Python 附件深度解析器: ${py || '未检测到（基础上下文统计不受影响）'}`);
  const live = await queryLiveWindow();
  console.log(`  - 运行中窗口状态: ${live.running ? (live.active ? `已挂载 v${live.version} (${live.origin})` : `运行中 (${live.note || live.origin || '待重启加载钩子'})`) : '客户端未运行'}`);
  console.log('✅ 环境预检通过！');
}

function setDisabledFlag(disabled) {
  const stateDir = getStateDir();
  const cfgPath = path.join(stateDir, 'config.json');
  const cfg = fs.existsSync(cfgPath) ? (JSON.parse(fs.readFileSync(cfgPath, 'utf8')) || {}) : {};
  cfg.disabled = Boolean(disabled);
  cfg.updatedAt = new Date().toISOString();
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
  if (!disabled) {
    const bootPath = path.join(stateDir, 'state', 'boot.json');
    try { if (fs.existsSync(bootPath)) fs.unlinkSync(bootPath); } catch {}
  }
}

async function main() {
  const args = process.argv.slice(2);
  const cmd = (args.find(a => !a.startsWith('-')) || 'install').toLowerCase();
  const pathIdx = args.indexOf('--path');
  const customPath = pathIdx >= 0 ? args[pathIdx + 1] : null;

  if (cmd === 'install') {
    console.log('🚀 [Antigravity 对话上下文查看器 v3.2] 正在部署外置运行时与原位单行钩子...');
    const manifest = await install({ path: customPath, dev: args.includes('--dev'), force: args.includes('--force') });
    console.log(`✅ 原位钩子写入完成 (${manifest.patchMode}, ${manifest.patchElapsedMs}ms): ${manifest.installed} (Antigravity v${manifest.version})`);
    console.log(`✅ 更新自动自愈守护: ${manifest.autoHealReady ? '已就绪（后续点 Restart to Update 将在毫秒级自动续接）' : '未检测到独立 Node.js'}`);
    if (manifest.liveInjected) {
      console.log('✅ 运行中窗口状态: 已即时热更新生效（无需重启）');
    } else {
      const liveAfter = await queryLiveWindow();
      if (liveAfter.running) {
        console.log('ℹ️ 首次激活提示: 当前运行实例启动于钩子写入前，重启一次客户端即可激活，之后客户端再升级将全程自动自愈！');
      } else {
        console.log('✅ 启动状态: 下次打开 Antigravity 时将自动生效');
      }
    }
  } else if (cmd === 'reload') {
    const stateDir = getStateDir();
    deployRuntimeFiles(stateDir);
    triggerReloadSignal(stateDir);
    console.log('✅ 已同步最新前端代码并向运行中窗口发送免重启热重载信号！');
  } else if (cmd === 'heal') {
    const stateDir = getStateDir();
    const asarPath = customPath ? findAsarPath(customPath) : null;
    const res = await runHeal({ mode: 'check', stateDir, asarPath });
    console.log(JSON.stringify(res, null, 2));
  } else if (cmd === 'enable') {
    setDisabledFlag(false);
    const stateDir = getStateDir();
    try {
      await runHeal({ mode: 'check', stateDir, asarPath: customPath ? findAsarPath(customPath) : null });
    } catch {}
    console.log('✅ 已启用 Context Meter 外置加载器（已校验钩子并重置启动熔断计数）。');
  } else if (cmd === 'disable') {
    setDisabledFlag(true);
    console.log('⏸️ 已停用 Context Meter 外置加载器（无需改包，下次启动自动跳过）。');
  } else if (cmd === 'live') {
    const ok = await tryHotInject();
    if (!ok) {
      throw new Error('当前客户端未加载外置运行时且未开启 --remote-debugging-port；请运行 node cli.js install 后重启一次客户端。');
    }
    console.log('✅ 已热更新当前运行的 Antigravity 窗口！');
  } else if (cmd === 'restore' || cmd === 'uninstall') {
    const res = await restore(customPath ? { asarPath: findAsarPath(customPath) } : {});
    console.log(`✅ 已无损还原官方包 (${res.mode || 'backup'}): ${res.restored}`);
  } else if (cmd === 'status') {
    await cmdStatus(customPath);
  } else if (cmd === 'check') {
    await cmdCheck(customPath);
  } else {
    console.log(`用法:
  node cli.js install [--dev] [--path <app.asar>]  毫秒级原位安装单行钩子 + 外置运行时（含自动更新自愈）
  node cli.js reload                               同步最新 UI 代码并通知运行中窗口免重启热刷新
  node cli.js status                               查看钩子、熔断器、更新自愈与运行窗口状态
  node cli.js heal                                 执行按需单行钩子自检与补齐
  node cli.js enable | disable                     一键启用 / 停用外置加载器（免改包）
  node cli.js restore                              毫秒级逐字节无损卸载并还原官方原包`);
  }
}

if (require.main === module) {
  main().catch(error => {
    console.error('❌ 执行失败:', error.message);
    process.exitCode = 1;
  });
}

module.exports = { cmdStatus, cmdCheck, queryLiveWindow };
